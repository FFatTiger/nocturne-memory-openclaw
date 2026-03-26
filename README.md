# Nocturne Memory for OpenClaw

Nocturne Memory for OpenClaw is a self-hosted Nocturne distribution built as a **single Next.js SSR app** for both UI and server API, plus a local OpenClaw plugin.

This repository is for OpenClaw deployments that want one web service talking directly to PostgreSQL, without a separate Python backend in the runtime path.

## What this repo contains

- `web/` — the Next.js app
  - UI pages
  - server-side API routes under `/api/*`
  - PostgreSQL access layer
  - recall, review, and maintenance logic
- `openclaw-plugin/` — the local OpenClaw plugin that talks to the web app over HTTP
- `docker-compose.yml` — default self-hosted stack
- `docker-compose.portainer.yml` — Portainer-oriented deployment example

## Current architecture

```text
OpenClaw ──local plugin──> Next.js SSR app (/api/*) ──> PostgreSQL + pgvector
   │
   └──── optional recall injection

Browser ──> Next.js SSR app
```

Current stack:

- **App runtime:** Next.js 14
- **Database:** PostgreSQL
- **Vector search:** `pgvector`
- **Full-text search:** PostgreSQL FTS
- **Plugin transport:** REST API to the Next.js app

## What changed from the earlier layout

This repo used to be split into a frontend and a Python backend.

That is no longer the runtime model.

Current direction:

- the old `frontend/` layout has been reorganized into `web/`
- the old `plugin/` directory has been renamed to `openclaw-plugin/`
- the UI and API now run in the same Next.js service
- the OpenClaw plugin now targets the web service and uses `/api/*` routes
- the old Python backend has been removed from the active project layout

## Repository layout

```text
.
├── web/                       # Next.js app (UI + server API)
├── openclaw-plugin/           # Local OpenClaw plugin
├── docker-compose.yml         # Default self-hosted stack
├── docker-compose.portainer.yml
├── .env.example
└── README.md
```

Inside `web/`, the structure is intentionally flattened:

```text
web/
├── app/                       # Next.js app router pages and API routes
├── components/                # Shared UI components
├── lib/                       # Client/shared helpers
├── server/                    # Server-side DB/auth/service code
├── public/
├── package.json
└── Dockerfile
```

## Requirements

For normal deployment:

- Docker + Docker Compose

For local development:

- Node.js 18+
- PostgreSQL with the `vector` extension available

## Quick start

### 1. Configure environment

```bash
cp .env.example .env
```

Example root config:

```env
POSTGRES_DB=nocturne
POSTGRES_USER=nocturne
POSTGRES_PASSWORD=change-me
POSTGRES_PORT=5432
DATABASE_URL=postgresql://nocturne:change-me@postgres:5432/nocturne
API_TOKEN=your-token-if-needed
WEB_PORT=18901
CORE_MEMORY_URIS=core://agent,preferences://user,core://workflow
NOCTURNE_POSTGRES_IMAGE=pgvector/pgvector:pg16
NOCTURNE_FRONTEND_IMAGE=fffattiger/nocturne-memory-frontend:ssr-20260326-1022-amd64
```

Notes:

- `pgvector` is required.
- `API_TOKEN` is optional, but recommended outside local development.
- the app health endpoint is `/api/health`

### 2. Start the stack

```bash
docker compose up -d --build
```

Default exposed ports:

- PostgreSQL: `5432`
- web app: `18901`

After startup:

- app health: `http://127.0.0.1:18901/api/health`
- main UI: `http://127.0.0.1:18901`
- Plugin Lab: `http://127.0.0.1:18901/plugin`

## Local development

### Web app

```bash
cd web
cp .env.local.example .env.local
npm install
npm run dev
```

`web/.env.local.example` defaults to:

```env
DATABASE_URL=postgresql://nocturne:change-me@127.0.0.1:5432/nocturne
API_TOKEN=
CORE_MEMORY_URIS=core://agent,preferences://user,core://workflow
SNAPSHOT_DIR=./snapshots
```

Production-style local run:

```bash
cd web
npm install
npm run build
npm start -- -H 0.0.0.0 -p 18901
```

## OpenClaw plugin

The local plugin lives in `openclaw-plugin/`.

Load it from OpenClaw and point it at the web service base URL:

```json
{
  "plugins": {
    "load": {
      "paths": [
        "/absolute/path/to/openclaw-plugin"
      ]
    },
    "entries": {
      "nocturne": {
        "enabled": true,
        "config": {
          "baseUrl": "http://127.0.0.1:18901",
          "timeoutMs": 30000,
          "defaultDomain": "core",
          "injectPromptGuidance": true,
          "startupHealthcheck": true,
          "recallEnabled": true,
          "embeddingBaseUrl": "http://127.0.0.1:8090/v1",
          "embeddingApiKey": "YOUR_API_KEY",
          "embeddingModel": "text-embedding-3-large",
          "minDisplayScore": 0.4,
          "maxDisplayItems": 3,
          "scorePrecision": 2,
          "readNodeDisplayMode": "soft",
          "excludeBootFromResults": false
        }
      }
    }
  }
}
```

The plugin targets `/api/*` on the configured base URL internally, so the configured `baseUrl` should be the web app origin, not an old backend route prefix.

Current day-to-day tool surface (11 tools):

- `nocturne_status`
- `nocturne_boot`
- `nocturne_get_node`
- `nocturne_search`
- `nocturne_list_domains`
- `nocturne_create_node`
- `nocturne_update_node`
- `nocturne_delete_node`
- `nocturne_add_alias`
- `nocturne_list_session_reads`
- `nocturne_clear_session_reads`

The app also includes recall, review, and maintenance flows used by the web UI and plugin integration.

## API surface

Main routes now live under `/api/*`.

Useful endpoints:

- `/api/health`
- `/api/browse/domains`
- `/api/browse/node`
- `/api/browse/search`
- `/api/browse/boot`
- `/api/browse/alias`
- `/api/browse/glossary`
- `/api/browse/triggers`
- `/api/browse/session/read`
- `/api/browse/recall`
- `/api/browse/recall/rebuild`
- `/api/review/*`
- `/api/maintenance/*`

The legacy catch-all API proxy is intentionally disabled.

## Recall model

Recall data is stored in PostgreSQL in the `recall_documents` table.

The current recall pipeline is built around compact cue cards instead of long body previews. Embedding inputs are derived mainly from:

- URI
- title or name
- glossary bindings
- path tokens
- short disclosure hints

This keeps retrieval focused on recall quality instead of stuffing whole documents into the embedding payload.

## Docker images

Default image variables:

```env
NOCTURNE_POSTGRES_IMAGE=pgvector/pgvector:pg16
NOCTURNE_FRONTEND_IMAGE=fffattiger/nocturne-memory-frontend:ssr-20260326-1418-fix1-amd64
```

To use published images directly:

```bash
docker compose pull
docker compose up -d
```

A Portainer-oriented example deployment is included in `docker-compose.portainer.yml`.

## Testing

Basic sanity checks:

```bash
curl http://127.0.0.1:18901/api/health
curl http://127.0.0.1:18901/api/browse/domains
curl 'http://127.0.0.1:18901/api/browse/node?domain=core&path=agent'
```

Build check:

```bash
cd web
npm run build
```

## What is not included

This repository intentionally does not ship:

- real database contents
- real `.env` values
- tokens or API keys
- build output
- production logs

## Upstream and license

The original project foundation came from:

- https://github.com/Dataojitori/nocturne_memory

Upstream is MIT-licensed, and this repository keeps the upstream `LICENSE`.

This fork restructures that base into a Next.js-first OpenClaw deployment focused on a single web runtime plus plugin integration.
