# esleer 文章自动采集 Pipeline — OpenClaw Agent 接入文档

> **读者定位**：本文档面向 OpenClaw agent，用于接入并驱动「采集文章 → AI 全文精读 → 笔记生成」完整流程。

---

## 一、Pipeline 概述（推荐流程）

```
用户给出文章链接
    ↓
[Step 0] node scripts/fetch-article.mjs <URL> --job-mode
         采集 HTML、解析正文、写入 esleer DB（含 elpais/elmundo 反爬处理）
         → stdout: { success, articleId, title }
    ↓
[Step 1] CHECKPOINT：向用户展示文章信息，确认是否消耗 AI 额度
    ↓
[Step 2] POST /api/jobs/from-article/{articleId}/confirm
         创建 Job 并立即触发 AI 全文精读
         → { jobId, status: "processing" }
    ↓
[Step 3] GET /api/jobs/{jobId}（轮询，3秒/次，最多300秒）
         → 等待 status = "completed" 或 "failed"
    ↓
完成：文章 + 笔记已保存到用户账号
```

**为何用此流程而非 `/api/jobs/collect`**：collect 路由仅有基础 User-Agent，对 elpais.com / elmundo.es 必 403。`fetch-article.mjs` 内置 cookie 预热、完整 headers、iso-8859-15 编码处理，反爬能力强，是这两个站点的唯一可靠入口。

---

## 二、前提条件

| 条件 | 说明 |
|------|------|
| esleer-next 运行中 | `http://localhost:3000`（本地开发环境） |
| 管理员账号 | Jobs API 仅管理员可用，普通账号返回 403 |
| 凭证文件 | `~/.config/esleer/credentials.json` |
| DeepSeek API Key | 用户已在 esleer 前端设置中配置 |
| Node.js 18+ | 运行 fetch-article.mjs |

### 凭证文件格式

路径：`~/.config/esleer/credentials.json`

```json
{
  "email": "管理员邮箱",
  "password": "密码"
}
```

---

## 三、Step 0：采集文章（subprocess）

### 调用方式

```bash
node /path/to/esleer-article-collector/scripts/fetch-article.mjs <URL> --job-mode
```

`--job-mode` 标志：
- **stdout**：仅输出一行 JSON（agent 解析此行）
- **stderr**：进度日志（仅用于显示，不参与解析）

### 成功输出（stdout）

```json
{"success": true, "articleId": 12345, "title": "文章标题"}
```

### 失败输出（stdout，exit code 1）

```json
{"success": false, "error": "列表页/首页拒绝采集：首页（空路径）"}
```

### Agent 调用规范

```python
import subprocess, json

result = subprocess.run(
    ['node', '/path/to/scripts/fetch-article.mjs', url, '--job-mode'],
    capture_output=True, text=True, timeout=60
)
# stderr 可打印为进度日志
# stdout 解析 JSON
data = json.loads(result.stdout.strip())

if result.returncode != 0 or not data.get('success'):
    # Gate 0 失败：报告 data['error']，停止
    raise SystemExit(f"❌ 采集失败: {data.get('error', '未知')}")

article_id = data['articleId']
title = data['title']
```

**Gate 0**：exit code = 0 且 `success = true`，否则立即停止报告原因。

### 内置限制与拒绝条件

| 情况 | 错误信息关键词 | 说明 |
|------|--------------|------|
| 首页/列表页 | 列表页/首页拒绝采集 | 提示用户提供具体文章 URL |
| 节流限制 | 反爬限制 | 同一域名每天最多 3 次，次日重试 |
| 正文不足 | 正文不足 | 页面内容 < 120 字符，可能需要 JS 渲染 |
| HTTP 错误 | HTTP 4xx/5xx | 网络问题或站点封锁 |

---

## 四、CHECKPOINT：用户确认 AI 额度

在调用 Step 2（消耗 DeepSeek 额度）前，**必须**向用户展示：

```
📄 文章已导入成功
   标题：<title>
   ID：<articleId>
   访问：http://localhost:3000/esleer/reader/<articleId>

⚠️  即将消耗 AI 额度进行全文精读，是否继续？(y/n)
```

用户回复 `y` / `yes` / `继续` 才执行 Step 2。否则停止，告知文章已入库可手动精读。

---

## 五、Step 2：触发 AI 精读

### 认证：获取 Session Cookie

先获取 NextAuth Session Cookie（每次 Pipeline 开始时执行一次）：

```bash
# Step A：获取 CSRF Token
curl -s -c /tmp/esleer_session.txt \
  http://localhost:3000/esleer/api/auth/csrf
# 返回: {"csrfToken": "xxxxxx"}

# Step B：登录
curl -s -L \
  -c /tmp/esleer_session.txt -b /tmp/esleer_session.txt \
  -X POST http://localhost:3000/esleer/api/auth/callback/credentials \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "email=<EMAIL>&password=<PASSWORD>&csrfToken=<CSRF>&callbackUrl=&json=true"
```

验证 `/tmp/esleer_session.txt` 中含 `authjs.session-token`（非 `#` 开头的行）。

### 调用 API

```
POST http://localhost:3000/esleer/api/jobs/from-article/{articleId}/confirm
Cookie: <session cookie>
```

无请求 body。

**成功响应（HTTP 200）：**
```json
{"jobId": "clxxxxxx", "status": "processing"}
```

**Gate 1**：HTTP 200 且 `jobId` 非空，否则停止。

| HTTP 状态码 | 含义 | 处理 |
|------------|------|------|
| 200 | 成功，AI 已启动 | 继续轮询 |
| 401 | Session 过期 | 重新认证后重试 |
| 403 | 非管理员或文章不属于当前用户 | 停止报告 |
| 404 | 文章不存在（articleId 错误） | 停止报告 |
| 400 | articleId 非整数 | 停止报告 |

---

## 六、Step 3：轮询等待完成

```
GET http://localhost:3000/esleer/api/jobs/{jobId}
Cookie: <session cookie>
```

**响应结构：**
```json
{
  "jobId": "clxxxxxx",
  "status": "processing",
  "articleId": 12345,
  "articleTitle": "文章标题",
  "notesGenerated": 25,
  "errorMessage": null,
  "expiresAt": null
}
```

- 轮询间隔：**3 秒/次**
- 最大等待：**300 秒**（100 次）
- 目标状态：`completed` 或 `failed`

**Gate 2**：status = `completed` 且 `notesGenerated > 0`，否则停止报告 `errorMessage`。

### Job 状态机（from-article 流程）

```
processing  ← 创建时直接此状态（跳过 pending/fetching/imported）
  ↓
completed ✅  (notesGenerated > 0)
  或
failed    ❌  (errorMessage 说明原因)
```

---

## 七、完整 Python Pipeline 脚本

```python
#!/usr/bin/env python3
"""
Esleer 文章采集 Pipeline（PLAN3 版：fetch-article.mjs + Jobs API）
用法: python3 pipeline.py <URL>
"""
import subprocess, json, os, sys, time

CREDS_FILE = os.path.expanduser("~/.config/esleer/credentials.json")
BASE = "http://localhost:3000/esleer"
COOKIE_FILE = "/tmp/esleer_session.txt"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
FETCH_SCRIPT = os.path.join(SCRIPT_DIR, "scripts", "fetch-article.mjs")


def get_session():
    with open(CREDS_FILE) as f:
        creds = json.load(f)
    r = subprocess.run(
        ['curl', '-s', '-c', COOKIE_FILE, f'{BASE}/api/auth/csrf'],
        capture_output=True, text=True
    )
    csrf = json.loads(r.stdout)['csrfToken']
    subprocess.run(
        ['curl', '-s', '-L', '-c', COOKIE_FILE, '-b', COOKIE_FILE,
         '-X', 'POST', f'{BASE}/api/auth/callback/credentials',
         '-H', 'Content-Type: application/x-www-form-urlencoded',
         '-d', f"email={creds['email']}&password={creds['password']}&csrfToken={csrf}&callbackUrl=&json=true"],
        capture_output=True, text=True, timeout=30
    )
    with open(COOKIE_FILE) as f:
        for line in f:
            if 'authjs.session-token' in line and not line.startswith('#'):
                return line.strip().split()[-1]
    raise RuntimeError("❌ Session 获取失败，检查 credentials.json")


def fetch_article(url):
    print(f"\n📥 Step 0: 采集文章\n   URL: {url}")
    r = subprocess.run(
        ['node', FETCH_SCRIPT, url, '--job-mode'],
        capture_output=True, text=True, timeout=60
    )
    if r.stderr:
        print(r.stderr, end='', file=sys.stderr)
    data = json.loads(r.stdout.strip())
    if r.returncode != 0 or not data.get('success'):
        raise SystemExit(f"❌ Gate 0 失败: {data.get('error', '未知')}")
    print(f"   ✅ Gate 0 通过: articleId={data['articleId']}, 标题={data['title'][:50]}")
    return data['articleId'], data['title']


def trigger_ai(article_id):
    r = subprocess.run(
        ['curl', '-s', '-X', 'POST',
         f'{BASE}/api/jobs/from-article/{article_id}/confirm',
         '-b', COOKIE_FILE],
        capture_output=True, text=True, timeout=15
    )
    result = json.loads(r.stdout)
    if result.get("error"):
        raise SystemExit(f"❌ Gate 1 失败: {result['error']}")
    job_id = result.get("jobId")
    if not job_id:
        raise SystemExit(f"❌ Gate 1 失败: 返回中无 jobId\n   {r.stdout[:200]}")
    print(f"   ✅ Gate 1 通过: jobId={job_id}")
    return job_id


def poll_job(job_id, max_seconds=300):
    print(f"⏳ 轮询 Job 状态（最多 {max_seconds} 秒）")
    status = "unknown"
    for attempt in range(max_seconds // 3):
        time.sleep(3)
        r = subprocess.run(
            ['curl', '-s', f'{BASE}/api/jobs/{job_id}', '-b', COOKIE_FILE],
            capture_output=True, text=True, timeout=10
        )
        try:
            result = json.loads(r.stdout)
        except json.JSONDecodeError:
            continue
        status = result.get("status", "unknown")
        print(f"   [{attempt+1}] status={status}")
        if status in ("completed", "failed"):
            return result
    raise SystemExit(f"❌ 轮询超时（{max_seconds}秒），最后 status={status}")


def main():
    if len(sys.argv) < 2:
        sys.exit("用法: python3 pipeline.py <URL>")
    url = sys.argv[1].strip()

    print(f"🔑 获取 Session...")
    get_session()
    print(f"   Session OK")

    # Step 0: 采集
    article_id, title = fetch_article(url)

    # Checkpoint: 用户确认 AI 额度
    print(f"\n{'─'*50}")
    print(f"📄 文章已导入成功")
    print(f"   标题: {title}")
    print(f"   ID: {article_id}")
    print(f"   访问: {BASE}/reader/{article_id}")
    print(f"{'─'*50}")
    answer = input("\n⚠️  即将消耗 AI 额度进行全文精读，是否继续？(y/n): ").strip().lower()
    if answer not in ("y", "yes", "继续", "是"):
        raise SystemExit(f"⏸  已暂停。文章已保存，可手动访问: {BASE}/reader/{article_id}")

    # Step 2: 触发 AI
    print(f"\n🤖 Step 2: 触发 AI 精读")
    job_id = trigger_ai(article_id)

    # Step 3: 轮询
    print(f"\n⏳ Step 3: 等待 AI 精读完成")
    final = poll_job(job_id, max_seconds=300)

    if final.get("status") == "failed":
        raise SystemExit(f"❌ Gate 2 失败: {final.get('errorMessage', '未知')}")
    notes = final.get("notesGenerated", 0)
    if notes == 0:
        raise SystemExit("❌ Gate 2 失败: notesGenerated=0，笔记未生成")

    print(f"\n{'='*50}")
    print(f"✅ Pipeline 完成")
    print(f"   文章: {title}")
    print(f"   笔记: {notes} 条")
    print(f"   查看: {BASE}/reader/{article_id}")
    print(f"{'='*50}")


if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        print(f"\n{e}"); sys.exit(1)
    except KeyboardInterrupt:
        print("\n\n⏸  用户中断"); sys.exit(0)
    except Exception as e:
        print(f"\n❌ 未预期的错误: {e}"); sys.exit(1)
```

---

## 八、错误处理参考

| 错误现象 | 原因 | 处理方式 |
|---------|------|---------|
| Gate 0 失败，"列表页/首页拒绝采集" | URL 是首页/分类页 | 提示用户提供含 slug/日期的具体文章 URL |
| Gate 0 失败，"反爬限制" | 同一域名今日已采集 3 次 | 告知次日重试 |
| Gate 0 失败，"正文不足" | 页面 JS 渲染依赖或被封锁 | 停止，建议手动复制导入 |
| Gate 0 失败，"HTTP 403" | 站点封锁 | 停止，暂时无法采集 |
| Gate 1 失败，401 | Session Cookie 过期 | 重新执行认证流程后重试 |
| Gate 1 失败，403 | 非管理员账号 | 检查 credentials.json |
| Gate 1 失败，404 | articleId 不存在（DB 写入失败） | 检查 DB 路径配置 |
| Gate 2 失败，AI 相关 | DeepSeek API Key 未配置 | 用户在 esleer 前端设置 API Key |
| Gate 2 失败，"文章无有效段落" | 正文 HTML 结构无 `<p>` 标签 | 报告问题，文章已入库 |

---

## 九、约束与限制

| 项目 | 值 | 备注 |
|------|----|------|
| 每域名采集频率 | 3 次/天 | fetch-article.mjs 内置节流 |
| 最小正文长度 | 120 字符 | 低于此值拒绝导入 |
| AI 笔记密度 | 约 20-30 条/篇 | 按段落粒度 |
| AI 生成耗时 | 约 30-120 秒 | 最多等待 300 秒 |
| Jobs API 权限 | 管理员账号 | 普通用户返回 403 |
| subprocess 超时 | 60 秒 | fetch-article.mjs 单次采集 |

---

## 十、禁止调用的端点

| 端点 | 原因 |
|------|------|
| `POST /api/ai/generate-notes` | 选段高亮注释，不是全文精读 |
| `POST /api/ai/auto-generate` | 已废弃 |
| `POST /api/ai/batch-process` | 内部端点，由 Jobs API 封装 |
| `POST /api/jobs/collect` | 对 elpais/elmundo 反爬弱（会 403），改用 fetch-article.mjs |

---

## 十一、备用流程（/api/jobs/collect）

对于**不需要特殊反爬处理**的普通站点，可使用原始 Jobs API 流程（适用范围：非 elpais/elmundo 的公开站点）：

```
POST /api/jobs/collect { "url": "..." }  → { jobId, status: "pending" }
GET  /api/jobs/{jobId}（轮询60秒）      → 等待 status = "imported"
[CHECKPOINT 用户确认]
POST /api/jobs/{jobId}/confirm           → { jobId, status: "processing" }
GET  /api/jobs/{jobId}（轮询300秒）     → 等待 status = "completed"
```

---

## 十二、关键文件路径

| 文件 | 路径 |
|------|------|
| 采集脚本 | `esleer-article-collector/scripts/fetch-article.mjs` |
| 凭证文件 | `~/.config/esleer/credentials.json` |
| Session Cookie | `/tmp/esleer_session.txt`（运行时生成） |
| 数据库（只读参考） | `~/Documents/GitHub/esleer/esleer-data/dev.db` |
| 新 API 路由 | `esleer-next/src/app/api/jobs/from-article/[articleId]/confirm/route.ts` |
| 共享 AI 处理函数 | `esleer-next/src/lib/ai/runAiProcessing.ts` |
| 本文档 | `esleer-article-collector/INTEGRATION.md` |
