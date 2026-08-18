"""Optional OpenCV preprocessing for OCR input images.

OpenCV is an optional dependency: when it is unavailable the image passes
through unchanged (logged once per call to stderr) so OCR still runs.
"""

from __future__ import annotations

import sys
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import numpy as np


def preprocess_for_ocr(image: np.ndarray) -> np.ndarray:
    """Grayscale + Otsu binarization; passthrough when OpenCV is missing."""
    try:
        import cv2
    except ImportError:
        print("image_processing: OpenCV unavailable; skipping OCR preprocessing", file=sys.stderr, flush=True)
        return image

    gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY) if getattr(image, "ndim", 0) == 3 else image
    return cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]
