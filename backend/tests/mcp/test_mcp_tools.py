async def test_read_memory_system_views(mcp_module, graph_service):
    await graph_service.create_memory(
        parent_path="",
        content="Agent identity",
        priority=1,
        title="agent",
        disclosure="When booting",
    )
    await graph_service.create_memory(
        parent_path="",
        content="User identity",
        priority=1,
        title="my_user",
        disclosure="When booting",
    )

    boot = await mcp_module.read_memory("system://boot")
    index_view = await mcp_module.read_memory("system://index/core")
    recent = await mcp_module.read_memory("system://recent/5")

    assert "core://agent" in boot
    assert "core://my_user" in boot
    assert "core://agent" in index_view
    assert "core://my_user" in recent


async def test_mcp_tool_flow_covers_crud_alias_triggers_and_search(mcp_module, graph_service):
    created = await mcp_module.create_memory(
        "core://",
        "Important Salem memory",
        priority=2,
        title="salem_note",
        disclosure="When testing MCP tools",
    )
    updated = await mcp_module.update_memory(
        "core://salem_note",
        append="\nGraphService handles aliases.",
    )
    triggers = await mcp_module.manage_triggers(
        "core://salem_note",
        add=["Salem"],
    )
    search = await mcp_module.search_memory("GraphService")
    alias = await mcp_module.add_alias(
        "project://salem_alias",
        "core://salem_note",
        priority=3,
        disclosure="When mirroring note",
    )
    deleted = await mcp_module.delete_memory("project://salem_alias")

    current = await graph_service.get_memory_by_path("salem_note", "core")
    removed_alias = await graph_service.get_memory_by_path("salem_alias", "project")

    assert "Success: Memory created" in created
    assert "Success: Memory at 'core://salem_note' updated" == updated
    assert "Added: Salem" in triggers
    assert "core://salem_note" in search
    assert "Success: Alias 'project://salem_alias'" in alias
    assert "Success: Memory 'project://salem_alias' deleted." in deleted
    assert current["content"].endswith("GraphService handles aliases.")
    assert removed_alias is None
