from __future__ import annotations

import os
import secrets
from typing import Iterable, Sequence

from dotenv import find_dotenv, load_dotenv
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp, Receive, Scope, Send


# 尽早加载 .env，确保独立导入本模块时也能读取 API_TOKEN。
_dotenv_path = find_dotenv(usecwd=True)
if _dotenv_path:
    load_dotenv(_dotenv_path)


UNAUTHORIZED_MESSAGE = {"detail": "Unauthorized"}


def _normalize_path(path: str) -> str:
    if not path or path == "/":
        return "/"
    normalized = f"/{path.lstrip('/')}"
    return normalized.rstrip("/") or "/"


def is_excluded_path(path: str, excluded_paths: Iterable[str] | None = None) -> bool:
    normalized_path = _normalize_path(path)

    for raw_excluded_path in excluded_paths or ():
        excluded_path = _normalize_path(raw_excluded_path)
        if excluded_path == "/":
            return True
        if normalized_path == excluded_path:
            return True
        if normalized_path.startswith(f"{excluded_path}/"):
            return True

    return False


def get_api_token() -> str | None:
    return os.environ.get("API_TOKEN")


def _unauthorized_response() -> JSONResponse:
    return JSONResponse(status_code=401, content=UNAUTHORIZED_MESSAGE)


async def verify_token(
    request: Request,
    expected_token: str | None = None,
) -> Response | None:
    """校验 Bearer Token。

    Args:
        request: Starlette/FastAPI 请求对象。
        expected_token: 可选的预读 token；未传入时会从环境变量读取。

    Returns:
        校验失败时返回 401 JSONResponse，成功时返回 None。
    """

    token = expected_token if expected_token is not None else get_api_token()
    
    # 如果没有设置 token，默认不进行验证
    if not token:
        return None
    authorization = request.headers.get("Authorization", "")

    if not authorization.startswith("Bearer "):
        return _unauthorized_response()

    provided_token = authorization.removeprefix("Bearer ").strip()
    if not provided_token:
        return _unauthorized_response()

    if not secrets.compare_digest(provided_token, token):
        return _unauthorized_response()

    return None


class BearerTokenAuthMiddleware:
    """通用 Bearer Token ASGI 中间件。

    设计目标：
    - FastAPI: `app.add_middleware(BearerTokenAuthMiddleware, excluded_paths=[...])`
    - Starlette/ASGI: `app = BearerTokenAuthMiddleware(app, excluded_paths=[...])`
    """

    def __init__(
        self,
        app: ASGIApp,
        excluded_paths: Sequence[str] | None = None,
    ) -> None:
        self.app = app
        self.excluded_paths = tuple(excluded_paths or ())
        self.expected_token = get_api_token()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        # 如果没有配置 Token，直接放行所有 HTTP 请求
        if not self.expected_token:
            await self.app(scope, receive, send)
            return

        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "/")
        if is_excluded_path(path, self.excluded_paths):
            await self.app(scope, receive, send)
            return

        request = Request(scope, receive=receive)
        response = await verify_token(request, expected_token=self.expected_token)
        if response is not None:
            await response(scope, receive, send)
            return

        await self.app(scope, receive, send)


__all__ = [
    "BearerTokenAuthMiddleware",
    "UNAUTHORIZED_MESSAGE",
    "get_api_token",
    "is_excluded_path",
    "verify_token",
]
