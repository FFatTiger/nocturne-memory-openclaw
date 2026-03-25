# pyright: reportArgumentType=false, reportCallIssue=false

"""
Database connection and session management.

PG-only infrastructure layer: owns the engine, session factory, and migration
runner. No business logic lives here.
"""

import os
from contextlib import asynccontextmanager
from typing import Optional
from urllib.parse import urlparse, parse_qs

from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.pool import NullPool

from .models import Base


class DatabaseManager:
    """Async PostgreSQL connection manager."""

    def __init__(self, database_url: str):
        self.database_url = self._normalize_database_url(database_url)
        self.db_type = self._detect_database_type(self.database_url)

        parsed = urlparse(self.database_url)
        is_local = parsed.hostname in ("localhost", "127.0.0.1", "::1", "postgres")

        connect_args = {}
        parsed_qs = parse_qs(parsed.query, keep_blank_values=True)
        ssl_values = parsed_qs.get("ssl", []) + parsed_qs.get("sslmode", [])
        ssl_value = ssl_values[-1].lower() if ssl_values else ""
        ssl_disabled = ssl_value in ("disable", "false", "off", "0", "no")

        if is_local or ssl_disabled:
            connect_args["ssl"] = False
        else:
            connect_args["ssl"] = "require"
            connect_args["statement_cache_size"] = 0

        engine_kwargs = {
            "echo": False,
            "connect_args": connect_args,
        }
        if os.getenv("NOCTURNE_DISABLE_DB_POOL") == "1":
            engine_kwargs["poolclass"] = NullPool
        else:
            engine_kwargs.update(
                {
                    "pool_size": 10,
                    "max_overflow": 20,
                    "pool_recycle": 3600,
                    "pool_pre_ping": True,
                }
            )

        self.engine = create_async_engine(self.database_url, **engine_kwargs)

        self.async_session = async_sessionmaker(
            self.engine, class_=AsyncSession, expire_on_commit=False
        )

    @staticmethod
    def _normalize_database_url(url: str) -> str:
        normalized = (url or "").strip()
        if normalized.startswith("postgresql+asyncpg://"):
            return normalized
        if normalized.startswith("postgresql://"):
            return "postgresql+asyncpg://" + normalized[len("postgresql://"):]
        if normalized.startswith("postgres://"):
            return "postgresql+asyncpg://" + normalized[len("postgres://"):]
        if normalized.startswith("postgresql+"):
            driver_split = normalized.split("://", 1)
            if len(driver_split) == 2:
                return "postgresql+asyncpg://" + driver_split[1]
        return normalized

    @staticmethod
    def _detect_database_type(url: str) -> str:
        if "postgresql" not in url:
            raise ValueError(
                "Nocturne is now PostgreSQL-only. "
                "Set DATABASE_URL to a PostgreSQL DSN, for example: "
                "postgresql+asyncpg://user:password@host:5432/nocturne"
            )
        return "postgresql"

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
        from sqlalchemy import inspect as sa_inspect, text as sa_text

        project_root = _os.path.abspath(
            _os.path.join(_os.path.dirname(__file__), "..", "..")
        )
        if project_root not in _sys.path:
            _sys.path.insert(0, project_root)

        from db.migrations.runner import run_migrations

        try:
            def check_initialized(connection):
                return sa_inspect(connection).has_table("memories")

            async with self.engine.begin() as conn:
                await conn.execute(sa_text("CREATE EXTENSION IF NOT EXISTS vector"))
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
                f"  - Ensure the target database user can CREATE EXTENSION vector\n"
                f"  - Ensure the host is reachable and the password has no unescaped special characters (& * # etc.)"
            ) from e

    async def close(self):
        """Close the database connection."""
        await self.engine.dispose()
