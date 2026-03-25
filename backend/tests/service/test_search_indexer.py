async def test_search_indexer_refreshes_on_content_and_alias_changes(graph_service, search_indexer):
    await graph_service.create_memory(
        parent_path="",
        content="GraphService owns alias refreshes",
        priority=2,
        title="search_note",
        disclosure="When testing search refresh",
    )

    initial_results = await search_indexer.search("GraphService")

    await graph_service.update_memory("search_note", content="MemoryBrowser owns rendered search")
    await graph_service.add_path(
        new_path="mirrored_search_note",
        target_path="search_note",
        new_domain="project",
        target_domain="core",
        priority=4,
        disclosure="When mirroring search note",
    )

    updated_results = await search_indexer.search("MemoryBrowser")
    alias_results = await search_indexer.search("mirrored_search_note", domain="project")

    assert initial_results[0]["uri"] == "core://search_note"
    assert updated_results[0]["uri"] == "core://search_note"
    assert alias_results[0]["uri"] == "project://mirrored_search_note"
