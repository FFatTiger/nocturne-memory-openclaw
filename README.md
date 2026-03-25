# Nocturne Memory for OpenClaw

一个把 **Nocturne 后端 + Next.js 前端 + OpenClaw 本地插件** 整理到同一仓库里的二次开发版本。

这不是上游原仓库的原样镜像，而是为了 OpenClaw 本地接入、REST 化调用、前端代理、以及召回（recall）链路整理出来的公开版本。

## 仓库定位

这个仓库的目标很简单：

- 把目前实际在跑的 **后端 / 前端 / 插件** 放进同一个代码仓库里
- 明确区分 **上游来源** 和 **本地二开改动**
- 不把数据库、备份、缓存、密钥、`.env` 等私有内容带进公开仓库
- 让别人拿到这个仓库后，能看懂架构，也能自己复现一套本地环境

## 上游来源 / Original Upstream

本仓库的后端与前端基础来自上游项目：

- Upstream repository: `https://github.com/Dataojitori/nocturne_memory`

上游仓库当前许可证为 **MIT License**，本仓库保留其 `LICENSE`。

## 这是二次开发版本 / Secondary Development Notice

本仓库 **不是** 上游仓库的官方发布，也不是无改动镜像。

这是一个围绕 OpenClaw 场景做的二次开发版本，主要差异包括：

1. **OpenClaw 本地插件接入**
   - 新增 `plugin/` 目录
   - 通过 REST API 而不是旧的 MCP 桥作为主要接入方式
   - 提供 `nocturne_*` 工具注册、prompt guidance 注入、hook 生命周期逻辑

2. **前端改为可代理后端的 Next.js 结构**
   - `frontend/app/api/[...path]/route.js` 负责把前端请求代理到后端 API
   - 外部访问前端时，不需要浏览器直接跨域打后端

3. **后端补充 OpenClaw 集成所需能力**
   - 浏览 API 扩展
   - recall / session-read 相关接口与数据结构
   - 与插件协作的读取追踪逻辑

4. **仓库结构整理**
   - 把后端、前端、插件集中到一个公开仓库里
   - 不包含线上私有状态文件、数据库、备份、缓存与本地凭据

## 目录结构

```text
.
├── backend/                 # FastAPI backend
│   ├── api/
│   ├── db/
│   ├── models/
│   ├── tests/
│   ├── main.py
│   ├── auth.py
│   ├── health.py
│   └── requirements.txt
├── frontend/                # Next.js frontend
│   ├── app/
│   ├── public/
│   ├── src/
│   ├── package.json
│   └── next.config.js
├── plugin/                  # OpenClaw local plugin
│   ├── index.ts
│   ├── openclaw.plugin.json
│   └── package.json
├── .env.example
├── LICENSE
└── README.md
```

## 各部分说明

### 1) backend/

后端是 FastAPI 服务，负责：

- 节点读写
- 搜索
- glossary
- review
- orphan maintenance
- recall / session-read
- 健康检查

主要入口：

- `backend/main.py`
- `backend/api/browse.py`
- `backend/api/review.py`
- `backend/api/maintenance.py`
- `backend/db/recall.py`
- `backend/db/migrations/010_v1.4.0_add_recall_index_and_session_reads.py`

### 2) frontend/

前端是 Next.js 应用。

关键点：

- `frontend/app/page.js`：首页
- `frontend/app/memory/page.js`：Memory Explorer
- `frontend/app/review/page.js`：Review 页面
- `frontend/app/maintenance/page.js`：Maintenance 页面
- `frontend/app/api/[...path]/route.js`：把 `/api/*` 代理到后端 `BACKEND_URL`

默认代理目标：

- `http://127.0.0.1:18901`

可以通过 `frontend/.env.local` 里的 `BACKEND_URL` 覆盖。

### 3) plugin/

这是 OpenClaw 的本地插件部分。

主要职责：

- 注册 `nocturne_status / nocturne_boot / nocturne_get_node / nocturne_search ...` 等工具
- 在 prompt build 前注入 guidance
- 在支持 recall 配置时注入 `<recall>` block
- 在 `before_tool_call` / `session_end` 生命周期里做 session read tracking

关键文件：

- `plugin/index.ts`
- `plugin/openclaw.plugin.json`

## 不包含的内容

这个公开仓库 **故意不包含** 以下内容：

- 实际数据库文件（如 `nocturne.db`）
- 各种 `.bak` 备份
- `.env` 真值
- OpenClaw 主配置里的 token / key
- `node_modules/`
- `.next/`
- Python 虚拟环境
- 线上运行日志

如果你要复现环境，需要自己准备数据库和环境变量。

## 快速开始

### 后端

建议 Python 3.11+。

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp ../.env.example ../.env
```

把 `../.env` 里的 `DATABASE_URL` 改成你自己的绝对路径，例如：

```env
DATABASE_URL=sqlite+aiosqlite:///absolute/path/to/state/nocturne.db
API_TOKEN=your-token-if-needed
```

启动：

```bash
cd backend
python -m uvicorn main:app --host 0.0.0.0 --port 18901 --app-dir .
```

如果你从仓库根目录启动，也可以用：

```bash
python -m uvicorn main:app --host 0.0.0.0 --port 18901 --app-dir backend
```

### 前端

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

### OpenClaw 插件

把 `plugin/` 作为本地插件目录接入 OpenClaw，然后在 OpenClaw 配置里加载它。

一个示例配置片段如下：

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

如果你还要启用 recall，可以再补这些配置：

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

## 当前本地部署参考

这是作者当前本地部署时用过的一组典型端口：

- backend: `18901`
- frontend: `18902`

常见链路：

```text
Browser -> Next.js frontend (18902) -> /api/[...path] proxy -> FastAPI backend (18901)
OpenClaw plugin -> REST API -> FastAPI backend (18901)
```

## 为什么不直接继续用上游仓库

因为当前实际运行环境里，已经不只是单纯的 `nocturne_memory`：

- 有 OpenClaw 插件层
- 有本地 prompt / recall / lifecycle 集成
- 有前端代理层调整
- 有针对本地部署的路径与工作流约束

如果继续把这些散在不同目录里，后续维护、回滚、公开说明都会很乱。

所以这里把「当前真正跑着的三块代码」收成一个公共仓库，方便：

- 自己维护
- 对外说明
- 做版本对照
- 继续二开

## 兼容与注意事项

1. 这个仓库以 **本地单机 / 自托管** 场景为主。
2. 默认假设你知道怎么自己配置 `.env`。
3. 如果你直接公开部署，请自己补：
   - 反向代理
   - 鉴权
   - HTTPS
   - 数据库备份
   - 访问控制
4. 仓库里的端口只是本地习惯值，不是协议要求。

## 致谢

感谢上游项目提供基础实现：

- `Dataojitori/nocturne_memory`

本仓库在其基础上做了 OpenClaw 相关的二次开发与仓库结构整理。
