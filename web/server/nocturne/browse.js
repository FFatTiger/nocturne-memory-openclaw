import { sql } from '../db';

export const ROOT_NODE_UUID = '00000000-0000-0000-0000-000000000000';

function toSnippet(content) {
  const text = String(content || '');
  return text.length > 100 ? `${text.slice(0, 100)}...` : text;
}

function pickBestPath(paths, contextDomain, prefix) {
  if (!Array.isArray(paths) || paths.length === 0) return null;
  if (paths.length === 1) return paths[0];

  if (contextDomain && prefix) {
    const tier1 = paths.find((item) => item.domain === contextDomain && item.path.startsWith(prefix));
    if (tier1) return tier1;
  }

  if (contextDomain) {
    const tier2 = paths.find((item) => item.domain === contextDomain);
    if (tier2) return tier2;
  }

  return paths[0];
}

function buildBreadcrumbs(path) {
  if (!path) return [{ path: '', label: 'root' }];
  const segments = path.split('/').filter(Boolean);
  const breadcrumbs = [{ path: '', label: 'root' }];
  let accumulated = '';
  for (const seg of segments) {
    accumulated = accumulated ? `${accumulated}/${seg}` : seg;
    breadcrumbs.push({ path: accumulated, label: seg });
  }
  return breadcrumbs;
}

export async function listDomains() {
  const result = await sql(
    `
      SELECT p.domain, COUNT(DISTINCT p.path) AS root_count
      FROM paths p
      WHERE p.path NOT LIKE '%/%'
      GROUP BY p.domain
      ORDER BY p.domain ASC
    `,
  );

  return result.rows.map((row) => ({
    domain: row.domain,
    root_count: Number(row.root_count || 0),
  }));
}

async function getMemoryByPath(domain, path) {
  if (!path) {
    return {
      id: 0,
      node_uuid: ROOT_NODE_UUID,
      content: '',
      priority: 0,
      disclosure: null,
      deprecated: false,
      created_at: null,
      domain,
      path: '',
      alias_count: 0,
    };
  }

  const result = await sql(
    `
      SELECT
        p.domain,
        p.path,
        e.child_uuid AS node_uuid,
        e.priority,
        e.disclosure,
        m.id,
        m.content,
        m.deprecated,
        m.created_at
      FROM paths p
      JOIN edges e ON p.edge_id = e.id
      JOIN LATERAL (
        SELECT id, content, deprecated, created_at
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

  const row = result.rows[0];
  if (!row) return null;

  const aliasResult = await sql(
    `
      SELECT COUNT(*) AS total_paths
      FROM paths p
      JOIN edges e ON p.edge_id = e.id
      WHERE e.child_uuid = $1
    `,
    [row.node_uuid],
  );

  return {
    id: row.id,
    node_uuid: row.node_uuid,
    content: row.content,
    priority: row.priority,
    disclosure: row.disclosure,
    deprecated: row.deprecated,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
    domain: row.domain,
    path: row.path,
    alias_count: Math.max(0, Number(aliasResult.rows[0]?.total_paths || 0) - 1),
  };
}

async function getAliases(nodeUuid, domain, path) {
  if (!nodeUuid || nodeUuid === ROOT_NODE_UUID) return [];
  const result = await sql(
    `
      SELECT p.domain, p.path
      FROM paths p
      JOIN edges e ON p.edge_id = e.id
      WHERE e.child_uuid = $1
      ORDER BY p.domain, p.path
    `,
    [nodeUuid],
  );

  return result.rows
    .filter((row) => !(row.domain === domain && row.path === path))
    .map((row) => `${row.domain}://${row.path}`);
}

async function getGlossaryKeywords(nodeUuid) {
  if (!nodeUuid || nodeUuid === ROOT_NODE_UUID) return [];
  const result = await sql(
    `
      SELECT keyword
      FROM glossary_keywords
      WHERE node_uuid = $1
      ORDER BY keyword ASC
    `,
    [nodeUuid],
  );
  return result.rows.map((row) => row.keyword);
}

async function getChildren(nodeUuid, contextDomain, contextPath) {
  const childResult = await sql(
    `
      SELECT
        e.id AS edge_id,
        e.child_uuid,
        e.name,
        e.priority,
        e.disclosure,
        m.content
      FROM edges e
      JOIN LATERAL (
        SELECT content
        FROM memories
        WHERE node_uuid = e.child_uuid AND deprecated = FALSE
        ORDER BY created_at DESC
        LIMIT 1
      ) m ON TRUE
      WHERE e.parent_uuid = $1
      ORDER BY e.priority ASC, e.name ASC
    `,
    [nodeUuid],
  );

  const childRows = childResult.rows;
  if (childRows.length === 0) return [];

  const childUuids = [...new Set(childRows.map((row) => row.child_uuid))];
  const edgeIds = [...new Set(childRows.map((row) => row.edge_id))];

  const countsResult = await sql(
    `
      SELECT parent_uuid, COUNT(id) AS child_count
      FROM edges
      WHERE parent_uuid = ANY($1::text[])
      GROUP BY parent_uuid
    `,
    [childUuids],
  );
  const childCountMap = new Map(countsResult.rows.map((row) => [row.parent_uuid, Number(row.child_count || 0)]));

  const pathResult = await sql(
    `
      SELECT edge_id, domain, path
      FROM paths
      WHERE edge_id = ANY($1::int[])
      ORDER BY domain ASC, path ASC
    `,
    [edgeIds],
  );

  const pathsByEdgeId = new Map();
  for (const row of pathResult.rows) {
    const list = pathsByEdgeId.get(row.edge_id) || [];
    list.push({ domain: row.domain, path: row.path });
    pathsByEdgeId.set(row.edge_id, list);
  }

  const prefix = contextPath ? `${contextPath}/` : null;
  const children = [];
  const seen = new Set();

  for (const row of childRows) {
    if (seen.has(row.child_uuid)) continue;
    seen.add(row.child_uuid);

    const allPaths = pathsByEdgeId.get(row.edge_id) || [];
    if (nodeUuid === ROOT_NODE_UUID && contextDomain) {
      const hasDomainPath = allPaths.some((item) => item.domain === contextDomain);
      if (!hasDomainPath) continue;
    }

    const pathObj = pickBestPath(allPaths, contextDomain, prefix);
    children.push({
      node_uuid: row.child_uuid,
      edge_id: row.edge_id,
      name: row.name,
      domain: pathObj?.domain || 'core',
      path: pathObj?.path || row.name,
      uri: `${pathObj?.domain || 'core'}://${pathObj?.path || row.name}`,
      priority: row.priority,
      disclosure: row.disclosure,
      content_snippet: toSnippet(row.content),
      approx_children_count: childCountMap.get(row.child_uuid) || 0,
    });
  }

  children.sort((a, b) => {
    const priorityA = Number.isFinite(a.priority) ? a.priority : 999;
    const priorityB = Number.isFinite(b.priority) ? b.priority : 999;
    if (priorityA !== priorityB) return priorityA - priorityB;
    return a.path.localeCompare(b.path);
  });

  return children;
}

export async function getNodePayload({ domain = 'core', path = '', navOnly = false }) {
  const memory = await getMemoryByPath(domain, path);
  if (!memory) {
    const error = new Error(`Path not found: ${domain}://${path}`);
    error.status = 404;
    throw error;
  }

  const [aliases, glossaryKeywords, children] = await Promise.all([
    getAliases(memory.node_uuid, domain, path),
    navOnly ? Promise.resolve([]) : getGlossaryKeywords(memory.node_uuid),
    getChildren(memory.node_uuid, domain, path),
  ]);

  return {
    node: {
      path,
      domain,
      uri: `${domain}://${path}`,
      name: path ? path.split('/').pop() : 'root',
      content: memory.content,
      priority: memory.priority,
      disclosure: memory.disclosure,
      created_at: memory.created_at,
      is_virtual: memory.node_uuid === ROOT_NODE_UUID,
      aliases,
      node_uuid: memory.node_uuid,
      glossary_keywords: glossaryKeywords,
      glossary_matches: [],
    },
    children,
    breadcrumbs: buildBreadcrumbs(path),
  };
}
