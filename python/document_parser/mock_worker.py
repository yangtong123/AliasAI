"""A protocol-only mock worker. It never parses a source file or writes application data."""

from __future__ import annotations

import json
import sys
import threading
from typing import Any

from protocol import ProtocolValidationError, event, validate_request


_output_lock = threading.Lock()


def emit(message: dict[str, object]) -> None:
    with _output_lock:
        print(json.dumps(message, ensure_ascii=False), flush=True)


def process_document(request: dict[str, Any], cancelled: threading.Event) -> None:
    job_id = request["jobId"]
    document_id = request["documentId"]
    emit(event("started", job_id, document_id))
    if cancelled.wait(0.05):
        emit(event("cancelled", job_id, document_id, lastCompletedPage=0))
        return
    emit(event("progress", job_id, document_id, stage="INSPECT", completed=0, total=1, pageNo=1))
    emit(
        event(
            "page_result",
            job_id,
            document_id,
            page={
                "pageNo": 1,
                "originalWidth": 1000,
                "originalHeight": 1000,
                "rotation": 0,
                "sourceType": "NATIVE",
                "blocks": [
                    {
                        "localId": "synthetic-block-1",
                        "blockType": "TEXT",
                        "text": "Synthetic document block",
                        "bbox": {"x": 0.1, "y": 0.1, "width": 0.4, "height": 0.1},
                        "confidence": 1.0,
                        "source": "NATIVE",
                        "readingOrder": 0,
                    }
                ],
            },
        )
    )
    emit(event("completed", job_id, document_id, pageCount=1, processedPages=1))


def main() -> int:
    jobs: dict[str, tuple[threading.Event, threading.Thread]] = {}
    jobs_lock = threading.Lock()

    def run_job(request: dict[str, Any], cancelled: threading.Event) -> None:
        job_id = request["jobId"]
        try:
            process_document(request, cancelled)
        except Exception:
            emit(event("error", job_id, request["documentId"], code="INTERNAL_ERROR", message="Worker failed", retryable=False))
        finally:
            with jobs_lock:
                current = jobs.get(job_id)
                if current is not None and current[0] is cancelled:
                    jobs.pop(job_id, None)

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
            with jobs_lock:
                active_job = jobs.get(request["jobId"])
            if active_job is not None:
                active_job[0].set()
            continue

        cancelled = threading.Event()
        worker = threading.Thread(target=run_job, args=(request, cancelled), name=f"mock-worker-{request['jobId']}")
        with jobs_lock:
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

    with jobs_lock:
        active_workers = [worker for _, worker in jobs.values()]
    for worker in active_workers:
        worker.join()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
