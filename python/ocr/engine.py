"""OCR engine abstraction plus the PaddleOCR adapter.

The engine boundary is deliberately small: an image in, normalized text
regions out. PaddleOCR is an optional, lazily imported dependency so the
protocol worker can start (and serve native-only documents) without it.
"""

from __future__ import annotations

import numbers
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    import numpy as np


class OcrError(RuntimeError):
    """A safe, protocol-facing OCR stack failure (engine, renderer, pipeline)."""

    def __init__(self, code: str, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable


@dataclass(frozen=True)
class OcrTextRegion:
    """One recognized text line in rendered-image pixel coordinates."""

    text: str
    x: float
    y: float
    width: float
    height: float
    confidence: float


class OcrEngine(Protocol):
    """Recognizes text regions in a rendered page image."""

    def recognize(self, image: np.ndarray) -> list[OcrTextRegion]: ...


def _is_number(value: object) -> bool:
    return isinstance(value, numbers.Real) and not isinstance(value, bool)


def _points_bbox(points: Sequence[Sequence[float]]) -> tuple[float, float, float, float]:
    xs = [float(point[0]) for point in points]
    ys = [float(point[1]) for point in points]
    left, right = min(xs), max(xs)
    top, bottom = min(ys), max(ys)
    return left, top, right - left, bottom - top


def _box_bbox(box: Any) -> tuple[float, float, float, float]:
    items = list(box)
    if len(items) == 4 and all(_is_number(value) for value in items):
        left, top, right, bottom = (float(value) for value in items)
        return left, top, max(0.0, right - left), max(0.0, bottom - top)
    return _points_bbox(items)


def _looks_like_v2_line(value: Any) -> bool:
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        return False
    text_score = value[1]
    return (
        isinstance(text_score, (list, tuple))
        and len(text_score) == 2
        and isinstance(text_score[0], str)
        and _is_number(text_score[1])
    )


def _from_v2_lines(lines: Any) -> list[OcrTextRegion]:
    regions: list[OcrTextRegion] = []
    if lines is None:
        return regions
    if _looks_like_v2_line(lines):
        lines = [lines]
    for line in lines:
        if not _looks_like_v2_line(line):
            continue
        text, score = line[1]
        if not text.strip():
            continue
        x, y, width, height = _points_bbox(line[0])
        regions.append(OcrTextRegion(text=text, x=x, y=y, width=width, height=height, confidence=float(score)))
    return regions


def _from_v3_result(result: Mapping[str, Any]) -> list[OcrTextRegion]:
    # rec_texts/rec_scores/rec_boxes may be NumPy arrays; never evaluate them
    # as booleans (multi-element arrays raise ValueError on truthiness).
    texts = result.get("rec_texts")
    if texts is None:
        return []
    scores = result.get("rec_scores")
    boxes = result.get("rec_boxes")
    if boxes is None:
        boxes = result.get("rec_polys")
    if boxes is None:
        boxes = result.get("dt_polys")
    regions: list[OcrTextRegion] = []
    for index, text in enumerate(texts):
        if not isinstance(text, str) or not text.strip():
            continue
        score = scores[index] if scores is not None and index < len(scores) else 0.0
        if boxes is None or index >= len(boxes):
            continue
        x, y, width, height = _box_bbox(boxes[index])
        regions.append(
            OcrTextRegion(text=text, x=x, y=y, width=width, height=height, confidence=float(score))
        )
    return regions


def normalize_ocr_result(raw: Any) -> list[OcrTextRegion]:
    """Normalize PaddleOCR output across major versions.

    PaddleOCR 2.x returns one list of ``[points, (text, score)]`` lines per
    image; PaddleOCR 3.x returns dict-style ``OCRResult`` objects with
    ``rec_texts``/``rec_scores``/``rec_boxes`` (or polygon variants). Both
    collapse to the same OcrTextRegion list so the pipeline never sees
    engine-specific shapes.
    """
    if raw is None:
        return []
    if isinstance(raw, Mapping):
        return _from_v3_result(raw)
    regions: list[OcrTextRegion] = []
    for result in raw:
        if result is None:
            continue
        if isinstance(result, Mapping):
            regions.extend(_from_v3_result(result))
        else:
            regions.extend(_from_v2_lines(result))
    return regions


class PaddleOcrEngine:
    """PaddleOCR adapter. Legal documents are primarily Chinese: lang='ch'."""

    def __init__(self, *, lang: str = "ch") -> None:
        try:
            from paddleocr import PaddleOCR
        except ImportError as error:
            raise OcrError(
                "MODEL_LOAD_FAILURE",
                "PaddleOCR is not installed; install the 'ocr' extra",
            ) from error
        try:
            self._ocr = PaddleOCR(lang=lang)
        except Exception as error:
            raise OcrError("MODEL_LOAD_FAILURE", "OCR model could not be loaded", retryable=True) from error

    def recognize(self, image: np.ndarray) -> list[OcrTextRegion]:
        try:
            predict = getattr(self._ocr, "predict", None)
            raw = predict(image) if callable(predict) else self._ocr.ocr(image)
            # Normalization stays inside the failure mapping: unexpected engine
            # output shapes surface as OCR_ENGINE_FAILURE, never raw exceptions.
            return normalize_ocr_result(raw)
        except OcrError:
            raise
        except Exception as error:
            raise OcrError("OCR_ENGINE_FAILURE", "OCR recognition failed", retryable=True) from error
