import logging
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from db.search_terms import build_document_search_terms

logger = logging.getLogger(__name__)

async def up(engine: AsyncEngine):
    """
    Version: v1.3.0
    Add derived full-text search documents and backfill them from live graph data.
    """
    is_postgres = "postgresql" in str(engine.url)
    false_val = "FALSE" if is_postgres else "0"
    search_text_expr = (
        "coalesce(path, '') || ' ' || "
        "coalesce(uri, '') || ' ' || "
        "coalesce(content, '') || ' ' || "
        "coalesce(disclosure, '') || ' ' || "
        "coalesce(search_terms, '')"
    )
    keyword_agg = (
        "COALESCE((SELECT string_agg(keyword, ' ') FROM glossary_keywords g "
        "WHERE g.node_uuid = e.child_uuid), '')"
        if is_postgres
        else "COALESCE((SELECT group_concat(keyword, ' ') FROM glossary_keywords g "
        "WHERE g.node_uuid = e.child_uuid), '')"
    )

    async with engine.begin() as conn:
        await conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS search_documents (
                    domain VARCHAR(64) NOT NULL,
                    path VARCHAR(512) NOT NULL,
                    node_uuid VARCHAR(36) NOT NULL REFERENCES nodes(uuid) ON DELETE CASCADE,
                    memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
                    uri TEXT NOT NULL,
                    content TEXT NOT NULL,
                    disclosure TEXT,
                    search_terms TEXT NOT NULL DEFAULT '',
                    priority INTEGER NOT NULL DEFAULT 0,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (domain, path)
                )
                """
            )
        )
        await conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS idx_search_documents_node_uuid "
                "ON search_documents(node_uuid)"
            )
        )
        await conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS idx_search_documents_memory_id "
                "ON search_documents(memory_id)"
            )
        )
        await conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS idx_search_documents_domain "
                "ON search_documents(domain)"
            )
        )

        if is_postgres:
            await conn.execute(
                text(
                    f"""
                    CREATE INDEX IF NOT EXISTS idx_search_documents_fts
                    ON search_documents
                    USING GIN (
                        to_tsvector('simple', {search_text_expr})
                    )
                    """
                )
            )
        else:
            await conn.execute(
                text(
                    """
                    CREATE VIRTUAL TABLE IF NOT EXISTS search_documents_fts
                    USING fts5(
                        domain UNINDEXED,
                        path,
                        node_uuid UNINDEXED,
                        uri,
                        content,
                        disclosure,
                        search_terms,
                        tokenize = 'unicode61'
                    )
                    """
                )
            )

        await conn.execute(text("DELETE FROM search_documents"))
        if not is_postgres:
            await conn.execute(text("DELETE FROM search_documents_fts"))

        raw_rows = (
            await conn.execute(
                text(
                    f"""
                    SELECT
                        p.domain,
                        p.path,
                        e.child_uuid as node_uuid,
                        m.id as memory_id,
                        p.domain || '://' || p.path as uri,
                        m.content,
                        e.disclosure,
                        {keyword_agg} as glossary_text,
                        e.priority
                    FROM paths p
                    JOIN edges e ON p.edge_id = e.id
                    JOIN memories m
                      ON m.node_uuid = e.child_uuid
                     AND m.deprecated = {false_val}
                    """
                )
            )
        ).mappings().all()

        for row in raw_rows:
            search_terms = build_document_search_terms(
                row["path"],
                row["uri"],
                row["content"],
                row["disclosure"],
                row["glossary_text"] or "",
            )
            await conn.execute(
                text(
                    """
                    INSERT INTO search_documents (
                        domain, path, node_uuid, memory_id, uri, content, disclosure, search_terms, priority
                    ) VALUES (
                        :domain, :path, :node_uuid, :memory_id, :uri, :content, :disclosure, :search_terms, :priority
                    )
                    """
                ),
                {
                    "domain": row["domain"],
                    "path": row["path"],
                    "node_uuid": row["node_uuid"],
                    "memory_id": row["memory_id"],
                    "uri": row["uri"],
                    "content": row["content"],
                    "disclosure": row["disclosure"],
                    "search_terms": search_terms,
                    "priority": row["priority"],
                }
            )

        if not is_postgres:
            await conn.execute(
                text(
                    """
                    INSERT INTO search_documents_fts (
                        domain,
                        path,
                        node_uuid,
                        uri,
                        content,
                        disclosure,
                        search_terms
                    )
                    SELECT
                        domain,
                        path,
                        node_uuid,
                        uri,
                        content,
                        coalesce(disclosure, ''),
                        search_terms
                    FROM search_documents
                    """
                )
            )

    logger.info("Migration 009: created and backfilled search_documents FTS index with jieba tokenization")
