async def test_glossary_keyword_scan_and_remove(glossary_service, graph_service):
    target = await graph_service.create_memory(
        parent_path="",
        content="Salem target memory",
        priority=2,
        title="glossary_target",
        disclosure="When testing glossary",
    )

    await glossary_service.add_glossary_keyword("Salem", target["node_uuid"])

    matches = await glossary_service.find_glossary_in_content("We need Salem in this memory.")
    keywords = await glossary_service.get_glossary_for_node(target["node_uuid"])

    assert "Salem" in keywords
    assert matches["Salem"][0]["uri"] == "core://glossary_target"

    removed = await glossary_service.remove_glossary_keyword("Salem", target["node_uuid"])
    keywords_after = await glossary_service.get_glossary_for_node(target["node_uuid"])

    assert removed["success"] is True
    assert keywords_after == []
