import { sql } from '../db';

async function resolveMigrationChain(memoryId) {
  let currentId = memoryId;
  while (currentId) {
    const memoryResult = await sql(
      `SELECT id, node_uuid, content, created_at, deprecated, migrated_to FROM memories WHERE id = $1 LIMIT 1`,
      [currentId],
    );
    const memory = memoryResult.rows[0];
    if (!memory) return null;

    if (!memory.migrated_to) {
      const pathsResult = await sql(
        `
          SELECT p.domain, p.path
          FROM paths p
          JOIN edges e ON p.edge_id = e.id
          WHERE e.child_uuid = $1
          ORDER BY p.domain, p.path
        `,
        [memory.node_uuid],
      );
      const paths = pathsResult.rows.map((row) => `${row.domain}://${row.path}`);
      return {
        id: memory.id,
        content: memory.content,
        content_snippet: memory.content.length > 200 ? `${memory.content.slice(0, 200)}...` : memory.content,
        created_at: memory.created_at ? new Date(memory.created_at).toISOString() : null,
        deprecated: memory.deprecated,
        paths,
      };
    }

    currentId = memory.migrated_to;
  }

  return null;
}

export async function listOrphans() {
  const result = await sql(
    `
      SELECT id, content, created_at, deprecated, migrated_to
      FROM memories
      WHERE deprecated = TRUE
      ORDER BY created_at DESC
    `,
  );

  const items = [];
  for (const memory of result.rows) {
    const item = {
      id: memory.id,
      content_snippet: memory.content.length > 200 ? `${memory.content.slice(0, 200)}...` : memory.content,
      created_at: memory.created_at ? new Date(memory.created_at).toISOString() : null,
      deprecated: true,
      migrated_to: memory.migrated_to,
      category: memory.migrated_to ? 'deprecated' : 'orphaned',
      migration_target: null,
    };

    if (memory.migrated_to) {
      const target = await resolveMigrationChain(memory.migrated_to);
      if (target) {
        item.migration_target = {
          id: target.id,
          paths: target.paths,
          content_snippet: target.content_snippet,
        };
      }
    }

    items.push(item);
  }

  return items;
}

export async function getOrphanDetail(memoryId) {
  const result = await sql(
    `SELECT id, content, created_at, deprecated, migrated_to FROM memories WHERE id = $1 LIMIT 1`,
    [memoryId],
  );
  const memory = result.rows[0];
  if (!memory) return null;

  const detail = {
    id: memory.id,
    content: memory.content,
    created_at: memory.created_at ? new Date(memory.created_at).toISOString() : null,
    deprecated: memory.deprecated,
    migrated_to: memory.migrated_to,
    category: !memory.deprecated ? 'active' : memory.migrated_to ? 'deprecated' : 'orphaned',
    migration_target: null,
  };

  if (memory.migrated_to) {
    const target = await resolveMigrationChain(memory.migrated_to);
    if (target) {
      detail.migration_target = {
        id: target.id,
        content: target.content,
        paths: target.paths,
        created_at: target.created_at,
      };
    }
  }

  return detail;
}

export async function permanentlyDeleteDeprecatedMemory(memoryId) {
  const client = await (await import('../db')).getPool().connect();
  try {
    await client.query('BEGIN');

    const targetResult = await client.query(
      `SELECT id, node_uuid, deprecated, migrated_to FROM memories WHERE id = $1 LIMIT 1`,
      [memoryId],
    );
    const target = targetResult.rows[0];
    if (!target) {
      const error = new Error(`Memory ${memoryId} not found`);
      error.status = 404;
      throw error;
    }
    if (!target.deprecated) {
      const error = new Error(`Memory ${memoryId} is active (deprecated=false). Deletion aborted.`);
      error.status = 409;
      throw error;
    }

    await client.query(
      `UPDATE memories SET migrated_to = $2 WHERE migrated_to = $1`,
      [memoryId, target.migrated_to],
    );
    await client.query(`DELETE FROM memories WHERE id = $1`, [memoryId]);

    if (target.node_uuid) {
      const countResult = await client.query(`SELECT COUNT(*) AS count FROM memories WHERE node_uuid = $1`, [target.node_uuid]);
      if (Number(countResult.rows[0]?.count || 0) === 0) {
        await client.query(`DELETE FROM glossary_keywords WHERE node_uuid = $1`, [target.node_uuid]);
        await client.query(`DELETE FROM paths WHERE edge_id IN (SELECT id FROM edges WHERE parent_uuid = $1 OR child_uuid = $1)`, [target.node_uuid]);
        await client.query(`DELETE FROM edges WHERE parent_uuid = $1 OR child_uuid = $1`, [target.node_uuid]);
        await client.query(`DELETE FROM nodes WHERE uuid = $1`, [target.node_uuid]);
      }
    }

    await client.query('COMMIT');
    return { deleted_memory_id: memoryId, chain_repaired_to: target.migrated_to };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
