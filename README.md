# Nocturne Memory for OpenClaw

> 一个面向 OpenClaw 的自托管长期记忆发行版。  
> 以 **单体 Next.js SSR Web App + 本地 OpenClaw Plugin + PostgreSQL/pgvector** 为核心，强调**部署简单、运行路径短、检索可控、适合个人与小规模自托管场景**。

## 项目定位

Nocturne Memory for OpenClaw 不是一个通用“AI 记忆 Demo”，也不是把若干向量检索组件临时拼起来的实验仓库。

它的目标很明确：

**为 OpenClaw 提供一套可长期运行、可解释、可维护、可自托管的长期记忆系统。**

相比很多“前端一套、后端一套、向量库再一套”的常见组合，这个仓库更关注真实使用时的几个核心问题：

- 记忆是否能稳定服务于日常对话，而不是只在演示里可用
- 部署链路是否足够短，出问题时能不能快速定位
- 读写接口是否足够收敛，避免模型在工具层频繁走偏
- 检索结果是否兼顾语义召回与词法可控性，而不是完全黑盒
- 整套系统是否适合个人开发者长期维护，而不是只能靠复杂运维撑着

所以，这个项目本质上是一套 **OpenClaw 优先** 的 Nocturne 发行版：
它保留了 Nocturne 作为长期记忆系统的核心思想，同时围绕 OpenClaw 的插件调用、提示注入、会话记忆读取与日常运维做了更适合实际落地的重构。

---

## 上游来源 / 原作者仓库

本项目基于上游 Nocturne Memory 演进而来，保留并尊重原项目脉络。

- **上游原作者仓库**：https://github.com/Dataojitori/nocturne_memory
- **当前 OpenClaw 发行版仓库**：https://github.com/FFatTiger/nocturne-memory-openclaw

上游项目采用 MIT License，本仓库沿用上游许可证。

---

## 这个仓库解决了什么问题

如果你只是想“给 AI 接个向量库”，其实有很多更轻的做法。

但如果你要的是下面这种能力，这个仓库会更合适：

- 让 OpenClaw 在新会话中执行 boot，恢复稳定的人设、偏好与工作规则
- 让模型在需要时读取长期记忆，而不是把所有历史都塞进上下文
- 让 recall/search 同时支持**语义召回**和**词法兜底**
- 让 UI、API、数据库访问逻辑在一个统一服务里闭环
- 让 OpenClaw 通过本地 plugin 直接访问记忆服务，而不是再绕一层独立后端
- 让部署、升级、回滚都能沿着清晰的单体服务路径完成

它适合的场景不是“超大规模多租户 SaaS”，而是：

- 个人 AI 助手长期记忆
- 私有化、自托管的 AI 工作流
- OpenClaw 本地/家庭服务器部署
- 需要可控记忆结构和可查检索结果的开发环境

---

## 核心优势

### 1. 运行链路短，部署和排障都更直接

当前架构把 UI、API、数据库访问层放进同一个 Next.js SSR 应用里，OpenClaw 再通过本地插件访问这套 Web 服务。

这意味着：

- 组件更少
- 网络跳数更少
- 配置面更收敛
- 故障边界更清晰

对自托管用户来说，这种“少一层就是少一类问题”的收益非常实际。

### 2. 检索不是纯黑盒向量搜索

很多记忆系统一旦全押注 embedding，短 query、专有名词、路径词、规则词就很容易飘。

这个项目没有把检索完全交给单一路径，而是采用：

- **PostgreSQL FTS** 做词法搜索与精确兜底
- **pgvector** 做语义召回
- 在搜索层做加权与融合，而不是简单“谁分高就用谁”

这样做的好处是：

- 短 query 更稳
- URI / path / glossary / disclosure 这类结构化信息能发挥作用
- 检索结果更容易解释和调优

### 3. 工具面收口，减少模型误用

在真实代理系统里，工具不是越多越好，**稳定可预测比“功能全开”更重要**。

当前对 OpenClaw 日常对话暴露的工具面维持在 11 个常用工具，聚焦：

- boot
- status
- get/search/list
- create/update/delete
- alias
- session read tracking

而 review、orphan、glossary、trigger 这类维护型能力，不默认暴露给日常对话模型。

这背后的设计思想很简单：

**把“模型日常会碰到的操作”与“开发者维护系统时才需要的操作”分开。**

这样能明显减少误调用、降低提示负担，也更符合真实代理环境的稳定性需求。

### 4. URI 心智模型更统一

这个仓库在工具接口上做过一轮明显收口：

- `get/update/delete` 统一优先使用 `uri`
- recall 结果直接返回完整 URI
- `create` 优先支持最终 `uri`
- `add_alias` 使用 `new_uri` / `target_uri`

这不是小修小补，而是在刻意降低“路径、domain、path segment、内部定位方式”之间的歧义。

对模型来说，**接口越统一，长期使用时出错越少**。

### 5. 更适合 OpenClaw 的运行方式

这个项目不是把一个通用 Web 应用硬接到 OpenClaw 上，而是从一开始就考虑：

- plugin 如何接入
- recall 如何注入
- boot 如何成为会话启动的一部分
- 会话读取记录如何服务模型行为约束
- 维护能力哪些该留给 UI，哪些该给插件

所以它不是“兼容 OpenClaw”，而是**面向 OpenClaw 运行现实做过定向设计**。

---

## 架构设计思想

### 一、单体优先，而不是服务拆分优先

这个仓库当前采用 **单个 Next.js SSR 应用承载 UI + Server API + 数据访问层** 的方式。

不是因为“不会拆”，而是因为对这个项目来说，单体方案更符合目标：

- 自托管场景优先考虑可部署性
- 个人/小团队维护优先考虑可理解性
- 记忆系统的核心复杂度在数据模型与检索，不在服务编排

如果在这个阶段就把前端、API、记忆服务、检索服务拆成多个运行单元，复杂度会先一步落到部署和运维上，而不是落在真正有价值的检索质量和记忆结构上。

所以这里的核心取舍是：

**先让系统足够稳定、足够清晰、足够容易跑起来，再谈进一步拆分。**

### 二、数据库中心化，而不是外置一堆中间层

本项目的数据层以 PostgreSQL 为中心：

- 结构化记忆数据在 PostgreSQL
- 词法搜索在 PostgreSQL FTS
- 语义索引在 `pgvector`

这让系统在很多场景下避免引入额外独立检索服务。

设计收益：

- 技术栈更收敛
- 备份、迁移、排障路径更统一
- 检索结果能直接与结构化字段联动

换句话说，这个项目不是在追求“最潮的检索架构”，而是在追求：

**一套足够强、但依然能被个人开发者完整掌控的记忆底座。**

### 三、检索分层，而不是把“搜索”当成单一动作

这里对搜索的理解不是“输个词 → 返回结果”，而是把检索拆成不同职责层：

- **boot**：恢复核心身份与规则
- **recall**：围绕当前对话做语义提示与候选唤醒
- **search**：显式查询、查找、定位
- **read**：打开节点，获取完整内容

这意味着 Nocturne 在这里不是一个“文档搜索框”，而是一个围绕代理行为设计的记忆系统。

### 四、内容与访问路径解耦

Nocturne 的一个关键思想是：

- 内容是内容
- 访问路径是访问路径
- 同一段记忆可以有多个入口

这也是 `alias` 存在的意义。

它允许记忆网络更接近真实思维方式：
不是只有一棵死板目录树，而是可以从不同语境进入同一段内容。

在代理系统里，这一点非常重要，因为很多“想起某件事”的触发条件，本来就不只一种。

### 五、对模型友好的接口，比“理论最完美的接口”更重要

很多系统设计在人工使用时没问题，但一交给模型就开始出现歧义、漂移和误操作。

这个项目在工具接口上的很多收口，本质都是围绕这个现实：

- 模型需要稳定、窄而清晰的输入形状
- 日常工具和维护工具要分层
- 召回线索必须能直接转成后续读取动作

所以这套架构并不迷信“接口抽象得越通用越好”，而更在意：

**模型能不能持续用对。**

---

## 当前架构

```text
OpenClaw ── local plugin ──> Next.js SSR app (/api/*) ──> PostgreSQL + pgvector
   │
   └──── optional recall injection

Browser ──> Next.js SSR app
```

当前运行时栈：

- **App Runtime**: Next.js 14
- **Database**: PostgreSQL
- **Vector Search**: pgvector
- **Lexical Search**: PostgreSQL Full-Text Search
- **Plugin Transport**: REST API

当前仓库布局：

```text
.
├── web/                       # Next.js app（UI + API + server-side data access）
├── openclaw-plugin/           # 本地 OpenClaw 插件
├── docker-compose.yml         # 默认部署栈
├── docker-compose.portainer.yml
├── .env.example
└── README.md
```

`web/` 内部是一个相对收敛的单体结构：

```text
web/
├── app/                       # Next.js App Router 页面与 API routes
├── components/                # 共享 UI 组件
├── lib/                       # 通用辅助逻辑
├── server/                    # 服务端数据库/业务逻辑
├── public/
├── package.json
└── Dockerfile
```

---

## 检索设计

当前检索不是单一路径，而是**词法 + 语义**并行考虑。

### Lexical Search

通过 PostgreSQL FTS 对以下信息做加权搜索：

- name / title
- path / URI 相关 token
- glossary
- disclosure
- content

并对 URI、path、name、glossary 等精确命中做额外 boost。

### Hybrid Search

在需要时，词法候选会与 embedding 语义候选合并，再做融合排序。

### 当前语义索引思路

语义索引并不追求“把整篇内容都塞进 embedding”，而更偏向 **cue-card 风格的紧凑表示**，重点围绕：

- URI
- title / name
- glossary
- path token
- disclosure 提示

这样做的原因不是偷懒，而是为了让 recall 更聚焦“该不该想起这段记忆”，而不是把长正文粗暴压缩进向量后再赌一次黑盒匹配。

---

## OpenClaw 插件集成

本地插件位于：

- `openclaw-plugin/`

插件通过 HTTP 调用 Web 服务的 `/api/*` 路由，配置时应填写 **Web App 的 origin**，而不是历史后端地址前缀。

示例：

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

当前面向日常对话的工具面为 11 个：

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

这组工具覆盖了长期记忆系统日常运行最常见的动作，同时把维护型能力留在更合适的边界内。

---

## 快速开始

### 1) 配置环境变量

```bash
cp .env.example .env
```

示例：

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

说明：

- `pgvector` 是必需的
- `API_TOKEN` 在公网或半公网部署时建议开启
- 健康检查接口为 `/api/health`

### 2) 启动服务

```bash
docker compose up -d --build
```

默认暴露端口：

- PostgreSQL: `5432`
- Web App: `18901`

启动后可访问：

- Health: `http://127.0.0.1:18901/api/health`
- UI: `http://127.0.0.1:18901`
- Plugin Lab: `http://127.0.0.1:18901/plugin`

---

## 本地开发

### Web App

```bash
cd web
cp .env.local.example .env.local
npm install
npm run dev
```

或以更接近生产的方式运行：

```bash
cd web
npm install
npm run build
npm start -- -H 0.0.0.0 -p 18901
```

环境要求：

- Node.js 18+
- PostgreSQL
- PostgreSQL `vector` extension

---

## API 概览

主接口位于 `/api/*` 下，常用端点包括：

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

其中：

- `GET /api/browse/search` 主要用于 lexical search
- `POST /api/browse/search` 可接入 embedding 做 hybrid search

---

## 为什么是这个仓库结构

这个仓库并不试图把所有能力都做成“理论最通用”的层次化平台。

它更像是一套**经过工程取舍后的发行版**：

- 保留 Nocturne 作为长期记忆系统的核心能力
- 用更短的运行路径服务 OpenClaw
- 用更收敛的接口减少模型误用
- 用 PostgreSQL + pgvector + FTS 建立兼顾可控性与实用性的检索底座

如果你在找的是：

- 一个适合 OpenClaw 的长期记忆后端
- 一个部署负担没有那么重的 Nocturne 变体
- 一个便于继续演进检索策略与记忆结构的工程基础

那这个仓库就是为这个目标而写的。

---

## 不包含的内容

仓库不会包含以下内容：

- 真实数据库内容
- 真实 `.env` 配置
- Token / API Key
- 构建产物
- 生产日志

---

## License

MIT License. See `LICENSE`.

并再次感谢上游原作者项目：

- https://github.com/Dataojitori/nocturne_memory
