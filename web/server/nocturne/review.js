import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { sql } from '../db';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../../');
const DEFAULT_SNAPSHOT_DIR = process.env.SNAPSHOT_DIR || path.join(REPO_ROOT, 'snapshots');
const CHANGESET_PATH = path.join(DEFAULT_SNAPSHOT_DIR, 'changeset.json');

const TABLE_PKS = {
  nodes: 'uuid',
  memories: 'id',
  edges: 'id',
  paths: ['domain', 'path'],
  glossary_keywords: ['keyword', 'node_uuid'],
};

function makeRowKey(table, row) {
  const pkDef = TABLE_PKS[table];
  if (Array.isArray(pkDef)) {
    return `${table}:${pkDef.map((key) => String(row[key])).join('|')}`;
  }
  return `${table}:${String(row[pkDef])}`;
}

function rowsEqual(table, a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (table === 'glossary_keywords') {
    const clean = (value) => {
      const out = { ...value };
      delete out.id;
      delete out.created_at;
      return out;
    };
    return JSON.stringify(clean(a)) === JSON.stringify(clean(b));
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

async function loadChangeset() {
  try {
    const raw = await fs.readFile(CHANGESET_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed?.rows ? parsed : { rows: {} };
  } catch {
    return { rows: {} };
  }
}

async function saveChangeset(data) {
  await fs.mkdir(DEFAULT_SNAPSHOT_DIR, { recursive: true });
  await fs.writeFile(CHANGESET_PATH, JSON.stringify(data, null, 2), 'utf8');
}

async function removeChangesetFile() {
  try {
    await fs.unlink(CHANGESET_PATH);
  } catch {}
}

function getAllRows(data) {
  return Object.values(data?.rows || {});
}

function getChangedRows(data) {
  return getAllRows(data).filter((entry) => !rowsEqual(entry.table, entry.before, entry.after));
}

function resolveNodeUuidSync(row, allRows, dbEdgeToNode) {
  const table = row.table;
  const ref = row.before || row.after;
  if (!ref) return null;
  if (table === 'nodes') return ref.uuid || null;
  if (table === 'memories') return ref.node_uuid || null;
  if (table === 'glossary_keywords') return ref.node_uuid || null;
  if (table === 'edges') return ref.child_uuid || null;
  if (table === 'paths') {
    if (ref.node_uuid) return ref.node_uuid;
    const edgeId = ref.edge_id;
    if (edgeId != null) {
      for (const item of allRows) {
        if (item.table !== 'edges') continue;
        const edgeRef = item.before || item.after;
        if (edgeRef?.id === edgeId && edgeRef?.child_uuid) return edgeRef.child_uuid;
      }
      return dbEdgeToNode[edgeId] || null;
    }
  }
  return null;
}

async function buildEdgeResolutionMap(allRows) {
  const edgeIds = new Set();
  for (const row of allRows) {
    if (row.table !== 'paths') continue;
    const ref = row.before || row.after;
    if (ref?.edge_id != null) edgeIds.add(ref.edge_id);
  }
  if (!edgeIds.size) return {};
  const result = await sql(`SELECT id, child_uuid FROM edges WHERE id = ANY($1::int[])`, [[...edgeIds]]);
  return Object.fromEntries(result.rows.map((row) => [row.id, row.child_uuid]));
}

function extractTopTable(rows) {
  const TABLE_RANK = { nodes: 5, memories: 4, edges: 3, paths: 2, glossary_keywords: 1 };
  const RANK_TO_TABLE = { 5: 'nodes', 4: 'memories', 3: 'edges', 2: 'paths', 1: 'glossary_keywords' };
  const topRank = Math.max(...rows.map((row) => TABLE_RANK[row.table] || 1), 1);
  return RANK_TO_TABLE[topRank];
}

async function findDisplayUri(nodeUuid, allRows, dbEdgeToNode) {
  for (const row of allRows) {
    if (row.table !== 'paths') continue;
    if (resolveNodeUuidSync(row, allRows, dbEdgeToNode) !== nodeUuid) continue;
    const ref = row.before || row.after;
    if (ref) return `${ref.domain || 'core'}://${ref.path || ''}`;
  }

  const liveResult = await sql(
    `
      SELECT p.domain, p.path
      FROM paths p
      JOIN edges e ON p.edge_id = e.id
      WHERE e.child_uuid = $1
      ORDER BY p.domain, p.path
      LIMIT 1
    `,
    [nodeUuid],
  );
  const live = liveResult.rows[0];
  if (live) return `${live.domain}://${live.path}`;
  return `[unmapped]/${nodeUuid}`;
}

async function extractContentAndMeta(rows, slot, nodeUuid) {
  let memoryId = null;
  const meta = { priority: null, disclosure: null };

  for (const row of rows) {
    const data = row[slot];
    if (!data) continue;
    if (row.table === 'memories' && !data.deprecated) memoryId = data.id;
    if (row.table === 'edges') {
      meta.priority = data.priority ?? null;
      meta.disclosure = data.disclosure ?? null;
    }
  }

  let content = null;
  if (memoryId != null) {
    const result = await sql(`SELECT content FROM memories WHERE id = $1 LIMIT 1`, [memoryId]);
    content = result.rows[0]?.content ?? null;
  } else {
    const shouldFetchActive = slot === 'after' || rows.every((row) => row.table !== 'memories');
    if (shouldFetchActive) {
      const result = await sql(
        `
          SELECT content
          FROM memories
          WHERE node_uuid = $1 AND deprecated = FALSE
          ORDER BY created_at DESC
          LIMIT 1
        `,
        [nodeUuid],
      );
      content = result.rows[0]?.content ?? null;
    }
  }

  if (meta.priority == null && meta.disclosure == null) {
    const edgeResult = await sql(
      `SELECT priority, disclosure FROM edges WHERE child_uuid = $1 ORDER BY id LIMIT 1`,
      [nodeUuid],
    );
    if (edgeResult.rows[0]) {
      meta.priority = edgeResult.rows[0].priority;
      meta.disclosure = edgeResult.rows[0].disclosure;
    }
  }

  return { content, meta };
}

export async function listReviewGroups() {
  const data = await loadChangeset();
  const allRows = getAllRows(data);
  const changedRows = getChangedRows(data);
  const dbEdgeToNode = await buildEdgeResolutionMap(allRows);

  const groups = new Map();
  for (const row of changedRows) {
    const ref = row.before || row.after;
    if (!ref) continue;
    const key = makeRowKey(row.table, ref);
    const nodeUuid = resolveNodeUuidSync(row, allRows, dbEdgeToNode);
    if (!nodeUuid) continue;
    const list = groups.get(nodeUuid) || [];
    list.push({ ...row, __key: key });
    groups.set(nodeUuid, list);
  }

  const result = [];
  for (const [nodeUuid, rows] of groups.entries()) {
    const topTable = extractTopTable(rows);
    const topRows = rows.filter((row) => row.table === topTable);
    let action = 'modified';
    if (topRows.every((row) => row.before == null && row.after != null)) action = 'created';
    else if (topRows.every((row) => row.before != null && row.after == null)) action = 'deleted';

    result.push({
      node_uuid: nodeUuid,
      display_uri: await findDisplayUri(nodeUuid, allRows, dbEdgeToNode),
      top_level_table: topTable,
      action,
      row_count: rows.length,
    });
  }

  return result.sort((a, b) => a.display_uri.localeCompare(b.display_uri));
}

export async function getReviewGroupDiff(nodeUuid) {
  const data = await loadChangeset();
  const allRows = getAllRows(data);
  const changedRows = getChangedRows(data);
  const dbEdgeToNode = await buildEdgeResolutionMap(allRows);

  const rows = changedRows.filter((row) => resolveNodeUuidSync(row, allRows, dbEdgeToNode) === nodeUuid);
  if (!rows.length) {
    const error = new Error(`No changes for node '${nodeUuid}'`);
    error.status = 404;
    throw error;
  }

  const topTable = extractTopTable(rows);
  const topRows = rows.filter((row) => row.table === topTable);
  let action = 'modified';
  if (topRows.every((row) => row.before == null && row.after != null)) action = 'created';
  else if (topRows.every((row) => row.before != null && row.after == null)) action = 'deleted';

  const path_changes = [];
  const glossary_changes = [];
  for (const row of rows) {
    if (row.table === 'paths') {
      if (!row.before && row.after) path_changes.push({ action: 'created', uri: `${row.after.domain}://${row.after.path}` });
      if (row.before && !row.after) path_changes.push({ action: 'deleted', uri: `${row.before.domain}://${row.before.path}` });
    }
    if (row.table === 'glossary_keywords') {
      if (!row.before && row.after) glossary_changes.push({ action: 'created', keyword: row.after.keyword });
      if (row.before && !row.after) glossary_changes.push({ action: 'deleted', keyword: row.before.keyword });
    }
  }

  const activePathsResult = await sql(
    `
      SELECT p.domain, p.path
      FROM paths p
      JOIN edges e ON p.edge_id = e.id
      WHERE e.child_uuid = $1
      ORDER BY p.domain, p.path
    `,
    [nodeUuid],
  );
  const active_paths = activePathsResult.rows.map((row) => `${row.domain}://${row.path}`);

  const beforeState = await extractContentAndMeta(rows, 'before', nodeUuid);
  const afterState = await extractContentAndMeta(rows, 'after', nodeUuid);

  return {
    uri: nodeUuid,
    change_type: topTable,
    action,
    before_content: beforeState.content,
    current_content: afterState.content,
    before_meta: beforeState.meta,
    current_meta: afterState.meta,
    path_changes: path_changes.length ? path_changes : null,
    glossary_changes: glossary_changes.length ? glossary_changes : null,
    active_paths: active_paths.length ? active_paths : null,
    has_changes:
      beforeState.content !== afterState.content ||
      JSON.stringify(beforeState.meta) !== JSON.stringify(afterState.meta) ||
      glossary_changes.length > 0 ||
      path_changes.length > 0,
  };
}

export async function approveReviewGroup(nodeUuid) {
  const data = await loadChangeset();
  const allRows = getAllRows(data);
  const dbEdgeToNode = await buildEdgeResolutionMap(allRows);

  const keysToRemove = [];
  for (const row of allRows) {
    const ref = row.before || row.after;
    if (!ref) continue;
    if (resolveNodeUuidSync(row, allRows, dbEdgeToNode) === nodeUuid) {
      keysToRemove.push(makeRowKey(row.table, ref));
    }
  }

  if (!keysToRemove.length) {
    const error = new Error(`No changes for '${nodeUuid}'`);
    error.status = 404;
    throw error;
  }

  for (const key of keysToRemove) {
    delete data.rows[key];
  }

  if (Object.keys(data.rows).length === 0) await removeChangesetFile();
  else await saveChangeset(data);

  return { message: `Approved node '${nodeUuid}' (${keysToRemove.length} rows cleared)` };
}

function getTableColumns(table) {
  switch (table) {
    case 'nodes':
      return ['uuid', 'created_at'];
    case 'memories':
      return ['id', 'node_uuid', 'content', 'deprecated', 'migrated_to', 'created_at'];
    case 'edges':
      return ['id', 'parent_uuid', 'child_uuid', 'name', 'priority', 'disclosure', 'created_at'];
    case 'paths':
      return ['domain', 'path', 'edge_id', 'created_at'];
    case 'glossary_keywords':
      return ['id', 'keyword', 'node_uuid', 'created_at'];
    default:
      return [];
  }
}

function getPkColumns(table) {
  const def = TABLE_PKS[table];
  return Array.isArray(def) ? def : [def];
}

async function insertSnapshotRow(client, table, row) {
  const columns = getTableColumns(table).filter((column) => Object.prototype.hasOwnProperty.call(row, column));
  const values = columns.map((_, index) => `$${index + 1}`);
  const sqlText = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${values.join(', ')}) ON CONFLICT DO NOTHING`;
  await client.query(sqlText, columns.map((column) => row[column]));
}

async function deleteSnapshotRow(client, table, row) {
  const pkColumns = getPkColumns(table);
  const where = pkColumns.map((column, index) => `${column} = $${index + 1}`).join(' AND ');
  await client.query(`DELETE FROM ${table} WHERE ${where}`, pkColumns.map((column) => row[column]));
}

async function updateSnapshotRow(client, table, beforeRow, afterRow) {
  const pkColumns = getPkColumns(table);
  const assignable = getTableColumns(table).filter(
    (column) => !pkColumns.includes(column) && Object.prototype.hasOwnProperty.call(beforeRow, column),
  );
  if (!assignable.length) return;
  const setClause = assignable.map((column, index) => `${column} = $${index + 1}`).join(', ');
  const whereClause = pkColumns
    .map((column, index) => `${column} = $${assignable.length + index + 1}`)
    .join(' AND ');
  const values = [
    ...assignable.map((column) => beforeRow[column]),
    ...pkColumns.map((column) => (afterRow || beforeRow)[column]),
  ];
  await client.query(`UPDATE ${table} SET ${setClause} WHERE ${whereClause}`, values);
}

export async function rollbackReviewGroup(nodeUuid) {
  const data = await loadChangeset();
  const allRows = getAllRows(data);
  const changedRows = getChangedRows(data);
  const dbEdgeToNode = await buildEdgeResolutionMap(allRows);
  const rows = changedRows.filter((row) => resolveNodeUuidSync(row, allRows, dbEdgeToNode) === nodeUuid);
  if (!rows.length) {
    const error = new Error(`No changes for '${nodeUuid}'`);
    error.status = 404;
    throw error;
  }

  const client = await (await import('../db')).getPool().connect();
  try {
    await client.query('BEGIN');

    const createdRows = rows.filter((row) => row.before == null && row.after != null);
    const deletedRows = rows.filter((row) => row.before != null && row.after == null);
    const updatedRows = rows.filter((row) => row.before != null && row.after != null);

    const deleteOrder = ['paths', 'glossary_keywords', 'edges', 'memories', 'nodes'];
    for (const table of deleteOrder) {
      for (const row of createdRows.filter((item) => item.table === table)) {
        await deleteSnapshotRow(client, table, row.after);
      }
    }

    const insertOrder = ['nodes', 'memories', 'edges', 'paths', 'glossary_keywords'];
    for (const table of insertOrder) {
      for (const row of deletedRows.filter((item) => item.table === table)) {
        await insertSnapshotRow(client, table, row.before);
      }
    }

    for (const row of updatedRows) {
      await updateSnapshotRow(client, row.table, row.before, row.after);
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  const keysToRemove = [];
  for (const row of allRows) {
    const ref = row.before || row.after;
    if (!ref) continue;
    if (resolveNodeUuidSync(row, allRows, dbEdgeToNode) === nodeUuid) {
      keysToRemove.push(makeRowKey(row.table, ref));
    }
  }
  for (const key of keysToRemove) delete data.rows[key];
  if (Object.keys(data.rows).length === 0) await removeChangesetFile();
  else await saveChangeset(data);

  return { node_uuid: nodeUuid, success: true, message: `Rolled back ${rows.length} tracked row changes.` };
}

export async function clearAllReviewGroups() {
  const data = await loadChangeset();
  const count = getChangedRows(data).length;
  if (count === 0) {
    const error = new Error('No pending changes');
    error.status = 404;
    throw error;
  }
  await removeChangesetFile();
  return { message: `All changes integrated (${count} row changes cleared)` };
}
