"""Native PDF text extraction into the AliasAI Protocol v1 document model."""

from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from threading import Event

from pdfminer.converter import PDFPageAggregator
from pdfminer.layout import LAParams, LTComponent, LTFigure, LTImage, LTPage, LTTextContainer
from pdfminer.pdfdocument import PDFEncryptionError, PDFSyntaxError, PDFTextExtractionNotAllowed
from pdfminer.pdfinterp import PDFPageInterpreter, PDFResourceManager
from pdfminer.pdfpage import PDFPage


class NativePdfError(RuntimeError):
    """A safe, protocol-facing PDF parse failure."""

    def __init__(self, code: str, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable


@dataclass(frozen=True)
class NativePdfSummary:
    page_count: int
    processed_pages: int
    last_completed_page: int
    cancelled: bool


PageCallback = Callable[[dict[str, object]], None]
ProgressCallback = Callable[[int, int, int], None]


def _descendants(items: Iterable[LTComponent]) -> Iterable[LTComponent]:
    for item in items:
        yield item
        if isinstance(item, LTFigure):
            yield from _descendants(item)


def _normalized_bbox(component: LTComponent, width: float, height: float) -> dict[str, float]:
    x0, y0, x1, y1 = component.bbox
    left = min(max(float(x0) / width, 0.0), 1.0)
    top = min(max((height - float(y1)) / height, 0.0), 1.0)
    right = min(max(float(x1) / width, left), 1.0)
    bottom = min(max((height - float(y0)) / height, top), 1.0)
    return {"x": left, "y": top, "width": right - left, "height": bottom - top}


def _page_model(layout: LTPage, page_no: int, rotation: int) -> dict[str, object]:
    width = float(layout.width)
    height = float(layout.height)
    if width <= 0 or height <= 0:
        raise NativePdfError("PDF_PARSE_FAILURE", "PDF page has invalid dimensions")

    descendants = list(_descendants(layout))
    text_containers = [item for item in descendants if isinstance(item, LTTextContainer) and item.get_text().strip()]
    text_containers.sort(key=lambda item: (height - float(item.y1), float(item.x0), -float(item.y0)))
    has_images = any(isinstance(item, LTImage) for item in descendants)
    if text_containers and has_images:
        source_type = "MIXED"
    elif has_images:
        source_type = "RASTER"
    else:
        source_type = "NATIVE"

    blocks: list[dict[str, object]] = []
    for reading_order, container in enumerate(text_containers):
        blocks.append(
            {
                "localId": f"page-{page_no}-block-{reading_order + 1}",
                "blockType": "TEXT",
                "text": container.get_text().strip(),
                "bbox": _normalized_bbox(container, width, height),
                "source": "NATIVE",
                "readingOrder": reading_order,
            }
        )

    return {
        "pageNo": page_no,
        "originalWidth": width,
        "originalHeight": height,
        "rotation": rotation,
        "sourceType": source_type,
        "blocks": blocks,
    }


def parse_native_pdf(
    file_path: str,
    *,
    page_start: int = 1,
    page_end: int | None = None,
    cancelled: Event | None = None,
    on_page: PageCallback,
    on_progress: ProgressCallback | None = None,
) -> NativePdfSummary:
    """Stream native PDF pages through callbacks without persisting source content."""
    source = Path(file_path)
    if not source.is_file():
        raise NativePdfError("FILE_NOT_FOUND", "Document file was not found")

    try:
        with source.open("rb") as stream:
            pages = list(PDFPage.get_pages(stream, check_extractable=True))
            page_count = len(pages)
            if page_start > page_count and page_count > 0:
                raise NativePdfError("INVALID_REQUEST", "Requested page range is outside the document")

            last_page = min(page_end if page_end is not None else page_count, page_count)
            total = max(0, last_page - page_start + 1)
            processed = 0
            last_completed = 0
            resource_manager = PDFResourceManager(caching=True)
            device = PDFPageAggregator(resource_manager, laparams=LAParams())
            interpreter = PDFPageInterpreter(resource_manager, device)

            for page_index in range(page_start - 1, last_page):
                if cancelled is not None and cancelled.is_set():
                    return NativePdfSummary(page_count, processed, last_completed, True)

                pdf_page = pages[page_index]
                rotation = int(pdf_page.rotate) % 360
                pdf_page.rotate = 0
                interpreter.process_page(pdf_page)
                layout = device.get_result()
                page_no = page_index + 1
                page_result = _page_model(layout, page_no, rotation)

                if cancelled is not None and cancelled.is_set():
                    return NativePdfSummary(page_count, processed, last_completed, True)

                on_page(page_result)
                processed += 1
                last_completed = page_no
                if on_progress is not None:
                    on_progress(processed, total, page_no)

            return NativePdfSummary(page_count, processed, last_completed, False)
    except NativePdfError:
        raise
    except PDFTextExtractionNotAllowed as error:
        raise NativePdfError("PDF_PARSE_FAILURE", "PDF does not allow text extraction") from error
    except PDFEncryptionError as error:
        raise NativePdfError("PDF_PARSE_FAILURE", "Password-protected PDF cannot be parsed") from error
    except (OSError, ValueError, PDFSyntaxError) as error:
        raise NativePdfError("PDF_PARSE_FAILURE", "PDF native text extraction failed") from error
