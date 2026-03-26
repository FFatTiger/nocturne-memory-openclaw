import crypto from 'crypto';
import { sql } from '../db';

const EXACT_DISCLOSURE_TOKENS = [
  '偏好', '规则', '项目', '微信', 'browser', 'OpenClaw', 'Nocturne', '回滚',
  '字幕', 'HLTV', 'CLI', 'opencode', '前置召回', '记忆系统', 'Memory Explorer',
];

function truncate(value, maxChars) {
  const text = String(value || '').trim();
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

function dedupeTerms(values, maxItems = 8) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const text = String(value || '').trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function buildEmbeddingText(doc) {
  const pathTokens = String(doc.path || '').split(/[\/_\-\s]+/).filter((token) => token.length >= 2);
  const nameTokens = String(doc.name || '').split(/[\/_\-\s]+/).filter(Boolean);
  const glossary = Array.isArray(doc.glossary_keywords) ? doc.glossary_keywords : [];
  const disclosure = truncate(doc.disclosure, 120);
  const triggerTerms = dedupeTerms([...glossary, ...nameTokens, ...pathTokens], 8);
  const parts = [`URI: ${doc.uri}`, `Name: ${doc.name}`];
  if (triggerTerms.length) parts.push(`Triggers: ${triggerTerms.join(', ')}`);
  if (disclosure) parts.push(`Hint: ${disclosure}`);
  return parts.join('\n');
}

function buildCueText(doc) {
  const glossary = Array.isArray(doc.glossary_keywords) ? doc.glossary_keywords : [];
  const nameTokens = String(doc.name || '').split(/[\/_\-\s]+/).filter(Boolean);
  const pathTokens = String(doc.path || '').split(/[\/_\-\s]+/).filter((token) => token.length >= 2);
  const disclosure = truncate(doc.disclosure, 80);
  return dedupeTerms([...glossary, ...nameTokens, ...pathTokens, ...(disclosure ? [disclosure] : [])], 6).join(' · ');
}

function hashPayload(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function vectorLiteral(value) {
  if (Array.isArray(value)) return `[${value.map((item) => Number(item)).join(',')}]`;
  return String(value || '[]');
}

async function embedTexts(embedding, inputs) {
  const results = [];
  for (const text of inputs) {
    const response = await fetch(`${String(embedding.base_url || '').replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${embedding.api_key}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: embedding.model, input: text }),
    });
    if (!response.ok) {
      throw new Error(`Embedding request failed: ${response.status}`);
    }
    const data = await response.json();
    const rows = [...(data.data || [])].sort((a, b) => (a.index || 0) - (b.index || 0));
    if (!rows[0]?.embedding) throw new Error('Embedding response missing data rows');
    results.push(rows[0].embedding);
  }
  return results;
}

async function loadSourceDocuments() {
  const result = await sql(
    `
      SELECT p.domain, p.path, e.child_uuid AS node_uuid, e.priority, e.disclosure, m.id AS memory_id, m.content
      FROM paths p
      JOIN edges e ON p.edge_id = e.id
      JOIN LATERAL (
        SELECT id, content
        FROM memories
        WHERE node_uuid = e.child_uuid AND deprecated = FALSE
        ORDER BY created_at DESC
        LIMIT 1
      ) m ON TRUE
      ORDER BY p.domain, p.path
    `,
  );
  if (!result.rows.length) return [];

  const nodeUuids = [...new Set(result.rows.map((row) => row.node_uuid))];
  const glossaryResult = await sql(
    `SELECT node_uuid, keyword FROM glossary_keywords WHERE node_uuid = ANY($1::text[]) ORDER BY node_uuid, keyword`,
    [nodeUuids],
  );
  const glossaryMap = new Map();
  for (const row of glossaryResult.rows) {
    const list = glossaryMap.get(row.node_uuid) || [];
    list.push(row.keyword);
    glossaryMap.set(row.node_uuid, list);
  }

  return result.rows.map((row) => {
    const doc = {
      domain: row.domain,
      path: row.path,
      node_uuid: row.node_uuid,
      memory_id: row.memory_id,
      uri: `${row.domain}://${row.path}`,
      name: row.path ? row.path.split('/').pop() : 'root',
      priority: row.priority || 0,
      disclosure: row.disclosure || '',
      glossary_keywords: glossaryMap.get(row.node_uuid) || [],
      body_preview: truncate(row.content, 900),
    };
    doc.cue_text = buildCueText(doc);
    doc.embedding_text = buildEmbeddingText(doc);
    doc.source_signature = hashPayload({
      uri: doc.uri,
      memory_id: doc.memory_id,
      priority: doc.priority,
      disclosure: doc.disclosure,
      glossary_keywords: doc.glossary_keywords,
      body_preview: doc.body_preview,
      embedding_text: doc.embedding_text,
    });
    return doc;
  });
}

export async function ensureRecallIndex(embedding) {
  const sourceDocs = await loadSourceDocuments();
  const existing = await sql(`SELECT domain, path, source_signature FROM recall_documents`);
  const existingMap = new Map(existing.rows.map((row) => [`${row.domain}::${row.path}`, row]));
  const sourceMap = new Map(sourceDocs.map((doc) => [`${doc.domain}::${doc.path}`, doc]));

  const stale = sourceDocs.filter((doc) => {
    const key = `${doc.domain}::${doc.path}`;
    const row = existingMap.get(key);
    return !row || row.source_signature !== doc.source_signature;
  });

  if (stale.length) {
    const vectors = await embedTexts(embedding, stale.map((doc) => doc.embedding_text));
    for (let i = 0; i < stale.length; i += 1) {
      const doc = stale[i];
      const vector = vectors[i];
      await sql(
        `
          INSERT INTO recall_documents (
            domain, path, node_uuid, memory_id, uri, name, priority, disclosure,
            glossary_json, cue_text, body_preview, embedding_text, embedding_model,
            embedding_dim, embedding_vector, source_signature, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8,
            $9, $10, $11, $12, $13,
            $14, CAST($15 AS vector), $16, NOW()
          )
          ON CONFLICT (domain, path) DO UPDATE SET
            node_uuid = EXCLUDED.node_uuid,
            memory_id = EXCLUDED.memory_id,
            uri = EXCLUDED.uri,
            name = EXCLUDED.name,
            priority = EXCLUDED.priority,
            disclosure = EXCLUDED.disclosure,
            glossary_json = EXCLUDED.glossary_json,
            cue_text = EXCLUDED.cue_text,
            body_preview = EXCLUDED.body_preview,
            embedding_text = EXCLUDED.embedding_text,
            embedding_model = EXCLUDED.embedding_model,
            embedding_dim = EXCLUDED.embedding_dim,
            embedding_vector = EXCLUDED.embedding_vector,
            source_signature = EXCLUDED.source_signature,
            updated_at = NOW()
        `,
        [
          doc.domain,
          doc.path,
          doc.node_uuid,
          doc.memory_id,
          doc.uri,
          doc.name,
          doc.priority,
          doc.disclosure,
          JSON.stringify(doc.glossary_keywords),
          doc.cue_text,
          doc.body_preview,
          doc.embedding_text,
          embedding.model,
          vector.length,
          vectorLiteral(vector),
          doc.source_signature,
        ],
      );
    }
  }

  let deletedCount = 0;
  for (const row of existing.rows) {
    const key = `${row.domain}::${row.path}`;
    if (!sourceMap.has(key)) {
      const result = await sql(`DELETE FROM recall_documents WHERE domain = $1 AND path = $2`, [row.domain, row.path]);
      deletedCount += result.rowCount || 0;
    }
  }

  return { source_count: sourceDocs.length, updated_count: stale.length, deleted_count: deletedCount };
}

function defaultBootUris() {
  return new Set(String(process.env.CORE_MEMORY_URIS || '').split(',').map((item) => item.trim()).filter(Boolean));
}

function parseGlossary(raw) {
  try {
    const data = JSON.parse(raw || '[]');
    return Array.isArray(data) ? data.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function exactBonus(query, row) {
  const q = String(query || '').toLowerCase();
  let bonus = 0;
  const reasons = [];
  const cues = [];

  const glossaryHits = parseGlossary(row.glossary_json).filter((kw) => q.includes(kw.toLowerCase()));
  if (glossaryHits.length) {
    bonus += Math.min(0.18, 0.07 * glossaryHits.length);
    reasons.push('glossary');
    cues.push(...glossaryHits.slice(0, 3));
  }

  const name = String(row.name || '').replace(/[_-]/g, ' ');
  if (name && q.includes(name.toLowerCase())) {
    bonus += 0.08;
    reasons.push('name');
    cues.push(row.name || '');
  }

  const pathHits = String(row.path || '')
    .split(/[\/_\-\s]+/)
    .filter((token) => token.length >= 3 && q.includes(token.toLowerCase()));
  if (pathHits.length) {
    bonus += Math.min(0.1, 0.03 * pathHits.length);
    reasons.push('path');
    cues.push(...pathHits.slice(0, 3));
  }

  const disclosureText = String(row.disclosure || '').toLowerCase();
  const overlapTerms = EXACT_DISCLOSURE_TOKENS.filter((token) => q.includes(token.toLowerCase()) && disclosureText.includes(token.toLowerCase()));
  if (overlapTerms.length) {
    bonus += Math.min(0.08, 0.02 * overlapTerms.length);
    reasons.push('disclosure');
    cues.push(...overlapTerms.slice(0, 3));
  }

  return { bonus, reasons, cues: dedupeTerms(cues, 3) };
}

export async function recallMemories(body) {
  const embedding = body.embedding;
  const index = await ensureRecallIndex(embedding);
  const [queryVector] = await embedTexts(embedding, [body.query]);
  const candidateLimit = Math.max(body.limit || 12, body.max_display_items || 3, 1) * 6;

  const queryResult = await sql(
    `
      SELECT domain, path, uri, name, priority, disclosure, glossary_json, cue_text,
             1 - (embedding_vector <=> CAST($1 AS vector)) AS cosine
      FROM recall_documents
      WHERE embedding_model = $2
      ORDER BY embedding_vector <=> CAST($1 AS vector), priority ASC, char_length(path) ASC
      LIMIT $3
    `,
    [vectorLiteral(queryVector), embedding.model, candidateLimit],
  );

  const readUris = new Set();
  if (body.session_id) {
    const readResult = await sql(`SELECT uri FROM session_read_nodes WHERE session_id = $1`, [body.session_id]);
    for (const row of readResult.rows) readUris.add(row.uri);
  }

  const bootUris = body.exclude_boot_from_results === false ? new Set() : defaultBootUris();
  const ranked = queryResult.rows
    .map((row) => {
      const cosine = Number(row.cosine || 0);
      const { bonus, reasons, cues } = exactBonus(body.query, row);
      const score = cosine + bonus;
      return {
        uri: row.uri,
        score: Number(score.toFixed((body.score_precision || 2) + 4)),
        score_display: Number(score.toFixed(body.score_precision || 2)),
        cosine: Number(cosine.toFixed(6)),
        bonus: Number(bonus.toFixed(6)),
        reasons,
        cues: cues.length ? cues : String(row.cue_text || '').split('·').map((item) => item.trim()).filter(Boolean).slice(0, 3),
        read: readUris.has(row.uri),
        boot: bootUris.has(row.uri),
      };
    })
    .filter((item) => item.score >= Number(body.min_score || 0))
    .sort((a, b) => b.score - a.score || a.uri.localeCompare(b.uri));

  const candidates = ranked.slice(0, Math.max(body.limit || 12, body.max_display_items || 3));
  const display = [];
  const suppressed = { boot: 0, read: 0, score: 0 };
  for (const item of candidates) {
    if (item.boot) {
      suppressed.boot += 1;
      continue;
    }
    if (item.read) {
      const strongReadHit = item.bonus >= 0.08 || item.score >= Math.max(Number(body.min_display_score || 0.45) + 0.1, 0.62);
      if (body.read_node_display_mode === 'hard') {
        suppressed.read += 1;
        continue;
      }
      if ((body.read_node_display_mode || 'soft') === 'soft' && !strongReadHit) {
        suppressed.read += 1;
        continue;
      }
    }
    if (item.score < Number(body.min_display_score || 0.45)) {
      suppressed.score += 1;
      continue;
    }
    display.push(item);
    if (display.length >= Number(body.max_display_items || 3)) break;
  }

  return {
    query: body.query,
    index,
    candidates,
    items: display,
    suppressed,
    boot_uris: [...bootUris].sort(),
    read_node_display_mode: body.read_node_display_mode || 'soft',
  };
}
