import crypto from 'crypto';
import { getPool } from '../db';
import { ROOT_NODE_UUID } from './browse';

async function getPathContext(client, domain, path) {
  const result = await client.query(
    `
      SELECT p.domain, p.path, e.id AS edge_id, e.parent_uuid, e.child_uuid, e.name, e.priority, e.disclosure
      FROM paths p
      JOIN edges e ON p.edge_id = e.id
      WHERE p.domain = $1 AND p.path = $2
      LIMIT 1
    `,
    [domain, path],
  );
  return result.rows[0] || null;
}

const PATH_SEGMENT_RE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

function assertValidPathSegment(value, label = 'path segment') {
  const segment = String(value || '').trim();
  if (!segment) {
    const error = new Error(`${label} is required`);
    error.status = 422;
    throw error;
  }
  if (!PATH_SEGMENT_RE.test(segment)) {
    const error = new Error(`${label} must use snake_case ASCII only (lowercase letters, digits, underscores; no Chinese, spaces, or hyphens)`);
    error.status = 422;
    throw error;
  }
  return segment;
}

function assertValidPathSegments(path, label = 'path') {
  const segments = String(path || '').split('/').map((segment) => segment.trim()).filter(Boolean);
  if (!segments.length) {
    const error = new Error(`${label} must include at least one path segment`);
    error.status = 422;
    throw error;
  }
  for (const segment of segments) {
    assertValidPathSegment(segment, label);
  }
  return segments;
}

export async function updateNodeByPath({ domain = 'core', path, content, priority, disclosure }) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    const ctx = await getPathContext(client, domain, path);
    if (!ctx) {
      const error = new Error(`Path not found: ${domain}://${path}`);
      error.status = 404;
      throw error;
    }

    if (content !== undefined) {
      const currentMemoryResult = await client.query(
        `
          SELECT id, content
          FROM memories
          WHERE node_uuid = $1 AND deprecated = FALSE
          ORDER BY created_at DESC
          LIMIT 1
          FOR UPDATE
        `,
        [ctx.child_uuid],
      );
      const currentMemory = currentMemoryResult.rows[0];
      if (currentMemory && currentMemory.content !== content) {
        await client.query(
          `
            UPDATE memories
            SET deprecated = TRUE, migrated_to = NULL
            WHERE id = $1
          `,
          [currentMemory.id],
        );
        await client.query(
          `
            INSERT INTO memories (node_uuid, content, deprecated, migrated_to, created_at)
            VALUES ($1, $2, FALSE, NULL, NOW())
          `,
          [ctx.child_uuid, content],
        );
      }
    }

    if (priority !== undefined || disclosure !== undefined) {
      await client.query(
        `
          UPDATE edges
          SET priority = COALESCE($2, priority),
              disclosure = CASE WHEN $3::text IS NULL THEN disclosure ELSE $3 END
          WHERE id = $1
        `,
        [ctx.edge_id, priority ?? null, disclosure ?? null],
      );
    }

    await client.query('COMMIT');
    return { success: true, node_uuid: ctx.child_uuid };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function createNode({ domain = 'core', parentPath = '', content, priority = 0, title, disclosure = null }) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    let parentUuid = ROOT_NODE_UUID;
    if (parentPath) {
      const parentCtx = await getPathContext(client, domain, parentPath);
      if (!parentCtx) {
        const error = new Error(`Parent path not found: ${domain}://${parentPath}`);
        error.status = 422;
        throw error;
      }
      parentUuid = parentCtx.child_uuid;
    }

    let name = (title || '').trim();
    if (!name) {
      const siblingResult = await client.query(`SELECT name FROM edges WHERE parent_uuid = $1`, [parentUuid]);
      let maxNum = 0;
      for (const row of siblingResult.rows) {
        const n = Number(row.name);
        if (Number.isFinite(n)) maxNum = Math.max(maxNum, n);
      }
      name = String(maxNum + 1);
    }
    name = assertValidPathSegment(name, 'title/path segment');

    const childUuid = crypto.randomUUID();
    await client.query(`INSERT INTO nodes (uuid, created_at) VALUES ($1, NOW())`, [childUuid]);
    await client.query(
      `INSERT INTO memories (node_uuid, content, deprecated, migrated_to, created_at) VALUES ($1, $2, FALSE, NULL, NOW())`,
      [childUuid, content],
    );
    const edgeResult = await client.query(
      `
        INSERT INTO edges (parent_uuid, child_uuid, name, priority, disclosure, created_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        RETURNING id
      `,
      [parentUuid, childUuid, name, priority, disclosure],
    );
    const edgeId = edgeResult.rows[0].id;
    const path = parentPath ? `${parentPath}/${name}` : name;
    await client.query(`INSERT INTO paths (domain, path, edge_id, created_at) VALUES ($1, $2, $3, NOW())`, [domain, path, edgeId]);

    await client.query('COMMIT');
    return { success: true, uri: `${domain}://${path}`, path, node_uuid: childUuid };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function parseUri(uri) {
  const value = String(uri || '').trim();
  if (value.includes('://')) {
    const [d, p] = value.split('://', 2);
    return { domain: d.trim() || 'core', path: p.replace(/^\/+|\/+$/g, '') };
  }
  return { domain: 'core', path: value.replace(/^\/+|\/+$/g, '') };
}

export async function addAlias({ new_uri, target_uri, priority = 0, disclosure = null }) {
  const target = parseUri(target_uri);
  const alias = parseUri(new_uri);
  const aliasSegments = assertValidPathSegments(alias.path, 'new_uri path');

  const parentPath = aliasSegments.slice(0, -1).join('/');
  const name = aliasSegments[aliasSegments.length - 1];

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    const targetCtx = await getPathContext(client, target.domain, target.path);
    if (!targetCtx) {
      const error = new Error(`Target path not found: ${target.domain}://${target.path}`);
      error.status = 422;
      throw error;
    }

    let parentUuid = ROOT_NODE_UUID;
    if (parentPath) {
      const parentCtx = await getPathContext(client, alias.domain, parentPath);
      if (!parentCtx) {
        const error = new Error(`Alias parent path not found: ${alias.domain}://${parentPath}`);
        error.status = 422;
        throw error;
      }
      parentUuid = parentCtx.child_uuid;
    }

    const existingEdge = await client.query(
      `SELECT id FROM edges WHERE parent_uuid = $1 AND child_uuid = $2 LIMIT 1`,
      [parentUuid, targetCtx.child_uuid],
    );
    let edgeId = existingEdge.rows[0]?.id;
    if (!edgeId) {
      const edgeResult = await client.query(
        `
          INSERT INTO edges (parent_uuid, child_uuid, name, priority, disclosure, created_at)
          VALUES ($1, $2, $3, $4, $5, NOW())
          RETURNING id
        `,
        [parentUuid, targetCtx.child_uuid, name, priority, disclosure],
      );
      edgeId = edgeResult.rows[0].id;
    }

    await client.query(`INSERT INTO paths (domain, path, edge_id, created_at) VALUES ($1, $2, $3, NOW())`, [alias.domain, alias.path, edgeId]);
    await client.query('COMMIT');
    return { success: true, new_uri: `${alias.domain}://${alias.path}`, target_uri: `${target.domain}://${target.path}` };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteNodeByPath({ domain = 'core', path }) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    const baseCtx = await getPathContext(client, domain, path);
    if (!baseCtx) {
      const error = new Error(`Path not found: ${domain}://${path}`);
      error.status = 404;
      throw error;
    }

    const pathRows = await client.query(
      `
        SELECT p.domain, p.path, p.edge_id, e.child_uuid
        FROM paths p
        JOIN edges e ON p.edge_id = e.id
        WHERE p.domain = $1 AND (p.path = $2 OR p.path LIKE $3)
        ORDER BY LENGTH(p.path) DESC
      `,
      [domain, path, `${path}/%`],
    );

    const edgeIds = [...new Set(pathRows.rows.map((row) => row.edge_id))];
    const affectedNodeUuids = [...new Set(pathRows.rows.map((row) => row.child_uuid))];

    await client.query(
      `DELETE FROM paths WHERE domain = $1 AND (path = $2 OR path LIKE $3)`,
      [domain, path, `${path}/%`],
    );

    for (const edgeId of edgeIds) {
      const refCount = await client.query(`SELECT COUNT(*) AS count FROM paths WHERE edge_id = $1`, [edgeId]);
      if (Number(refCount.rows[0]?.count || 0) === 0) {
        await client.query(`DELETE FROM edges WHERE id = $1`, [edgeId]);
      }
    }

    for (const nodeUuid of affectedNodeUuids) {
      const pathCount = await client.query(
        `SELECT COUNT(*) AS count FROM paths p JOIN edges e ON p.edge_id = e.id WHERE e.child_uuid = $1`,
        [nodeUuid],
      );
      if (Number(pathCount.rows[0]?.count || 0) === 0) {
        await client.query(
          `UPDATE memories SET deprecated = TRUE, migrated_to = NULL WHERE node_uuid = $1 AND deprecated = FALSE`,
          [nodeUuid],
        );
      }
    }

    await client.query('COMMIT');
    return { success: true, deleted_uri: `${domain}://${path}` };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
