import logging
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

logger = logging.getLogger(__name__)


async def up(engine: AsyncEngine):
    """
    Version: v1.4.0
    Add semantic recall documents and per-session read tracking.
    """
    async with engine.begin() as conn:
        await conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS recall_documents (
                    domain VARCHAR(64) NOT NULL,
                    path VARCHAR(512) NOT NULL,
                    node_uuid VARCHAR(36) NOT NULL REFERENCES nodes(uuid) ON DELETE CASCADE,
                    memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
                    uri TEXT NOT NULL,
                    name VARCHAR(256) NOT NULL DEFAULT '',
                    priority INTEGER NOT NULL DEFAULT 0,
                    disclosure TEXT,
                    glossary_json TEXT NOT NULL DEFAULT '[]',
                    cue_text TEXT NOT NULL DEFAULT '',
                    body_preview TEXT NOT NULL DEFAULT '',
                    embedding_text TEXT NOT NULL,
                    embedding_model VARCHAR(128) NOT NULL,
                    embedding_dim INTEGER NOT NULL DEFAULT 0,
                    embedding_json TEXT NOT NULL,
                    source_signature VARCHAR(64) NOT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (domain, path)
                )
                """
            )
        )
        await conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS idx_recall_documents_node_uuid ON recall_documents(node_uuid)"
            )
        )
        await conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS idx_recall_documents_model ON recall_documents(embedding_model)"
            )
        )
        await conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS idx_recall_documents_signature ON recall_documents(source_signature)"
            )
        )

        await conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS session_read_nodes (
                    session_id VARCHAR(128) NOT NULL,
                    uri TEXT NOT NULL,
                    node_uuid VARCHAR(36) NOT NULL REFERENCES nodes(uuid) ON DELETE CASCADE,
                    session_key VARCHAR(512),
                    source VARCHAR(64),
                    read_count INTEGER NOT NULL DEFAULT 1,
                    first_read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    last_read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (session_id, uri)
                )
                """
            )
        )
        await conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS idx_session_read_nodes_node_uuid ON session_read_nodes(node_uuid)"
            )
        )
        await conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS idx_session_read_nodes_session_key ON session_read_nodes(session_key)"
            )
        )

    logger.info("Migration 010: created recall_documents and session_read_nodes")
