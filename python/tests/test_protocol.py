import pytest

from document_parser.protocol import ProtocolValidationError, event, validate_normalized_bbox, validate_request


def process_document_request() -> dict[str, object]:
    return {
        "protocolVersion": 1,
        "type": "process_document",
        "jobId": "job-1",
        "documentId": "document-1",
        "filePath": "/synthetic/source.pdf",
        "options": {
            "preferNativeText": True,
            "enableOcr": False,
            "enableLayoutAnalysis": False,
            "pageStart": 1,
            "pageEnd": None,
        },
    }


def test_protocol_accepts_a_valid_process_document_request() -> None:
    request = validate_request(process_document_request())

    assert request["jobId"] == "job-1"


def test_protocol_rejects_an_unknown_version() -> None:
    try:
        validate_request({"protocolVersion": 2, "type": "cancel_job", "jobId": "job-1"})
    except ProtocolValidationError as error:
        assert str(error) == "unsupported protocol version"
    else:
        raise AssertionError("unknown protocol version must be rejected")


def test_events_do_not_include_the_local_file_path() -> None:
    message = event("started", "job-1", "document-1")

    assert "filePath" not in message


@pytest.mark.parametrize(
    ("field", "message"),
    [
        ("pageStart", r"options\.pageStart must be a positive integer"),
        ("pageEnd", r"options\.pageEnd must be a positive integer or null"),
    ],
)
def test_protocol_rejects_boolean_page_ranges(field: str, message: str) -> None:
    request = process_document_request()
    options = request["options"]
    assert isinstance(options, dict)
    options[field] = True

    with pytest.raises(ProtocolValidationError, match=message):
        validate_request(request)


def test_protocol_rejects_a_null_page_start() -> None:
    request = process_document_request()
    options = request["options"]
    assert isinstance(options, dict)
    options["pageStart"] = None

    with pytest.raises(ProtocolValidationError, match=r"options\.pageStart must be a positive integer"):
        validate_request(request)


def test_protocol_requires_page_end_to_match_the_typescript_contract() -> None:
    request = process_document_request()
    options = request["options"]
    assert isinstance(options, dict)
    del options["pageEnd"]

    with pytest.raises(ProtocolValidationError, match=r"options\.pageEnd is required"):
        validate_request(request)


def test_protocol_rejects_an_inverted_page_range() -> None:
    request = process_document_request()
    options = request["options"]
    assert isinstance(options, dict)
    options["pageStart"] = 5
    options["pageEnd"] = 4

    with pytest.raises(ProtocolValidationError, match="pageEnd must be greater than or equal to"):
        validate_request(request)


def test_protocol_accepts_a_bbox_contained_by_the_page() -> None:
    assert validate_normalized_bbox({"x": 0.2, "y": 0.1, "width": 0.8, "height": 0.9}) == {
        "x": 0.2,
        "y": 0.1,
        "width": 0.8,
        "height": 0.9,
    }


@pytest.mark.parametrize(
    ("bbox", "message"),
    [
        ({"x": 0.8, "y": 0.1, "width": 0.3, "height": 0.2}, r"bbox\.x \+ bbox\.width must not exceed 1"),
        ({"x": 0.1, "y": 0.8, "width": 0.2, "height": 0.3}, r"bbox\.y \+ bbox\.height must not exceed 1"),
        ({"x": True, "y": 0.1, "width": 0.2, "height": 0.2}, r"bbox\.x must be a number between 0 and 1"),
    ],
)
def test_protocol_rejects_invalid_normalized_bboxes(bbox: dict[str, object], message: str) -> None:
    with pytest.raises(ProtocolValidationError, match=message):
        validate_normalized_bbox(bbox)


def test_page_result_event_validates_block_bboxes() -> None:
    with pytest.raises(ProtocolValidationError, match=r"bbox\.x \+ bbox\.width must not exceed 1"):
        event(
            "page_result",
            "job-1",
            "document-1",
            page={"blocks": [{"bbox": {"x": 0.9, "y": 0.1, "width": 0.2, "height": 0.2}}]},
        )
