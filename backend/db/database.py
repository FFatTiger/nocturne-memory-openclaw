# pyright: reportArgumentType=false, reportCallIssue=false

"""
Database connection and session management.

Infrastructure-only layer: owns the engine, session factory, and migration
runner.  No business logic lives here.

Supports both SQLite (local, single-user) and PostgreSQL (remote, multi-device).
"""

from contextlib import asynccontextmanager
from typing import Optional
from urllib.parse import urlparse, parse_qs

from sqlalchemy import event
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker

from .models import Base


class DatabaseManager:
    """Async database connection manager.

    Provides session lifecycle management (commit/rollback) and migration
    running.  All business-logic services receive a ``DatabaseManager``
    via constructor injection and pull ``session`` / ``_optional_session``
    from it.
    """

    def __init__(self, database_url: str):
        self.database_url = database_url
        self.db_type = self._detect_database_type(database_url)

        engine_kwargs = {"echo": False}
        if self.db_type == "postgresql":
            parsed = urlparse(database_url)
            is_local = parsed.hostname in ("localhost", "127.0.0.1", "::1")

            connect_args = {}
            parsed_qs = parse_qs(parsed.query, keep_blank_values=True)
            ssl_values = parsed_qs.get("ssl", []) + parsed_qs.get("sslmode", [])
            ssl_value = ssl_values[-1].lower() if ssl_values else ""
            ssl_disabled = ssl_value in ("disable", "false", "off", "0", "no")

            if not is_local and not ssl_disabled:
                connect_args["ssl"] = "require"
                connect_args["statement_cache_size"] = 0

            engine_kwargs.update(
                {
                    "pool_size": 10,
                    "max_overflow": 20,
                    "pool_recycle": 3600,
                    "pool_pre_ping": True,
                    "connect_args": connect_args,
                }
            )

        self.engine = create_async_engine(database_url, **engine_kwargs)

        if self.db_type == "sqlite":
            @event.listens_for(self.engine.sync_engine, "connect")
            def set_sqlite_pragma(dbapi_connection, connection_record):
                cursor = dbapi_connection.cursor()
                cursor.execute("PRAGMA foreign_keys=ON")
                cursor.close()

        self.async_session = async_sessionmaker(
            self.engine, class_=AsyncSession, expire_on_commit=False
        )

    @staticmethod
    def _detect_database_type(url: str) -> str:
        if "postgresql" in url:
            return "postgresql"
        elif "sqlite" in url:
            return "sqlite"
        else:
            return "sqlite"

    @asynccontextmanager
    async def session(self):
        """Get an async session context manager."""
        async with self.async_session() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    @asynccontextmanager
    async def _optional_session(self, session: Optional[AsyncSession] = None):
        """Helper to use an existing session or create a new one."""
        if session:
            yield session
        else:
            async with self.session() as new_session:
                yield new_session

    async def init_db(self):
        """Create tables if they don't exist, and run migrations."""
        import sys as _sys
        import os as _os

        project_root = _os.path.abspath(
            _os.path.join(_os.path.dirname(__file__), "..", "..")
        )
        if project_root not in _sys.path:
            _sys.path.insert(0, project_root)

        from db.migrations.runner import run_migrations

        try:
            from sqlalchemy import inspect as sa_inspect

            def check_initialized(connection):
                return sa_inspect(connection).has_table("memories")

            async with self.engine.begin() as conn:
                is_initialized = await conn.run_sync(check_initialized)
                if not is_initialized:
                    await conn.run_sync(Base.metadata.create_all)

            await run_migrations(self.engine)
        except Exception as e:
            db_url = self.database_url
            if "@" in db_url and ":" in db_url:
                try:
                    parsed = urlparse(db_url)
                    if parsed.password:
                        db_url = db_url.replace(f":{parsed.password}@", ":***@")
                except Exception:
                    pass
            raise RuntimeError(
                f"Failed to connect to database.\n"
                f"  URL: {db_url}\n"
                f"  Error: {e}\n\n"
                f"Troubleshooting:\n"
                f"  - Check that DATABASE_URL in your .env file is correct\n"
                f"  - For PostgreSQL, ensure the host is reachable and the password has no unescaped special characters (& * # etc.)\n"
                f"  - For SQLite, ensure the file path is absolute and the directory exists"
            ) from e

    async def close(self):
        """Close the database connection."""
        await self.engine.dispose()
