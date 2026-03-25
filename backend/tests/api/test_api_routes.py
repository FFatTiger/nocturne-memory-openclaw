from httpx import ASGITransport, AsyncClient


async def _seed_review_change(graph_service, mcp_module):
    await graph_service.create_memory(
        parent_path="",
        content="Original review content",
        priority=2,
        title="review_item",
        disclosure="When reviewing",
    )
    await mcp_module.update_memory("core://review_item", append="\nPending review update")


async def test_health_endpoint_reports_connected_database(api_client):
    response = await api_client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "database": "connected"}


async def test_browse_node_round_trip_update(api_client, graph_service):
    await graph_service.create_memory(
        parent_path="",
        content="Workspace content",
        priority=2,
        title="workspace",
        disclosure="When browsing workspace",
    )

    response = await api_client.get("/browse/node", params={"domain": "core", "path": "workspace"})
    assert response.status_code == 200
    assert response.json()["node"]["content"] == "Workspace content"

    update_response = await api_client.put(
        "/browse/node",
        params={"domain": "core", "path": "workspace"},
        json={
            "content": "Updated workspace content",
            "priority": 5,
            "disclosure": "When updating workspace",
        },
    )
    assert update_response.status_code == 200

    refreshed = await api_client.get("/browse/node", params={"domain": "core", "path": "workspace"})
    payload = refreshed.json()["node"]

    assert payload["content"] == "Updated workspace content"
    assert payload["priority"] == 5
    assert payload["disclosure"] == "When updating workspace"


async def test_review_group_diff_and_rollback(api_client, graph_service, mcp_module):
    await _seed_review_change(graph_service, mcp_module)

    groups = await api_client.get("/review/groups")
    group = groups.json()[0]

    diff = await api_client.get(f"/review/groups/{group['node_uuid']}/diff")
    assert diff.status_code == 200
    assert diff.json()["before_content"] == "Original review content"
    assert "Pending review update" in diff.json()["current_content"]

    rollback = await api_client.post(f"/review/groups/{group['node_uuid']}/rollback")
    assert rollback.status_code == 200
    assert rollback.json()["success"] is True

    groups_after = await api_client.get("/review/groups")
    current = await graph_service.get_memory_by_path("review_item", "core")

    assert groups_after.json() == []
    assert current["content"] == "Original review content"


async def test_review_diff_includes_path_and_glossary_changes(api_client, graph_service, mcp_module):
    await graph_service.create_memory(
        parent_path="",
        content="Searchable linked memory",
        priority=2,
        title="linked_item",
        disclosure="When diffing linked memory",
    )

    await mcp_module.add_alias(
        "project://linked_alias",
        "core://linked_item",
        priority=3,
        disclosure="When mirroring linked memory",
    )
    await mcp_module.manage_triggers("core://linked_item", add=["GraphService"])

    groups = await api_client.get("/review/groups")
    payload = groups.json()
    linked_group = payload[0]

    diff = await api_client.get(f"/review/groups/{linked_group['node_uuid']}/diff")
    payload = diff.json()

    assert any(change["action"] == "created" for change in payload["path_changes"])
    assert any(change["keyword"] == "GraphService" for change in payload["glossary_changes"])


async def test_maintenance_lists_deprecated_and_orphaned_memories(api_client, graph_service):
    await graph_service.create_memory(
        parent_path="",
        content="Deprecated source",
        priority=2,
        title="deprecated_item",
        disclosure="When testing maintenance",
    )
    await graph_service.update_memory("deprecated_item", content="Active replacement")

    await graph_service.create_memory(
        parent_path="",
        content="Orphan me",
        priority=2,
        title="orphan_leaf",
        disclosure="When testing maintenance",
    )
    await graph_service.remove_path("orphan_leaf", "core")

    response = await api_client.get("/maintenance/orphans")
    categories = {item["category"] for item in response.json()}

    assert response.status_code == 200
    assert {"deprecated", "orphaned"}.issubset(categories)


async def test_api_requires_bearer_token_when_configured(reload_module, monkeypatch):
    monkeypatch.setenv("API_TOKEN", "secret-token")

    from db import get_db_manager

    main = reload_module("main")
    await get_db_manager().init_db()

    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        unauthorized = await client.get("/browse/domains")
        authorized = await client.get(
            "/browse/domains",
            headers={"Authorization": "Bearer secret-token"},
        )

    assert unauthorized.status_code == 401
    assert authorized.status_code == 200
