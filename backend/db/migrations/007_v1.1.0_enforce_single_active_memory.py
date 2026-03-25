import logging
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

logger = logging.getLogger(__name__)


async def up(engine: AsyncEngine):
    """
    Version: v1.1.0
    Enforce "at most one active memory per node_uuid".

    Steps:
    1) Repair existing data with duplicate active rows by keeping the latest
       active memory (created_at DESC, id DESC) and deprecating the rest.
    2) Create a partial unique index to enforce the rule in DB.
    """
    async with engine.begin() as conn:
        # Detect dialect for cross-DB compatibility
        is_postgres = "postgresql" in str(engine.url)
        true_val = "TRUE" if is_postgres else "1"
        false_val = "FALSE" if is_postgres else "0"
        
        dup_nodes_result = await conn.execute(
            text(
                f"""
                SELECT node_uuid
                FROM memories
                WHERE deprecated = {false_val}
                  AND node_uuid IS NOT NULL
                GROUP BY node_uuid
                HAVING COUNT(*) > 1
                """
            )
        )
        dup_nodes = [row[0] for row in dup_nodes_result.fetchall()]

        fixed_nodes = 0
        fixed_rows = 0

        for node_uuid in dup_nodes:
            active_result = await conn.execute(
                text(
                    f"""
                    SELECT id
                    FROM memories
                    WHERE node_uuid = :node_uuid
                      AND deprecated = {false_val}
                    ORDER BY created_at DESC, id DESC
                    """
                ),
                {"node_uuid": node_uuid},
            )
            active_ids = [row[0] for row in active_result.fetchall()]
            if len(active_ids) <= 1:
                continue

            keep_id = active_ids[0]
            for memory_id in active_ids[1:]:
                update_result = await conn.execute(
                    text(
                        f"""
                        UPDATE memories
                        SET deprecated = {true_val},
                            migrated_to = COALESCE(migrated_to, :keep_id)
                        WHERE id = :memory_id
                        """
                    ),
                    {"keep_id": keep_id, "memory_id": memory_id},
                )
                fixed_rows += update_result.rowcount or 0

            fixed_nodes += 1

        if fixed_nodes > 0:
            logger.info(
                "Migration 007: repaired %d nodes with duplicate active memories; "
                "deprecated %d rows",
                fixed_nodes,
                fixed_rows,
            )

        await conn.execute(
            text(
                f"""
                CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_active_memory
                ON memories(node_uuid)
                WHERE deprecated = {false_val} AND node_uuid IS NOT NULL
                """
            )
        )

        logger.info(
            "Migration 007: ensured unique partial index "
            "'idx_unique_active_memory' on memories(node_uuid) for active rows"
        )
