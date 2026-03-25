import pytest


async def test_create_and_update_memory_creates_version_chain(graph_service):
    created = await graph_service.create_memory(
        parent_path="",
        content="Original agent memory",
        priority=1,
        title="agent",
        disclosure="When booting tests",
    )

    updated = await graph_service.update_memory(
        path="agent",
        content="Updated agent memory",
        priority=2,
        disclosure="When verifying updates",
    )
    current = await graph_service.get_memory_by_path("agent", domain="core")
    old_memory = await graph_service.get_memory_by_id(updated["old_memory_id"])
    new_memory = await graph_service.get_memory_by_id(updated["new_memory_id"])

    assert created["uri"] == "core://agent"
    assert current["content"] == "Updated agent memory"
    assert current["priority"] == 2
    assert current["disclosure"] == "When verifying updates"
    assert old_memory["deprecated"] is True
    assert old_memory["migrated_to"] == updated["new_memory_id"]
    assert new_memory["deprecated"] is False


async def test_add_alias_cascades_child_paths(graph_service):
    await graph_service.create_memory(
        parent_path="",
        content="Folder memory",
        priority=2,
        title="folder",
        disclosure="When building alias trees",
    )
    await graph_service.create_memory(
        parent_path="folder",
        content="Nested child memory",
        priority=3,
        title="child",
        disclosure="When exploring nested children",
    )

    await graph_service.add_path(
        new_path="mirror_workspace",
        target_path="folder",
        new_domain="project",
        target_domain="core",
        priority=4,
        disclosure="When mirroring folder",
    )

    mirrored_parent = await graph_service.get_memory_by_path("mirror_workspace", "project")
    mirrored_child = await graph_service.get_memory_by_path("mirror_workspace/child", "project")

    assert mirrored_parent["content"] == "Folder memory"
    assert mirrored_child["content"] == "Nested child memory"


async def test_remove_path_rejects_orphaning_child_nodes(graph_service):
    await graph_service.create_memory(
        parent_path="",
        content="Parent memory",
        priority=2,
        title="parent",
        disclosure="When testing orphan prevention",
    )
    await graph_service.create_memory(
        parent_path="parent",
        content="Child memory",
        priority=3,
        title="child",
        disclosure="When testing orphan prevention",
    )

    with pytest.raises(ValueError, match="would become unreachable"):
        await graph_service.remove_path("parent", "core")


async def test_remove_path_soft_gc_creates_orphan_memory(graph_service):
    await graph_service.create_memory(
        parent_path="",
        content="Temporary memory",
        priority=2,
        title="temporary",
        disclosure="When testing soft GC",
    )

    await graph_service.remove_path("temporary", "core")

    current = await graph_service.get_memory_by_path("temporary", "core")
    orphans = await graph_service.get_all_orphan_memories()

    assert current is None
    assert any(item["category"] == "orphaned" for item in orphans)


async def test_permanently_delete_memory_repairs_migration_chain(graph_service):
    await graph_service.create_memory(
        parent_path="",
        content="Version 1",
        priority=2,
        title="versioned",
        disclosure="When testing chain repair",
    )
    second = await graph_service.update_memory("versioned", content="Version 2")
    third = await graph_service.update_memory("versioned", content="Version 3")

    await graph_service.permanently_delete_memory(third["old_memory_id"])

    first = await graph_service.get_memory_by_id(second["old_memory_id"])
    latest = await graph_service.get_memory_by_id(third["new_memory_id"])

    assert first["migrated_to"] == latest["memory_id"]
    assert latest["deprecated"] is False
