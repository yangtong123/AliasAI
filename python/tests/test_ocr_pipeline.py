from __future__ import annotations

import io
import json
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

import pytest

from image_processing.preprocess import preprocess_for_ocr
from ocr import ocr_worker as ocr_worker_module
from ocr.engine import OcrError, OcrTextRegion, PaddleOcrEngine, normalize_ocr_result
from ocr.ocr_worker import _LazyPaddleEngine
from ocr.pipeline import process_pdf_with_ocr
from ocr.render import PdfiumRenderer, RenderedPage


def pdf_bytes(objects: list[bytes]) -> bytes:
    output = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for object_number, value in enumerate(objects, start=1):
        offsets.append(len(output))
        output.extend(f"{object_number} 0 obj\n".encode())
        output.extend(value)
        output.extend(b"\nendobj\n")
    xref_offset = len(output)
    output.extend(f"xref\n0 {len(objects) + 1}\n".encode())
    output.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n \n".encode())
    output.extend(f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n".encode())
    return bytes(output)


def create_native_pdf(path: Path) -> None:
    content = b"BT /F1 11 Tf 20 70 Td (Synthetic native text) Tj ET"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length %d >>\nstream\n%s\nendstream" % (len(content), content),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    path.write_bytes(pdf_bytes(objects))


def create_raster_mixed_pdf(path: Path) -> None:
    raster_content = b"q 100 0 0 100 0 0 cm /Im0 Do Q"
    mixed_content = b"q 100 0 0 100 0 0 cm /Im0 Do Q BT /F1 11 Tf 10 80 Td (Synthetic mixed layer) Tj ET"
    image = b"\xff\xff\xff"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length %d >>\nstream\n%s\nendstream" % (len(raster_content), raster_content),
        b"<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length %d >>\nstream\n%s\nendstream"
        % (len(image), image),
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /XObject << /Im0 5 0 R >> /Font << /F1 8 0 R >> >> /Contents 7 0 R >>",
        b"<< /Length %d >>\nstream\n%s\nendstream" % (len(mixed_content), mixed_content),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    path.write_bytes(pdf_bytes(objects))


class FakeEngine:
    def __init__(self, regions: list[OcrTextRegion]) -> None:
        self.regions = regions
        self.images: list[Any] = []

    def recognize(self, image: Any) -> list[OcrTextRegion]:
        self.images.append(image)
        return self.regions


class FakeRenderer:
    def __init__(self, *, width: int = 1000, height: int = 2000) -> None:
        self.width = width
        self.height = height
        self.rendered_pages: list[int] = []

    def render_page(self, file_path: str, page_no: int) -> RenderedPage:
        self.rendered_pages.append(page_no)
        return RenderedPage(image=object(), width=self.width, height=self.height)  # type: ignore[arg-type]


def synthetic_region() -> OcrTextRegion:
    return OcrTextRegion(text="Synthetic scanned line", x=100, y=200, width=400, height=100, confidence=0.9)


def ocr_request(job_id: str, file_path: str) -> dict[str, object]:
    return {
        "protocolVersion": 1,
        "type": "process_document",
        "jobId": job_id,
        "documentId": f"document-{job_id}",
        "filePath": file_path,
        "options": {
            "preferNativeText": True,
            "enableOcr": True,
            "enableLayoutAnalysis": False,
            "pageStart": 1,
            "pageEnd": None,
        },
    }


def run_pipeline(
    path: Path,
    *,
    engine: FakeEngine | None = None,
    renderer: FakeRenderer | None = None,
    cancelled: threading.Event | None = None,
    enable_ocr: bool = True,
) -> tuple[list[dict[str, object]], list[tuple[str, int, int, int]], object]:
    pages: list[dict[str, object]] = []
    progress: list[tuple[str, int, int, int]] = []
    summary = process_pdf_with_ocr(
        str(path),
        cancelled=cancelled,
        enable_ocr=enable_ocr,
        engine=engine if engine is not None else FakeEngine([synthetic_region()]),
        renderer=renderer if renderer is not None else FakeRenderer(),
        on_page=pages.append,
        on_progress=lambda stage, completed, total, page_no: progress.append((stage, completed, total, page_no)),
    )
    return pages, progress, summary


def test_raster_pages_are_rendered_and_ocred(tmp_path: Path) -> None:
    source = tmp_path / "synthetic-raster.pdf"
    create_raster_mixed_pdf(source)
    engine = FakeEngine([synthetic_region()])
    renderer = FakeRenderer(width=1000, height=2000)

    pages, progress, summary = run_pipeline(source, engine=engine, renderer=renderer)

    assert summary.page_count == 2
    assert summary.processed_pages == 2
    assert summary.cancelled is False
    assert renderer.rendered_pages == [1]
    assert len(engine.images) == 1

    raster_page = pages[0]
    assert raster_page["sourceType"] == "RASTER"
    blocks = raster_page["blocks"]
    assert isinstance(blocks, list) and len(blocks) == 1
    block = blocks[0]
    assert block["text"] == "Synthetic scanned line"
    assert block["source"] == "OCR"
    assert block["blockType"] == "TEXT"
    assert block["confidence"] == 0.9
    assert block["readingOrder"] == 0
    assert block["localId"] == "page-1-block-1"
    assert block["bbox"] == pytest.approx({"x": 0.1, "y": 0.1, "width": 0.4, "height": 0.05})

    stages = [stage for stage, _, _, _ in progress]
    assert stages == ["RENDER", "PREPROCESS", "OCR", "NATIVE_PARSE"]
    assert all(total == 2 for _, _, total, _ in progress)


def test_mixed_pages_keep_the_native_layer_only(tmp_path: Path) -> None:
    source = tmp_path / "synthetic-mixed.pdf"
    create_raster_mixed_pdf(source)

    pages, _, _ = run_pipeline(source)

    mixed_page = pages[1]
    assert mixed_page["sourceType"] == "MIXED"
    blocks = mixed_page["blocks"]
    assert isinstance(blocks, list) and len(blocks) == 1
    assert blocks[0]["source"] == "NATIVE"
    assert blocks[0]["text"] == "Synthetic mixed layer"


def test_native_pages_pass_through_without_engine_or_renderer(tmp_path: Path) -> None:
    source = tmp_path / "synthetic-native.pdf"
    create_native_pdf(source)
    engine = FakeEngine([synthetic_region()])
    renderer = FakeRenderer()

    pages, progress, summary = run_pipeline(source, engine=engine, renderer=renderer)

    assert summary.processed_pages == 1
    assert pages[0]["sourceType"] == "NATIVE"
    blocks = pages[0]["blocks"]
    assert isinstance(blocks, list) and blocks[0]["source"] == "NATIVE"
    assert engine.images == []
    assert renderer.rendered_pages == []
    assert [stage for stage, _, _, _ in progress] == ["NATIVE_PARSE"]


def test_pipeline_cancels_between_ocr_stages(tmp_path: Path) -> None:
    source = tmp_path / "synthetic-raster.pdf"
    create_raster_mixed_pdf(source)
    cancelled = threading.Event()

    class CancellingRenderer(FakeRenderer):
        def render_page(self, file_path: str, page_no: int) -> RenderedPage:
            cancelled.set()
            return super().render_page(file_path, page_no)

    pages, _, summary = run_pipeline(source, renderer=CancellingRenderer(), cancelled=cancelled)

    assert pages == []
    assert summary.cancelled is True
    assert summary.processed_pages == 0


def test_raster_page_with_ocr_disabled_fails_closed(tmp_path: Path) -> None:
    source = tmp_path / "synthetic-raster.pdf"
    create_raster_mixed_pdf(source)

    with pytest.raises(OcrError) as captured:
        run_pipeline(source, enable_ocr=False)

    assert captured.value.code == "OCR_ENGINE_FAILURE"


def test_paddle_engine_reports_missing_dependency(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "paddleocr", None)

    with pytest.raises(OcrError) as captured:
        PaddleOcrEngine()

    assert captured.value.code == "MODEL_LOAD_FAILURE"


def test_lazy_paddle_engine_reuses_the_model_across_recognize_calls() -> None:
    builds: list[object] = []

    class FakePaddleEngine:
        def recognize(self, image: Any) -> list[OcrTextRegion]:
            return [synthetic_region()]

    def factory() -> FakePaddleEngine:
        builds.append(object())
        return FakePaddleEngine()

    engine = _LazyPaddleEngine(factory=factory)

    assert engine.recognize(object()) == [synthetic_region()]
    assert engine.recognize(object()) == [synthetic_region()]
    assert len(builds) == 1


def test_lazy_paddle_engine_serializes_inference_under_concurrency() -> None:
    builds: list[object] = []
    active = 0
    max_active = 0
    state_lock = threading.Lock()
    start_barrier = threading.Barrier(8)

    class FakePaddleEngine:
        def recognize(self, image: Any) -> list[OcrTextRegion]:
            nonlocal active, max_active
            with state_lock:
                active += 1
                max_active = max(max_active, active)
            time.sleep(0.05)  # widen the overlap window for concurrent callers
            with state_lock:
                active -= 1
            return [synthetic_region()]

    def factory() -> FakePaddleEngine:
        builds.append(object())
        return FakePaddleEngine()

    engine = _LazyPaddleEngine(factory=factory)
    results: list[list[OcrTextRegion]] = []

    def recognize() -> None:
        start_barrier.wait()
        results.append(engine.recognize(object()))

    threads = [threading.Thread(target=recognize) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert len(builds) == 1
    # The engine lock admits exactly one recognize at a time; without it the
    # barrier-released threads would overlap and max_active would exceed 1.
    assert max_active == 1
    assert results == [[synthetic_region()]] * 8


def test_pdfium_renderer_reports_missing_dependency(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "pypdfium2", None)
    source = tmp_path / "synthetic-native.pdf"
    create_native_pdf(source)

    with pytest.raises(OcrError) as captured:
        PdfiumRenderer().render_page(str(source), 1)

    assert captured.value.code == "RENDER_FAILURE"
    assert str(source) not in str(captured.value)


def test_preprocess_passes_through_without_opencv(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture) -> None:
    monkeypatch.setitem(sys.modules, "cv2", None)
    image = object()

    assert preprocess_for_ocr(image) is image  # type: ignore[arg-type]
    assert "OpenCV unavailable" in capsys.readouterr().err


def test_normalize_ocr_result_accepts_paddleocr_v2_shape() -> None:
    raw = [
        [
            [[[10, 20], [110, 20], [110, 40], [10, 40]], ("Synthetic v2 line", 0.95)],
            [[[10, 60], [60, 60], [60, 80], [10, 80]], ("", 0.5)],
        ]
    ]

    regions = normalize_ocr_result(raw)

    assert regions == [
        OcrTextRegion(text="Synthetic v2 line", x=10, y=20, width=100, height=20, confidence=0.95)
    ]


def test_normalize_ocr_result_accepts_paddleocr_v3_shape() -> None:
    raw = [
        {
            "rec_texts": ["Synthetic v3 line"],
            "rec_scores": [0.8],
            "rec_boxes": [[5, 10, 105, 30]],
        }
    ]

    regions = normalize_ocr_result(raw)

    assert regions == [
        OcrTextRegion(text="Synthetic v3 line", x=5, y=10, width=100, height=20, confidence=0.8)
    ]
    assert normalize_ocr_result(None) == []
    assert normalize_ocr_result([None]) == []


def test_ocr_worker_streams_native_pages_without_ocr_dependencies(tmp_path: Path) -> None:
    source = tmp_path / "synthetic.pdf"
    create_native_pdf(source)
    request = {
        "protocolVersion": 1,
        "type": "process_document",
        "jobId": "job-ocr-1",
        "documentId": "document-ocr-1",
        "filePath": str(source),
        "options": {
            "preferNativeText": True,
            "enableOcr": True,
            "enableLayoutAnalysis": False,
            "pageStart": 1,
            "pageEnd": None,
        },
    }
    worker_path = Path(__file__).parents[1] / "ocr" / "ocr_worker.py"

    result = subprocess.run(
        [sys.executable, "-u", str(worker_path)],
        input=f"{json.dumps(request)}\n",
        text=True,
        capture_output=True,
        timeout=10,
        check=False,
    )

    assert result.returncode == 0
    assert result.stderr == ""
    messages = [json.loads(line) for line in result.stdout.splitlines()]
    assert messages[0]["type"] == "started"
    assert messages[-1] == {
        "protocolVersion": 1,
        "type": "completed",
        "jobId": "job-ocr-1",
        "documentId": "document-ocr-1",
        "pageCount": 1,
        "processedPages": 1,
    }
    page_results = [message for message in messages if message["type"] == "page_result"]
    assert len(page_results) == 1
    assert page_results[0]["page"]["blocks"][0]["text"] == "Synthetic native text"
    stages = [message["stage"] for message in messages if message["type"] == "progress"]
    assert stages == ["INSPECT", "NATIVE_PARSE", "FINALIZE"]
    assert str(source) not in result.stdout


def test_ocr_worker_reports_missing_renderer_for_raster_pages(tmp_path: Path) -> None:
    try:
        import pypdfium2  # noqa: F401
    except ImportError:
        pass
    else:
        pytest.skip("requires pypdfium2 to be absent")
    source = tmp_path / "synthetic-raster.pdf"
    create_raster_mixed_pdf(source)
    request = {
        "protocolVersion": 1,
        "type": "process_document",
        "jobId": "job-ocr-2",
        "documentId": "document-ocr-2",
        "filePath": str(source),
        "options": {
            "preferNativeText": True,
            "enableOcr": True,
            "enableLayoutAnalysis": False,
            "pageStart": 1,
            "pageEnd": None,
        },
    }
    worker_path = Path(__file__).parents[1] / "ocr" / "ocr_worker.py"

    result = subprocess.run(
        [sys.executable, "-u", str(worker_path)],
        input=f"{json.dumps(request)}\n",
        text=True,
        capture_output=True,
        timeout=10,
        check=False,
    )

    assert result.returncode == 0
    messages = [json.loads(line) for line in result.stdout.splitlines()]
    assert messages[-1]["type"] == "error"
    assert messages[-1]["code"] == "RENDER_FAILURE"
    assert str(source) not in result.stdout


def test_ocr_worker_serializes_jobs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture) -> None:
    source = tmp_path / "synthetic-raster.pdf"
    create_raster_mixed_pdf(source)
    active = 0
    max_active = 0
    state_lock = threading.Lock()

    class CountingEngine:
        def recognize(self, image: Any) -> list[OcrTextRegion]:
            nonlocal active, max_active
            with state_lock:
                active += 1
                max_active = max(max_active, active)
            time.sleep(0.05)  # widen the overlap window for concurrent jobs
            with state_lock:
                active -= 1
            return [synthetic_region()]

    monkeypatch.setattr(ocr_worker_module, "PdfiumRenderer", FakeRenderer)
    requests = (
        f"{json.dumps(ocr_request('job-serial-1', str(source)))}\n"
        f"{json.dumps(ocr_request('job-serial-2', str(source)))}\n"
    )
    monkeypatch.setattr(sys, "stdin", io.StringIO(requests))

    result = ocr_worker_module.main(CountingEngine())

    assert result == 0
    # A single execution slot means rendering and inference never overlap
    # across jobs; without it max_active would reach 2 during the sleep.
    assert max_active == 1
    assert capsys.readouterr().out.count('"type": "completed"') == 2


def test_ocr_worker_reuses_one_model_across_jobs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture
) -> None:
    source = tmp_path / "synthetic-raster.pdf"
    create_raster_mixed_pdf(source)
    builds: list[object] = []

    class FakePaddleEngine:
        def recognize(self, image: Any) -> list[OcrTextRegion]:
            return [synthetic_region()]

    def factory() -> FakePaddleEngine:
        builds.append(object())
        return FakePaddleEngine()

    monkeypatch.setattr(ocr_worker_module, "PdfiumRenderer", FakeRenderer)
    requests = (
        f"{json.dumps(ocr_request('job-shared-1', str(source)))}\n"
        f"{json.dumps(ocr_request('job-shared-2', str(source)))}\n"
    )
    monkeypatch.setattr(sys, "stdin", io.StringIO(requests))

    result = ocr_worker_module.main(_LazyPaddleEngine(factory=factory))

    assert result == 0
    assert len(builds) == 1
    assert capsys.readouterr().out.count('"type": "completed"') == 2


def test_ocr_worker_cancels_queued_jobs_without_running_them(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture
) -> None:
    source = tmp_path / "synthetic-raster.pdf"
    create_raster_mixed_pdf(source)
    recognize_calls = 0

    class SlowEngine:
        def recognize(self, image: Any) -> list[OcrTextRegion]:
            nonlocal recognize_calls
            recognize_calls += 1
            time.sleep(0.2)  # hold the single slot so the second job queues
            return [synthetic_region()]

    monkeypatch.setattr(ocr_worker_module, "PdfiumRenderer", FakeRenderer)
    requests = (
        f"{json.dumps(ocr_request('job-slow-1', str(source)))}\n"
        f"{json.dumps(ocr_request('job-queued-2', str(source)))}\n"
        f"{json.dumps({'protocolVersion': 1, 'type': 'cancel_job', 'jobId': 'job-queued-2'})}\n"
    )
    monkeypatch.setattr(sys, "stdin", io.StringIO(requests))

    result = ocr_worker_module.main(SlowEngine())

    assert result == 0
    assert recognize_calls == 1  # the queued job was never started
    out = capsys.readouterr().out
    assert out.count('"type": "completed"') == 1
    assert out.count('"type": "cancelled"') == 1
    assert '"lastCompletedPage": 0' in out


class _ArrayLike:
    """Mimics a NumPy ndarray: len/getitem work, truthiness raises ValueError."""

    def __init__(self, values: list[Any]) -> None:
        self._values = list(values)

    def __len__(self) -> int:
        return len(self._values)

    def __getitem__(self, index: int) -> Any:
        return self._values[index]

    def __bool__(self) -> bool:
        raise ValueError("The truth value of an array with more than one element is ambiguous")


def test_normalize_ocr_result_handles_array_like_v3_fields() -> None:
    raw = [
        {
            "rec_texts": _ArrayLike(["Synthetic v3 line", "Another synthetic line"]),
            "rec_scores": _ArrayLike([0.8, 0.7]),
            "rec_boxes": _ArrayLike([[5, 10, 105, 30], [5, 40, 105, 60]]),
        }
    ]

    regions = normalize_ocr_result(raw)

    assert regions == [
        OcrTextRegion(text="Synthetic v3 line", x=5, y=10, width=100, height=20, confidence=0.8),
        OcrTextRegion(text="Another synthetic line", x=5, y=40, width=100, height=20, confidence=0.7),
    ]


def test_recognize_maps_unexpected_engine_output_to_engine_failure() -> None:
    engine = object.__new__(PaddleOcrEngine)

    class GarbageOcr:
        def predict(self, image: Any) -> Any:
            return 42  # not iterable: normalization must not escape as a raw error

    engine._ocr = GarbageOcr()

    with pytest.raises(OcrError) as captured:
        engine.recognize(object())

    assert captured.value.code == "OCR_ENGINE_FAILURE"
    assert captured.value.retryable is True


def test_pipeline_cancels_after_inference_before_emitting(tmp_path: Path) -> None:
    source = tmp_path / "synthetic-raster.pdf"
    create_raster_mixed_pdf(source)
    cancelled = threading.Event()

    class CancellingEngine(FakeEngine):
        def recognize(self, image: Any) -> list[OcrTextRegion]:
            cancelled.set()
            return super().recognize(image)

    pages, _, summary = run_pipeline(source, engine=CancellingEngine([synthetic_region()]), cancelled=cancelled)

    assert pages == []
    assert summary.cancelled is True
    assert summary.processed_pages == 0
