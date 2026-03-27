# Nocturne Memory

Self-hosted long-term memory for AI agents. Built for [OpenClaw](https://github.com/openclaw/openclaw), works anywhere.

## What it does

Nocturne gives an AI agent **persistent memory that survives session resets**. Instead of stuffing everything into context or forgetting between conversations, the agent stores, retrieves, and maintains structured memories through a clean tool interface.

Core capabilities:

- **Boot** — restore identity, preferences, and rules at session start
- **Recall** — semantic pre-fetch of relevant memories before each reply
- **Read / Search** — explicit memory lookup by URI, keyword, or domain
- **Write** — create, update, delete, and alias memory nodes
- **Web UI** — browse, inspect, and manage the full memory graph

## Architecture

```
┌─────────────────────────────────────────────┐
│  OpenClaw Agent                             │
│  ┌───────────┐  recall injection  ┌───────┐ │
│  │  LLM      │◄──────────────────│ Plugin│ │
│  │           │  tool calls ──────►│  REST │ │
│  └───────────┘                    └───┬───┘ │
└──────────────────────────────────────┼─────┘
                                       │ HTTP
┌──────────────────────────────────────┼─────┐
│  Nocturne (Next.js SSR)              │     │
│  ┌───────────┐  ┌───────────┐  ┌────▼───┐ │
│  │  Web UI   │  │  API /api │  │ Server │ │
│  └───────────┘  └───────────┘  │  Layer │ │
│                                └────┬───┘ │
└─────────────────────────────────────┼─────┘
                                      │
                          ┌───────────▼───────────┐
                          │  PostgreSQL + pgvector │
                          │  · structured data     │
                          │  · FTS (lexical)       │
                          │  · vector embeddings   │
                          └───────────────────────┘
```

Single binary. Single database. No extra vector service, no separate backend.

## Key Concepts

### Memory Nodes

Each memory is a **node** with:

| Field | Purpose |
|-------|---------|
| `uri` | Unique address, e.g. `core://agent`, `project://subtitle_automation` |
| `content` | The actual memory text |
| `priority` | Importance tier — 0 = core identity, 1 = key facts, 2+ = general |
| `disclosure` | When to recall this memory (trigger description) |
| `glossary` | Keywords for search indexing |

### Domains

URIs are namespaced by domain: `core://`, `preferences://`, `project://`, etc. Domains let you organize memories by category without rigid folder hierarchies.

### Alias

One memory, multiple entry points. A node at `project://nocturne_integration` can have an alias at `workflow://memory_backend` — same content, different trigger context.

### Retrieval Layers

| Layer | What it does |
|-------|-------------|
| **Boot** | Loads designated core URIs at session start |
| **Recall** | Embedding-based semantic pre-fetch before each LLM turn |
| **Search** | Hybrid FTS + vector search for explicit queries |

Recall uses a cue-card strategy — embeddings are built from URI, title, glossary, and disclosure rather than full content. This keeps recall focused on "should I think about this?" rather than trying to match against long-form text.

## Quick Start

### Docker (recommended)

```bash
git clone https://github.com/FFatTiger/nocturne-memory-openclaw.git
cd nocturne-memory-openclaw
cp .env.example .env
# edit .env — at minimum, change POSTGRES_PASSWORD
docker compose up -d
```

Verify it's running:

```bash
curl http://127.0.0.1:18901/api/health
```

Open `http://127.0.0.1:18901` for the Web UI.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_DB` | `nocturne` | Database name |
| `POSTGRES_USER` | `nocturne` | Database user |
| `POSTGRES_PASSWORD` | `change-me` | **Change this** |
| `POSTGRES_PORT` | `5432` | PostgreSQL exposed port |
| `DATABASE_URL` | auto | Full connection string |
| `API_TOKEN` | (empty) | Set this for auth on public deployments |
| `WEB_PORT` | `18901` | Web app port |
| `CORE_MEMORY_URIS` | `core://agent,preferences://user,core://workflow` | Comma-separated URIs loaded on boot |

### Local Development

```bash
cd web
cp .env.local.example .env.local
npm install
npm run dev
```

Requires Node.js 18+ and a local PostgreSQL instance with the `vector` extension.

## OpenClaw Plugin

Copy or symlink `openclaw-plugin/` into your OpenClaw plugin path, then configure in `openclaw.json`:

```jsonc
{
  "plugins": {
    "load": { "paths": ["/path/to/openclaw-plugin"] },
    "entries": {
      "nocturne": {
        "enabled": true,
        "config": {
          "baseUrl": "http://127.0.0.1:18901",
          "recallEnabled": true,
          "startupHealthcheck": true,
          "embeddingBaseUrl": "http://127.0.0.1:8090/v1",
          "embeddingApiKey": "your-key",
          "embeddingModel": "text-embedding-3-large"
        }
      }
    }
  }
}
```

### Plugin Config Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `baseUrl` | string | — | **Required.** Nocturne web app URL |
| `apiToken` | string | — | API token if auth is enabled |
| `timeoutMs` | integer | `30000` | Request timeout |
| `recallEnabled` | boolean | `true` | Inject recall candidates into prompts |
| `startupHealthcheck` | boolean | `true` | Health check on gateway start |
| `embeddingBaseUrl` | string | — | OpenAI-compatible embedding endpoint |
| `embeddingApiKey` | string | — | Embedding API key |
| `embeddingModel` | string | — | Embedding model name |
| `minDisplayScore` | number | `0.4` | Minimum recall score to display |
| `maxDisplayItems` | integer | `3` | Max recall candidates per turn |
| `injectPromptGuidance` | boolean | `true` | Add usage hints to system prompt |
| `readNodeDisplayMode` | string | `soft` | `soft` = condensed, `hard` = full dump |
| `excludeBootFromResults` | boolean | `false` | Exclude boot nodes from recall results |

## Agent Tools

The plugin exposes these tools to the LLM:

| Tool | Purpose |
|------|---------|
| `nocturne_status` | Check connection health |
| `nocturne_boot` | Load core memories for session init |
| `nocturne_get_node` | Read a node by URI |
| `nocturne_search` | Find memories by keyword or domain |
| `nocturne_list_domains` | Browse top-level domains |
| `nocturne_create_node` | Create a new memory |
| `nocturne_update_node` | Revise existing memory content |
| `nocturne_delete_node` | Remove a memory path |
| `nocturne_add_alias` | Create alternate access path |
| `nocturne_list_session_reads` | Show memories read this session |
| `nocturne_clear_session_reads` | Reset session read tracking |

All read/write tools use `uri` as the primary node identifier. This keeps the interface narrow and predictable for the model.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Service health check |
| `/api/browse/domains` | GET | List all domains |
| `/api/browse/node` | GET | Read a node (`?uri=...`) |
| `/api/browse/search` | GET | Lexical search (`?q=...`) |
| `/api/browse/search` | POST | Hybrid search (with embedding) |
| `/api/browse/boot` | GET | Load boot memories |
| `/api/browse/alias` | POST | Create alias |
| `/api/browse/glossary` | GET | Glossary index |
| `/api/browse/triggers` | GET | Disclosure triggers |
| `/api/browse/session/read` | POST | Track session reads |
| `/api/browse/recall` | POST | Get recall candidates |
| `/api/browse/recall/rebuild` | POST | Rebuild recall index |
| `/api/review/*` | — | Memory review tools |
| `/api/maintenance/*` | — | Maintenance operations |

## Project Structure

```
.
├── web/                        # Next.js SSR app
│   ├── app/                    #   Pages & API routes
│   │   ├── api/
│   │   │   ├── browse/         #     Memory CRUD & search
│   │   │   ├── review/         #     Review endpoints
│   │   │   ├── maintenance/    #     Maintenance endpoints
│   │   │   └── health/         #     Health check
│   │   ├── memory/             #     Memory browser UI
│   │   ├── review/             #     Review UI
│   │   ├── plugin/             #     Plugin lab UI
│   │   └── maintenance/        #     Maintenance UI
│   ├── server/                 #   Server-side logic
│   │   ├── db.js               #     Database connection
│   │   ├── auth.js             #     Token auth
│   │   └── nocturne/           #     Core business logic
│   ├── components/             #   Shared UI components
│   ├── lib/                    #   Utilities
│   └── Dockerfile
├── openclaw-plugin/            # OpenClaw integration plugin
│   ├── index.ts                #   Plugin entry (tool definitions & handlers)
│   └── openclaw.plugin.json    #   Plugin manifest & config schema
├── docker-compose.yml          # Standard deployment
├── docker-compose.portainer.yml
├── .env.example
└── README.md
```

## Design Decisions

**Monolith over microservices.** UI, API, and data access live in one Next.js app. Fewer moving parts, fewer failure modes, easier to debug. The complexity is in the memory model and retrieval, not in service orchestration.

**PostgreSQL for everything.** Structured data, full-text search, and vector search all in one database. No separate vector service to deploy, monitor, or backup.

**Narrow tool surface.** 11 tools for the agent, not 30. Maintenance and review capabilities exist in the API and UI but aren't exposed to the LLM by default. Fewer tools = fewer hallucinated tool calls.

**Cue-card embeddings.** Recall embeddings are built from URI, title, glossary, and disclosure — not the full content body. This makes recall a "should I think about this?" signal rather than a fuzzy content match.

## Credits

Based on [Nocturne Memory](https://github.com/Dataojitori/nocturne_memory) by Dataojitori. Adapted and extended for OpenClaw.

## License

MIT
