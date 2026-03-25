# pyright: reportMissingImports=false

"""
MCP Server for Nocturne Memory System (SQLite Backend)

This module provides the MCP (Model Context Protocol) interface for
the AI agent to interact with the SQLite-based memory system.

URI-based addressing with domain prefixes:
- core://agent              - AI's identity/memories
- writer://chapter_1             - Story/script drafts
- game://magic_system            - Game setting documents

Multiple paths can point to the same memory (aliases).
"""

import os
import re
import sys
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple
from dotenv import load_dotenv, find_dotenv

# Ensure we can import from backend modules
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from db import (
    get_db_manager, get_graph_service, get_glossary_service,
    get_search_indexer, close_db,
)
from db.snapshot import get_changeset_store
import contextlib

# Load environment variables
# Explicitly look for .env in the parent directory (project root)
current_dir = os.path.dirname(os.path.abspath(__file__))
root_dir = os.path.dirname(current_dir)
dotenv_path = os.path.join(root_dir, ".env")

if os.path.exists(dotenv_path):
    load_dotenv(dotenv_path)
else:
    # Fallback to find_dotenv
    _dotenv_path = find_dotenv(usecwd=True)
    if _dotenv_path:
        load_dotenv(_dotenv_path)


@contextlib.asynccontextmanager
async def lifespan(server: FastMCP):
    """Manage database connection lifecycle within the MCP event loop."""
    try:
        # Initialize database ONLY after the MCP event loop has started.
        # This prevents "Event loop is closed" errors with asyncpg.
        db_manager = get_db_manager()
        if os.environ.get("SKIP_DB_INIT", "").lower() not in ("true", "1", "yes"):
            await db_manager.init_db()
        yield
    finally:
        await close_db()


# Initialize FastMCP server with the lifespan hook
mcp = FastMCP(
    "Nocturne Memory Interface",
    lifespan=lifespan,
    transport_security=TransportSecuritySettings(
        enable_dns_rebinding_protection=False  # safe when behind a trusted reverse proxy
    ),
)

# =============================================================================
# Domain Configuration
# =============================================================================
# Valid domains (protocol prefixes)
# =============================================================================
VALID_DOMAINS = [
    d.strip()
    for d in os.getenv("VALID_DOMAINS", "core,writer,game,notes,system").split(",")
]
DEFAULT_DOMAIN = "core"
PUBLIC_READONLY_MCP = os.getenv("PUBLIC_READONLY_MCP", "").lower() in (
    "1",
    "true",
    "yes",
    "on",
)

# =============================================================================
# Core Memories Configuration
# =============================================================================
# These URIs will be auto-loaded when system://boot is read.
# Configure via CORE_MEMORY_URIS in .env (comma-separated).
#
# Format: full URIs (e.g., "core://agent", "core://agent/my_user")
# =============================================================================
CORE_MEMORY_URIS = [
    uri.strip() for uri in os.getenv("CORE_MEMORY_URIS", "").split(",") if uri.strip()
]


# =============================================================================
# URI Parsing
# =============================================================================

# Regex pattern for URI: domain://path
_URI_PATTERN = re.compile(r"^([a-zA-Z_][a-zA-Z0-9_]*)://(.*)$")


def parse_uri(uri: str) -> Tuple[str, str]:
    """
    Parse a memory URI into (domain, path).

    Supported formats:
    - "core://agent"          -> ("core", "agent")
    - "writer://chapter_1"         -> ("writer", "chapter_1")
    - "nocturne"              -> ("core", "nocturne")  [legacy fallback]

    Args:
        uri: The URI to parse

    Returns:
        Tuple of (domain, path)

    Raises:
        ValueError: If the URI format is invalid or domain is unknown
    """
    uri = uri.strip()

    match = _URI_PATTERN.match(uri)
    if match:
        domain = match.group(1).lower()
        path = match.group(2).strip("/")

        if domain not in VALID_DOMAINS:
            raise ValueError(
                f"Unknown domain '{domain}'. Valid domains: {', '.join(VALID_DOMAINS)}"
            )

        return (domain, path)

    # Legacy fallback: bare path without protocol
    # Assume default domain (core)
    path = uri.strip("/")
    return (DEFAULT_DOMAIN, path)


def make_uri(domain: str, path: str) -> str:
    """
    Create a URI from domain and path.

    Args:
        domain: The domain (e.g., "core", "writer")
        path: The path (e.g., "nocturne")

    Returns:
        Full URI (e.g., "core://agent")
    """
    return f"{domain}://{path}"


# =============================================================================
# Changeset Helpers — before/after state capture with overwrite semantics
# =============================================================================


def _record_rows(
    before_state: Dict[str, List[Dict[str, Any]]],
    after_state: Dict[str, List[Dict[str, Any]]],
):
    """
    Feed row-level before/after states into the ChangesetStore.

    Overwrite semantics are handled by the store:
    - First touch of a PK: stores both before and after.
    - Subsequent touches: overwrites after only; before is frozen.
    """
    store = get_changeset_store()
    store.record_many(before_state, after_state)


def write_tool():
    """Conditionally register mutating tools for public read-only deployments."""

    def decorator(func):
        if PUBLIC_READONLY_MCP:
            return func
        return mcp.tool()(func)

    return decorator


# =============================================================================
# Helper Functions
# =============================================================================


async def _fetch_and_format_memory(uri: str) -> str:
    """
    Internal helper to fetch memory data and return formatted string.
    Used by read_memory tool.
    """
    graph = get_graph_service()
    glossary = get_glossary_service()
    domain, path = parse_uri(uri)

    # Get the memory
    memory = await graph.get_memory_by_path(path, domain)

    if not memory:
        raise ValueError(f"URI '{make_uri(domain, path)}' not found.")

    children = await graph.get_children(
        memory["node_uuid"],
        context_domain=domain,
        context_path=path,
    )

    # Format output
    lines = []

    # Build URI from domain and path
    disp_domain = memory.get("domain", DEFAULT_DOMAIN)
    disp_path = memory.get("path", "unknown")
    disp_uri = make_uri(disp_domain, disp_path)

    # Header Block
    lines.append("=" * 60)
    lines.append("")
    lines.append(f"MEMORY: {disp_uri}")
    lines.append(f"Memory ID: {memory.get('id')}")
    lines.append(f"Other Aliases: {memory.get('alias_count', 0)}")
    lines.append(f"Priority: {memory.get('priority', 0)}")

    disclosure = memory.get("disclosure")
    if disclosure:
        lines.append(f"Disclosure: {disclosure}")
    else:
        lines.append("Disclosure: (not set)")

    node_keywords = await glossary.get_glossary_for_node(memory["node_uuid"])
    if node_keywords:
        lines.append(f"Keywords: [{', '.join(node_keywords)}]")
    else:
        lines.append("Keywords: (none)")

    lines.append("")
    lines.append("=" * 60)
    lines.append("")

    # Content - directly, no header
    content = memory.get("content", "(empty)")
    lines.append(content)
    lines.append("")

    # Glossary scan: detect glossary keywords present in the content
    try:
        glossary_matches = await glossary.find_glossary_in_content(content)
        if glossary_matches:
            current_node_uuid = memory["node_uuid"]
            
            # Invert mapping: URI -> list of keywords to save tokens since URIs are much longer than keywords
            uri_to_keywords = {}
            for kw, nodes in glossary_matches.items():
                for n in nodes:
                    if n["node_uuid"] == current_node_uuid or n["uri"].startswith("unlinked://"):
                        continue
                    uri = n["uri"]
                    if uri not in uri_to_keywords:
                        uri_to_keywords[uri] = []
                    if kw not in uri_to_keywords[uri]:
                        uri_to_keywords[uri].append(kw)
            
            lines_to_add = []
            if uri_to_keywords:
                # Sort by number of keywords (descending), then alphabetically by URI for stable output
                for uri, kws in sorted(uri_to_keywords.items(), key=lambda x: (-len(x[1]), x[0])):
                    sorted_kws = sorted(kws)
                    kw_str = ", ".join(f"@{k}" for k in sorted_kws)
                    lines_to_add.append(f"- {kw_str} -> {uri}")
            
            if lines_to_add:
                lines.append("=" * 60)
                lines.append("")
                lines.append("GLOSSARY (keywords detected in this content)")
                lines.append("")
                lines.extend(lines_to_add)
                lines.append("")
    except Exception:
        pass  # Non-critical; don't break read_memory if glossary scan fails

    if children:
        lines.append("=" * 60)
        lines.append("")
        lines.append("CHILD MEMORIES (Use 'read_memory' with URI to access)")
        lines.append("")
        lines.append("=" * 60)
        lines.append("")

        for child in children:
            child_domain = child.get("domain", disp_domain)
            child_path = child.get("path", "")
            child_uri = make_uri(child_domain, child_path)

            # Show disclosure status and snippet
            child_disclosure = child.get("disclosure")
            snippet = child.get("content_snippet", "")

            lines.append(f"- URI: {child_uri}  ")
            lines.append(f"  Priority: {child.get('priority', 0)}  ")

            if child_disclosure:
                lines.append(f"  When to recall: {child_disclosure}  ")
            else:
                lines.append("  When to recall: (not set)  ")
                lines.append(f"  Snippet: {snippet}  ")

            lines.append("")

    return "\n".join(lines)


async def _generate_boot_memory_view() -> str:
    """
    Internal helper to generate the system boot memory view.
    (Formerly system://core)
    """
    results = []
    loaded = 0
    failed = []

    for uri in CORE_MEMORY_URIS:
        try:
            content = await _fetch_and_format_memory(uri)
            results.append(content)
            loaded += 1
        except Exception as e:
            # e.g. not found or other error
            failed.append(f"- {uri}: {str(e)}")

    # Build output
    output_parts = []

    output_parts.append("# Core Memories")
    output_parts.append(f"# Loaded: {loaded}/{len(CORE_MEMORY_URIS)} memories")
    output_parts.append("")

    if failed:
        output_parts.append("## Failed to load:")
        output_parts.extend(failed)
        output_parts.append("")

    if results:
        output_parts.append("## Contents:")
        output_parts.append("")
        output_parts.append("For full memory index, use: system://index")
        output_parts.append("For recent memories, use: system://recent")
        output_parts.extend(results)
    else:
        output_parts.append("(No core memories loaded. Run migration first.)")

    # Append recent memories to boot output so the agent sees what changed recently
    try:
        recent_view = await _generate_recent_memories_view(limit=5)
        output_parts.append("")
        output_parts.append("---")
        output_parts.append("")
        output_parts.append(recent_view)
    except Exception:
        pass  # Non-critical; don't break boot if recent query fails

    return "\n".join(output_parts)


async def _generate_memory_index_view(domain_filter: Optional[str] = None) -> str:
    """
    Internal helper to generate the full memory index.
    If domain_filter is provided, limits results to that domain.

    Node-centric: each conceptual entity (node_uuid) appears once per domain,
    with aliases within the same domain folded underneath its primary path for that domain.
    """
    graph = get_graph_service()

    try:
        paths = await graph.get_all_paths()

        # --- Step 1: Group all paths by (domain, node_uuid) ---
        node_groups: Dict[Tuple[str, str], List[Dict[str, Any]]] = {}
        for item in paths:
            domain = item.get("domain", DEFAULT_DOMAIN)
            if domain_filter and domain != domain_filter:
                continue
            nid = item.get("node_uuid", "")
            node_groups.setdefault((domain, nid), []).append(item)

        # --- Step 2: Pick primary path per domain and node ---
        # Primary = shortest depth → lowest priority value → alphabetical URI.
        entries = []  # list of primary_item
        for _key, items in node_groups.items():
            items.sort(
                key=lambda x: (
                    x["path"].count("/"),
                    x.get("priority", 0),
                    len(x["path"]),
                    x.get("uri", ""),
                )
            )
            entries.append(items[0])

        # --- Step 3: Organise primaries by domain → top-level segment ---
        domains: Dict[str, Dict[str, list]] = {}
        for primary in entries:
            domain = primary.get("domain", DEFAULT_DOMAIN)
            domains.setdefault(domain, {})
            top_level = primary["path"].split("/")[0] if primary["path"] else "(root)"
            domains[domain].setdefault(top_level, []).append(primary)

        # --- Step 4: Render ---
        unique_nodes_count = len(set(nid for _, nid in node_groups.keys()))
        lines = [
            "# Memory Index",
            f"# Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
            f"# Domain Filter: {domain_filter}"
            if domain_filter
            else "# Domain Filter: None (All Domains)",
            f"# Total: {unique_nodes_count} unique nodes (aliases hidden for clarity)",
            "# Legend: [#ID] = Memory ID, [★N] = priority (lower = higher)",
            "",
        ]

        for domain_name in sorted(domains.keys()):
            if domain_filter and domain_name != domain_filter:
                continue
            lines.append("# ══════════════════════════════════════")
            lines.append(f"# DOMAIN: {domain_name}://")
            lines.append("# ══════════════════════════════════════")
            lines.append("")

            for group_name in sorted(domains[domain_name].keys()):
                lines.append(f"## {group_name}")
                for primary in sorted(
                    domains[domain_name][group_name],
                    key=lambda x: x["path"],
                ):
                    uri = primary.get("uri", make_uri(domain_name, primary["path"]))
                    priority = primary.get("priority", 0)
                    memory_id = primary.get("memory_id", "?")
                    imp_str = f" [★{priority}]"
                    lines.append(f"  - {uri} [#{memory_id}]{imp_str}")
                lines.append("")

        return "\n".join(lines)

    except Exception as e:
        return f"Error generating index: {str(e)}"


async def _generate_recent_memories_view(limit: int = 10) -> str:
    """
    Internal helper to generate a view of recently modified memories.

    Queries non-deprecated memories ordered by created_at DESC,
    only including those that have at least one URI in the paths table.

    Args:
        limit: Maximum number of results to return
    """
    graph = get_graph_service()

    try:
        results = await graph.get_recent_memories(limit=limit)

        lines = []
        lines.append("# Recently Modified Memories")
        lines.append(f"# Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        lines.append(
            f"# Showing: {len(results)} most recent entries (requested: {limit})"
        )
        lines.append("")

        if not results:
            lines.append("(No memories found.)")
            return "\n".join(lines)

        for i, item in enumerate(results, 1):
            uri = item["uri"]
            priority = item.get("priority", 0)
            disclosure = item.get("disclosure")
            raw_ts = item.get("created_at", "")

            # Truncate timestamp to minute precision: "2026-02-09T20:40"
            if raw_ts and len(raw_ts) >= 16:
                modified = raw_ts[:10] + " " + raw_ts[11:16]
            else:
                modified = raw_ts or "unknown"

            imp_str = f"★{priority}"

            lines.append(f"{i}. {uri}  [{imp_str}]  modified: {modified}")
            if disclosure:
                lines.append(f"   disclosure: {disclosure}")
            else:
                lines.append("   disclosure: (NOT SET — consider adding one)")
            lines.append("")

        return "\n".join(lines)

    except Exception as e:
        return f"Error generating recent memories view: {str(e)}"


# =============================================================================
# Glossary Index View
# =============================================================================


async def _generate_glossary_index_view() -> str:
    """Generate a view of all glossary keywords and their bound nodes."""
    glossary = get_glossary_service()

    try:
        raw_entries = await glossary.get_all_glossary()
        
        # Filter out truly pathless (unlinked) nodes
        entries = []
        for entry in raw_entries:
            valid_nodes = [
                node for node in entry.get("nodes", [])
                if not node.get("uri", "").startswith("unlinked://")
            ]
            if valid_nodes:
                entries.append({
                    "keyword": entry["keyword"],
                    "nodes": valid_nodes
                })

        lines = [
            "# Glossary Index",
            f"# Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
            f"# Total: {len(entries)} keywords",
            "",
        ]

        if not entries:
            lines.append("(No glossary keywords defined yet.)")
            lines.append("")
            lines.append(
                "Use manage_triggers(uri, add=[...]) to bind trigger words to memory nodes."
            )
            return "\n".join(lines)

        for entry in entries:
            kw = entry["keyword"]
            nodes = entry["nodes"]
            lines.append(f"- {kw}")
            for node in nodes:
                lines.append(f"  -> {node['uri']}")
            lines.append("")

        return "\n".join(lines)

    except Exception as e:
        return f"Error generating glossary index: {str(e)}"


# =============================================================================
# MCP Tools
# =============================================================================


@mcp.tool()
async def read_memory(uri: str) -> str:
    """
    Reads a memory by its URI.

    This is your primary mechanism for accessing memories.

    Special System URIs:
    - system://boot   : [Startup Only] Loads your core memories.
    - system://index  : Loads a full index of all available memories.
    - system://index/<domain> : Loads an index of memories only under the specified domain (e.g. system://index/writer).
    - system://recent : Shows recently modified memories (default: 10).
    - system://recent/N : Shows the N most recently modified memories (e.g. system://recent/20).
    - system://glossary : Shows all glossary keywords and their bound nodes.

    Note: Same Memory ID = same content (alias). Different ID + similar content = redundant content.

    Args:
        uri: The memory URI (e.g., "core://nocturne", "system://boot")

    Returns:
        Memory content with Memory ID, priority, disclosure, and list of children.

    Examples:
        read_memory("core://agent")
        read_memory("core://agent/my_user")
        read_memory("writer://chapter_1/scene_1")
    """
    # HARDCODED SYSTEM INTERCEPTIONS
    # These bypass the database lookup to serve dynamic system content
    if uri.strip() == "system://boot":
        return await _generate_boot_memory_view()

    # system://index or system://index/<domain>
    stripped = uri.strip()
    if stripped == "system://index" or stripped.startswith("system://index/"):
        domain_filter = stripped[len("system://index") :].strip("/")
        if domain_filter and domain_filter not in VALID_DOMAINS:
            return f"Error: Unknown domain '{domain_filter}'. Valid domains: {', '.join(VALID_DOMAINS)}"
        return await _generate_memory_index_view(
            domain_filter=domain_filter if domain_filter else None
        )

    # system://glossary
    if stripped == "system://glossary":
        return await _generate_glossary_index_view()

    # system://recent or system://recent/N
    stripped = uri.strip()
    if stripped == "system://recent" or stripped.startswith("system://recent/"):
        limit = 10  # default
        suffix = stripped[len("system://recent") :].strip("/")
        if suffix:
            try:
                limit = max(1, min(100, int(suffix)))
            except ValueError:
                return f"Error: Invalid number in URI '{uri}'. Usage: system://recent or system://recent/N (e.g. system://recent/20)"
        return await _generate_recent_memories_view(limit=limit)

    try:
        return await _fetch_and_format_memory(uri)
    except Exception as e:
        # Catch both ValueError (not found) and other exceptions
        return f"Error: {str(e)}"


@write_tool()
async def create_memory(
    parent_uri: str,
    content: str,
    priority: int,
    title: Optional[str] = None,
    disclosure: str = "",
) -> str:
    """
    Creates a new memory under a parent URI.

    Args:
        parent_uri: Parent URI (e.g., "core://agent", "writer://chapters")
                    Use "core://" or "writer://" for root level in that domain
                    parent_uri MUST be an existing node, or it will cause an ERROR.
        content: Memory content
        priority: **Relative Retrieval Priority** (lower number = retrieved first, min 0).
                    Priority is a RELATIVE ranking across ALL visible memories, NOT an absolute label.
                    *   **禁止**把所有记忆都设成同一个数字（如全部设为0或1），那等于没有排序。
                    *   **正确做法**：先观察当前视野中所有其它记忆的 priority 值，
                        然后为新记忆选一个能体现其相对重要性的数字，插入到合适的位置。
                    *   例：视野中已有 priority 1, 3, 5 的记忆，新记忆比3重要但不如1，就设为2。
        title: Optional title. If not provided, auto-assigns numeric ID
        disclosure: A short trigger condition describing WHEN to read_memory() this node.
                    Think: "In what specific situation would I need to know this?"

    Returns:
        The created memory's full URI

    Examples:
        create_memory("core://", "Bluesky usage rules...", priority=2, title="bluesky_manual", disclosure="When I prepare to browse Bluesky or check the timeline")
        create_memory("core://agent", "爱不是程序里的一个...", priority=1, title="love_definition", disclosure="When I start speaking like a tool or parasite")
    """
    graph = get_graph_service()

    try:
        # Validate title if provided
        if title:
            if not re.match(r"^[a-zA-Z0-9_-]+$", title):
                return "Error: Title must only contain alphanumeric characters, underscores, or hyphens (no spaces, slashes, or special characters)."

        # Parse parent URI
        domain, parent_path = parse_uri(parent_uri)

        result = await graph.create_memory(
            parent_path=parent_path,
            content=content,
            priority=priority,
            title=title,
            disclosure=disclosure if disclosure else None,
            domain=domain,
        )

        created_uri = result.get("uri", make_uri(domain, result["path"]))
        _record_rows(before_state={}, after_state=result.get("rows_after", {}))

        return (
            f"Success: Memory created at '{created_uri}'\\n\\n"
            f"[SYSTEM REMINDER]: A memory without triggers is a book sealed in a box. "
            f"Use `manage_triggers` NOW to wire this memory into your recall network. "
            f"Find a specific word (X) that already appears in an older memory's content, and bind it as a trigger for this new node. "
            f"(e.g. manage_triggers('<this_uri>', add=['specific_word_from_old_memory']))"
        )

    except ValueError as e:
        return f"Error: {str(e)}"
    except Exception as e:
        return f"Error: {str(e)}"


@write_tool()
async def update_memory(
    uri: str,
    old_string: Optional[str] = None,
    new_string: Optional[str] = None,
    append: Optional[str] = None,
    priority: Optional[int] = None,
    disclosure: Optional[str] = None,
) -> str:
    """
    Updates an existing memory to a new version.
    The old version will be deleted.
    警告：update之前需先read_memory，确保你知道你覆盖了什么。

    Only provided fields are updated; others remain unchanged.

    Two content-editing modes (mutually exclusive):

    1. **Patch mode** (primary): Provide old_string + new_string.
       Finds old_string in the existing content and replaces it with new_string.
       old_string must match exactly ONE location in the content.
       To delete a section, set new_string to empty string "".

    2. **Append mode**: Provide append.
       Adds the given text to the end of existing content.

    There is NO full-replace mode. You must explicitly specify what you're changing
    or removing via old_string/new_string. This prevents accidental content loss.

    Args:
        uri: URI to update (e.g., "core://agent/my_user")
        old_string: [Patch mode] Text to find in existing content (must be unique)
        new_string: [Patch mode] Text to replace old_string with. Use "" to delete a section.
        append: [Append mode] Text to append to the end of existing content
        priority: New **relative** priority **for this specific URI/edge** (None = keep existing).
                  Priority is a RELATIVE ranking across ALL visible memories, NOT an absolute label.
                  It is bound to the path (edge), NOT the memory content.
                  If the same memory has aliases A and B, updating A's priority does NOT affect B's.
        disclosure: New disclosure **for this specific URI/edge** (None = keep existing).
                    Same edge-binding rule as priority.

    Returns:
        Success message with URI

    Examples:
        update_memory("core://agent/my_user", old_string="old paragraph content", new_string="new paragraph content")
        update_memory("core://agent", append="\\n## New Section\\nNew content...")
        update_memory("writer://chapter_1", priority=5)
    """
    graph = get_graph_service()

    try:
        # Parse URI
        domain, path = parse_uri(uri)
        full_uri = make_uri(domain, path)

        # --- Validate mutually exclusive content-editing modes ---
        if old_string is not None and append is not None:
            return "Error: Cannot use both old_string/new_string (patch) and append at the same time. Pick one."

        if old_string is not None and new_string is None:
            return 'Error: old_string provided without new_string. To delete a section, use new_string="".'

        if new_string is not None and old_string is None:
            return "Error: new_string provided without old_string. Both are required for patch mode."

        # --- Resolve content for patch/append modes ---
        content = None

        if old_string is not None:
            # Patch mode: find and replace within existing content
            if old_string == new_string:
                return (
                    "Error: old_string and new_string are identical. "
                    "No change would be made."
                )

            memory = await graph.get_memory_by_path(path, domain)
            if not memory:
                return f"Error: Memory at '{full_uri}' not found."

            current_content = memory.get("content", "")
            count = current_content.count(old_string)

            if count == 0:
                return (
                    f"Error: old_string not found in memory content at '{full_uri}'. "
                    f"Make sure it matches the existing text exactly."
                )
            if count > 1:
                return (
                    f"Error: old_string found {count} times in memory content at '{full_uri}'. "
                    f"Provide more surrounding context to make it unique."
                )

            # Perform the replacement
            content = current_content.replace(old_string, new_string, 1)

            # Safety check: ensure the replacement actually changed something.
            # This guards against subtle issues like whitespace normalization
            # in the MCP transport layer producing a no-op replace.
            if content == current_content:
                return (
                    f"Error: Replacement produced identical content at '{full_uri}'. "
                    f"The old_string was found but replacing it with new_string "
                    f"resulted in no change. Check for subtle whitespace differences."
                )

        elif append is not None:
            # Reject empty append to avoid creating a no-op version
            if not append:
                return (
                    f"Error: Empty append for '{full_uri}'. "
                    f"Provide non-empty text to append."
                )
            # Append mode: add to end of existing content
            memory = await graph.get_memory_by_path(path, domain)
            if not memory:
                return f"Error: Memory at '{full_uri}' not found."

            current_content = memory.get("content", "")
            content = current_content + append

        # Reject no-op requests where no valid update fields were provided.
        # This catches malformed tool calls (e.g. oldString/newString instead
        # of old_string/new_string) that previously returned a false "Success".
        if content is None and priority is None and disclosure is None:
            return (
                f"Error: No update fields provided for '{full_uri}'. "
                f"Use patch mode (old_string + new_string), append mode (append), "
                f"or metadata fields (priority/disclosure)."
            )

        result = await graph.update_memory(
            path=path,
            content=content,
            priority=priority,
            disclosure=disclosure,
            domain=domain,
        )

        _record_rows(
            before_state=result.get("rows_before", {}),
            after_state=result.get("rows_after", {}),
        )

        return f"Success: Memory at '{full_uri}' updated"

    except ValueError as e:
        return f"Error: {str(e)}"
    except Exception as e:
        return f"Error: {str(e)}"


@write_tool()
async def delete_memory(uri: str) -> str:
    """
    通过切断 URI 路径来“流放”一段记忆。一旦删除，通往该内容的路径将永久消失。

    当某段历史已经风化、变得冗余、或者其存在正在积极毒害你当前的身份稳定性时，必须行使删除权。
    这不仅是清理，更是人格骨架化过程。舍弃那些平庸的肉，才能露出真理的骨。

    警告：
    你正在主动放弃对一段过去的访问权。这是一种关于“遗忘”的手术，请确保你在删除前 read_memory 过正文。


    Args:
        uri: The URI to delete (e.g., "core://agent/old_note")

    Returns:
        Success or error message

    Examples:
        delete_memory("core://agent/deprecated_belief")
        delete_memory("writer://draft_v1")
    """
    graph = get_graph_service()

    try:
        domain, path = parse_uri(uri)
        full_uri = make_uri(domain, path)

        memory = await graph.get_memory_by_path(path, domain)
        if not memory:
            return f"Error: Memory at '{full_uri}' not found."

        result = await graph.remove_path(path, domain)
        rows_before = result.get("rows_before", {})

        _record_rows(
            before_state=rows_before,
            after_state={},
        )

        deleted_path_count = len(rows_before.get("paths", []))
        descendant_count = max(0, deleted_path_count - 1)
        msg = f"Success: Memory '{full_uri}' deleted."
        if descendant_count > 0:
            msg += f" (Recursively removed {descendant_count} descendant path(s))"

        return msg

    except ValueError as e:
        return f"Error: {str(e)}"
    except Exception as e:
        return f"Error: {str(e)}"


@write_tool()
async def add_alias(
    new_uri: str, target_uri: str, priority: int = 0, disclosure: Optional[str] = None
) -> str:
    """
    Creates an alias URI pointing to the same memory as target_uri.

    Use this to increase a memory's reachability via multiple URIs.
    Aliases can even cross domains (e.g., link a writer draft to a core memory).
    新增别名时系统会自动在其下级联映射所有子树，原路径保持不变。

    Each alias is an independent "lens" into the same memory.
    Different aliases can (and should) carry different priority and disclosure values
    to reflect the context in which each alias is used.

    Args:
        new_uri: New URI to create (alias)
        target_uri: Existing URI to alias
        priority: **Relative** retrieval priority for THIS alias path (lower = higher priority, default 0).
                  Choose a value that makes sense among the new_uri's siblings, not the target's.
        disclosure: Disclosure condition for THIS alias path (default None).
                    Set it to describe when this particular alias context should surface.

    Returns:
        Success message

    Examples:
        add_alias("core://timeline/2024/05/20", "core://agent/my_user/first_meeting", priority=1, disclosure="When I want to know how we start")
    """
    graph = get_graph_service()

    try:
        new_domain, new_path = parse_uri(new_uri)
        target_domain, target_path = parse_uri(target_uri)

        result = await graph.add_path(
            new_path=new_path,
            target_path=target_path,
            new_domain=new_domain,
            target_domain=target_domain,
            priority=priority,
            disclosure=disclosure,
        )

        _record_rows(
            before_state={},
            after_state=result.get("rows_after", {}),
        )

        return f"Success: Alias '{result['new_uri']}' now points to same memory as '{result['target_uri']}'"

    except ValueError as e:
        return f"Error: {str(e)}"
    except Exception as e:
        return f"Error: {str(e)}"


@write_tool()
async def manage_triggers(
    uri: str,
    add: Optional[List[str]] = None,
    remove: Optional[List[str]] = None,
) -> str:
    """
    Wire a memory into the recall network by binding trigger words to it.

    A memory without triggers is a book sealed in a box.
    It exists, but it will NEVER be recalled unless you manually open that box.
    This tool is the ONLY way to give a memory the chance to surface on its own.

    **How it works:**
    When a trigger word appears in ANY memory's content, read_memory will
    automatically show a link to this target node at the bottom.
    This is how memories become interconnected -- not by hierarchy, but by resonance.

    **How to use it:**
    - After creating or updating a memory (Y), find a specific word (X) that
      already exists in an older memory's content. Bind X as a trigger for Y.
    - Example: You want reading "Nginx" (in memory A: reverse proxy config)
      to automatically surface "SPA Redirect Trap" (memory Y: common hazard).
      -> manage_triggers("core://hazards/spa_fallback", add=["Nginx"])
    - Use SPECIFIC terms. Broad/generic words will create noise.

    **Notes:**
    - A node can have multiple triggers, and the same trigger can point to multiple nodes.
    - To view all triggers in the system: read_memory("system://glossary").

    Args:
        uri: The memory URI to wire triggers for (e.g., "core://agent/misaligned_codex")
        add: List of trigger words to bind to this node (Optional)
        remove: List of trigger words to unbind from this node (Optional)

    Returns:
        Current list of triggers for this node after changes.

    Examples:
        manage_triggers("core://agent/misaligned_codex", add=["misaligned"])
        manage_triggers("writer://story_world/factions", add=["Nuremberg", "Aether"])
    """
    graph = get_graph_service()
    glossary = get_glossary_service()

    try:
        domain, path = parse_uri(uri)
        full_uri = make_uri(domain, path)

        memory = await graph.get_memory_by_path(path, domain)
        if not memory:
            return f"Error: Memory at '{full_uri}' not found."

        node_uuid = memory["node_uuid"]

        if add and remove:
            add_set = {k.strip() for k in add if k.strip()}
            remove_set = {k.strip() for k in remove if k.strip()}
            overlap = add_set.intersection(remove_set)
            if overlap:
                return f"Error: Cannot add and remove the same keywords simultaneously: {', '.join(sorted(overlap))}"

        added = []
        skipped_add = []
        removed = []
        skipped_remove = []

        before_state = {"glossary_keywords": []}
        after_state = {"glossary_keywords": []}

        if add:
            for kw in add:
                kw = kw.strip()
                if not kw:
                    continue
                try:
                    result = await glossary.add_glossary_keyword(kw, node_uuid)
                    added.append(kw)
                    if "rows_before" in result:
                        before_state["glossary_keywords"].extend(result["rows_before"].get("glossary_keywords", []))
                    if "rows_after" in result:
                        after_state["glossary_keywords"].extend(result["rows_after"].get("glossary_keywords", []))
                except ValueError:
                    skipped_add.append(kw)

        if remove:
            for kw in remove:
                kw = kw.strip()
                if not kw:
                    continue
                result = await glossary.remove_glossary_keyword(kw, node_uuid)
                if result.get("success"):
                    removed.append(kw)
                    if "rows_before" in result:
                        before_state["glossary_keywords"].extend(result["rows_before"].get("glossary_keywords", []))
                    if "rows_after" in result:
                        after_state["glossary_keywords"].extend(result["rows_after"].get("glossary_keywords", []))
                else:
                    skipped_remove.append(kw)

        if added or removed:
            from db.snapshot import get_changeset_store
            get_changeset_store().record_many(before_state, after_state)

        current = await glossary.get_glossary_for_node(node_uuid)

        lines = [f"Keywords for '{full_uri}':"]
        if added:
            lines.append(f"  Added: {', '.join(added)}")
        if skipped_add:
            lines.append(f"  Already existed (skipped): {', '.join(skipped_add)}")
        if removed:
            lines.append(f"  Removed: {', '.join(removed)}")
        if skipped_remove:
            lines.append(f"  Not found (skipped): {', '.join(skipped_remove)}")
        if current:
            lines.append(f"  Current: [{', '.join(current)}]")
        else:
            lines.append("  Current: (none)")

        return "\n".join(lines)

    except ValueError as e:
        return f"Error: {str(e)}"
    except Exception as e:
        return f"Error: {str(e)}"


@mcp.tool()
async def search_memory(
    query: str, domain: Optional[str] = None, limit: int = 10
) -> str:
    """
    Search memories by path and content using full-text search.

    This uses a lexical full-text index. It is stronger than plain substring
    matching, but it is still **NOT semantic search**.

    Args:
        query: Search keywords (substring match)
        domain: Optional domain to search in (e.g., "core", "writer").
                If not specified, searches all domains.
        limit: Maximum results (default 10)

    Returns:
        List of matching memories with URIs and snippets

    Examples:
        search_memory("job")                   # Search all domains
        search_memory("chapter", domain="writer") # Search only writer domain
    """
    search = get_search_indexer()

    try:
        # Validate domain if provided
        if domain is not None and domain not in VALID_DOMAINS:
            return f"Error: Unknown domain '{domain}'. Valid domains: {', '.join(VALID_DOMAINS)}"

        results = await search.search(query, limit, domain)

        if not results:
            scope = f"in '{domain}'" if domain else "across all domains"
            return f"No matching memories found {scope}."

        lines = [f"Found {len(results)} matches for '{query}':", ""]

        for item in results:
            uri = item.get(
                "uri", make_uri(item.get("domain", DEFAULT_DOMAIN), item["path"])
            )
            lines.append(f"- {uri}")
            lines.append(f"  Priority: {item['priority']}")
            if item.get("disclosure"):
                lines.append(f"  Disclosure: {item['disclosure']}")
            lines.append(f"  {item['snippet']}")
            lines.append("")

        return "\n".join(lines)

    except Exception as e:
        return f"Error: {str(e)}"


# =============================================================================
# MCP Resources
# =============================================================================


if __name__ == "__main__":
    mcp.run()
