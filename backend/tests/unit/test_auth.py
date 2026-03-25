from starlette.requests import Request

from auth import is_excluded_path, verify_token


def _make_request(headers=None):
    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    raw_headers = [
        (key.lower().encode("utf-8"), value.encode("utf-8"))
        for key, value in (headers or {}).items()
    ]
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/browse/node",
        "headers": raw_headers,
    }
    return Request(scope, receive=receive)


def test_is_excluded_path_matches_exact_and_nested_routes():
    assert is_excluded_path("/health", ["/health"])
    assert is_excluded_path("/review/groups", ["/review"])
    assert not is_excluded_path("/browse/node", ["/health", "/review"])


async def test_verify_token_allows_requests_when_unconfigured(monkeypatch):
    monkeypatch.delenv("API_TOKEN", raising=False)

    response = await verify_token(_make_request(), expected_token=None)

    assert response is None


async def test_verify_token_accepts_matching_bearer_token():
    response = await verify_token(
        _make_request({"Authorization": "Bearer secret-token"}),
        expected_token="secret-token",
    )

    assert response is None


async def test_verify_token_rejects_missing_or_invalid_bearer_token():
    missing = await verify_token(_make_request(), expected_token="secret-token")
    invalid = await verify_token(
        _make_request({"Authorization": "Bearer wrong-token"}),
        expected_token="secret-token",
    )

    assert missing.status_code == 401
    assert invalid.status_code == 401
