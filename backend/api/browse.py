"""
Browse API - Clean URI-based memory navigation

This replaces the old Entity/Relation/Chapter conceptual split with a simple
hierarchical browser. Every path is just a node with content and children.
"""

import re
from typing import Optional, List, Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field
from db import get_graph_service, get_glossary_service, get_search_indexer, get_db_manager, get_recall_service
from db.models import Path as PathModel, Edge as EdgeModel, ROOT_NODE_UUID
from sqlalchemy import select

router = APIRouter(prefix="/browse", tags=["browse"])


class NodeUpdate(BaseModel):
    content: str | None = None
    priority: int | None = None
    disclosure: str | None = None


class GlossaryAdd(BaseModel):
    keyword: str
    node_uuid: str


class GlossaryRemove(BaseModel):
    keyword: str
    node_uuid: str


class RecallEmbeddingConfigBody(BaseModel):
    base_url: str
    api_key: str
    model: str
    timeout_ms: int = Field(default=45000, ge=1000, le=300000)


class RecallQueryBody(BaseModel):
    query: str
    embedding: RecallEmbeddingConfigBody
    limit: int = Field(default=12, ge=1, le=100)
    min_score: float = 0.0
    max_display_items: int = Field(default=3, ge=1, le=10)
    min_display_score: float = 0.45
    score_precision: int = Field(default=2, ge=0, le=4)
    exclude_boot_from_results: bool = True
    session_id: str | None = None
    read_node_display_mode: Literal["soft", "hard"] = "soft"


class SessionReadMarkBody(BaseModel):
    session_id: str
    uri: str
    node_uuid: str | None = None
    session_key: str | None = None
    source: str = "tool:get_node"


@router.get("/domains")
async def list_domains():
    """Return all domains that contain at least one root-level path."""
    from sqlalchemy import func, distinct

    db = get_db_manager()
    async with db.session() as session:
        result = await session.execute(
            select(
                PathModel.domain,
                func.count(distinct(PathModel.path)).label("node_count"),
            )
            .where(~PathModel.path.contains("/"))
            .group_by(PathModel.domain)
            .order_by(PathModel.domain)
        )
        return [
            {"domain": row.domain, "root_count": row.node_count}
            for row in result.all()
        ]


@router.get("/node")
async def get_node(
    path: str = Query("", description="URI path like 'nocturne' or 'nocturne/salem'"),
    domain: str = Query("core"),
    nav_only: bool = Query(False, description="Skip expensive processing if only navigating tree")
):
    """
    Get a node's content and its direct children.
    
    This is the only read endpoint you need - it gives you:
    - The current node's full content (or virtual root)
    - Preview of all children (next level)
    - Breadcrumb trail for navigation
    """
    graph = get_graph_service()
    
    if not path:
        # Check if there is an actual memory stored at the root path
        memory = await graph.get_memory_by_path("", domain=domain)
        
        children_raw = await graph.get_children(
            ROOT_NODE_UUID,
            context_domain=domain,
            context_path=path,
        )
        
        if memory:
            # Hide the actual root node from the root directory listing.
            children_raw = [
                c for c in children_raw
                if c.get("node_uuid") != memory["node_uuid"]
            ]
        else:
            # Virtual Root Node
            memory = {
                "content": "",
                "priority": 0,
                "disclosure": None,
                "created_at": None,
                "node_uuid": ROOT_NODE_UUID,
            }
            
        breadcrumbs = [{"path": "", "label": "root"}]
    else:
        # Get the node itself
        memory = await graph.get_memory_by_path(path, domain=domain)
        
        if not memory:
            raise HTTPException(status_code=404, detail=f"Path not found: {domain}://{path}")
        
        children_raw = await graph.get_children(
            memory["node_uuid"],
            context_domain=domain,
            context_path=path,
        )
        
        # Build breadcrumbs
        segments = path.split("/")
        breadcrumbs = [{"path": "", "label": "root"}]
        accumulated = ""
        for seg in segments:
            accumulated = f"{accumulated}/{seg}" if accumulated else seg
            breadcrumbs.append({"path": accumulated, "label": seg})
    
    children = [
        {
            "domain": c["domain"],
            "path": c["path"],
            "uri": f"{c['domain']}://{c['path']}",
            "name": c["path"].split("/")[-1],  # Last segment
            "priority": c["priority"],
            "disclosure": c.get("disclosure"),
            "content_snippet": c["content_snippet"],
            "approx_children_count": c.get("approx_children_count", 0)
        }
        for c in children_raw
        if c["domain"] == domain
    ]
    children.sort(key=lambda x: (x["priority"] if x["priority"] is not None else 999, x["path"]))
    
    # Get all aliases (other paths pointing to the same node)
    aliases = []
    if memory.get("node_uuid") and memory["node_uuid"] != ROOT_NODE_UUID:
        async with get_db_manager().session() as session:
            result = await session.execute(
                select(PathModel.domain, PathModel.path)
                .select_from(PathModel)
                .join(EdgeModel, PathModel.edge_id == EdgeModel.id)
                .where(EdgeModel.child_uuid == memory["node_uuid"])
            )
            aliases = [
                f"{row[0]}://{row[1]}"
                for row in result.all()
                if not (row[0] == domain and row[1] == path)
            ]
    
    # Get glossary keywords for this node
    glossary_keywords = []
    glossary_matches = []
    node_uuid = memory.get("node_uuid")

    if not nav_only:
        _glossary = get_glossary_service()
        if node_uuid and node_uuid != ROOT_NODE_UUID:
            glossary_keywords = await _glossary.get_glossary_for_node(node_uuid)

        # Get all glossary matches for the node content using Aho-Corasick
        if memory.get("content"):
            matches_dict = await _glossary.find_glossary_in_content(memory["content"])
            if matches_dict:
                glossary_matches = [
                    {"keyword": kw, "nodes": nodes}
                    for kw, nodes in matches_dict.items()
                ]

    return {
        "node": {
            "path": path,
            "domain": domain,
            "uri": f"{domain}://{path}",
            "name": path.split("/")[-1] if path else "root",
            "content": memory["content"],
            "priority": memory["priority"],
            "disclosure": memory["disclosure"],
            "created_at": memory["created_at"],
            "is_virtual": memory.get("node_uuid") == ROOT_NODE_UUID,
            "aliases": aliases,
            "node_uuid": node_uuid,
            "glossary_keywords": glossary_keywords,
            "glossary_matches": glossary_matches,
        },
        "children": children,
        "breadcrumbs": breadcrumbs
    }


@router.put("/node")
async def update_node(
    path: str = Query(...),
    domain: str = Query("core"),
    body: NodeUpdate = ...
):
    """
    Update a node's content.
    """
    graph = get_graph_service()
    
    # Check exists
    memory = await graph.get_memory_by_path(path, domain=domain)
    if not memory:
        raise HTTPException(status_code=404, detail=f"Path not found: {domain}://{path}")
    
    # Update (creates new version if content changed, updates path metadata otherwise)
    try:
        result = await graph.update_memory(
            path=path,
            domain=domain,
            content=body.content,
            priority=body.priority,
            disclosure=body.disclosure,
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    
    return {"success": True, "memory_id": result["new_memory_id"]}


# =============================================================================
# Glossary Endpoints
# =============================================================================


@router.get("/glossary")
async def get_glossary():
    """Get all glossary keywords with their associated nodes."""
    glossary = get_glossary_service()
    raw_entries = await glossary.get_all_glossary()
    
    return {"glossary": raw_entries}


@router.post("/glossary")
async def add_glossary_keyword(body: GlossaryAdd):
    """Bind a keyword to a node."""
    # Human-facing direct edit endpoint: intentionally bypasses changeset/review.
    # The review queue tracks AI-authored mutations only.
    glossary = get_glossary_service()
    try:
        result = await glossary.add_glossary_keyword(body.keyword, body.node_uuid)
        return {"success": True, **result}
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.delete("/glossary")
async def remove_glossary_keyword(body: GlossaryRemove):
    """Remove a keyword binding from a node."""
    # Human-facing direct edit endpoint: intentionally bypasses changeset/review.
    # The review queue tracks AI-authored mutations only.
    glossary = get_glossary_service()
    result = await glossary.remove_glossary_keyword(body.keyword, body.node_uuid)
    if not result.get("success"):
        raise HTTPException(status_code=404, detail="Keyword binding not found")
    return {"success": True}


# =============================================================================
# Create / Delete / Search / Alias / Triggers / Boot
# =============================================================================


class NodeCreate(BaseModel):
    domain: str = "core"
    parent_path: str = ""
    content: str
    priority: int
    title: Optional[str] = None
    disclosure: Optional[str] = None


class AliasCreate(BaseModel):
    new_uri: str
    target_uri: str
    priority: int = 0
    disclosure: Optional[str] = None


class TriggerUpdate(BaseModel):
    uri: str
    add: Optional[List[str]] = None
    remove: Optional[List[str]] = None


def _parse_uri(uri: str) -> tuple:
    """Parse domain://path into (domain, path). Defaults to core domain."""
    uri = uri.strip()
    if "://" in uri:
        domain, path = uri.split("://", 1)
        return (domain.strip().lower(), path.strip("/"))
    return ("core", uri.strip("/"))


@router.post("/node")
async def create_node(body: NodeCreate):
    """Create a new memory node under a parent path."""
    graph = get_graph_service()

    if body.title and not re.match(r"^[a-zA-Z0-9_-]+$", body.title):
        raise HTTPException(status_code=422, detail="Title must only contain alphanumeric characters, underscores, or hyphens.")

    try:
        result = await graph.create_memory(
            parent_path=body.parent_path,
            content=body.content,
            priority=body.priority,
            title=body.title,
            disclosure=body.disclosure,
            domain=body.domain,
        )
        created_uri = result.get("uri", f"{body.domain}://{result['path']}")
        return {"success": True, "uri": created_uri, "path": result["path"]}
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.delete("/node")
async def delete_node(
    path: str = Query(...),
    domain: str = Query("core"),
):
    """Delete a memory node and all its descendants by cutting the URI path."""
    graph = get_graph_service()

    memory = await graph.get_memory_by_path(path, domain=domain)
    if not memory:
        raise HTTPException(status_code=404, detail=f"Path not found: {domain}://{path}")

    try:
        result = await graph.remove_path(path, domain)
        return {"success": True, "deleted_uri": f"{domain}://{path}"}
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.get("/search")
async def search_memories(
    query: str = Query(...),
    domain: Optional[str] = Query(None),
    limit: int = Query(10, ge=1, le=100),
):
    """Search memories by path and content using full-text search."""
    search = get_search_indexer()

    try:
        results = await search.search(query, limit, domain)
        return [
            {
                "uri": r.get("uri", f"{r.get('domain', 'core')}://{r['path']}"),
                "domain": r.get("domain", "core"),
                "path": r["path"],
                "priority": r.get("priority", 0),
                "disclosure": r.get("disclosure"),
                "snippet": r.get("snippet", ""),
            }
            for r in results
        ]
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/recall")
async def recall_memories(body: RecallQueryBody):
    """Hybrid semantic recall over Nocturne nodes with boot/read suppression."""
    recall = get_recall_service()

    try:
        data = await recall.recall(
            query=body.query,
            embedding=body.embedding,
            limit=body.limit,
            min_score=body.min_score,
            max_display_items=body.max_display_items,
            min_display_score=body.min_display_score,
            score_precision=body.score_precision,
            exclude_boot_from_results=body.exclude_boot_from_results,
            session_id=body.session_id,
            read_node_display_mode=body.read_node_display_mode,
        )
        return data
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/recall/rebuild")
async def rebuild_recall_index(body: RecallEmbeddingConfigBody):
    """Force rebuild/refresh of the semantic recall index for the given embedding model."""
    recall = get_recall_service()

    try:
        data = await recall.ensure_index(body)
        return {"success": True, **data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/session/read")
async def mark_session_read(body: SessionReadMarkBody):
    recall = get_recall_service()
    graph = get_graph_service()

    try:
        node_uuid = body.node_uuid
        if not node_uuid:
            domain, path = _parse_uri(body.uri)
            memory = await graph.get_memory_by_path(path, domain)
            if not memory:
                raise HTTPException(status_code=404, detail=f"Memory at '{body.uri}' not found.")
            node_uuid = memory["node_uuid"]

        return await recall.record_read(
            session_id=body.session_id,
            uri=body.uri,
            node_uuid=node_uuid,
            session_key=body.session_key,
            source=body.source,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/session/read")
async def list_session_reads(session_id: str = Query(...)):
    recall = get_recall_service()

    try:
        return await recall.list_session_reads(session_id=session_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/session/read")
async def clear_session_reads(session_id: str = Query(...)):
    recall = get_recall_service()

    try:
        return await recall.clear_session_reads(session_id=session_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/alias")
async def add_alias(body: AliasCreate):
    """Create an alias URI pointing to the same memory as target_uri."""
    graph = get_graph_service()

    new_domain, new_path = _parse_uri(body.new_uri)
    target_domain, target_path = _parse_uri(body.target_uri)

    try:
        result = await graph.add_path(
            new_path=new_path,
            target_path=target_path,
            new_domain=new_domain,
            target_domain=target_domain,
            priority=body.priority,
            disclosure=body.disclosure,
        )
        return {"success": True, "new_uri": result["new_uri"], "target_uri": result["target_uri"]}
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.post("/triggers")
async def manage_triggers(body: TriggerUpdate):
    """Bind or unbind trigger (glossary) words for a memory URI."""
    graph = get_graph_service()
    glossary = get_glossary_service()

    domain, path = _parse_uri(body.uri)

    memory = await graph.get_memory_by_path(path, domain)
    if not memory:
        raise HTTPException(status_code=404, detail=f"Memory at '{domain}://{path}' not found.")

    node_uuid = memory["node_uuid"]

    added = []
    skipped_add = []
    removed = []
    skipped_remove = []

    if body.add:
        for kw in body.add:
            kw = kw.strip()
            if not kw:
                continue
            try:
                await glossary.add_glossary_keyword(kw, node_uuid)
                added.append(kw)
            except ValueError:
                skipped_add.append(kw)

    if body.remove:
        for kw in body.remove:
            kw = kw.strip()
            if not kw:
                continue
            result = await glossary.remove_glossary_keyword(kw, node_uuid)
            if result.get("success"):
                removed.append(kw)
            else:
                skipped_remove.append(kw)

    current = await glossary.get_glossary_for_node(node_uuid)

    return {
        "success": True,
        "uri": f"{domain}://{path}",
        "added": added,
        "skipped_add": skipped_add,
        "removed": removed,
        "skipped_remove": skipped_remove,
        "current": current,
    }


@router.get("/boot")
async def boot_view(
    core_memory_uris: Optional[str] = Query(None, description="Comma-separated URIs to load as core memories"),
):
    """
    Generate the boot memory view: loads core memories + recent memories.
    Mirrors the MCP system://boot behavior.
    """
    import os
    from datetime import datetime

    graph = get_graph_service()
    glossary = get_glossary_service()

    uris_str = core_memory_uris or os.getenv("CORE_MEMORY_URIS", "")
    uris = [u.strip() for u in uris_str.split(",") if u.strip()]

    results = []
    loaded = 0
    failed = []

    for uri in uris:
        try:
            domain, path = _parse_uri(uri)
            memory = await graph.get_memory_by_path(path, domain)
            if not memory:
                failed.append(f"- {uri}: not found")
                continue
            results.append({
                "uri": f"{domain}://{path}",
                "content": memory.get("content", ""),
                "priority": memory.get("priority", 0),
                "disclosure": memory.get("disclosure"),
                "node_uuid": memory.get("node_uuid"),
            })
            loaded += 1
        except Exception as e:
            failed.append(f"- {uri}: {str(e)}")

    # Recent memories
    recent = []
    try:
        raw_recent = await graph.get_recent_memories(limit=5)
        for item in raw_recent:
            recent.append({
                "uri": item.get("uri", ""),
                "priority": item.get("priority", 0),
                "disclosure": item.get("disclosure"),
                "created_at": item.get("created_at", ""),
            })
    except Exception:
        pass

    return {
        "loaded": loaded,
        "total": len(uris),
        "failed": failed,
        "core_memories": results,
        "recent_memories": recent,
    }
