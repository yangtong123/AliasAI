"""Smoke tests for the Python worker package layout."""

import document_parser
import image_processing
import ner
import ocr


def test_worker_adapter_packages_are_importable() -> None:
    assert document_parser.__doc__
    assert image_processing.__doc__
    assert ner.__doc__
    assert ocr.__doc__
