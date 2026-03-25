from db.search_terms import build_document_search_terms, expand_query_terms


def test_expand_query_terms_normalizes_paths_and_cjk_content():
    expanded = expand_query_terms("project://nocturne_memory/architecture GraphService 记忆")

    assert "project" in expanded
    assert "nocturne_memory" in expanded
    assert "architecture" in expanded
    assert "GraphService" in expanded
    assert "记忆" in expanded


def test_build_document_search_terms_includes_path_uri_glossary_and_disclosure():
    terms = build_document_search_terms(
        path="project/nocturne_memory",
        uri="project://nocturne_memory",
        content="GraphService coordinates glossary triggers",
        disclosure="当讨论架构时",
        glossary_text="Salem 豆辞典",
    )

    assert "GraphService" in terms
    assert "project" in terms
    assert "nocturne_memory" in terms
    assert "Salem" in terms
    assert "豆辞典" in terms
    assert "架构" in terms
