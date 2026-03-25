from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine
from sqlalchemy import inspect as sa_inspect

async def up(engine: AsyncEngine):
    """
    Version: v1.1.0 (Fix)
    Recreates the paths table to drop legacy columns (memory_id, priority, disclosure)
    and their associated NOT NULL / FOREIGN KEY constraints.
    """
    def check_memory_id(connection):
        inspector = sa_inspect(connection)
        return "memory_id" in [col["name"] for col in inspector.get_columns("paths")]

    async with engine.begin() as conn:
        has_mem_id = await conn.run_sync(check_memory_id)
        if has_mem_id:
            # 1. Create new table without the legacy columns
            # Detect dialect for cross-DB compatibility
            is_postgres = "postgresql" in str(engine.url)
            timestamp_type = "TIMESTAMP" if is_postgres else "DATETIME"
            
            # 1. Create new table without the legacy columns
            await conn.execute(text(f"""
                CREATE TABLE paths_new (
                    domain VARCHAR(64) DEFAULT 'core',
                    path VARCHAR(512),
                    edge_id INTEGER REFERENCES edges(id),
                    created_at {timestamp_type} DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (domain, path)
                )
            """))
            # 2. Copy data
            await conn.execute(text("""
                INSERT INTO paths_new (domain, path, edge_id, created_at)
                SELECT domain, path, edge_id, created_at FROM paths
            """))
            # 3. Drop old table
            await conn.execute(text("DROP TABLE paths"))
            # 4. Rename new table
            await conn.execute(text("ALTER TABLE paths_new RENAME TO paths"))
