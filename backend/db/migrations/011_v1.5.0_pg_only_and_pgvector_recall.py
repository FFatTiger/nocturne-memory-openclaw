import logging
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

logger = logging.getLogger(__name__)


async def up(engine: AsyncEngine):
    """
    Version: v1.5.0
    Make Nocturne PostgreSQL-only and move recall embeddings into pgvector.
    """
    async with engine.begin() as conn:
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))

        await conn.execute(
            text(
                """
                ALTER TABLE recall_documents
                ADD COLUMN IF NOT EXISTS embedding_vector VECTOR
                """
            )
        )

        has_embedding_json = bool(
            (
                await conn.execute(
                    text(
                        """
                        SELECT 1
                        FROM information_schema.columns
                        WHERE table_name = 'recall_documents'
                          AND column_name = 'embedding_json'
                        LIMIT 1
                        """
                    )
                )
            ).scalar()
        )

        if has_embedding_json:
            await conn.execute(
                text(
                    """
                    UPDATE recall_documents
                    SET embedding_vector = CAST(embedding_json AS vector)
                    WHERE embedding_vector IS NULL
                      AND embedding_json IS NOT NULL
                      AND btrim(embedding_json) <> ''
                    """
                )
            )

        await conn.execute(
            text(
                """
                ALTER TABLE recall_documents
                ALTER COLUMN embedding_vector SET NOT NULL
                """
            )
        )

        await conn.execute(
            text("DROP INDEX IF EXISTS idx_recall_documents_signature")
        )
        await conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS idx_recall_documents_signature ON recall_documents(source_signature)"
            )
        )
        await conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS idx_recall_documents_model ON recall_documents(embedding_model)"
            )
        )
        await conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS idx_recall_documents_model_priority ON recall_documents(embedding_model, priority)"
            )
        )

        await conn.execute(
            text(
                """
                ALTER TABLE recall_documents
                DROP COLUMN IF EXISTS embedding_json
                """
            )
        )

        await conn.execute(text("DROP TABLE IF EXISTS search_documents_fts"))

    logger.info("Migration 011: enabled pgvector recall storage and removed sqlite-only leftovers")
