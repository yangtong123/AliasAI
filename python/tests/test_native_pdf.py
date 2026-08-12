from __future__ import annotations

import json
import subprocess
import sys
import threading
from pathlib import Path

import pytest

from document_parser.native_pdf import NativePdfError, parse_native_pdf
from document_parser.protocol import event


def create_synthetic_pdf(path: Path) -> None:
    first_content = b"BT /F1 11 Tf 20 70 Td (Synthetic Alice) Tj 0 -30 Td (Matter 42) Tj ET"
    second_content = b"BT /F1 11 Tf 30 150 Td (Synthetic second page) Tj ET"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length %d >>\nstream\n%s\nendstream" % (len(first_content), first_content),
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Rotate 90 /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>",
        b"<< /Length %d >>\nstream\n%s\nendstream" % (len(second_content), second_content),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    path.write_bytes(pdf_bytes(objects))


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


def collect_pages(path: Path, *, page_start: int = 1, page_end: int | None = None) -> tuple[list[dict[str, object]], object]:
    pages: list[dict[str, object]] = []
    summary = parse_native_pdf(
        str(path),
        page_start=page_start,
        page_end=page_end,
        on_page=pages.append,
    )
    return pages, summary


def test_native_pdf_parser_returns_normalized_document_pages(tmp_path: Path) -> None:
    source = tmp_path / "synthetic.pdf"
    create_synthetic_pdf(source)

    pages, summary = collect_pages(source)

    assert summary.page_count == 2
    assert summary.processed_pages == 2
    assert summary.cancelled is False
    assert [page["pageNo"] for page in pages] == [1, 2]
    assert pages[0]["originalWidth"] == 200
    assert pages[0]["originalHeight"] == 100
    assert pages[0]["sourceType"] == "NATIVE"
    assert pages[1]["rotation"] == 90
    assert pages[1]["originalWidth"] == 300
    assert pages[1]["originalHeight"] == 200

    first_blocks = pages[0]["blocks"]
    assert isinstance(first_blocks, list)
    assert [block["readingOrder"] for block in first_blocks] == [0, 1]
    assert [block["text"] for block in first_blocks] == ["Synthetic Alice", "Matter 42"]
    for page in pages:
        blocks = page["blocks"]
        assert isinstance(blocks, list)
        for block in blocks:
            assert block["source"] == "NATIVE"
            assert block["blockType"] == "TEXT"
            bbox = block["bbox"]
            assert 0 <= bbox["x"] <= 1
            assert 0 <= bbox["y"] <= 1
            assert bbox["x"] + bbox["width"] <= 1
            assert bbox["y"] + bbox["height"] <= 1
            event("page_result", "job-1", "document-1", page=page)


def test_native_pdf_parser_honors_page_ranges(tmp_path: Path) -> None:
    source = tmp_path / "synthetic.pdf"
    create_synthetic_pdf(source)

    pages, summary = collect_pages(source, page_start=2, page_end=2)

    assert [page["pageNo"] for page in pages] == [2]
    assert summary.page_count == 2
    assert summary.processed_pages == 1
    assert summary.last_completed_page == 2


def test_native_pdf_parser_identifies_raster_and_mixed_pages(tmp_path: Path) -> None:
    source = tmp_path / "synthetic-images.pdf"
    raster_content = b"q 100 0 0 100 0 0 cm /Im0 Do Q"
    mixed_content = b"q 100 0 0 100 0 0 cm /Im0 Do Q BT /F1 11 Tf 10 80 Td (Native layer) Tj ET"
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
    source.write_bytes(pdf_bytes(objects))

    pages, _ = collect_pages(source)

    assert pages[0]["sourceType"] == "RASTER"
    assert pages[0]["blocks"] == []
    assert pages[1]["sourceType"] == "MIXED"
    assert len(pages[1]["blocks"]) == 1


def test_native_pdf_parser_checks_cancellation_at_page_boundaries(tmp_path: Path) -> None:
    source = tmp_path / "synthetic.pdf"
    create_synthetic_pdf(source)
    cancelled = threading.Event()
    cancelled.set()
    pages: list[dict[str, object]] = []

    summary = parse_native_pdf(str(source), cancelled=cancelled, on_page=pages.append)

    assert pages == []
    assert summary.cancelled is True
    assert summary.processed_pages == 0
    assert summary.last_completed_page == 0


def test_native_pdf_parser_uses_safe_errors_without_source_paths(tmp_path: Path) -> None:
    source = tmp_path / "private-client-name.pdf"

    with pytest.raises(NativePdfError) as captured:
        parse_native_pdf(str(source), on_page=lambda _: None)

    assert captured.value.code == "FILE_NOT_FOUND"
    assert str(source) not in str(captured.value)


def test_native_worker_streams_protocol_v1_document_model(tmp_path: Path) -> None:
    source = tmp_path / "synthetic.pdf"
    create_synthetic_pdf(source)
    request = {
        "protocolVersion": 1,
        "type": "process_document",
        "jobId": "job-native-1",
        "documentId": "document-native-1",
        "filePath": str(source),
        "options": {
            "preferNativeText": True,
            "enableOcr": False,
            "enableLayoutAnalysis": False,
            "pageStart": 1,
            "pageEnd": None,
        },
    }
    worker_path = Path(__file__).parents[1] / "document_parser" / "native_worker.py"

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
        "jobId": "job-native-1",
        "documentId": "document-native-1",
        "pageCount": 2,
        "processedPages": 2,
    }
    page_results = [message for message in messages if message["type"] == "page_result"]
    assert len(page_results) == 2
    assert page_results[0]["page"]["blocks"][0]["text"] == "Synthetic Alice"
    assert str(source) not in result.stdout
