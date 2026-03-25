import os
import sys
import uvicorn

# Ensure we can import from backend dir
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from auth import BearerTokenAuthMiddleware
from mcp_server import mcp


def main():
    """
    Run the Nocturne Memory MCP server using SSE (Server-Sent Events) transport.
    This is required for clients that don't support stdio (like some web-based tools).
    """
    print("Initializing Nocturne Memory SSE Server...")

    # For legacy SSE clients (like some older UI tools or Claude Desktop)
    # This exposes GET /sse and POST /messages/
    sse_asgi_app = mcp.sse_app("/")
    
    # For newer Streamable HTTP clients (like GitHub Copilot type: "http")
    # This exposes GET/POST on /mcp
    streamable_asgi_app = mcp.streamable_http_app()
    
    # Combine routes into one ASGI app
    from starlette.applications import Starlette
    import contextlib

    @contextlib.asynccontextmanager
    async def combined_lifespan(app):
        async with contextlib.AsyncExitStack() as stack:
            await stack.enter_async_context(sse_asgi_app.router.lifespan_context(app))
            await stack.enter_async_context(streamable_asgi_app.router.lifespan_context(app))
            yield

    routes = []
    routes.extend(sse_asgi_app.router.routes)
    routes.extend(streamable_asgi_app.router.routes)
    combined_app = Starlette(routes=routes, lifespan=combined_lifespan)

    app = BearerTokenAuthMiddleware(combined_app, excluded_paths=[])

    port = int(os.getenv("PORT", 8000))
    host = os.getenv("HOST", "0.0.0.0")

    print(f"Starting SSE Server on http://{host}:{port}")
    print(f"Legacy SSE Endpoint: http://{host}:{port}/sse")
    print(f"Streamable HTTP Endpoint: http://{host}:{port}/mcp")

    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    main()
