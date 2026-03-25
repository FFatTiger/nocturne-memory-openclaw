from db.snapshot import ChangesetStore


def test_changeset_store_overwrites_after_state_but_keeps_before_state(tmp_path):
    store = ChangesetStore(snapshot_dir=str(tmp_path))

    store.record(
        "edges",
        {"id": 1, "priority": 1, "disclosure": "before"},
        {"id": 1, "priority": 2, "disclosure": "mid"},
    )
    store.record(
        "edges",
        {"id": 1, "priority": 2, "disclosure": "mid"},
        {"id": 1, "priority": 3, "disclosure": "after"},
    )

    row = store.get_all_rows_dict()["edges:1"]

    assert row["before"]["priority"] == 1
    assert row["after"]["priority"] == 3
    assert store.get_change_count() == 1


def test_changeset_store_gc_removes_create_then_delete_subtree_noise(tmp_path):
    store = ChangesetStore(snapshot_dir=str(tmp_path))

    created = {
        "nodes": [{"uuid": "node-1"}],
        "memories": [{"id": 1, "node_uuid": "node-1"}],
        "edges": [{"id": 1, "parent_uuid": "root", "child_uuid": "node-1"}],
        "paths": [{"domain": "core", "path": "temp", "edge_id": 1}],
    }
    deleted_path = {
        "paths": [{"domain": "core", "path": "temp", "edge_id": 1}],
    }

    store.record_many(before_state={}, after_state=created)
    store.record_many(before_state=deleted_path, after_state={})

    assert store.get_change_count() == 0
    assert store.get_all_rows_dict() == {}
