from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine
from sqlalchemy import inspect as sa_inspect

async def up(engine: AsyncEngine):
    """
    Version: v1.0.0 (from v0.9.0-legacy)
    Add migrated_to column to memories table for version-chain tracking.
    """
    def check_col(connection):
        inspector = sa_inspect(connection)
        columns = [col["name"] for col in inspector.get_columns("memories")]
        return "migrated_to" in columns

    async with engine.begin() as conn:
        has_col = await conn.run_sync(check_col)
        if not has_col:
            await conn.execute(text("ALTER TABLE memories ADD COLUMN migrated_to INTEGER"))
