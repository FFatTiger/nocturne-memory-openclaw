# Nocturne Memory for OpenClaw

一个把 **Nocturne 后端 + Next.js 前端 + OpenClaw 本地插件** 收到同一仓库里的二次开发版本。

这不是上游仓库的原样镜像，而是围绕 OpenClaw 场景做的整理版：REST 化接入、前端代理、recall 链路，以及 PostgreSQL + pgvector 部署方案都在这里。

## 现在的技术路线

这个仓库现在是 **PostgreSQL-only**。

- 主数据：PostgreSQL
- recall 向量：**同一个 PostgreSQL** 里的 `pgvector`
- 全文搜索：PostgreSQL `tsvector`
- 前端代理：Next.js
- OpenClaw 接入：本地插件走 REST API

不再维护 SQLite 分支，也不再拆两套数据库。

## 上游来源 / Original Upstream

本仓库的后端与前端基础来自：

- Upstream repository: `https://github.com/Dataojitori/nocturne_memory`

上游仓库当前许可证为 **MIT License**，本仓库保留其 `LICENSE`。

## 主要改动

1. **OpenClaw 本地插件接入**
   - 新增 `plugin/`
   - 通过 REST API 而不是旧的 MCP 桥作为主要接入方式
   - 提供 `nocturne_*` 工具注册、prompt guidance 注入、hook 生命周期逻辑

2. **前端改为可代理后端的 Next.js 结构**
   - `frontend/app/api/[...path]/route.js` 负责把前端请求代理到后端 API
   - 外部访问前端时，不需要浏览器直接跨域打后端

3. **后端补充 OpenClaw 集成能力**
   - 浏览 API 扩展
   - recall / session-read 相关接口与数据结构
   - 与插件协作的读取追踪逻辑

4. **前端新增 Plugin Lab 页面**
   - 新增 `/plugin` 测试页
   - 可直接验证 status / boot / browse / glossary / alias / triggers / review / maintenance / recall
   - 适合对照 OpenClaw plugin 的各个能力逐项联调

5. **存储统一到 PostgreSQL**
   - 普通图数据走 PostgreSQL
   - recall embedding 存到 `pgvector`
   - search 走 PostgreSQL FTS

## 目录结构

```text
.
├── backend/                 # FastAPI backend
│   ├── api/
│   ├── db/
│   ├── models/
│   ├── tests/
│   ├── Dockerfile
│   ├── main.py
│   └── requirements.txt
├── frontend/                # Next.js frontend
│   ├── app/
│   ├── public/
│   ├── src/
│   ├── Dockerfile
│   └── package.json
├── plugin/                  # OpenClaw local plugin
│   ├── index.ts
│   ├── openclaw.plugin.json
│   └── package.json
├── docker-compose.yml
├── .env.example
├── LICENSE
└── README.md
```

## 快速开始

### 1) 准备环境变量

复制一份根目录 `.env.example`：

```bash
cp .env.example .env
```

示例：

```env
DATABASE_URL=postgresql+asyncpg://nocturne:change-me@127.0.0.1:5432/nocturne
API_TOKEN=your-token-if-needed
```

说明：

- 可以直接写 `postgresql://...`
- 后端会自动归一化成 `postgresql+asyncpg://...`
- 目标数据库用户需要有 `CREATE EXTENSION vector` 权限

### 2) 本地直接启动后端

建议 Python 3.11+。

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m uvicorn main:app --host 0.0.0.0 --port 18901 --app-dir .
```

### 3) 本地直接启动前端

建议 Node.js 18+。

```bash
cd frontend
cp .env.local.example .env.local
npm install
npm run dev
```

生产模式：

```bash
cd frontend
npm install
npm run build
npm start -- -H 0.0.0.0 -p 18902
```

## Docker 部署

仓库根目录带了 `docker-compose.yml`。

默认会启动三项：

- `postgres`：`pgvector/pgvector:pg16`
- `backend`：FastAPI
- `frontend`：Next.js

### 本地或 Ubuntu 直接起

```bash
docker compose up -d --build
```

默认端口：

- PostgreSQL: `5432`
- backend: `18901`
- frontend: `18902`

### 常用环境变量

```env
POSTGRES_DB=nocturne
POSTGRES_USER=nocturne
POSTGRES_PASSWORD=change-me
DATABASE_URL=postgresql+asyncpg://nocturne:change-me@postgres:5432/nocturne
API_TOKEN=
BACKEND_PORT=18901
FRONTEND_PORT=18902
```

### Ubuntu 部署建议

如果是全新 Ubuntu 主机，最省事的方式是：

```bash
git clone <this-repo>
cd nocturne-openclaw-public
cp .env.example .env
# 按实际情况改密码 / token / 域名反代

docker compose up -d --build
```

如果你不想在 Ubuntu 现场编译，也可以直接使用已发布镜像。

当前可用镜像：

- backend: `fffattiger/nocturne-memory-backend:pgonly-20260325`
- frontend: `fffattiger/nocturne-memory-frontend:plugin-20260325-180901`

最小 `.env` 覆盖示例：

```env
NOCTURNE_BACKEND_IMAGE=fffattiger/nocturne-memory-backend:pgonly-20260325
NOCTURNE_FRONTEND_IMAGE=fffattiger/nocturne-memory-frontend:plugin-20260325-180901
```

然后：

```bash
docker compose pull
docker compose up -d
```

## Docker Hub 推镜像

### 构建

```bash
docker build -t fffattiger/nocturne-memory-backend:pgonly-20260325 ./backend
docker build -t fffattiger/nocturne-memory-frontend:plugin-20260325-180901 ./frontend
```

### 推送

```bash
echo "$DOCKER_HUB_TOKEN" | docker login -u fffattiger --password-stdin
docker push fffattiger/nocturne-memory-backend:pgonly-20260325
docker push fffattiger/nocturne-memory-frontend:plugin-20260325-180901
```

## OpenClaw 插件接入

把 `plugin/` 作为本地插件目录接入 OpenClaw，然后在 OpenClaw 配置里加载它。

示例：

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
          "startupHealthcheck": true
        }
      }
    }
  }
}
```

如果你要启用 recall，可以补这些配置：

```json
{
  "baseUrl": "http://127.0.0.1:18901",
  "recallEnabled": true,
  "embeddingBaseUrl": "http://127.0.0.1:8090/v1",
  "embeddingApiKey": "YOUR_API_KEY",
  "embeddingModel": "text-embedding-3-large",
  "minDisplayScore": 0.6,
  "maxDisplayItems": 3,
  "scorePrecision": 2,
  "readNodeDisplayMode": "soft"
}
```

## recall 现在怎么存

recall 索引会写到 PostgreSQL 的 `recall_documents` 表里。

关键点：

- 文本元数据还在普通列里
- embedding 改为 `pgvector` 的 `vector` 列
- 查询时直接在 PostgreSQL 内做向量相似度排序
- session read tracking 仍然走普通关系表

## Plugin Lab 页面

前端现在带一个 `/plugin` 页面，用来直接测试 plugin 的主要能力。

目前包含：

- health / boot / domains
- get node / search
- create / update / delete node
- alias / triggers / glossary
- session read
- review / orphan maintenance
- recall 与 recall index rebuild

如果你是在本机开发，前端起起来后直接打开：

- `http://127.0.0.1:18902/plugin`

## 测试

后端测试现在默认使用 PostgreSQL。

优先顺序：

1. 如果设置了 `TEST_DATABASE_URL`，直接使用它
2. 如果没设，测试会尝试自动起一个临时 `pgvector/pgvector:pg16` Docker 容器

运行：

```bash
cd backend
pytest
```

## 当前本地部署参考

典型端口：

- backend: `18901`
- frontend: `18902`

常见链路：

```text
Browser -> Next.js frontend (18902) -> /api/[...path] proxy -> FastAPI backend (18901)
OpenClaw plugin -> REST API -> FastAPI backend (18901)
```

## 不包含的内容

这个公开仓库故意不包含：

- 实际数据库数据
- `.env` 真值
- token / key
- `node_modules/`
- `.next/`
- Python 虚拟环境
- 线上日志

## 兼容与注意事项

1. 这个仓库以自托管为主。
2. 生产环境请自己补：反向代理、HTTPS、访问控制、数据库备份。
3. `pgvector` 扩展是必需项。
4. 仓库里的端口只是默认值，不是协议要求。

## 致谢

感谢上游项目提供基础实现：

- `Dataojitori/nocturne_memory`

本仓库在其基础上做了 OpenClaw 相关的二次开发与仓库结构整理。
