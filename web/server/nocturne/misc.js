import { sql } from '../db';
import { ROOT_NODE_UUID } from './browse';

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

export async function searchMemories({ query, domain = null, limit = 10 }) {
  const where = [`(p.path ILIKE $1 OR m.content ILIKE $1)`];
  const params = [`%${query}%`];
  if (domain) {
    params.push(domain);
    where.push(`p.domain = $${params.length}`);
  }
  params.push(limit);

  const result = await sql(
    `
      SELECT p.domain, p.path, e.priority, e.disclosure,
             LEFT(REGEXP_REPLACE(m.content, E'[\n\r\t]+', ' ', 'g'), 220) AS snippet
      FROM paths p
      JOIN edges e ON p.edge_id = e.id
      JOIN LATERAL (
        SELECT content
        FROM memories
        WHERE node_uuid = e.child_uuid AND deprecated = FALSE
        ORDER BY created_at DESC
        LIMIT 1
      ) m ON TRUE
      WHERE ${where.join(' AND ')}
      ORDER BY e.priority ASC, p.path ASC
      LIMIT $${params.length}
    `,
    params,
  );

  return result.rows.map((row) => ({
    uri: `${row.domain}://${row.path}`,
    domain: row.domain,
    path: row.path,
    priority: row.priority,
    disclosure: row.disclosure,
    snippet: row.snippet || '',
  }));
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
