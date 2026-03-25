#!/usr/bin/env python3
"""
Migration Script: Neo4j -> SQLite (Legacy)

This script migrates memory data from the old Neo4j backend (pre-1.0) to SQLite.
It is kept for users upgrading from pre-SQLite versions of Nocturne Memory.

NOTE: The neo4j driver is NOT included in requirements.txt.
      Install it separately before running:
          pip install "neo4j>=5.16.0"

Required .env variables for migration:
    DATABASE_URL=sqlite+aiosqlite:///C:/path/to/your/database.db
    NEO4J_URI=bolt://localhost:7687
    dbuser=neo4j
    dbpassword=your_password

Mapping (Neo4j -> SQLite URI):
    Entity  `nocturne`           -> core://nocturne
    Relation `rel:A>B`           -> core://A/B
    Chapter  `chap:A>B:name`     -> core://A/B/name

Usage:
    cd backend
    python -m scripts.migrate_neo4j_to_sqlite

    Or:
    python scripts/migrate_neo4j_to_sqlite.py
"""

import os
import sys
import asyncio
import json
from datetime import datetime
from typing import Optional

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dotenv import load_dotenv, find_dotenv

# Load environment variables
_dotenv_path = find_dotenv(usecwd=True)
if _dotenv_path:
    load_dotenv(_dotenv_path)

from db.neo4j_client import get_neo4j_client
from db import get_graph_service, get_db_manager, close_db
from db.graph import GraphService


class MigrationLogger:
    """Logs migration progress and results."""
    
    def __init__(self, log_file: str = "migration_log.json"):
        self.log_file = log_file
        self.entries = []
        self.errors = []
        self.stats = {
            "entities": 0,
            "relationships": 0,
            "chapters": 0,
            "total_memories": 0,
            "total_paths": 0
        }
    
    def log(self, entry_type: str, source_id: str, target_path: str, memory_id: int):
        """Log a successful migration."""
        self.entries.append({
            "type": entry_type,
            "source": source_id,
            "target_path": target_path,
            "memory_id": memory_id,
            "timestamp": datetime.now().isoformat()
        })
        # Pluralize: entity -> entities, relationship -> relationships, chapter -> chapters
        key = "entities" if entry_type == "entity" else f"{entry_type}s"
        if key in self.stats:
            self.stats[key] += 1
        self.stats["total_memories"] += 1
        self.stats["total_paths"] += 1
    
    def error(self, entry_type: str, source_id: str, error: str):
        """Log an error."""
        self.errors.append({
            "type": entry_type,
            "source": source_id,
            "error": error,
            "timestamp": datetime.now().isoformat()
        })
    
    def save(self):
        """Save log to file."""
        data = {
            "stats": self.stats,
            "entries": self.entries,
            "errors": self.errors,
            "completed_at": datetime.now().isoformat()
        }
        with open(self.log_file, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print(f"\nMigration log saved to: {self.log_file}")
    
    def print_summary(self):
        """Print migration summary."""
        print("\n" + "="*60)
        print("MIGRATION SUMMARY")
        print("="*60)
        print(f"Entities migrated:     {self.stats['entities']}")
        print(f"Relationships migrated: {self.stats['relationships']}")
        print(f"Chapters migrated:     {self.stats['chapters']}")
        print(f"Total memories created: {self.stats['total_memories']}")
        print(f"Total paths created:    {self.stats['total_paths']}")
        print(f"Errors:                {len(self.errors)}")
        if self.errors:
            print("\nErrors:")
            for err in self.errors[:10]:  # Show first 10 errors
                print(f"  - [{err['type']}] {err['source']}: {err['error']}")
            if len(self.errors) > 10:
                print(f"  ... and {len(self.errors) - 10} more errors")
        print("="*60)


async def migrate_entity(
    neo4j_client,
    sqlite_client: GraphService,
    entity_id: str,
    domain: str,
    logger: MigrationLogger
) -> Optional[int]:
    """
    Migrate a single entity.
    
    Returns:
        memory_id if successful, None if failed
    """
    try:
        # Skip relay entities (they will be migrated as chapters)
        if entity_id.startswith("relay__"):
            print(f"  [SKIP] Relay entity: {entity_id}")
            return None

        # Get entity info from Neo4j
        info = neo4j_client.get_entity_info(
            entity_id,
            include_basic=True,
            include_edges=False,
            include_children=False
        )
        
        if not info or not info.get("basic"):
            logger.error("entity", entity_id, "Entity not found or has no basic info")
            return None
        
        basic = info["basic"]
        content = basic.get("content", "")
        
        # Create in SQLite
        # Path = domain://entity_id (flat, root-level)
        result = await sqlite_client.create_memory(
            parent_path="",  # Root level
            content=content,
            title=entity_id,  # Use entity_id as path segment
            priority=0,
            disclosure=None,
            domain=domain,
        )
        
        logger.log("entity", entity_id, result["path"], result["id"])
        print(f"  [OK] Entity: {entity_id} -> {domain}://{result['path']}")
        return result["id"]
        
    except Exception as e:
        logger.error("entity", entity_id, str(e))
        print(f"  [ERR] Entity: {entity_id} - {e}")
        return None


async def migrate_relationship(
    neo4j_client,
    sqlite_client: GraphService,
    viewer_id: str,
    target_id: str,
    domain: str,
    logger: MigrationLogger
) -> Optional[int]:
    """
    Migrate a relationship (direct edge).
    
    Returns:
        memory_id if successful, None if failed
    """
    try:
        # Get relationship structure from Neo4j
        data = neo4j_client.get_relationship_structure(viewer_id, target_id)
        
        if not data.get("direct"):
            logger.error("relationship", f"rel:{viewer_id}>{target_id}", "Relationship not found")
            return None
        
        direct = data["direct"]
        content = direct.get("content", "")
        relation = direct.get("relation", "RELATIONSHIP")
        
        # Build content with relation metadata
        full_content = f"@relation: {relation}\n\n{content}"
        
        # Path = viewer_id/target_id  (parent must already exist from Phase 1)
        result = await sqlite_client.create_memory(
            parent_path=viewer_id,
            content=full_content,
            title=target_id,
            priority=0,
            disclosure=None,
            domain=domain,
        )
        
        logger.log("relationship", f"rel:{viewer_id}>{target_id}", result["path"], result["id"])
        print(f"  [OK] Relationship: rel:{viewer_id}>{target_id} -> {domain}://{result['path']}")
        return result["id"]
        
    except Exception as e:
        logger.error("relationship", f"rel:{viewer_id}>{target_id}", str(e))
        print(f"  [ERR] Relationship: rel:{viewer_id}>{target_id} - {e}")
        return None


async def migrate_chapter(
    neo4j_client,
    sqlite_client: GraphService,
    viewer_id: str,
    target_id: str,
    chapter_name: str,
    domain: str,
    logger: MigrationLogger
) -> Optional[int]:
    """
    Migrate a chapter (relay edge).
    
    Returns:
        memory_id if successful, None if failed
    """
    try:
        # Get chapter content from Neo4j via relay entity
        relay_entity_id = neo4j_client.generate_relay_entity_id(viewer_id, chapter_name, target_id)
        info = neo4j_client.get_entity_info(relay_entity_id, include_basic=True)
        
        if not info or not info.get("basic"):
            logger.error("chapter", f"chap:{viewer_id}>{target_id}:{chapter_name}", "Chapter relay entity not found")
            return None
        
        basic = info["basic"]
        content = basic.get("content", "")
        
        # Path = viewer_id/target_id/chapter_name  (parent must exist from relationship migration)
        parent_path = f"{viewer_id}/{target_id}"
        
        result = await sqlite_client.create_memory(
            parent_path=parent_path,
            content=content,
            title=chapter_name,
            priority=0,
            disclosure=None,
            domain=domain,
        )
        
        logger.log("chapter", f"chap:{viewer_id}>{target_id}:{chapter_name}", result["path"], result["id"])
        print(f"  [OK] Chapter: chap:{viewer_id}>{target_id}:{chapter_name} -> {domain}://{result['path']}")
        return result["id"]
        
    except Exception as e:
        logger.error("chapter", f"chap:{viewer_id}>{target_id}:{chapter_name}", str(e))
        print(f"  [ERR] Chapter: chap:{viewer_id}>{target_id}:{chapter_name} - {e}")
        return None


def preflight_check() -> bool:
    """Validate that all required environment variables are set."""
    ok = True
    
    # SQLite (target)
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        print("[ERROR] DATABASE_URL is not set. Point it to your new SQLite database.")
        ok = False
    else:
        print(f"  SQLite target: {db_url}")
    
    # Neo4j (source)
    neo4j_uri = os.getenv("NEO4J_URI", "bolt://localhost:7687")
    neo4j_user = os.getenv("dbuser", "neo4j")
    print(f"  Neo4j source:  {neo4j_uri} (user: {neo4j_user})")
    
    if not os.getenv("dbpassword"):
        print("[WARN]  dbpassword not set in .env; using default 'password'.")
    
    return ok


async def run_migration(domain: str = "core"):
    """
    Main migration function.
    
    Args:
        domain: Target domain for all migrated memories (default: "core").
    """
    print("=" * 60)
    print("  NEO4J -> SQLITE MIGRATION  (pre-1.0 -> v1.0)")
    print("=" * 60)
    
    # Preflight
    print("\n[1/6] Preflight check...")
    if not preflight_check():
        print("\nAborted: fix the errors above and try again.")
        return
    
    # Confirmation
    print(f"\n  All memories will be migrated into the '{domain}://' domain.")
    answer = input("\n  Proceed? [y/N] ").strip().lower()
    if answer != "y":
        print("Aborted by user.")
        return
    
    # Initialize clients
    print("\n[2/6] Initializing clients...")
    try:
        neo4j_client = get_neo4j_client()
    except Exception as e:
        print(f"[ERROR] Failed to connect to Neo4j: {e}")
        return
    
    sqlite_client = get_graph_service()
    
    # Initialize SQLite tables
    print("[3/6] Creating SQLite tables...")
    await get_db_manager().init_db()
    
    logger = MigrationLogger()
    
    # Get catalog from Neo4j
    print("[4/6] Reading Neo4j catalog...")
    catalog = neo4j_client.get_catalog_data()
    print(f"  Found {len(catalog)} entities in catalog")
    
    # Phase 1: Migrate all entities first (to ensure parent paths exist)
    print(f"\n[5/6] Migrating entities -> {domain}://...")
    entity_ids = set()
    for item in catalog:
        entity_id = item["entity_id"]
        entity_ids.add(entity_id)
        await migrate_entity(neo4j_client, sqlite_client, entity_id, domain, logger)
    
    # Phase 2: Migrate relationships and chapters
    print(f"\n[6/6] Migrating relationships & chapters -> {domain}://...")
    for item in catalog:
        entity_id = item["entity_id"]
        edges = item.get("edges", [])
        
        for edge in edges:
            target_id = edge["target_entity_id"]
            
            # Migrate the relationship
            # Note: target_id does NOT need to exist as its own path.
            # The relationship path is viewer_id/target_id, where target_id
            # is just the last segment (title). Only viewer_id must exist.
            await migrate_relationship(
                neo4j_client, sqlite_client, entity_id, target_id, domain, logger
            )
            
            # Get and migrate chapters
            rel_data = neo4j_client.get_relationship_structure(entity_id, target_id)
            relays = rel_data.get("relays", [])
            
            for relay in relays:
                if relay is None:
                    continue
                state = relay.get("state", {})
                chapter_name = state.get("name", "")
                if chapter_name:
                    await migrate_chapter(
                        neo4j_client, sqlite_client,
                        entity_id, target_id, chapter_name,
                        domain, logger
                    )
    
    # Print summary and save log
    logger.print_summary()
    logger.save()
    
    # Cleanup
    await close_db()
    neo4j_client.close()
    
    print("\nMigration complete!")


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(
        description="Migrate Nocturne Memory data from Neo4j (pre-1.0) to SQLite (v1.0)."
    )
    parser.add_argument(
        "--domain", default="core",
        help="Target domain for migrated memories (default: core)"
    )
    args = parser.parse_args()
    
    asyncio.run(run_migration(domain=args.domain))
