"""Protocol v1 validation shared by the local mock worker."""

from __future__ import annotations

from typing import Any

PROTOCOL_VERSION = 1


class ProtocolValidationError(ValueError):
    """Raised when a JSON Lines protocol message does not meet Protocol v1."""


def validate_normalized_bbox(value: object) -> dict[str, float]:
    if not isinstance(value, dict):
        raise ProtocolValidationError("bbox must be a JSON object")

    bbox: dict[str, float] = {}
    for field in ("x", "y", "width", "height"):
        coordinate = value.get(field)
        if isinstance(coordinate, bool) or not isinstance(coordinate, (int, float)) or not 0 <= coordinate <= 1:
            raise ProtocolValidationError(f"bbox.{field} must be a number between 0 and 1")
        bbox[field] = float(coordinate)

    if bbox["x"] + bbox["width"] > 1:
        raise ProtocolValidationError("bbox.x + bbox.width must not exceed 1")
    if bbox["y"] + bbox["height"] > 1:
        raise ProtocolValidationError("bbox.y + bbox.height must not exceed 1")
    return bbox


def validate_request(message: object) -> dict[str, Any]:
    if not isinstance(message, dict):
        raise ProtocolValidationError("request must be a JSON object")
    if message.get("protocolVersion") != PROTOCOL_VERSION:
        raise ProtocolValidationError("unsupported protocol version")
    if not isinstance(message.get("jobId"), str) or not message["jobId"]:
        raise ProtocolValidationError("jobId is required")

    message_type = message.get("type")
    if message_type == "cancel_job":
        return message
    if message_type != "process_document":
        raise ProtocolValidationError("unsupported request type")
    if not isinstance(message.get("documentId"), str) or not message["documentId"]:
        raise ProtocolValidationError("documentId is required")
    if not isinstance(message.get("filePath"), str) or not message["filePath"]:
        raise ProtocolValidationError("filePath is required")

    options = message.get("options")
    if not isinstance(options, dict):
        raise ProtocolValidationError("options is required")
    for field in ("preferNativeText", "enableOcr", "enableLayoutAnalysis"):
        if not isinstance(options.get(field), bool):
            raise ProtocolValidationError(f"options.{field} must be boolean")
    if "pageEnd" not in options:
        raise ProtocolValidationError("options.pageEnd is required")

    if "pageStart" in options:
        page_start_value = options["pageStart"]
        if isinstance(page_start_value, bool) or not isinstance(page_start_value, int) or page_start_value < 1:
            raise ProtocolValidationError("options.pageStart must be a positive integer")

    page_end_value = options["pageEnd"]
    if page_end_value is not None and (
        isinstance(page_end_value, bool) or not isinstance(page_end_value, int) or page_end_value < 1
    ):
        raise ProtocolValidationError("options.pageEnd must be a positive integer or null")

    page_start = options.get("pageStart", 1)
    page_end = options["pageEnd"]
    if page_end is not None and page_end < page_start:
        raise ProtocolValidationError("options.pageEnd must be greater than or equal to options.pageStart")
    return message


def event(event_type: str, job_id: str, document_id: str, **payload: object) -> dict[str, object]:
    """Build an outbound envelope. filePath is intentionally never an event field."""
    if event_type == "page_result":
        page = payload.get("page")
        if not isinstance(page, dict) or not isinstance(page.get("blocks"), list):
            raise ProtocolValidationError("page_result.page.blocks must be an array")
        for block in page["blocks"]:
            if not isinstance(block, dict):
                raise ProtocolValidationError("page_result blocks must be JSON objects")
            validate_normalized_bbox(block.get("bbox"))

    return {
        "protocolVersion": PROTOCOL_VERSION,
        "type": event_type,
        "jobId": job_id,
        "documentId": document_id,
        **payload,
    }
