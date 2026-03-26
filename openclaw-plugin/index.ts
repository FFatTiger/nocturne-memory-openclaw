const DEFAULT_BASE_URL = "http://127.0.0.1:18901";
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_DOMAIN = "core";
const DEFAULT_RECALL_MIN_DISPLAY_SCORE = 0.4;
const DEFAULT_RECALL_MAX_DISPLAY_ITEMS = 3;
const DEFAULT_RECALL_SCORE_PRECISION = 2;

function pickPluginConfig(api) {
  const cfg = api?.pluginConfig ?? {};
  const memorySearch = api?.config?.agents?.defaults?.memorySearch ?? {};
  const memorySearchRemote = memorySearch?.remote ?? {};

  const embeddingBaseUrl = typeof cfg.embeddingBaseUrl === "string" && cfg.embeddingBaseUrl.trim()
    ? cfg.embeddingBaseUrl.trim().replace(/\/$/, "")
    : (typeof memorySearchRemote.baseUrl === "string" && memorySearchRemote.baseUrl.trim()
      ? memorySearchRemote.baseUrl.trim().replace(/\/$/, "")
      : "");
  const embeddingApiKey = typeof cfg.embeddingApiKey === "string" && cfg.embeddingApiKey.trim()
    ? cfg.embeddingApiKey.trim()
    : (typeof memorySearchRemote.apiKey === "string" ? memorySearchRemote.apiKey : "");
  const embeddingModel = typeof cfg.embeddingModel === "string" && cfg.embeddingModel.trim()
    ? cfg.embeddingModel.trim()
    : (typeof memorySearch.model === "string" ? memorySearch.model.trim() : "");

  return {
    baseUrl: typeof cfg.baseUrl === "string" && cfg.baseUrl.trim() ? cfg.baseUrl.trim().replace(/\/$/, "") : DEFAULT_BASE_URL,
    apiToken: typeof cfg.apiToken === "string" && cfg.apiToken.trim() ? cfg.apiToken.trim() : (process.env.NOCTURNE_API_TOKEN || process.env.API_TOKEN || ""),
    timeoutMs: Number.isFinite(cfg.timeoutMs) ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS,
    defaultDomain: typeof cfg.defaultDomain === "string" && cfg.defaultDomain.trim() ? cfg.defaultDomain.trim() : DEFAULT_DOMAIN,
    injectPromptGuidance: cfg.injectPromptGuidance !== false,
    startupHealthcheck: cfg.startupHealthcheck !== false,
    recallEnabled: cfg.recallEnabled !== false,
    embeddingBaseUrl,
    embeddingApiKey,
    embeddingModel,
    recallMinDisplayScore: Number.isFinite(cfg.minDisplayScore) ? Number(cfg.minDisplayScore) : DEFAULT_RECALL_MIN_DISPLAY_SCORE,
    recallMaxDisplayItems: Number.isFinite(cfg.maxDisplayItems) ? Number(cfg.maxDisplayItems) : DEFAULT_RECALL_MAX_DISPLAY_ITEMS,
    recallScorePrecision: Number.isFinite(cfg.scorePrecision) ? Number(cfg.scorePrecision) : DEFAULT_RECALL_SCORE_PRECISION,
    readNodeDisplayMode: cfg.readNodeDisplayMode === "hard" ? "hard" : "soft",
    excludeBootFromResults: cfg.excludeBootFromResults !== false,
  };
}

function textResult(text, details) {
  return { content: [{ type: "text", text }], details };
}

function authHeaders(pluginCfg, includeJson = true) {
  const headers = {};
  if (includeJson) headers["content-type"] = "application/json";
  if (pluginCfg.apiToken) headers.authorization = `Bearer ${pluginCfg.apiToken}`;
  return headers;
}

function buildApiUrl(pluginCfg, path) {
  const rawPath = String(path || "");
  const normalizedPath = rawPath.startsWith("/api/")
    ? rawPath
    : `/api${rawPath.startsWith("/") ? rawPath : `/${rawPath}`}`;
  return `${pluginCfg.baseUrl}${normalizedPath}`;
}

async function fetchJson(pluginCfg, path, options = {}) {
  const url = buildApiUrl(pluginCfg, path);
  const response = await fetch(url, {
    ...options,
    headers: {
      ...authHeaders(pluginCfg, options.method && options.method !== "GET"),
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(pluginCfg.timeoutMs),
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    const detail = data?.detail || data?.error || text || `${response.status} ${response.statusText}`;
    const err = new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
    err.status = response.status;
    err.data = data;
    throw err;
  }

  return data;
}

function formatNode(data) {
  const node = data?.node || {};
  const children = Array.isArray(data?.children) ? data.children : [];
  const lines = [];
  lines.push(`URI: ${node.uri || ""}`);
  if (node.node_uuid) lines.push(`Node UUID: ${node.node_uuid}`);
  lines.push(`Priority: ${node.priority ?? ""}`);
  if (node.disclosure) lines.push(`Disclosure: ${node.disclosure}`);
  if (Array.isArray(node.aliases) && node.aliases.length > 0) {
    lines.push(`Aliases: ${node.aliases.join(", ")}`);
  }
  lines.push("");
  lines.push(node.content || "(empty)");
  if (children.length > 0) {
    lines.push("");
    lines.push("Children:");
    for (const child of children) {
      lines.push(`- ${child.uri} (priority: ${child.priority ?? ""})`);
      if (child.content_snippet) lines.push(`  ${child.content_snippet}`);
    }
  }
  if (Array.isArray(node.glossary_keywords) && node.glossary_keywords.length > 0) {
    lines.push("");
    lines.push(`Glossary keywords: ${node.glossary_keywords.join(", ")}`);
  }
  return lines.join("\n");
}

function formatBootView(data) {
  const coreMemories = Array.isArray(data?.core_memories) ? data.core_memories : [];
  const recentMemories = Array.isArray(data?.recent_memories) ? data.recent_memories : [];
  const failed = Array.isArray(data?.failed) ? data.failed : [];
  const loaded = Number.isFinite(data?.loaded) ? data.loaded : coreMemories.length;
  const total = Number.isFinite(data?.total) ? data.total : coreMemories.length;
  const lines = [];

  lines.push("# Core Memories");
  lines.push(`# Loaded: ${loaded}/${total} memories`);
  lines.push("");

  if (failed.length > 0) {
    lines.push("## Failed to load:");
    lines.push(...failed);
    lines.push("");
  }

  if (coreMemories.length > 0) {
    lines.push("## Contents:");
    lines.push("");
    lines.push("For full memory index, use: nocturne_list_domains and nocturne_get_node.");
    lines.push("For recent memories, see below.");
    lines.push("");
    for (const memory of coreMemories) {
      lines.push(`### ${memory?.uri || ""}`);
      if (Number.isFinite(memory?.priority)) lines.push(`Priority: ${memory.priority}`);
      if (memory?.disclosure) lines.push(`Disclosure: ${memory.disclosure}`);
      if (memory?.node_uuid) lines.push(`Node UUID: ${memory.node_uuid}`);
      lines.push("");
      lines.push(memory?.content || "(empty)");
      lines.push("");
    }
  } else {
    lines.push("(No core memories loaded. Run migration first.)");
  }

  if (recentMemories.length > 0) {
    lines.push("---");
    lines.push("");
    lines.push("# Recent Memories");
    for (const memory of recentMemories) {
      const meta = [];
      if (Number.isFinite(memory?.priority)) meta.push(`priority: ${memory.priority}`);
      if (memory?.created_at) meta.push(`created: ${memory.created_at}`);
      const suffix = meta.length > 0 ? ` (${meta.join(", ")})` : "";
      lines.push(`- ${memory?.uri || ""}${suffix}`);
      if (memory?.disclosure) lines.push(`  Disclosure: ${memory.disclosure}`);
    }
  }

  return lines.join("\n").trim();
}

function normalizeSearchResults(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.results)) return data.results;
  return [];
}

function hasRecallConfig(pluginCfg) {
  return Boolean(pluginCfg.recallEnabled && pluginCfg.embeddingBaseUrl && pluginCfg.embeddingApiKey && pluginCfg.embeddingModel);
}

function readCueList(item) {
  const cues = Array.isArray(item?.cues) ? item.cues : [];
  const cleaned = cues.map((x) => String(x || "").replace(/\s+/g, " ").trim()).filter(Boolean);
  return cleaned.slice(0, 3);
}

function formatRecallBlock(items, precision = DEFAULT_RECALL_SCORE_PRECISION) {
  if (!Array.isArray(items) || items.length === 0) return "";
  const lines = ["<recall>"];
  for (const item of items) {
    const score = Number.isFinite(item?.score_display) ? Number(item.score_display).toFixed(precision) : String(item?.score ?? "");
    const cues = readCueList(item);
    const cueText = `${item?.read ? "read · " : ""}${cues.join(" · ")}`.trim();
    lines.push(`${score} | ${item?.uri || ""}${cueText ? ` | ${cueText}` : ""}`);
  }
  lines.push("</recall>");
  return lines.join("\n");
}

async function fetchRecallBlock(pluginCfg, query, sessionId) {
  if (!hasRecallConfig(pluginCfg)) return null;
  const payload = {
    query,
    session_id: sessionId,
    max_display_items: pluginCfg.recallMaxDisplayItems,
    min_display_score: pluginCfg.recallMinDisplayScore,
    score_precision: pluginCfg.recallScorePrecision,
    read_node_display_mode: pluginCfg.readNodeDisplayMode,
    exclude_boot_from_results: pluginCfg.excludeBootFromResults,
    embedding: {
      base_url: pluginCfg.embeddingBaseUrl,
      api_key: pluginCfg.embeddingApiKey,
      model: pluginCfg.embeddingModel,
      timeout_ms: pluginCfg.timeoutMs,
    },
  };
  const data = await fetchJson(pluginCfg, "/browse/recall", { method: "POST", body: JSON.stringify(payload) });
  const block = formatRecallBlock(data?.items || [], pluginCfg.recallScorePrecision);
  return block ? { block, data } : null;
}

async function markSessionRead(pluginCfg, { sessionId, sessionKey, uri, nodeUuid, source = "tool:get_node" }) {
  if (!sessionId || !uri) return;
  const body = { session_id: sessionId, session_key: sessionKey, uri, source };
  if (nodeUuid) body.node_uuid = nodeUuid;
  try {
    await fetchJson(pluginCfg, "/browse/session/read", { method: "POST", body: JSON.stringify(body) });
  } catch {
    // best effort only
  }
}

async function clearSessionReads(pluginCfg, sessionId) {
  if (!sessionId) return;
  try {
    const qs = new URLSearchParams({ session_id: sessionId });
    await fetchJson(pluginCfg, `/browse/session/read?${qs.toString()}`, { method: "DELETE" });
  } catch {
    // best effort only
  }
}

const GUIDANCE = [
  "Nocturne plugin is enabled as a first-class plugin.",
  "Use Nocturne for long-term identity, user preferences, stable rules, and cross-session project constraints.",
  "Use local file memory_search for historical markdown archives and past worklogs.",
  "When a question is really about current long-term memory, prefer the Nocturne tools in this plugin.",
  "When a <recall> block is present, treat each line as score | uri | matched cues, and read a node only if your answer depends on those cues.",
  "Read before update. Do not blindly edit long-term memory nodes.",
].join("\n");

export default function register(api) {
  const pluginCfg = pickPluginConfig(api);

  api.registerTool({
    name: "nocturne_status",
    label: "Nocturne status",
    description: "Check whether the Nocturne backend API is online.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    async execute() {
      try {
        const data = await fetchJson(pluginCfg, "/health", { method: "GET" });
        return textResult(`Nocturne online\n\n${JSON.stringify(data, null, 2)}`, { ok: true, health: data, baseUrl: pluginCfg.baseUrl });
      } catch (error) {
        return textResult(`Nocturne offline: ${error.message}`, { ok: false, error: error.message, baseUrl: pluginCfg.baseUrl });
      }
    },
  });

  api.registerTool({
    name: "nocturne_boot",
    label: "Nocturne boot",
    description: "Read the Nocturne boot memory view for long-term identity startup.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    async execute() {
      try {
        const data = await fetchJson(pluginCfg, "/browse/boot", { method: "GET" });
        const content = formatBootView(data);
        return textResult(content, { ok: true, content, boot: data });
      } catch (error) {
        return textResult(`Nocturne boot failed: ${error.message}`, { ok: false, error: error.message });
      }
    },
  });

  api.registerTool({
    name: "nocturne_get_node",
    label: "Nocturne get node",
    description: "Read a Nocturne node by domain/path through the backend browse API.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        domain: { type: "string", description: "Domain like core" },
        path: { type: "string", description: "Path inside the domain, like agent/my_user. Empty string means root." },
        nav_only: { type: "boolean", description: "If true, skip expensive glossary processing." },
        __session_id: { type: "string", description: "Internal session tracking field." },
        __session_key: { type: "string", description: "Internal session tracking field." }
      }
    },
    async execute(_id, params) {
      const domain = typeof params?.domain === "string" && params.domain.trim() ? params.domain.trim() : pluginCfg.defaultDomain;
      const path = typeof params?.path === "string" ? params.path.trim() : "";
      const navOnly = params?.nav_only === true;
      const qs = new URLSearchParams({ domain, path, nav_only: String(navOnly) });
      const sessionId = typeof params?.__session_id === "string" && params.__session_id.trim() ? params.__session_id.trim() : "";
      const sessionKey = typeof params?.__session_key === "string" && params.__session_key.trim() ? params.__session_key.trim() : "";
      try {
        const data = await fetchJson(pluginCfg, `/browse/node?${qs.toString()}`, { method: "GET" });
        const node = data?.node || {};
        if (sessionId && node?.uri) {
          await markSessionRead(pluginCfg, {
            sessionId,
            sessionKey,
            uri: node.uri,
            nodeUuid: node.node_uuid,
            source: "tool:nocturne_get_node",
          });
        }
        return textResult(formatNode(data), { ok: true, node, children: data?.children || [] });
      } catch (error) {
        return textResult(`Nocturne get node failed: ${error.message}`, { ok: false, error: error.message, domain, path });
      }
    },
  });

  api.registerTool({
    name: "nocturne_search",
    label: "Nocturne search",
    description: "Search Nocturne memory content and paths by keyword.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string" },
        domain: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 }
      }
    },
    async execute(_id, params) {
      const query = String(params?.query || "").trim();
      const qs = new URLSearchParams({ query });
      if (typeof params?.domain === "string" && params.domain.trim()) qs.set("domain", params.domain.trim());
      if (Number.isFinite(params?.limit)) qs.set("limit", String(Math.max(1, Math.min(100, params.limit))));
      try {
        const data = await fetchJson(pluginCfg, `/browse/search?${qs.toString()}`, { method: "GET" });
        const results = normalizeSearchResults(data);
        const text = results.length > 0
          ? results.map((item, idx) => `${idx + 1}. ${item.uri} (priority: ${item.priority})\n   ${item.snippet}`).join("\n")
          : "No matching memories found.";
        return textResult(text, { ok: true, results });
      } catch (error) {
        return textResult(`Nocturne search failed: ${error.message}`, { ok: false, error: error.message, query });
      }
    },
  });

  api.registerTool({
    name: "nocturne_list_domains",
    label: "Nocturne list domains",
    description: "List Nocturne domains available in the backend browse API.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    async execute() {
      try {
        const data = await fetchJson(pluginCfg, "/browse/domains", { method: "GET" });
        const text = Array.isArray(data) && data.length > 0
          ? data.map((item) => `- ${item.domain} (${item.root_count})`).join("\n")
          : "No domains found.";
        return textResult(text, { ok: true, domains: data });
      } catch (error) {
        return textResult(`Nocturne list domains failed: ${error.message}`, { ok: false, error: error.message });
      }
    },
  });

  api.registerTool({
    name: "nocturne_create_node",
    label: "Nocturne create node",
    description: "Create a Nocturne memory node through the backend browse API.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["content", "priority"],
      properties: {
        domain: { type: "string" },
        parent_path: { type: "string" },
        content: { type: "string" },
        priority: { type: "integer", minimum: 0 },
        title: { type: "string" },
        disclosure: { type: "string" }
      }
    },
    async execute(_id, params) {
      const body = {
        domain: typeof params?.domain === "string" && params.domain.trim() ? params.domain.trim() : pluginCfg.defaultDomain,
        parent_path: typeof params?.parent_path === "string" ? params.parent_path.trim() : "",
        content: String(params?.content || ""),
        priority: Number(params?.priority),
      };
      if (typeof params?.title === "string") body.title = params.title;
      if (typeof params?.disclosure === "string") body.disclosure = params.disclosure;
      try {
        const data = await fetchJson(pluginCfg, `/browse/node`, { method: "POST", body: JSON.stringify(body) });
        return textResult(`Created ${data?.uri || `${body.domain}://${body.parent_path}`}`, { ok: true, result: data });
      } catch (error) {
        return textResult(`Nocturne create failed: ${error.message}`, { ok: false, error: error.message, body });
      }
    },
  });

  api.registerTool({
    name: "nocturne_update_node",
    label: "Nocturne update node",
    description: "Update a Nocturne node through the backend browse API.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        domain: { type: "string" },
        path: { type: "string" },
        content: { type: "string" },
        priority: { type: "integer", minimum: 0 },
        disclosure: { type: "string" }
      }
    },
    async execute(_id, params) {
      const domain = typeof params?.domain === "string" && params.domain.trim() ? params.domain.trim() : pluginCfg.defaultDomain;
      const path = String(params?.path || "").trim();
      const body = {};
      if (typeof params?.content === "string") body.content = params.content;
      if (Number.isFinite(params?.priority)) body.priority = params.priority;
      if (typeof params?.disclosure === "string") body.disclosure = params.disclosure;
      try {
        const qs = new URLSearchParams({ domain, path });
        const data = await fetchJson(pluginCfg, `/browse/node?${qs.toString()}`, { method: "PUT", body: JSON.stringify(body) });
        return textResult(`Updated ${domain}://${path}`, { ok: true, result: data });
      } catch (error) {
        return textResult(`Nocturne update failed: ${error.message}`, { ok: false, error: error.message, domain, path });
      }
    },
  });

  api.registerTool({
    name: "nocturne_delete_node",
    label: "Nocturne delete node",
    description: "Delete a Nocturne memory path through the backend browse API.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        domain: { type: "string" },
        path: { type: "string" }
      }
    },
    async execute(_id, params) {
      const domain = typeof params?.domain === "string" && params.domain.trim() ? params.domain.trim() : pluginCfg.defaultDomain;
      const path = String(params?.path || "").trim();
      try {
        const qs = new URLSearchParams({ domain, path });
        const data = await fetchJson(pluginCfg, `/browse/node?${qs.toString()}`, { method: "DELETE" });
        return textResult(`Deleted ${domain}://${path}`, { ok: true, result: data });
      } catch (error) {
        return textResult(`Nocturne delete failed: ${error.message}`, { ok: false, error: error.message, domain, path });
      }
    },
  });

  api.registerTool({
    name: "nocturne_add_alias",
    label: "Nocturne add alias",
    description: "Create an alias URI for an existing Nocturne memory.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["new_uri", "target_uri"],
      properties: {
        new_uri: { type: "string" },
        target_uri: { type: "string" },
        priority: { type: "integer", minimum: 0 },
        disclosure: { type: "string" }
      }
    },
    async execute(_id, params) {
      const body = {
        new_uri: String(params?.new_uri || "").trim(),
        target_uri: String(params?.target_uri || "").trim(),
        priority: Number.isFinite(params?.priority) ? Math.max(0, params.priority) : 0,
      };
      if (typeof params?.disclosure === "string") body.disclosure = params.disclosure;
      try {
        const data = await fetchJson(pluginCfg, `/browse/alias`, { method: "POST", body: JSON.stringify(body) });
        return textResult(`Alias created: ${body.new_uri}`, { ok: true, result: data });
      } catch (error) {
        return textResult(`Nocturne add alias failed: ${error.message}`, { ok: false, error: error.message, body });
      }
    },
  });

  api.registerTool({
    name: "nocturne_manage_triggers",
    label: "Nocturne manage triggers",
    description: "Bind or unbind trigger words for a Nocturne memory URI.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["uri"],
      properties: {
        uri: { type: "string" },
        add: { type: "array", items: { type: "string" } },
        remove: { type: "array", items: { type: "string" } }
      }
    },
    async execute(_id, params) {
      const body = { uri: String(params?.uri || "").trim() };
      if (Array.isArray(params?.add)) body.add = params.add.map((x) => String(x));
      if (Array.isArray(params?.remove)) body.remove = params.remove.map((x) => String(x));
      try {
        const data = await fetchJson(pluginCfg, `/browse/triggers`, { method: "POST", body: JSON.stringify(body) });
        const current = Array.isArray(data?.current) ? data.current.join(", ") : "";
        return textResult(`Triggers updated for ${body.uri}${current ? `\nCurrent: ${current}` : ""}`, { ok: true, result: data });
      } catch (error) {
        return textResult(`Nocturne manage triggers failed: ${error.message}`, { ok: false, error: error.message, body });
      }
    },
  });

  api.registerTool({
    name: "nocturne_get_glossary",
    label: "Nocturne get glossary",
    description: "Read the Nocturne glossary map.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    async execute() {
      try {
        const data = await fetchJson(pluginCfg, "/browse/glossary", { method: "GET" });
        const glossary = Array.isArray(data?.glossary) ? data.glossary : [];
        const text = glossary.length > 0
          ? glossary.map((item) => {
              const nodes = Array.isArray(item?.nodes) ? item.nodes : [];
              if (nodes.length === 0) return `- ${item.keyword}: (no linked nodes)`;
              return `- ${item.keyword}: ${nodes.map((node) => node?.uri || node?.node_uuid || "(unknown node)").join(", ")}`;
            }).join("\n")
          : "Glossary is empty.";
        return textResult(text, { ok: true, glossary });
      } catch (error) {
        return textResult(`Nocturne glossary read failed: ${error.message}`, { ok: false, error: error.message });
      }
    },
  });

  api.registerTool({
    name: "nocturne_add_glossary",
    label: "Nocturne add glossary",
    description: "Bind a glossary keyword to a Nocturne node UUID.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["keyword", "node_uuid"],
      properties: {
        keyword: { type: "string" },
        node_uuid: { type: "string" }
      }
    },
    async execute(_id, params) {
      try {
        const data = await fetchJson(pluginCfg, "/browse/glossary", {
          method: "POST",
          body: JSON.stringify({ keyword: String(params?.keyword || ""), node_uuid: String(params?.node_uuid || "") }),
        });
        return textResult(`Glossary keyword added: ${params.keyword}`, { ok: true, result: data });
      } catch (error) {
        return textResult(`Nocturne add glossary failed: ${error.message}`, { ok: false, error: error.message });
      }
    },
  });

  api.registerTool({
    name: "nocturne_remove_glossary",
    label: "Nocturne remove glossary",
    description: "Remove a glossary keyword binding from a Nocturne node UUID.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["keyword", "node_uuid"],
      properties: {
        keyword: { type: "string" },
        node_uuid: { type: "string" }
      }
    },
    async execute(_id, params) {
      try {
        const data = await fetchJson(pluginCfg, "/browse/glossary", {
          method: "DELETE",
          body: JSON.stringify({ keyword: String(params?.keyword || ""), node_uuid: String(params?.node_uuid || "") }),
        });
        return textResult(`Glossary keyword removed: ${params.keyword}`, { ok: true, result: data });
      } catch (error) {
        return textResult(`Nocturne remove glossary failed: ${error.message}`, { ok: false, error: error.message });
      }
    },
  });

  api.registerTool({
    name: "nocturne_list_session_reads",
    label: "Nocturne list session reads",
    description: "List Nocturne nodes already read in the current session.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["session_id"],
      properties: { session_id: { type: "string" } }
    },
    async execute(_id, params) {
      const sessionId = String(params?.session_id || "").trim();
      try {
        const qs = new URLSearchParams({ session_id: sessionId });
        const data = await fetchJson(pluginCfg, `/browse/session/read?${qs.toString()}`, { method: "GET" });
        const text = Array.isArray(data) && data.length > 0
          ? data.map((item) => `- ${item.uri} (${item.read_count})`).join("\n")
          : "No read nodes tracked for this session.";
        return textResult(text, { ok: true, reads: data });
      } catch (error) {
        return textResult(`Nocturne session reads failed: ${error.message}`, { ok: false, error: error.message });
      }
    },
  });

  api.registerTool({
    name: "nocturne_clear_session_reads",
    label: "Nocturne clear session reads",
    description: "Clear Nocturne read tracking for a session.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["session_id"],
      properties: { session_id: { type: "string" } }
    },
    async execute(_id, params) {
      const sessionId = String(params?.session_id || "").trim();
      try {
        const qs = new URLSearchParams({ session_id: sessionId });
        const data = await fetchJson(pluginCfg, `/browse/session/read?${qs.toString()}`, { method: "DELETE" });
        return textResult(`Cleared Nocturne read tracking for ${sessionId}`, { ok: true, result: data });
      } catch (error) {
        return textResult(`Nocturne clear session reads failed: ${error.message}`, { ok: false, error: error.message });
      }
    },
  });

  api.registerGatewayMethod("nocturne.status", async ({ respond }) => {
    try {
      const data = await fetchJson(pluginCfg, "/health", { method: "GET" });
      respond({ ok: true, baseUrl: pluginCfg.baseUrl, health: data });
    } catch (error) {
      respond({ ok: false, baseUrl: pluginCfg.baseUrl, error: error.message });
    }
  });

  api.registerHook(
    "gateway:startup",
    async () => {
      if (!pluginCfg.startupHealthcheck) return;
      try {
        await fetchJson(pluginCfg, "/health", { method: "GET" });
        api.logger.info(`nocturne: startup health check ok (${pluginCfg.baseUrl})`);
      } catch (error) {
        api.logger.warn(`nocturne: startup health check failed (${pluginCfg.baseUrl}): ${error.message}`);
      }
    },
    {
      name: "nocturne.gateway-startup-healthcheck",
      description: "Checks Nocturne API reachability at gateway startup",
    },
  );

  api.registerHook(
    "before_tool_call",
    async (event, ctx) => {
      if (event?.toolName !== "nocturne_get_node") return;
      if (!ctx?.sessionId) return;
      return {
        params: {
          ...(event?.params || {}),
          __session_id: ctx.sessionId,
          __session_key: ctx.sessionKey || undefined,
        },
      };
    },
    {
      name: "nocturne.inject-session-read-context",
      description: "Injects session tracking fields into nocturne_get_node before execution.",
    },
  );

  api.registerHook(
    "session_end",
    async (event) => {
      await clearSessionReads(pluginCfg, event?.sessionId);
    },
    {
      name: "nocturne.clear-session-reads",
      description: "Clears per-session Nocturne read tracking when a session ends.",
    },
  );

  api.on("before_prompt_build", async (event, ctx) => {
    const out = {};
    if (pluginCfg.injectPromptGuidance) out.prependSystemContext = GUIDANCE;

    if (hasRecallConfig(pluginCfg) && typeof event?.prompt === "string" && event.prompt.trim()) {
      try {
        const recalled = await fetchRecallBlock(pluginCfg, event.prompt, ctx?.sessionId);
        if (recalled?.block) out.prependContext = recalled.block;
      } catch (error) {
        api.logger.warn(`nocturne: prompt recall failed: ${error.message}`);
      }
    }

    return Object.keys(out).length > 0 ? out : undefined;
  });
}
