import importlib
import os
import sys
from pathlib import Path

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text


REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = REPO_ROOT / "backend"

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))


VALID_DOMAINS = ["core", "writer", "game", "notes", "project", "system"]
CORE_MEMORY_URIS = ["core://agent", "core://my_user"]


def _reload_module(name: str):
    module = importlib.import_module(name)
    return importlib.reload(module)


async def _reset_database(db_url: str):
    from db import close_db, get_db_manager
    from db.database import DatabaseManager

    await close_db()

    if db_url.startswith("sqlite"):
        sqlite_path = Path(db_url.split("///", 1)[1])
        sqlite_path.parent.mkdir(parents=True, exist_ok=True)
        if sqlite_path.exists():
            sqlite_path.unlink()
    elif db_url.startswith("postgresql"):
        manager = DatabaseManager(db_url)
        async with manager.engine.begin() as conn:
            await conn.execute(text("DROP SCHEMA IF EXISTS public CASCADE"))
            await conn.execute(text("CREATE SCHEMA public"))
        await manager.close()

    await close_db()
    db_manager = get_db_manager()
    await db_manager.init_db()


@pytest_asyncio.fixture(autouse=True)
async def isolated_test_environment(tmp_path, monkeypatch):
    db_url = os.environ.get("TEST_DATABASE_URL")
    if not db_url:
        db_url = f"sqlite+aiosqlite:///{tmp_path / 'test.db'}"

    snapshot_dir = tmp_path / "snapshots"
    snapshot_dir.mkdir(parents=True, exist_ok=True)

    monkeypatch.setenv("DATABASE_URL", db_url)
    monkeypatch.setenv("SNAPSHOT_DIR", str(snapshot_dir))
    monkeypatch.setenv("VALID_DOMAINS", ",".join(VALID_DOMAINS[:-1]))
    monkeypatch.setenv("CORE_MEMORY_URIS", ",".join(CORE_MEMORY_URIS))
    monkeypatch.setenv("API_TOKEN", "")

    import db.snapshot as snapshot_module

    snapshot_module._store = snapshot_module.ChangesetStore(snapshot_dir=str(snapshot_dir))

    await _reset_database(db_url)

    mcp_server = _reload_module("mcp_server")
    mcp_server.VALID_DOMAINS = VALID_DOMAINS
    mcp_server.CORE_MEMORY_URIS = CORE_MEMORY_URIS

    yield {
        "database_url": db_url,
        "snapshot_dir": snapshot_dir,
    }

    from db import close_db

    await close_db()
    snapshot_module._store = None


@pytest_asyncio.fixture
async def graph_service():
    from db import get_graph_service

    return get_graph_service()


@pytest_asyncio.fixture
async def glossary_service():
    from db import get_glossary_service

    return get_glossary_service()


@pytest_asyncio.fixture
async def search_indexer():
    from db import get_search_indexer

    return get_search_indexer()


@pytest_asyncio.fixture
async def api_client():
    main = _reload_module("main")
    from db import get_db_manager

    await get_db_manager().init_db()

    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        yield client


@pytest_asyncio.fixture
async def mcp_module():
    return _reload_module("mcp_server")


@pytest.fixture
def reload_module():
    return _reload_module
