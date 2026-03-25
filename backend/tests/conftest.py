import importlib
import os
import socket
import subprocess
import sys
import time
import uuid
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
DEFAULT_TEST_POSTGRES_IMAGE = os.environ.get("TEST_POSTGRES_IMAGE", "pgvector/pgvector:pg16")
DEFAULT_TEST_DB_NAME = os.environ.get("TEST_POSTGRES_DB", "nocturne_test")
DEFAULT_TEST_DB_USER = os.environ.get("TEST_POSTGRES_USER", "postgres")
DEFAULT_TEST_DB_PASSWORD = os.environ.get("TEST_POSTGRES_PASSWORD", "postgres")


def _reload_module(name: str):
    module = importlib.import_module(name)
    return importlib.reload(module)


def _pick_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _docker_available() -> bool:
    try:
        subprocess.run(["docker", "info"], check=True, capture_output=True, text=True)
        return True
    except Exception:
        return False


def _wait_for_postgres(container_name: str, timeout_seconds: int = 60):
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        probe = subprocess.run(
            [
                "docker",
                "exec",
                container_name,
                "pg_isready",
                "-U",
                DEFAULT_TEST_DB_USER,
                "-d",
                DEFAULT_TEST_DB_NAME,
            ],
            capture_output=True,
            text=True,
        )
        if probe.returncode == 0:
            return
        time.sleep(1)
    raise RuntimeError(f"Timed out waiting for PostgreSQL test container: {container_name}")


@pytest.fixture(scope="session")
def test_database_url():
    explicit = os.environ.get("TEST_DATABASE_URL")
    if explicit:
        yield {"url": explicit, "container_name": None}
        return

    if not _docker_available():
        pytest.skip("TEST_DATABASE_URL not set and Docker is unavailable for auto-starting PostgreSQL tests")

    port = _pick_free_port()
    container_name = f"nocturne-test-pg-{uuid.uuid4().hex[:10]}"
    subprocess.run(
        [
            "docker",
            "run",
            "-d",
            "--rm",
            "--name",
            container_name,
            "-e",
            f"POSTGRES_DB={DEFAULT_TEST_DB_NAME}",
            "-e",
            f"POSTGRES_USER={DEFAULT_TEST_DB_USER}",
            "-e",
            f"POSTGRES_PASSWORD={DEFAULT_TEST_DB_PASSWORD}",
            "-p",
            f"127.0.0.1:{port}:5432",
            DEFAULT_TEST_POSTGRES_IMAGE,
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    try:
        _wait_for_postgres(container_name)
        yield {
            "url": f"postgresql+asyncpg://{DEFAULT_TEST_DB_USER}:{DEFAULT_TEST_DB_PASSWORD}@127.0.0.1:{port}/{DEFAULT_TEST_DB_NAME}",
            "container_name": container_name,
        }
    finally:
        subprocess.run(["docker", "rm", "-f", container_name], capture_output=True, text=True)


async def _reset_database(db_url: str):
    from db import close_db, get_db_manager
    from db.database import DatabaseManager

    await close_db()

    manager = DatabaseManager(db_url)
    async with manager.engine.begin() as conn:
        await conn.execute(text("DROP SCHEMA IF EXISTS public CASCADE"))
        await conn.execute(text("CREATE SCHEMA public"))
    await manager.close()

    await close_db()
    os.environ["DATABASE_URL"] = db_url
    db_manager = get_db_manager()
    await db_manager.init_db()


@pytest_asyncio.fixture(autouse=True)
async def isolated_test_environment(tmp_path, monkeypatch, test_database_url):
    db_url = test_database_url["url"]

    snapshot_dir = tmp_path / "snapshots"
    snapshot_dir.mkdir(parents=True, exist_ok=True)

    monkeypatch.setenv("DATABASE_URL", db_url)
    monkeypatch.setenv("SNAPSHOT_DIR", str(snapshot_dir))
    monkeypatch.setenv("VALID_DOMAINS", ",".join(VALID_DOMAINS[:-1]))
    monkeypatch.setenv("CORE_MEMORY_URIS", ",".join(CORE_MEMORY_URIS))
    monkeypatch.setenv("API_TOKEN", "")
    monkeypatch.setenv("NOCTURNE_DISABLE_DB_POOL", "1")

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
