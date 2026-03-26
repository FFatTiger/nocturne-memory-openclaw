# Nocturne Memory for OpenClaw

Nocturne Memory for OpenClaw is a PostgreSQL-first Nocturne distribution that packages three pieces in one repository:

- a **FastAPI backend** for the Nocturne memory graph
- a **Next.js frontend** for browsing and operating the graph
- a **local OpenClaw plugin** that talks to the backend over REST

This repo is meant for self-hosted OpenClaw deployments. It keeps the memory service, web UI, and plugin integration in one place so you can run the full stack without MCP bridging or a split codebase.

## What this fork focuses on

This is not a mirror of the upstream repository. It is a focused integration fork for the OpenClaw workflow.

Key differences:

- **REST-based OpenClaw integration** via `plugin/`
- **PostgreSQL-only** storage
- **pgvector-backed recall** stored in the same database
- **Next.js proxy frontend** so the browser can talk to the backend through the web app
- **session-read tracking** and **recall injection** for OpenClaw
- a built-in **Plugin Lab** page for testing integration flows

## Architecture

```text
OpenClaw ──local plugin──> FastAPI backend ──> PostgreSQL + pgvector
   │
   └──── optional recall injection

Browser ──> Next.js frontend ──> /api/[...path] proxy ──> FastAPI backend
```

Current stack:

- **Backend:** FastAPI
- **Frontend:** Next.js 14
- **Database:** PostgreSQL
- **Vector search:** `pgvector`
- **Full-text search:** PostgreSQL FTS
- **Plugin transport:** REST API

## Repository layout

```text
.
├── backend/                   # FastAPI backend
├── frontend/                  # Next.js frontend
├── plugin/                    # Local OpenClaw plugin
├── docker-compose.yml         # Default self-hosted stack
├── docker-compose.portainer.yml
├── .env.example
└── README.md
```

## Requirements

For the default deployment path:

- Docker + Docker Compose

For local development:

- Python 3.11+
- Node.js 18+
- PostgreSQL with the `vector` extension available

## Quick start

### 1. Configure environment

```bash
cp .env.example .env
```

Important variables:

```env
POSTGRES_DB=nocturne
POSTGRES_USER=nocturne
POSTGRES_PASSWORD=change-me
DATABASE_URL=postgresql+asyncpg://nocturne:change-me@postgres:5432/nocturne
API_TOKEN=your-token-if-needed
BACKEND_PORT=18901
FRONTEND_PORT=18902
```

Notes:

- `pgvector` is required.
- `API_TOKEN` is optional, but recommended outside local development.
- `/health` is intentionally left unauthenticated for health checks.

### 2. Start the full stack with Docker

```bash
docker compose up -d --build
```

Default exposed ports:

- PostgreSQL: `5432`
- backend: `18901`
- frontend: `18902`

After startup:

- backend health: `http://127.0.0.1:18901/health`
- backend docs: `http://127.0.0.1:18901/docs`
- frontend: `http://127.0.0.1:18902`
- Plugin Lab: `http://127.0.0.1:18902/plugin`

## Local development

### Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m uvicorn main:app --host 0.0.0.0 --port 18901 --app-dir .
```

### Frontend

```bash
cd frontend
cp .env.local.example .env.local
npm install
npm run dev
```

`frontend/.env.local.example` defaults to:

```env
BACKEND_URL=http://127.0.0.1:18901
```

For a production-style frontend run:

```bash
cd frontend
npm install
npm run build
npm start -- -H 0.0.0.0 -p 18902
```

## OpenClaw plugin

The local plugin lives in `plugin/`.

Load it from your OpenClaw config and point it at the Nocturne backend:

```json
{
  "plugins": {
    "load": {
      "paths": [
        "/absolute/path/to/plugin"
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

The plugin currently exposes a focused day-to-day tool surface:

- `nocturne_status`
- `nocturne_boot`
- `nocturne_get_node`
- `nocturne_search`
- `nocturne_list_domains`
- `nocturne_create_node`
- `nocturne_update_node`
- `nocturne_delete_node`
- `nocturne_add_alias`
- `nocturne_manage_triggers`
- `nocturne_get_glossary`
- `nocturne_add_glossary`
- `nocturne_remove_glossary`
- `nocturne_list_session_reads`
- `nocturne_clear_session_reads`

The backend and web UI still include review and maintenance flows, but those are intentionally not part of the everyday public plugin tool surface.

## Recall model

Recall data is stored in PostgreSQL in the `recall_documents` table.

The current recall pipeline is designed around compact cue cards rather than long body previews. In practice that means embeddings are built from things like:

- URI
- title or name
- glossary bindings
- path tokens
- short disclosure hints

This keeps recall focused on retrievability instead of dumping large content previews into the embedding input.

## Docker images

The compose file supports image overrides.

Default image variables:

```env
NOCTURNE_POSTGRES_IMAGE=pgvector/pgvector:pg16
NOCTURNE_BACKEND_IMAGE=fffattiger/nocturne-memory-backend:recallcue-20260325-230834
NOCTURNE_FRONTEND_IMAGE=fffattiger/nocturne-memory-frontend:plugin-20260325-180901
```

To use published images directly:

```bash
docker compose pull
docker compose up -d
```

A Portainer-oriented example deployment is included in `docker-compose.portainer.yml`.

## Useful pages and endpoints

Web UI:

- `/` — main app
- `/plugin` — Plugin Lab for integration checks
- `/review` — review interface
- `/maintenance` — maintenance UI

Backend:

- `/health` — service health
- `/docs` — FastAPI docs
- `/browse/*` — browse and memory operations
- `/review/*` — review operations
- `/maintenance/*` — maintenance endpoints

## Testing

Backend tests prefer PostgreSQL.

- If `TEST_DATABASE_URL` is set, tests use that database.
- Otherwise the test suite can start a temporary `pgvector/pgvector:pg16` container.

Run:

```bash
cd backend
pytest
```

## What is not included

This repository intentionally does not ship:

- real database contents
- real `.env` values
- tokens or API keys
- frontend build output
- Python virtual environments
- production logs

## Upstream and license

The backend and frontend foundation came from the upstream project:

- https://github.com/Dataojitori/nocturne_memory

Upstream is MIT-licensed, and this repository keeps the upstream `LICENSE`.

This fork reorganizes and extends that base for OpenClaw-oriented self-hosting.