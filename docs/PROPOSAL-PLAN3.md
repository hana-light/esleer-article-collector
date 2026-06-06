# 方案3：采集与 AI 生成分离架构

## 目标

小花发任意 elpais.com 或 elmundo.es 文章链接 → article-collector 自动完成采集 + AI 精读 + 笔记保存。

## 现状

有两套流程，各自独立：

| 流程 | 采集 | AI 生成 |
|------|------|---------|
| fetch-article.mjs | ✅ 反爬完善（session 预热、headers、编码检测、elmundo iso-8859-15） | ❌ 需手动调 API |
| /api/jobs/collect | ❌ 反爬弱（只有基础 User-Agent，elpais/elmundo 必 403） | ✅ 有用户确认 checkpoint |

两者没有打通。

---

## 方案3：统一采集 + 新增 Job 确认 API

### 核心思路

```
agent 收到链接 → fetch-article.mjs 采集（处理反爬）→ 直接写 DB
              → 新增 API：/api/jobs/from-article/{articleId}/confirm
              → 触发 AI 精读（有用户确认 checkpoint）
              → 完成
```

**采集**：统一走 fetch-article.mjs（反爬逻辑集中，好维护）
**AI 生成**：走 Jobs API（统一入口，有 checkpoint）

### 架构图

```
用户发链接（elpais.com / elmundo.es）
    │
    ▼
┌─────────────────────────────────────┐
│  Agent（article-collector）          │
│                                     │
│  1. 识别域名                        │
│  2. 调用 fetch-article.mjs          │
│     （处理反爬，写入 esleer DB）      │
│  3. 拿到 article_id                 │
│  4. 调 /api/jobs/from-article/{id}   │
│     confirm 触发 AI 精读            │
│  5. 轮询等待 completed              │
└─────────────────────────────────────┘
    │                           │
    ▼                           ▼
fetch-article.mjs          /api/jobs/...
（采集，含反爬）            （AI 生成，含用户确认）
    │                           │
    ▼                           ▼
  esleer DB ←────────────── AI 精读 → 笔记
```

---

## 改动清单

### 1. 新增 API：`/api/jobs/from-article/{articleId}/confirm`

**路径**：`/esleer/api/jobs/from-article/[articleId]/confirm/route.ts`

**功能**：从已有的 article_id 创建 Job 并触发 AI 精读

**请求**：
```
POST http://localhost:3000/esleer/api/jobs/from-article/{articleId}/confirm
Cookie: <session cookie>
```

**响应**：
```json
{ "jobId": "clxxxxxx", "status": "processing" }
```

**行为**：
1. 验证 articleId 存在且属于当前用户
2. 创建 CollectionJob，status = "imported"（复用已采集的文章）
3. 自动触发 AI 精读（不需要再调 confirm）
4. 轮询时返回 `articleTitle` 和 `articleId`

**为何需要这个 API**：
- fetch-article.mjs 采完直接写 DB，没有「job」概念
- 原来的 Jobs API 假设「采集+AI」在同一个 Job 里
- 新 API 让「采集」和「AI 生成」解耦

---

### 2. 更新 fetch-article.mjs：新增 `--job` 输出模式

**改动**：采集成功后，支持输出 job-ready 的 JSON，供 agent 解析

```bash
# 默认模式（纯文本）
node scripts/fetch-article.mjs <URL>

# Job 模式（输出 article_id + 确认 API）
node scripts/fetch-article.mjs <URL> --job-mode

# 输出示例：
# {"articleId":"cmxxxxxx","title":"文章标题","confirmUrl":"/api/jobs/from-article/cmxxxxxx/confirm"}
```

**或更简单**：agent 直接解析最后一行 `article_id = xxx`，然后调 confirm API

---

### 3. 更新 INTEGRATION.md（agent 手册）

新增「采集 → AI 确认」的完整流程：

```
agent 收到 URL
    │
    ▼
[Step 1] 调用 fetch-article.mjs 采集
         node scripts/fetch-article.mjs <URL>
    │
    ├─ 失败 → 报告反爬问题
    │
[Step 2] 提取 article_id（从输出日志）
         格式：✅ 已写入数据库，article_id = <id>
    │
[Step 3] 向用户展示文章信息
         article_id = <id>
         访问：http://localhost:3000/esleer/reader/<id>
         ⚠️ 即将消耗 AI 额度进行全文精读，是否继续？(y/n)
    │
    ├─ 用户拒绝 → 结束，告知文章已入库
    │
[Step 4] 触发 AI 精读
         POST /api/jobs/from-article/{articleId}/confirm
    │
[Step 5] 轮询状态
         GET /api/jobs/{jobId}
         轮询间隔：3秒/次
         最多等待：300秒（100次）
         目标状态：completed 或 failed
    │
[Step 6] 完成
```

---

### 4. 完善反爬能力（已在 fetch-article.mjs）

当前 fetch-article.mjs 已实现：

**elpais.com**：
- 先打 elpais.com 首页建立 cookie，再采目标页（解决 403）
- 完整 headers：User-Agent + Accept + Accept-Language + Sec-Fetch-*

**elmundo.es**：
- 检测 iso-8859-15 编码（elmundo 返回 latin1）
- 通过 arrayBuffer + TextDecoder 统一处理

**通用**：
- 列表页检测（50+ 模式匹配）
- 节流（3次/天/域名）
- 正文不足检测（< 120 chars 拒绝）

**未来扩展**：只需修改 fetch-article.mjs，无需动 agent 逻辑

---

## 文件改动汇总

| 文件 | 改动 | 类型 |
|------|------|------|
| `esleer-next/src/app/api/jobs/from-article/[articleId]/confirm/route.ts` | 新增 | API |
| `scripts/fetch-article.mjs` | 可选：新增 `--job-mode` 输出 | 脚本 |
| `INTEGRATION.md` | 更新流程，加入采集步骤 | 文档 |
| `skills/esleer-article-notes-pipeline/SKILL.md` | 同步更新 agent skill | 文档 |

---

## 验证标准（DoD）

1. 发 `https://elpais.com/chile/2026-05-06/cuando-la-ia-puede-predecir-un-delito.html` → 采集成功 + AI 笔记生成
2. 发 `https://www.elmundo.es/xxx/article.html` → 编码正确（中文字符无乱码）+ AI 笔记生成
3. 发 `https://elpais.com/`（首页）→ 被拒绝，提示「请提供具体文章 URL」
4. 连续发 4 次 → 第 4 次被节流限制
5. 用户拒绝 AI 精读 → 文章已入库，可手动精读

---

## 时间估算

| 任务 | 负责 | 估算 |
|------|------|------|
| 新增 /api/jobs/from-article/{id}/confirm API | engineer | 1-2h |
| 更新 INTEGRATION.md + SKILL.md | product | 0.5h |
| 测试（elpais + elmundo + 列表页 + 节流） | tester | 1h |
| **合计** | | **2.5-3.5h** |

---

## 依赖关系

```
[新增 API] ──────────────────────────→ [更新 INTEGRATION.md]
       ↑                                       │
       └────── [测试验证] ←────────────────────┘
```

API 完成后才能更新文档和测试。

---

## 风险点

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| elpais 加强反爬 | 中 | 高 | fetch-article.mjs 可快速迭代，session 预热策略可调整 |
| elmundo 编码误判 | 低 | 中 | TextDecoder 自动检测，已有多次验证 |
| API 新增后与现有 Jobs API 冲突 | 低 | 中 | confirm API 独立路径，不改动现有逻辑 |