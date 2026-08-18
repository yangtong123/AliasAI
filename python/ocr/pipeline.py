"""Per-page OCR pipeline: native text where reliable, OCR for raster pages.

Page classification (NATIVE/RASTER/MIXED) is reused from the native parser.
V1 limitation: MIXED pages emit their native text layer only; embedded image
regions are not OCRed.
"""

from __future__ import annotations

from collections.abc import Callable
from threading import Event
from typing import Any

from document_parser.native_pdf import NativePdfSummary, count_pdf_pages, parse_native_pdf
from ocr.engine import OcrEngine, OcrError, OcrTextRegion
from ocr.render import PdfRenderer

PageCallback = Callable[[dict[str, object]], None]
StageProgressCallback = Callable[[str, int, int, int], None]
Preprocessor = Callable[[Any], Any]


class _JobCancelled(Exception):
    """Internal control flow: cancellation observed mid-page."""


def _normalized_region_bbox(region: OcrTextRegion, width: int, height: int) -> dict[str, float]:
    left = min(max(region.x / width, 0.0), 1.0)
    top = min(max(region.y / height, 0.0), 1.0)
    right = min(max((region.x + region.width) / width, left), 1.0)
    bottom = min(max((region.y + region.height) / height, top), 1.0)
    return {"x": left, "y": top, "width": right - left, "height": bottom - top}


def _ocr_blocks(page_no: int, regions: list[OcrTextRegion], width: int, height: int) -> list[dict[str, object]]:
    blocks: list[dict[str, object]] = []
    for reading_order, region in enumerate(regions):
        blocks.append(
            {
                "localId": f"page-{page_no}-block-{reading_order + 1}",
                "blockType": "TEXT",
                "text": region.text,
                "bbox": _normalized_region_bbox(region, width, height),
                "confidence": region.confidence,
                "source": "OCR",
                "readingOrder": reading_order,
            }
        )
    return blocks


def process_pdf_with_ocr(
    file_path: str,
    *,
    page_start: int = 1,
    page_end: int | None = None,
    cancelled: Event | None = None,
    enable_ocr: bool = True,
    engine: OcrEngine,
    renderer: PdfRenderer,
    preprocess: Preprocessor | None = None,
    on_page: PageCallback,
    on_progress: StageProgressCallback | None = None,
) -> NativePdfSummary:
    """Stream pages through on_page; RASTER pages are rendered and OCRed."""
    page_count = count_pdf_pages(file_path)
    last_page = min(page_end if page_end is not None else page_count, page_count)
    total = max(1, last_page - page_start + 1)
    processed = 0
    last_completed = 0

    def emit_progress(stage: str, completed: int, page_no: int) -> None:
        if on_progress is not None:
            on_progress(stage, completed, total, page_no)

    def check_cancelled() -> None:
        if cancelled is not None and cancelled.is_set():
            raise _JobCancelled

    def handle_page(page: dict[str, object]) -> None:
        nonlocal processed, last_completed
        page_no = int(page["pageNo"])  # type: ignore[arg-type]
        if page["sourceType"] != "RASTER":
            # NATIVE page, or MIXED page (V1 keeps the native text layer only).
            on_page(page)
            processed += 1
            last_completed = page_no
            emit_progress("NATIVE_PARSE", processed, page_no)
            return

        if not enable_ocr:
            raise OcrError("OCR_ENGINE_FAILURE", "OCR is disabled for this job")
        check_cancelled()
        emit_progress("RENDER", processed, page_no)
        rendered = renderer.render_page(file_path, page_no)
        check_cancelled()
        emit_progress("PREPROCESS", processed, page_no)
        image = preprocess(rendered.image) if preprocess is not None else rendered.image
        check_cancelled()
        emit_progress("OCR", processed, page_no)
        regions = engine.recognize(image)
        # Cancellation may arrive during inference; never emit or count a page
        # recognized after the job was cancelled.
        check_cancelled()
        on_page({**page, "blocks": _ocr_blocks(page_no, regions, rendered.width, rendered.height)})
        processed += 1
        last_completed = page_no

    try:
        summary = parse_native_pdf(
            file_path,
            page_start=page_start,
            page_end=page_end,
            cancelled=cancelled,
            on_page=handle_page,
        )
    except _JobCancelled:
        return NativePdfSummary(page_count, processed, last_completed, True)
    if summary.cancelled:
        return summary
    return NativePdfSummary(page_count, processed, last_completed, False)
