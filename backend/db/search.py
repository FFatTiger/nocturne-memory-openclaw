# pyright: reportArgumentType=false, reportAttributeAccessIssue=false, reportCallIssue=false, reportOperatorIssue=false

"""
FTS Search Indexer and Query Engine for Nocturne Memory System.

Maintains derived search rows (search_documents) and provides PostgreSQL
full-text search across the memory graph.
"""

from typing import Optional, Dict, Any, List, TYPE_CHECKING

from sqlalchemy import select, delete, text, or_
from sqlalchemy.ext.asyncio import AsyncSession

from .models import (
    Memory,
    Edge,
    Path,
    GlossaryKeyword,
    SearchDocument,
    escape_like_literal,
)
from .search_terms import build_document_search_terms, expand_query_terms

if TYPE_CHECKING:
    from .database import DatabaseManager


class SearchIndexer:
    """FTS index maintenance and query engine for PostgreSQL."""

    def __init__(self, db: "DatabaseManager"):
        self._session = db.session
        self._optional_session = db._optional_session
        self.db_type = db.db_type

    @staticmethod
    def _format_search_snippet(content: str, query: str) -> str:
        """Build a short content snippet around the first literal hit or token hit."""
        if not content:
            return ""

        content_lower = content.lower()
        query_lower = query.lower()

        pos = content_lower.find(query_lower)
        match_len = len(query)

        if pos < 0:
            tokens = expand_query_terms(query).split()
            for token in tokens:
                if not token:
                    continue
                pos = content_lower.find(token.lower())
                if pos >= 0:
                    match_len = len(token)
                    break

        if pos < 0:
            fallback = content[:80]
            return fallback + ("..." if len(content) > 80 else "")

        start = max(0, pos - 30)
        end = min(len(content), pos + match_len + 30)
        prefix = "..." if start > 0 else ""
        suffix = "..." if end < len(content) else ""
        return prefix + content[start:end] + suffix

    async def _build_search_documents_for_node(
        self, session: AsyncSession, node_uuid: str
    ) -> List[Dict[str, Any]]:
        """Materialize search rows for every reachable path of a node."""
        memory = (
            await session.execute(
                select(Memory)
                .where(Memory.node_uuid == node_uuid, Memory.deprecated == False)
                .limit(1)
            )
        ).scalar_one_or_none()
        if not memory:
            return []

        path_rows = (
            await session.execute(
                select(Path.domain, Path.path, Edge.priority, Edge.disclosure)
                .select_from(Path)
                .join(Edge, Path.edge_id == Edge.id)
                .where(Edge.child_uuid == node_uuid)
                .order_by(Path.domain, Path.path)
            )
        ).all()
        if not path_rows:
            return []

        keyword_rows = await session.execute(
            select(GlossaryKeyword.keyword)
            .where(GlossaryKeyword.node_uuid == node_uuid)
            .order_by(GlossaryKeyword.keyword)
        )
        glossary_text = " ".join(row[0] for row in keyword_rows if row[0])

        documents = []
        for row in path_rows:
            uri = f"{row.domain}://{row.path}"
            documents.append(
                {
                    "domain": row.domain,
                    "path": row.path,
                    "node_uuid": node_uuid,
                    "memory_id": memory.id,
                    "uri": uri,
                    "content": memory.content,
                    "disclosure": row.disclosure,
                    "search_terms": build_document_search_terms(
                        row.path,
                        uri,
                        memory.content,
                        row.disclosure,
                        glossary_text,
                    ),
                    "priority": row.priority,
                }
            )
        return documents

    async def _delete_search_documents_for_node(
        self, session: AsyncSession, node_uuid: str
    ) -> None:
        """Remove all derived search rows for a node."""
        await session.execute(
            delete(SearchDocument).where(SearchDocument.node_uuid == node_uuid)
        )

    async def _insert_search_documents(
        self, session: AsyncSession, documents: List[Dict[str, Any]]
    ) -> None:
        """Insert fresh derived search rows for one node."""
        if not documents:
            return

        session.add_all(SearchDocument(**doc) for doc in documents)
        await session.flush()

    async def refresh_search_documents_for_node(
        self, node_uuid: str, session: Optional[AsyncSession] = None
    ) -> None:
        """Rebuild derived search rows for one node."""
        async with self._optional_session(session) as session:
            documents = await self._build_search_documents_for_node(session, node_uuid)
            await self._delete_search_documents_for_node(session, node_uuid)
            await self._insert_search_documents(session, documents)

    async def get_node_uuids_for_prefix(
        self, session: AsyncSession, domain: str, base_path: str
    ) -> List[str]:
        """Collect unique node UUIDs for a path and all descendants."""
        safe = escape_like_literal(base_path)
        result = await session.execute(
            select(Edge.child_uuid)
            .select_from(Path)
            .join(Edge, Path.edge_id == Edge.id)
            .where(Path.domain == domain)
            .where(
                or_(
                    Path.path == base_path,
                    Path.path.like(f"{safe}/%", escape="\\"),
                )
            )
            .distinct()
        )
        return [row[0] for row in result.all()]

    async def rebuild_all_search_documents(
        self, session: Optional[AsyncSession] = None
    ) -> None:
        """Fully rebuild the derived search index from live graph state."""
        async with self._optional_session(session) as session:
            await session.execute(delete(SearchDocument))

            result = await session.execute(
                select(Edge.child_uuid)
                .select_from(Path)
                .join(Edge, Path.edge_id == Edge.id)
                .distinct()
            )
            for (node_uuid,) in result.all():
                documents = await self._build_search_documents_for_node(session, node_uuid)
                await self._insert_search_documents(session, documents)

    async def search(
        self, query: str, limit: int = 10, domain: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """Search memories by path and content using PostgreSQL full-text search."""
        async with self._session() as session:
            candidate_limit = max(limit * 5, 50)
            normalized = expand_query_terms(query)
            if not normalized:
                return []

            params = {
                "candidate_limit": candidate_limit,
                "ts_query": normalized,
            }
            domain_clause = ""
            if domain is not None:
                params["domain"] = domain
                domain_clause = "AND sd.domain = :domain"

            result = await session.execute(
                text(
                    f"""
                    SELECT
                        sd.domain,
                        sd.path,
                        sd.node_uuid,
                        sd.uri,
                        sd.priority,
                        sd.content,
                        sd.disclosure,
                        ts_rank_cd(
                            to_tsvector(
                                'simple',
                                coalesce(sd.path, '') || ' ' ||
                                coalesce(sd.uri, '') || ' ' ||
                                coalesce(sd.content, '') || ' ' ||
                                coalesce(sd.disclosure, '') || ' ' ||
                                coalesce(sd.search_terms, '')
                            ),
                            websearch_to_tsquery('simple', :ts_query)
                        ) AS score
                    FROM search_documents AS sd
                    WHERE to_tsvector(
                            'simple',
                            coalesce(sd.path, '') || ' ' ||
                            coalesce(sd.uri, '') || ' ' ||
                            coalesce(sd.content, '') || ' ' ||
                            coalesce(sd.disclosure, '') || ' ' ||
                            coalesce(sd.search_terms, '')
                          ) @@ websearch_to_tsquery('simple', :ts_query)
                      {domain_clause}
                    ORDER BY score DESC, sd.priority ASC, char_length(sd.path) ASC
                    LIMIT :candidate_limit
                    """
                ),
                params,
            )

            matches = []
            seen_nodes = set()

            for row in result.mappings():
                if row["node_uuid"] in seen_nodes:
                    continue
                seen_nodes.add(row["node_uuid"])
                matches.append(
                    {
                        "domain": row["domain"],
                        "path": row["path"],
                        "uri": row["uri"],
                        "name": row["path"].rsplit("/", 1)[-1],
                        "snippet": self._format_search_snippet(row["content"], query),
                        "priority": row["priority"],
                        "disclosure": row["disclosure"],
                    }
                )
                if len(matches) >= limit:
                    break

            return matches
