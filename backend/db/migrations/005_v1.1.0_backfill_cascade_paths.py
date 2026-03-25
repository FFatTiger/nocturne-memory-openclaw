from typing import Optional, Set
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession, AsyncEngine
from ..models import Edge, Path


async def up(engine: AsyncEngine):
    """
    Version: v1.1.0
    Backfill missing cascade sub-paths.

    After v1.1.0 introduced cascade logic in add_path, any path whose node
    has child edges must also have sub-paths for every descendant.  Legacy
    data created before the cascade feature may be missing these sub-paths.
    This migration fills the gaps.
    """
    async with AsyncSession(engine, expire_on_commit=False) as session:
        all_paths = (await session.execute(
            select(Path, Edge)
            .join(Edge, Path.edge_id == Edge.id)
        )).all()

        if not all_paths:
            await session.commit()
            return

        created = 0
        for path_obj, edge in all_paths:
            created += await _ensure_descendants(
                session, edge.child_uuid, path_obj.domain, path_obj.path
            )

        if created > 0:
            await session.commit()


async def _ensure_descendants(
    session: AsyncSession,
    node_uuid: str,
    domain: str,
    base_path: str,
    visited: Optional[Set[str]] = None,
) -> int:
    """Recursively ensure sub-paths exist for all descendants of a node."""
    if visited is None:
        visited = set()

    if node_uuid in visited:
        return 0

    visited.add(node_uuid)
    try:
        result = await session.execute(
            select(Edge).where(Edge.parent_uuid == node_uuid)
        )
        child_edges = result.scalars().all()

        created = 0
        for child_edge in child_edges:
            child_path = f"{base_path}/{child_edge.name}"

            existing = await session.execute(
                select(func.count())
                .select_from(Path)
                .where(Path.domain == domain)
                .where(Path.path == child_path)
            )
            if existing.scalar() == 0:
                session.add(
                    Path(domain=domain, path=child_path, edge_id=child_edge.id)
                )
                created += 1

            created += await _ensure_descendants(
                session, child_edge.child_uuid, domain, child_path, visited
            )

        return created
    finally:
        visited.remove(node_uuid)
