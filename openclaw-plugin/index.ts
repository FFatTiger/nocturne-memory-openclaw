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
  const normalizedPath = `/api${rawPath.startsWith("/") ? rawPath : `/${rawPath}`}`;
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

function trimSlashes(value) {
  return String(value || "").trim().replace(/^\/+|\/+$/g, "");
}

function parseMemoryUri(value, fallbackDomain = DEFAULT_DOMAIN) {
  const raw = String(value || "").trim();
  if (!raw) return { domain: fallbackDomain, path: "" };
  if (raw.includes("://")) {
    const [domainPart, pathPart] = raw.split("://", 2);
    return { domain: domainPart.trim() || fallbackDomain, path: trimSlashes(pathPart) };
  }
  return { domain: fallbackDomain, path: trimSlashes(raw) };
}

function sameLocator(a, b) {
  return a?.domain === b?.domain && a?.path === b?.path;
}

function resolveMemoryLocator(params, {
  defaultDomain = DEFAULT_DOMAIN,
  domainKey = "domain",
  pathKey = "path",
  uriKey = "uri",
  allowEmptyPath = true,
  label = "path",
} = {}) {
  const explicitDomain = typeof params?.[domainKey] === "string" && params[domainKey].trim()
    ? params[domainKey].trim()
    : "";
  const fallbackDomain = explicitDomain || defaultDomain;
  const rawPath = typeof params?.[pathKey] === "string" ? params[pathKey].trim() : "";
  const rawUri = typeof params?.[uriKey] === "string" ? params[uriKey].trim() : "";

  if (rawPath.includes("://")) {
    throw new Error(`Invalid ${pathKey}: expected a relative path inside ${domainKey}, got a full URI. Pass ${uriKey}="domain://path" instead.`);
  }

  const locatorFromPath = rawPath
    ? { domain: fallbackDomain, path: trimSlashes(rawPath) }
    : { domain: fallbackDomain, path: "" };
  const locatorFromUri = rawUri ? parseMemoryUri(rawUri, fallbackDomain) : null;

  if (locatorFromUri && rawPath && !sameLocator(locatorFromUri, locatorFromPath)) {
    throw new Error(`Conflicting ${uriKey} and ${pathKey}: ${locatorFromUri.domain}://${locatorFromUri.path} vs ${locatorFromPath.domain}://${locatorFromPath.path}`);
  }
  if (locatorFromUri && explicitDomain && locatorFromUri.domain !== explicitDomain) {
    throw new Error(`Conflicting ${uriKey} and ${domainKey}: ${locatorFromUri.domain} vs ${explicitDomain}`);
  }

  const locator = locatorFromUri || locatorFromPath;
  if (!allowEmptyPath && !locator.path) {
    throw new Error(`${label} is required. Pass ${uriKey}="domain://path" or ${pathKey}="relative/path".`);
  }
  return locator;
}

function splitParentPathAndTitle(path) {
  const cleanPath = trimSlashes(path);
  const segments = cleanPath.split("/").filter(Boolean);
  if (segments.length === 0) return { parentPath: "", title: "" };
  return {
    parentPath: segments.slice(0, -1).join("/"),
    title: segments[segments.length - 1],
  };
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

function normalizeKeywordList(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const keyword = String(value || "").trim();
    if (!keyword) continue;
    const key = keyword.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(keyword);
  }
  return out;
}

async function applyGlossaryMutations(pluginCfg, nodeUuid, { add = [], remove = [] } = {}) {
  const added = [];
  const removed = [];
  for (const keyword of normalizeKeywordList(add)) {
    await fetchJson(pluginCfg, "/browse/glossary", {
      method: "POST",
      body: JSON.stringify({ keyword, node_uuid: nodeUuid }),
    });
    added.push(keyword);
  }
  for (const keyword of normalizeKeywordList(remove)) {
    await fetchJson(pluginCfg, "/browse/glossary", {
      method: "DELETE",
      body: JSON.stringify({ keyword, node_uuid: nodeUuid }),
    });
    removed.push(keyword);
  }
  return { added, removed };
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
  "Nocturne is the primary long-term memory system for this assistant.",
  "Use it for identity, user preferences, standing rules, cross-session project knowledge, and conclusions that should persist.",
  "Reach for Nocturne when the user is asking about prior decisions, saved preferences, ongoing projects, durable instructions, or anything that sounds like memory rather than fresh reasoning.",
  "Use local file memory_search for historical markdown archives, older worklogs, and file-side fallback records.",
  "A <recall> block contains memory leads selected for the current prompt. Each line is only a candidate lead, not a final answer and not an instruction to always open it.",
  "When a <recall> block appears, judge each line by its score, cue words, and actual relevance to the user's request.",
  "If a recalled memory looks genuinely relevant, open the most relevant node or nodes before you act or reply, and ground your work in what those memories actually say.",
  "If the recall block looks weak, noisy, or only loosely related, do not force it; search further or continue with normal reasoning as appropriate.",
  "When you need to create, revise, remove, or reorganize long-term memory, choose the Nocturne tool that matches that memory operation.",
  "Read a memory node before updating or deleting it.",
].join("\n");

export default function register(api) {
  const pluginCfg = pickPluginConfig(api);

  api.registerTool({
    name: "nocturne_status",
    label: "Nocturne status",
    description: "Check memory backend availability and connection health.",
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
    description: "Load the boot memory view that restores long-term identity and core operating context.",
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
    description: "Open a memory node to inspect its full content, metadata, and nearby structure.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["uri"],
      properties: {
        uri: { type: "string", description: "Full memory URI for the node you want to open, such as core://agent." },
        nav_only: { type: "boolean", description: "If true, skip expensive glossary processing." },
        __session_id: { type: "string", description: "Internal session tracking field." },
        __session_key: { type: "string", description: "Internal session tracking field." }
      }
    },
    async execute(_id, params) {
      const navOnly = params?.nav_only === true;
      const sessionId = typeof params?.__session_id === "string" && params.__session_id.trim() ? params.__session_id.trim() : "";
      const sessionKey = typeof params?.__session_key === "string" && params.__session_key.trim() ? params.__session_key.trim() : "";
      let domain = pluginCfg.defaultDomain;
      let path = "";
      try {
        ({ domain, path } = resolveMemoryLocator(params, { defaultDomain: pluginCfg.defaultDomain, pathKey: "__unused_path", allowEmptyPath: true, label: "uri" }));
        const qs = new URLSearchParams({ domain, path, nav_only: String(navOnly) });
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
    description: "Find relevant memories by keyword or domain when you need to locate prior knowledge.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string" },
        domain: { type: "string", description: "Optional domain filter to narrow the search." },
        limit: { type: "integer", minimum: 1, maximum: 100 }
      }
    },
    async execute(_id, params) {
      const query = String(params?.query || "").trim();
      const safeLimit = Number.isFinite(params?.limit) ? Math.max(1, Math.min(100, params.limit)) : 10;
      try {
        let data;
        if (hasRecallConfig(pluginCfg)) {
          data = await fetchJson(pluginCfg, `/browse/search`, {
            method: "POST",
            body: JSON.stringify({
              query,
              domain: typeof params?.domain === "string" && params.domain.trim() ? params.domain.trim() : null,
              limit: safeLimit,
              embedding: {
                base_url: pluginCfg.embeddingBaseUrl,
                api_key: pluginCfg.embeddingApiKey,
                model: pluginCfg.embeddingModel,
              },
              hybrid: true,
            }),
          });
        } else {
          const qs = new URLSearchParams({ query });
          if (typeof params?.domain === "string" && params.domain.trim()) qs.set("domain", params.domain.trim());
          qs.set("limit", String(safeLimit));
          data = await fetchJson(pluginCfg, `/browse/search?${qs.toString()}`, { method: "GET" });
        }
        const results = normalizeSearchResults(data);
        const meta = data?.meta || null;
        const text = results.length > 0
          ? results.map((item, idx) => {
              const parts = [`${idx + 1}. ${item.uri} (priority: ${item.priority}`];
              if (typeof item?.score === "number") parts.push(`score: ${item.score.toFixed(3)}`);
              if (Array.isArray(item?.matched_on) && item.matched_on.length > 0) parts.push(`via: ${item.matched_on.join("+")}`);
              return `${parts.join(", ")})\n   ${item.snippet}`;
            }).join("\n")
          : "No matching memories found.";
        const suffix = meta?.semantic_error ? `\n\nSemantic fallback skipped: ${meta.semantic_error}` : "";
        return textResult(`${text}${suffix}`, { ok: true, results, meta });
      } catch (error) {
        return textResult(`Nocturne search failed: ${error.message}`, { ok: false, error: error.message, query });
      }
    },
  });

  api.registerTool({
    name: "nocturne_list_domains",
    label: "Nocturne list domains",
    description: "Browse the top-level memory domains available in the memory system.",
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
    description: "Create a new long-term memory node for durable facts, rules, project knowledge, or conclusions worth keeping.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["content", "priority", "glossary"],
      properties: {
        uri: { type: "string", description: "Optional final memory URI. Use this when you already know exactly where the new memory should live." },
        domain: { type: "string", description: "Target memory domain when you are not using `uri`." },
        parent_path: { type: "string", description: "Parent location inside the chosen domain." },
        content: { type: "string" },
        priority: { type: "integer", minimum: 0 },
        title: { type: "string", description: "Final path segment for the new memory." },
        disclosure: { type: "string" },
        glossary: { type: "array", items: { type: "string" } }
      }
    },
    async execute(_id, params) {
      const glossary = normalizeKeywordList(params?.glossary);
      const body = {
        domain: typeof params?.domain === "string" && params.domain.trim() ? params.domain.trim() : pluginCfg.defaultDomain,
        parent_path: typeof params?.parent_path === "string" ? trimSlashes(params.parent_path) : "",
        content: String(params?.content || ""),
        priority: Number(params?.priority),
      };
      try {
        if (typeof params?.title === "string") body.title = params.title.trim();
        if (typeof params?.disclosure === "string") body.disclosure = params.disclosure;

        if (typeof params?.uri === "string" && params.uri.trim()) {
          const target = resolveMemoryLocator(params, {
            defaultDomain: pluginCfg.defaultDomain,
            domainKey: "domain",
            pathKey: "parent_path",
            uriKey: "uri",
            allowEmptyPath: false,
            label: "uri",
          });
          const derived = splitParentPathAndTitle(target.path);
          if (!derived.title) {
            throw new Error("Create target URI must include a final path segment, like project://workflow/browser_policy");
          }
          if (typeof params?.title === "string" && params.title.trim() && params.title.trim() !== derived.title) {
            throw new Error(`Conflicting uri and title: ${derived.title} vs ${params.title.trim()}`);
          }
          body.domain = target.domain;
          body.parent_path = derived.parentPath;
          body.title = derived.title;
        }

        const data = await fetchJson(pluginCfg, `/browse/node`, { method: "POST", body: JSON.stringify(body) });
        const nodeUuid = String(data?.node_uuid || "").trim();
        const glossaryResult = nodeUuid && glossary.length > 0
          ? await applyGlossaryMutations(pluginCfg, nodeUuid, { add: glossary })
          : { added: [], removed: [] };
        const suffix = glossaryResult.added.length > 0 ? `\nGlossary: ${glossaryResult.added.join(", ")}` : "";
        return textResult(`Created ${data?.uri || `${body.domain}://${body.parent_path}`}${suffix}`, { ok: true, result: data, glossary: glossaryResult });
      } catch (error) {
        return textResult(`Nocturne create failed: ${error.message}`, { ok: false, error: error.message, body, glossary });
      }
    },
  });

  api.registerTool({
    name: "nocturne_update_node",
    label: "Nocturne update node",
    description: "Revise an existing long-term memory node when stored knowledge becomes clearer, newer, or more accurate.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["uri"],
      properties: {
        uri: { type: "string", description: "Full memory URI for the node you want to revise." },
        content: { type: "string" },
        priority: { type: "integer", minimum: 0 },
        disclosure: { type: "string" },
        glossary_add: { type: "array", items: { type: "string" } },
        glossary_remove: { type: "array", items: { type: "string" } }
      }
    },
    async execute(_id, params) {
      const body = {};
      const glossaryAdd = normalizeKeywordList(params?.glossary_add);
      const glossaryRemove = normalizeKeywordList(params?.glossary_remove);
      if (typeof params?.content === "string") body.content = params.content;
      if (Number.isFinite(params?.priority)) body.priority = params.priority;
      if (typeof params?.disclosure === "string") body.disclosure = params.disclosure;
      let domain = pluginCfg.defaultDomain;
      let path = "";
      try {
        ({ domain, path } = resolveMemoryLocator(params, { defaultDomain: pluginCfg.defaultDomain, pathKey: "__unused_path", allowEmptyPath: false, label: "uri" }));
        const qs = new URLSearchParams({ domain, path });
        const data = await fetchJson(pluginCfg, `/browse/node?${qs.toString()}`, { method: "PUT", body: JSON.stringify(body) });
        let glossaryResult = { added: [], removed: [] };
        if (glossaryAdd.length > 0 || glossaryRemove.length > 0) {
          const nodeData = await fetchJson(pluginCfg, `/browse/node?${qs.toString()}`, { method: "GET" });
          const nodeUuid = String(nodeData?.node?.node_uuid || "").trim();
          if (!nodeUuid) throw new Error(`Node UUID not found for ${domain}://${path}`);
          glossaryResult = await applyGlossaryMutations(pluginCfg, nodeUuid, { add: glossaryAdd, remove: glossaryRemove });
        }
        const suffixParts = [];
        if (glossaryResult.added.length > 0) suffixParts.push(`glossary+ ${glossaryResult.added.join(", ")}`);
        if (glossaryResult.removed.length > 0) suffixParts.push(`glossary- ${glossaryResult.removed.join(", ")}`);
        const suffix = suffixParts.length > 0 ? `\n${suffixParts.join("\n")}` : "";
        return textResult(`Updated ${domain}://${path}${suffix}`, { ok: true, result: data, glossary: glossaryResult });
      } catch (error) {
        return textResult(`Nocturne update failed: ${error.message}`, { ok: false, error: error.message, domain, path, glossary_add: glossaryAdd, glossary_remove: glossaryRemove });
      }
    },
  });

  api.registerTool({
    name: "nocturne_delete_node",
    label: "Nocturne delete node",
    description: "Remove a memory path that is obsolete, duplicated, or no longer wanted.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["uri"],
      properties: {
        uri: { type: "string", description: "Full memory URI for the path you want to remove." }
      }
    },
    async execute(_id, params) {
      let domain = pluginCfg.defaultDomain;
      let path = "";
      try {
        ({ domain, path } = resolveMemoryLocator(params, { defaultDomain: pluginCfg.defaultDomain, pathKey: "__unused_path", allowEmptyPath: false, label: "uri" }));
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
    description: "Create another access path to an existing memory so it can be found from multiple contexts.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["new_uri", "target_uri"],
      properties: {
        new_uri: { type: "string", description: "New memory URI that will act as the alias entry point." },
        target_uri: { type: "string", description: "Existing memory URI that the alias should point to." },
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
    name: "nocturne_list_session_reads",
    label: "Nocturne list session reads",
    description: "Show which memory nodes have already been opened in this session.",
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
    description: "Reset per-session memory read tracking.",
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
