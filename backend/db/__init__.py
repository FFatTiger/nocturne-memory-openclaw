"""
Nocturne Memory — DB package public API.

Provides per-service getters instead of a single god-object.
Services are lazily constructed on first access and share a
single DatabaseManager instance.
"""

import os
from typing import Optional, TYPE_CHECKING

from dotenv import load_dotenv, find_dotenv

from .database import DatabaseManager
from .snapshot import ChangesetStore, get_changeset_store
from .models import (
    Base, ROOT_NODE_UUID, Node, Memory, Edge, Path,
    GlossaryKeyword, SearchDocument, RecallDocument, SessionReadNode, ChangeCollector,
)

if TYPE_CHECKING:
    from .graph import GraphService
    from .search import SearchIndexer
    from .glossary import GlossaryService
    from .recall import RecallService

_dotenv_path = find_dotenv(usecwd=True)
if _dotenv_path:
    load_dotenv(_dotenv_path)

_db_manager: Optional[DatabaseManager] = None
_graph_service: Optional["GraphService"] = None
_search_indexer: Optional["SearchIndexer"] = None
_glossary_service: Optional["GlossaryService"] = None
_recall_service: Optional["RecallService"] = None


def _ensure_initialized():
    global _db_manager, _graph_service, _search_indexer, _glossary_service, _recall_service
    if _db_manager is not None:
        return

    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        raise ValueError(
            "DATABASE_URL environment variable is not set. "
            "Please check your .env file."
        )

    from .search import SearchIndexer
    from .glossary import GlossaryService
    from .graph import GraphService
    from .recall import RecallService

    _db_manager = DatabaseManager(database_url)
    _search_indexer = SearchIndexer(_db_manager)
    _glossary_service = GlossaryService(_db_manager, _search_indexer)
    _graph_service = GraphService(_db_manager, _search_indexer)
    _recall_service = RecallService(_db_manager)


def get_db_manager() -> DatabaseManager:
    _ensure_initialized()
    return _db_manager  # type: ignore[return-value]


def get_graph_service() -> "GraphService":
    _ensure_initialized()
    return _graph_service  # type: ignore[return-value]


def get_search_indexer() -> "SearchIndexer":
    _ensure_initialized()
    return _search_indexer  # type: ignore[return-value]


def get_glossary_service() -> "GlossaryService":
    _ensure_initialized()
    return _glossary_service  # type: ignore[return-value]


def get_recall_service() -> "RecallService":
    _ensure_initialized()
    return _recall_service  # type: ignore[return-value]


async def close_db():
    """Tear down all services and close the database connection."""
    global _db_manager, _graph_service, _search_indexer, _glossary_service, _recall_service
    if _db_manager:
        await _db_manager.close()
    _db_manager = None
    _graph_service = None
    _search_indexer = None
    _glossary_service = None
    _recall_service = None


__all__ = [
    "DatabaseManager",
    "get_db_manager", "get_graph_service",
    "get_search_indexer", "get_glossary_service", "get_recall_service",
    "close_db",
    "ChangesetStore", "get_changeset_store",
    "Base", "ROOT_NODE_UUID", "Node", "Memory", "Edge", "Path",
    "GlossaryKeyword", "SearchDocument", "RecallDocument", "SessionReadNode", "ChangeCollector",
]
