import { sql } from '../db';

export const NORMALIZED_DOCUMENTS_CTE = `
  WITH normalized_documents AS (
    SELECT
      p.domain,
      p.path,
      e.child_uuid AS node_uuid,
      e.priority,
      e.disclosure,
      m.id AS memory_id,
      (p.domain || '://' || p.path) AS uri,
      COALESCE(NULLIF(REGEXP_REPLACE(p.path, '^.*/', ''), ''), 'root') AS name,
      COALESCE(gk.glossary_keywords, ARRAY[]::text[]) AS glossary_keywords,
      COALESCE(gk.glossary_text, '') AS glossary_text,
      m.content AS latest_content
    FROM paths p
    JOIN edges e ON p.edge_id = e.id
    JOIN LATERAL (
      SELECT id, content
      FROM memories
      WHERE node_uuid = e.child_uuid AND deprecated = FALSE
      ORDER BY created_at DESC
      LIMIT 1
    ) m ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        COALESCE(array_agg(keyword ORDER BY keyword), ARRAY[]::text[]) AS glossary_keywords,
        COALESCE(string_agg(keyword, ' ' ORDER BY keyword), '') AS glossary_text
      FROM glossary_keywords
      WHERE node_uuid = e.child_uuid
    ) gk ON TRUE
  )
`;

export async function loadNormalizedDocuments() {
  const result = await sql(
    `
      ${NORMALIZED_DOCUMENTS_CTE}
      SELECT
        domain,
        path,
        node_uuid,
        priority,
        disclosure,
        memory_id,
        uri,
        name,
        glossary_keywords,
        glossary_text,
        latest_content
      FROM normalized_documents
      ORDER BY domain, path
    `,
  );

  return result.rows.map((row) => ({
    domain: row.domain,
    path: row.path,
    node_uuid: row.node_uuid,
    priority: row.priority || 0,
    disclosure: row.disclosure || '',
    memory_id: row.memory_id,
    uri: row.uri,
    name: row.name || 'root',
    glossary_keywords: Array.isArray(row.glossary_keywords) ? row.glossary_keywords : [],
    glossary_text: row.glossary_text || '',
    latest_content: row.latest_content || '',
  }));
}
