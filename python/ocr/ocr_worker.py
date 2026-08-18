"""JSON Lines worker that OCRs raster PDF pages as Protocol v1 pages.

Native text still wins where a reliable text layer exists; only RASTER pages
are rendered and recognized. PaddleOCR, pypdfium2, and OpenCV are optional
dependencies loaded lazily, so native-only documents work without them.
"""

from __future__ import annotations

import json
import sys
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from document_parser.native_pdf import NativePdfError
from document_parser.protocol import ProtocolValidationError, event, validate_request
from image_processing.preprocess import preprocess_for_ocr
from ocr.engine import OcrEngine, OcrError, OcrTextRegion, PaddleOcrEngine
from ocr.pipeline import process_pdf_with_ocr
from ocr.render import PdfiumRenderer


_output_lock = threading.Lock()


def emit(message: dict[str, object]) -> None:
    with _output_lock:
        print(json.dumps(message, ensure_ascii=False), flush=True)


class _LazyPaddleEngine:
    """Builds one PaddleOCR engine per worker and serializes its inference.

    The worker runs each job on its own thread, so a shared engine must never
    load the model more than once nor run concurrent ``recognize`` calls
    (PaddleOCR's predictor is not documented as thread-safe). The lock makes
    first-use construction race-free and serializes every inference; the
    worker additionally serializes whole jobs (see ``main``), so in practice
    the lock is never contended.
    """

    def __init__(self, factory: Callable[[], OcrEngine] = PaddleOcrEngine) -> None:
        self._factory = factory
        self._engine: OcrEngine | None = None
        self._lock = threading.Lock()

    def recognize(self, image: Any) -> list[OcrTextRegion]:
        with self._lock:
            if self._engine is None:
                self._engine = self._factory()
            return self._engine.recognize(image)


def process_document(request: dict[str, Any], cancelled: threading.Event, engine: _LazyPaddleEngine) -> None:
    job_id = request["jobId"]
    document_id = request["documentId"]
    options = request["options"]

    emit(event("started", job_id, document_id))
    emit(event("progress", job_id, document_id, stage="INSPECT", completed=0, total=1))

    def emit_page(page: dict[str, object]) -> None:
        emit(event("page_result", job_id, document_id, page=page))

    def emit_progress(stage: str, completed: int, total: int, page_no: int) -> None:
        emit(
            event(
                "progress",
                job_id,
                document_id,
                stage=stage,
                completed=completed,
                total=total,
                pageNo=page_no,
            )
        )

    summary = process_pdf_with_ocr(
        request["filePath"],
        page_start=options.get("pageStart", 1),
        page_end=options["pageEnd"],
        cancelled=cancelled,
        enable_ocr=options["enableOcr"],
        engine=engine,
        renderer=PdfiumRenderer(),
        preprocess=preprocess_for_ocr,
        on_page=emit_page,
        on_progress=emit_progress,
    )
    if summary.cancelled:
        emit(event("cancelled", job_id, document_id, lastCompletedPage=summary.last_completed_page))
        return

    emit(event("progress", job_id, document_id, stage="FINALIZE", completed=1, total=1))
    emit(
        event(
            "completed",
            job_id,
            document_id,
            pageCount=summary.page_count,
            processedPages=summary.processed_pages,
        )
    )


def main(engine: _LazyPaddleEngine | None = None) -> int:
    engine = engine if engine is not None else _LazyPaddleEngine()
    # V1 serializes whole OCR jobs through a single execution slot. Rendering
    # and preprocessing therefore never run concurrently, so high-resolution
    # page images cannot pile up in front of the shared PaddleOCR predictor.
    max_concurrent_jobs = 1
    jobs: dict[str, tuple[threading.Event, threading.Thread]] = {}
    jobs_lock = threading.Lock()
    job_slot = threading.Condition(jobs_lock)
    running_jobs = 0

    def run_job(request: dict[str, Any], cancelled: threading.Event) -> None:
        nonlocal running_jobs
        job_id = request["jobId"]
        document_id = request["documentId"]
        started = False
        try:
            with job_slot:
                while running_jobs >= max_concurrent_jobs and not cancelled.is_set():
                    job_slot.wait()
                if cancelled.is_set():
                    # Cancelled while queued for the slot: never start the job.
                    emit(event("cancelled", job_id, document_id, lastCompletedPage=0))
                    return
                running_jobs += 1
                started = True
            process_document(request, cancelled, engine)
        except (NativePdfError, OcrError) as error:
            emit(
                event(
                    "error",
                    job_id,
                    document_id,
                    code=error.code,
                    message=str(error),
                    retryable=error.retryable,
                )
            )
        except Exception:
            emit(
                event(
                    "error",
                    job_id,
                    document_id,
                    code="INTERNAL_ERROR",
                    message="Worker failed",
                    retryable=False,
                )
            )
        finally:
            with job_slot:
                if started:
                    running_jobs -= 1
                current = jobs.get(job_id)
                if current is not None and current[0] is cancelled:
                    jobs.pop(job_id, None)
                job_slot.notify_all()

    for line in sys.stdin:
        raw_request: object = None
        try:
            raw_request = json.loads(line)
            request = validate_request(raw_request)
        except (json.JSONDecodeError, ProtocolValidationError) as error:
            print(f"protocol validation failed: {error}", file=sys.stderr, flush=True)
            if isinstance(raw_request, dict):
                job_id = raw_request.get("jobId")
                document_id = raw_request.get("documentId")
                if isinstance(job_id, str) and job_id and isinstance(document_id, str) and document_id:
                    emit(
                        event(
                            "error",
                            job_id,
                            document_id,
                            code="INVALID_REQUEST",
                            message="Worker request was invalid",
                            retryable=False,
                        )
                    )
            continue

        if request["type"] == "cancel_job":
            with job_slot:
                active_job = jobs.get(request["jobId"])
                if active_job is not None:
                    active_job[0].set()
                    job_slot.notify_all()
            continue

        cancelled = threading.Event()
        worker = threading.Thread(target=run_job, args=(request, cancelled), name=f"ocr-worker-{request['jobId']}")
        with job_slot:
            if request["jobId"] in jobs:
                emit(
                    event(
                        "error",
                        request["jobId"],
                        request["documentId"],
                        code="INVALID_REQUEST",
                        message="Worker job is already active",
                        retryable=False,
                    )
                )
                continue
            jobs[request["jobId"]] = (cancelled, worker)
        worker.start()

    with job_slot:
        active_workers = [worker for _, worker in jobs.values()]
    for worker in active_workers:
        worker.join()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
