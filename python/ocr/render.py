"""PDF page rasterization for the OCR path.

pypdfium2 and numpy are optional, lazily imported dependencies; a missing
renderer surfaces as RENDER_FAILURE, never as an import-time crash.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

from ocr.engine import OcrError

if TYPE_CHECKING:
    import numpy as np

DEFAULT_RENDER_SCALE = 300 / 72  # roughly 300 DPI from PDF points


@dataclass(frozen=True)
class RenderedPage:
    image: np.ndarray
    width: int
    height: int


class PdfRenderer(Protocol):
    """Rasterizes one 1-based PDF page into a rendered image."""

    def render_page(self, file_path: str, page_no: int) -> RenderedPage: ...


class PdfiumRenderer:
    def __init__(self, *, scale: float = DEFAULT_RENDER_SCALE) -> None:
        self._scale = scale

    def render_page(self, file_path: str, page_no: int) -> RenderedPage:
        try:
            import pypdfium2 as pdfium
        except ImportError as error:
            raise OcrError(
                "RENDER_FAILURE",
                "pypdfium2 is not installed; install the 'ocr' extra",
            ) from error
        try:
            import numpy as np
        except ImportError as error:
            raise OcrError(
                "RENDER_FAILURE",
                "numpy is not installed; install the 'ocr' extra",
            ) from error

        try:
            pdf = pdfium.PdfDocument(file_path)
            try:
                pdf_page = pdf[page_no - 1]
                pil_image = pdf_page.render(scale=self._scale).to_pil()
            finally:
                pdf.close()
        except OcrError:
            raise
        except Exception as error:
            raise OcrError("RENDER_FAILURE", "PDF page could not be rendered") from error

        image = np.asarray(pil_image.convert("RGB"))
        height, width = int(image.shape[0]), int(image.shape[1])
        if width <= 0 or height <= 0:
            raise OcrError("RENDER_FAILURE", "PDF page rendered to an empty image")
        return RenderedPage(image=image, width=width, height=height)
