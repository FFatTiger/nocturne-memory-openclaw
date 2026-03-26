import { sql } from '../db';
import { ROOT_NODE_UUID } from './browse';
import { NORMALIZED_DOCUMENTS_CTE } from './retrieval';
import { embedTexts, vectorLiteral } from './embeddings';

function parseUri(uri) {
  const value = String(uri || '').trim();
  if (value.includes('://')) {
    const [domain, path] = value.split('://', 2);
    return { domain: domain.trim() || 'core', path: path.replace(/^\/+|\/+$/g, '') };
  }
  return { domain: 'core', path: value.replace(/^\/+|\/+$/g, '') };
}

async function getNodeUuidByPath(domain, path) {
  if (!path) return ROOT_NODE_UUID;
  const result = await sql(
    `
      SELECT e.child_uuid AS node_uuid
      FROM paths p
      JOIN edges e ON p.edge_id = e.id
      WHERE p.domain = $1 AND p.path = $2
      LIMIT 1
    `,
    [domain, path],
  );
  return result.rows[0]?.node_uuid || null;
}

export async function getGlossary() {
  const result = await sql(
    `SELECT keyword, node_uuid FROM glossary_keywords ORDER BY keyword ASC, node_uuid ASC`,
  );
  return { glossary: result.rows };
}

export async function addGlossaryKeyword({ keyword, node_uuid }) {
  await sql(
    `INSERT INTO glossary_keywords (keyword, node_uuid, created_at) VALUES ($1, $2, NOW()) ON CONFLICT DO NOTHING`,
    [keyword, node_uuid],
  );
  return { success: true, keyword, node_uuid };
}

export async function removeGlossaryKeyword({ keyword, node_uuid }) {
  const result = await sql(
    `DELETE FROM glossary_keywords WHERE keyword = $1 AND node_uuid = $2`,
    [keyword, node_uuid],
  );
  return { success: result.rowCount > 0 };
}

export async function manageTriggers({ uri, add = [], remove = [] }) {
  const { domain, path } = parseUri(uri);
  const nodeUuid = await getNodeUuidByPath(domain, path);
  if (!nodeUuid) {
    const error = new Error(`Memory at '${domain}://${path}' not found.`);
    error.status = 404;
    throw error;
  }

  const added = [];
  const skipped_add = [];
  const removed = [];
  const skipped_remove = [];

  for (const raw of add) {
    const keyword = String(raw || '').trim();
    if (!keyword) continue;
    const before = await sql(`SELECT 1 FROM glossary_keywords WHERE keyword = $1 AND node_uuid = $2 LIMIT 1`, [keyword, nodeUuid]);
    if (before.rows[0]) {
      skipped_add.push(keyword);
      continue;
    }
    await sql(`INSERT INTO glossary_keywords (keyword, node_uuid, created_at) VALUES ($1, $2, NOW())`, [keyword, nodeUuid]);
    added.push(keyword);
  }

  for (const raw of remove) {
    const keyword = String(raw || '').trim();
    if (!keyword) continue;
    const result = await sql(`DELETE FROM glossary_keywords WHERE keyword = $1 AND node_uuid = $2`, [keyword, nodeUuid]);
    if (result.rowCount > 0) removed.push(keyword);
    else skipped_remove.push(keyword);
  }

  const currentResult = await sql(`SELECT keyword FROM glossary_keywords WHERE node_uuid = $1 ORDER BY keyword ASC`, [nodeUuid]);
  return {
    success: true,
    uri: `${domain}://${path}`,
    added,
    skipped_add,
    removed,
    skipped_remove,
    current: currentResult.rows.map((row) => row.keyword),
  };
}

function normalizeEmbedding(embedding) {
  if (!embedding || typeof embedding !== 'object') return null;
  const base_url = String(embedding.base_url || '').trim().replace(/\/$/, '');
  const api_key = String(embedding.api_key || '').trim();
  const model = String(embedding.model || '').trim();
  if (!base_url || !api_key || !model) return null;
  return { base_url, api_key, model };
}

function dedupeMatchedOn(values) {
  return [...new Set(values.map((item) => String(item || '').trim()).filter(Boolean))];
}

async function fetchLexicalSearchRows({ query, domain = null, limit = 10 }) {
  const cleanedQuery = String(query || '').trim();
  if (!cleanedQuery) return [];

  const candidateLimit = Math.max(1, Math.min(200, Number(limit) || 10));
  const params = [cleanedQuery];
  const where = [
    `(
      sd.search_vector @@ si.ts_query
      OR sd.uri ILIKE si.like_query
      OR sd.path ILIKE si.like_query
      OR sd.name ILIKE si.like_query
      OR sd.glossary_text ILIKE si.like_query
      OR sd.disclosure ILIKE si.like_query
      OR sd.latest_content ILIKE si.like_query
    )`,
  ];

  if (domain) {
    params.push(domain);
    where.push(`sd.domain = $${params.length}`);
  }
  params.push(candidateLimit);

  const result = await sql(
    `
      ${NORMALIZED_DOCUMENTS_CTE},
      search_input AS (
        SELECT
          plainto_tsquery('simple', $1) AS ts_query,
          ('%' || $1 || '%') AS like_query
      ),
      search_documents AS (
        SELECT
          nd.*,
          REGEXP_REPLACE(COALESCE(nd.latest_content, ''), E'[\n\r\t]+', ' ', 'g') AS flat_content,
          (
            setweight(to_tsvector('simple', COALESCE(nd.name, '')), 'A') ||
            setweight(to_tsvector('simple', REGEXP_REPLACE(COALESCE(nd.path, ''), '[/_\\-]+', ' ', 'g')), 'A') ||
            setweight(to_tsvector('simple', COALESCE(nd.glossary_text, '')), 'A') ||
            setweight(to_tsvector('simple', COALESCE(nd.disclosure, '')), 'B') ||
            setweight(to_tsvector('simple', COALESCE(nd.latest_content, '')), 'C')
          ) AS search_vector
        FROM normalized_documents nd
      )
      SELECT
        sd.domain,
        sd.path,
        sd.uri,
        sd.name,
        sd.priority,
        sd.disclosure,
        COALESCE(
          NULLIF(
            ts_headline(
              'simple',
              sd.flat_content,
              si.ts_query,
              'MaxFragments=2, MinWords=8, MaxWords=18, FragmentDelimiter= … '
            ),
            ''
          ),
          LEFT(sd.flat_content, 220)
        ) AS snippet,
        ts_rank_cd(sd.search_vector, si.ts_query, 32) AS fts_score,
        (
          CASE WHEN sd.uri ILIKE si.like_query THEN 0.2 ELSE 0 END +
          CASE WHEN sd.path ILIKE si.like_query THEN 0.12 ELSE 0 END +
          CASE WHEN sd.name ILIKE si.like_query THEN 0.12 ELSE 0 END +
          CASE WHEN sd.glossary_text ILIKE si.like_query THEN 0.18 ELSE 0 END +
          CASE WHEN sd.disclosure ILIKE si.like_query THEN 0.06 ELSE 0 END
        ) AS exact_score,
        (sd.search_vector @@ si.ts_query) AS fts_hit,
        (sd.uri ILIKE si.like_query) AS uri_hit,
        (sd.path ILIKE si.like_query) AS path_hit,
        (sd.name ILIKE si.like_query) AS name_hit,
        (sd.glossary_text ILIKE si.like_query) AS glossary_hit,
        (sd.disclosure ILIKE si.like_query) AS disclosure_hit,
        (sd.latest_content ILIKE si.like_query) AS content_hit
      FROM search_documents sd
      CROSS JOIN search_input si
      WHERE ${where.join(' AND ')}
      ORDER BY (ts_rank_cd(sd.search_vector, si.ts_query, 32) + (
        CASE WHEN sd.uri ILIKE si.like_query THEN 0.2 ELSE 0 END +
        CASE WHEN sd.path ILIKE si.like_query THEN 0.12 ELSE 0 END +
        CASE WHEN sd.name ILIKE si.like_query THEN 0.12 ELSE 0 END +
        CASE WHEN sd.glossary_text ILIKE si.like_query THEN 0.18 ELSE 0 END +
        CASE WHEN sd.disclosure ILIKE si.like_query THEN 0.06 ELSE 0 END
      )) DESC,
      sd.priority ASC,
      char_length(sd.path) ASC,
      sd.uri ASC
      LIMIT $${params.length}
    `,
    params,
  );

  return result.rows;
}

async function fetchSemanticSearchRows({ query, domain = null, limit = 10, embedding }) {
  const normalizedEmbedding = normalizeEmbedding(embedding);
  if (!normalizedEmbedding) return [];

  const [queryVector] = await embedTexts(normalizedEmbedding, [String(query || '').trim()]);
  const candidateLimit = Math.max(1, Math.min(200, Number(limit) || 10));
  const params = [vectorLiteral(queryVector), normalizedEmbedding.model];
  const where = [`embedding_model = $2`];

  if (domain) {
    params.push(domain);
    where.push(`domain = $${params.length}`);
  }

  params.push(candidateLimit);

  const result = await sql(
    `
      SELECT
        domain,
        path,
        uri,
        name,
        priority,
        disclosure,
        body_preview AS snippet,
        cue_text,
        1 - (embedding_vector <=> CAST($1 AS vector)) AS semantic_score
      FROM recall_documents
      WHERE ${where.join(' AND ')}
      ORDER BY embedding_vector <=> CAST($1 AS vector), priority ASC, char_length(path) ASC
      LIMIT $${params.length}
    `,
    params,
  );

  return result.rows;
}

function mergeSearchResults({ lexicalRows, semanticRows, limit }) {
  const byUri = new Map();

  for (const row of lexicalRows) {
    const ftsScore = Number(row.fts_score || 0);
    const exactScore = Number(row.exact_score || 0);
    const lexicalScore = ftsScore + exactScore;
    const matched_on = [];
    if (row.fts_hit) matched_on.push('fts');
    if (row.uri_hit) matched_on.push('uri');
    if (row.path_hit) matched_on.push('path');
    if (row.name_hit) matched_on.push('name');
    if (row.glossary_hit) matched_on.push('glossary');
    if (row.disclosure_hit) matched_on.push('disclosure');
    if (row.content_hit) matched_on.push('content');

    byUri.set(row.uri, {
      uri: row.uri,
      domain: row.domain,
      path: row.path,
      priority: row.priority,
      disclosure: row.disclosure,
      snippet: row.snippet || '',
      lexical_score: lexicalScore,
      semantic_score: 0,
      score: lexicalScore,
      score_breakdown: {
        fts: Number(ftsScore.toFixed(6)),
        exact: Number(exactScore.toFixed(6)),
        semantic: 0,
      },
      matched_on,
    });
  }

  for (const row of semanticRows) {
    const semanticScore = Number(row.semantic_score || 0);
    const existing = byUri.get(row.uri);
    if (existing) {
      existing.semantic_score = Math.max(existing.semantic_score, semanticScore);
      existing.score_breakdown.semantic = Number(existing.semantic_score.toFixed(6));
      existing.score = existing.lexical_score + existing.semantic_score * 0.55;
      existing.matched_on = dedupeMatchedOn([...existing.matched_on, 'semantic']);
      if (!existing.snippet && row.snippet) existing.snippet = row.snippet;
      continue;
    }

    byUri.set(row.uri, {
      uri: row.uri,
      domain: row.domain,
      path: row.path,
      priority: row.priority,
      disclosure: row.disclosure,
      snippet: row.snippet || '',
      lexical_score: 0,
      semantic_score: semanticScore,
      score: semanticScore * 0.55,
      score_breakdown: {
        fts: 0,
        exact: 0,
        semantic: Number(semanticScore.toFixed(6)),
      },
      matched_on: ['semantic'],
    });
  }

  return [...byUri.values()]
    .map((item) => ({
      uri: item.uri,
      domain: item.domain,
      path: item.path,
      priority: item.priority,
      disclosure: item.disclosure,
      snippet: item.snippet || '',
      score: Number(item.score.toFixed(6)),
      score_breakdown: item.score_breakdown,
      matched_on: dedupeMatchedOn(item.matched_on),
    }))
    .sort((a, b) => b.score - a.score || a.priority - b.priority || a.uri.localeCompare(b.uri))
    .slice(0, limit);
}

export async function searchMemories({ query, domain = null, limit = 10, embedding = null, hybrid = true }) {
  const cleanedQuery = String(query || '').trim();
  if (!cleanedQuery) return { results: [], meta: { query: cleanedQuery, mode: 'empty' } };

  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 10));
  const candidateLimit = Math.max(safeLimit * 4, 20);
  const lexicalRows = await fetchLexicalSearchRows({ query: cleanedQuery, domain, limit: candidateLimit });

  let semanticRows = [];
  let semanticError = null;
  const normalizedEmbedding = hybrid ? normalizeEmbedding(embedding) : null;
  if (normalizedEmbedding) {
    try {
      semanticRows = await fetchSemanticSearchRows({ query: cleanedQuery, domain, limit: candidateLimit, embedding: normalizedEmbedding });
    } catch (error) {
      semanticError = error?.message || 'Semantic search failed';
    }
  }

  const results = mergeSearchResults({ lexicalRows, semanticRows, limit: safeLimit });
  return {
    results,
    meta: {
      query: cleanedQuery,
      domain: domain || null,
      limit: safeLimit,
      mode: normalizedEmbedding ? 'hybrid' : 'lexical',
      lexical_candidates: lexicalRows.length,
      semantic_candidates: semanticRows.length,
      semantic_error: semanticError,
    },
  };
}

export async function bootView(coreMemoryUris) {
  const uris = String(coreMemoryUris || process.env.CORE_MEMORY_URIS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  const results = [];
  const failed = [];

  for (const uri of uris) {
    try {
      const { domain, path } = parseUri(uri);
      const memoryResult = await sql(
        `
          SELECT e.child_uuid AS node_uuid, e.priority, e.disclosure, m.content
          FROM paths p
          JOIN edges e ON p.edge_id = e.id
          JOIN LATERAL (
            SELECT content
            FROM memories
            WHERE node_uuid = e.child_uuid AND deprecated = FALSE
            ORDER BY created_at DESC
            LIMIT 1
          ) m ON TRUE
          WHERE p.domain = $1 AND p.path = $2
          LIMIT 1
        `,
        [domain, path],
      );
      const row = memoryResult.rows[0];
      if (!row) {
        failed.push(`- ${uri}: not found`);
        continue;
      }
      results.push({
        uri: `${domain}://${path}`,
        content: row.content || '',
        priority: row.priority || 0,
        disclosure: row.disclosure,
        node_uuid: row.node_uuid,
      });
    } catch (error) {
      failed.push(`- ${uri}: ${error.message}`);
    }
  }

  const recentResult = await sql(
    `
      SELECT p.domain, p.path, e.priority, e.disclosure, MAX(m.created_at) AS created_at
      FROM paths p
      JOIN edges e ON p.edge_id = e.id
      JOIN memories m ON m.node_uuid = e.child_uuid
      WHERE m.deprecated = FALSE
      GROUP BY p.domain, p.path, e.priority, e.disclosure
      ORDER BY created_at DESC NULLS LAST
      LIMIT 5
    `,
  );

  return {
    loaded: results.length,
    total: uris.length,
    failed,
    core_memories: results,
    recent_memories: recentResult.rows.map((row) => ({
      uri: `${row.domain}://${row.path}`,
      priority: row.priority || 0,
      disclosure: row.disclosure,
      created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
    })),
  };
}

export async function markSessionRead({ session_id, uri, node_uuid, session_key = null, source = 'tool:get_node' }) {
  let resolvedNodeUuid = node_uuid;
  if (!resolvedNodeUuid) {
    const parsed = parseUri(uri);
    resolvedNodeUuid = await getNodeUuidByPath(parsed.domain, parsed.path);
  }
  if (!resolvedNodeUuid) {
    const error = new Error(`Memory at '${uri}' not found.`);
    error.status = 404;
    throw error;
  }

  const result = await sql(
    `
      INSERT INTO session_read_nodes (session_id, uri, node_uuid, session_key, source, read_count, first_read_at, last_read_at)
      VALUES ($1, $2, $3, $4, $5, 1, NOW(), NOW())
      ON CONFLICT (session_id, uri)
      DO UPDATE SET
        node_uuid = EXCLUDED.node_uuid,
        session_key = EXCLUDED.session_key,
        source = EXCLUDED.source,
        read_count = session_read_nodes.read_count + 1,
        last_read_at = NOW()
      RETURNING session_id, uri, node_uuid, session_key, source, read_count, first_read_at, last_read_at
    `,
    [session_id, uri, resolvedNodeUuid, session_key, source],
  );
  return result.rows[0];
}

export async function listSessionReads(sessionId) {
  const result = await sql(
    `
      SELECT session_id, uri, node_uuid, session_key, source, read_count, first_read_at, last_read_at
      FROM session_read_nodes
      WHERE session_id = $1
      ORDER BY last_read_at DESC
    `,
    [sessionId],
  );
  return result.rows;
}

export async function clearSessionReads(sessionId) {
  const result = await sql(`DELETE FROM session_read_nodes WHERE session_id = $1`, [sessionId]);
  return { success: true, session_id: sessionId, cleared: result.rowCount };
}
