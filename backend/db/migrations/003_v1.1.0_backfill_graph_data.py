import uuid as uuid_lib
from typing import Dict
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, AsyncEngine
from sqlalchemy import inspect as sa_inspect
from ..models import Node, Memory, Edge, ROOT_NODE_UUID

async def up(engine: AsyncEngine):
    """
    Version: v1.1.0 (from v1.0.4)
    Backfill: populate nodes/edges from legacy flat data and link to graph schema.
    Migrates memory_id/priority/disclosure from paths into edges.
    Safe to call repeatedly — skips if already migrated or if no old data exists.
    """
    def has_old_schema_column(connection):
        inspector = sa_inspect(connection)
        columns = [col["name"] for col in inspector.get_columns("paths")]
        return "memory_id" in columns

    async with engine.connect() as conn:
        has_old_schema = await conn.run_sync(has_old_schema_column)

    # Use expire_on_commit=False to keep objects accessible after flush/commit
    async with AsyncSession(engine, expire_on_commit=False) as session:
        # Always ensure root node exists
        root = await session.execute(
            select(Node).where(Node.uuid == ROOT_NODE_UUID)
        )
        if not root.scalar_one_or_none():
            session.add(Node(uuid=ROOT_NODE_UUID))
            await session.flush()

        if not has_old_schema:
            await session.commit()
            return  # Brand-new DB, no legacy data

        # ---- Phase 1: assign node_uuid to memories ----
        all_mems_result = await session.execute(select(Memory))
        all_memories = all_mems_result.scalars().all()

        if not all_memories:
            await session.commit()
            return

        # Build version-chain maps
        bwd: Dict[int, int] = {}  # id → predecessor id
        for m in all_memories:
            if m.migrated_to is not None:
                bwd[m.migrated_to] = m.id

        def find_chain_root(mem_id: int) -> int:
            visited = set()
            cur = mem_id
            while cur in bwd and cur not in visited:
                visited.add(cur)
                cur = bwd[cur]
            return cur

        mem_to_node: Dict[int, str] = {}
        chain_uuid: Dict[int, str] = {}
        chain_existing_uuid: Dict[int, str] = {}

        for m in all_memories:
            if m.node_uuid:
                chain_root = find_chain_root(m.id)
                chain_existing_uuid.setdefault(chain_root, m.node_uuid)

        for m in all_memories:
            if m.node_uuid:
                mem_to_node[m.id] = m.node_uuid
                continue

            root_id = find_chain_root(m.id)
            if root_id not in chain_uuid:
                chosen_uuid = chain_existing_uuid.get(root_id) or str(uuid_lib.uuid4())
                chain_uuid[root_id] = chosen_uuid
                existing_node = await session.execute(
                    select(Node).where(Node.uuid == chosen_uuid)
                )
                if not existing_node.scalar_one_or_none():
                    session.add(Node(uuid=chosen_uuid))

            node_uuid = chain_uuid[root_id]
            m.node_uuid = node_uuid
            mem_to_node[m.id] = node_uuid
            session.add(m)

        await session.flush()

        # ---- Phase 2: create edges from old paths ----
        path_rows = await session.execute(
            text(
                "SELECT domain, path, memory_id, priority, disclosure "
                "FROM paths WHERE memory_id IS NOT NULL"
            )
        )
        old_paths = path_rows.fetchall()

        if not old_paths:
            await session.commit()
            return

        # Sort by depth (shallowest first) so parents are processed first
        sorted_paths = sorted(old_paths, key=lambda r: r[1].count("/"))

        # Pre-build a lookup: (domain, path) → memory_id from old data
        old_path_lookup: Dict[tuple, int] = {}
        for row in old_paths:
            old_path_lookup[(row[0], row[1])] = row[2]

        edge_cache: Dict[tuple, int] = {}  # (parent_uuid, child_uuid) → edge_id
        path_to_edge: Dict[tuple, int] = {}  # (domain, path_str) → edge_id

        for row in sorted_paths:
            p_domain, p_path, p_memory_id, p_priority, p_disclosure = row

            child_uuid = mem_to_node.get(p_memory_id)
            if not child_uuid:
                continue

            # Determine parent
            if "/" in p_path:
                parent_path_str = p_path.rsplit("/", 1)[0]
                parent_mem_id = old_path_lookup.get((p_domain, parent_path_str))
                if parent_mem_id and parent_mem_id in mem_to_node:
                    parent_uuid = mem_to_node[parent_mem_id]
                else:
                    parent_uuid = ROOT_NODE_UUID
            else:
                parent_uuid = ROOT_NODE_UUID

            edge_key = (parent_uuid, child_uuid)
            edge_name = p_path.rsplit("/", 1)[-1]

            if edge_key not in edge_cache:
                # Check DB in case of partial previous run
                existing_edge = await session.execute(
                    select(Edge).where(
                        Edge.parent_uuid == parent_uuid,
                        Edge.child_uuid == child_uuid,
                    )
                )
                edge = existing_edge.scalar_one_or_none()
                if edge:
                    edge_cache[edge_key] = edge.id
                else:
                    edge = Edge(
                        parent_uuid=parent_uuid,
                        child_uuid=child_uuid,
                        name=edge_name,
                        priority=p_priority or 0,
                        disclosure=p_disclosure,
                    )
                    session.add(edge)
                    await session.flush()
                    edge_cache[edge_key] = edge.id

            path_to_edge[(p_domain, p_path)] = edge_cache[edge_key]

        # ---- Phase 3: update paths with edge_id ----
        for (p_domain, p_path), edge_id in path_to_edge.items():
            await session.execute(
                text(
                    "UPDATE paths SET edge_id = :edge_id "
                    "WHERE domain = :domain AND path = :path"
                ),
                {"edge_id": edge_id, "domain": p_domain, "path": p_path},
            )
            
        await session.commit()
