---
name: esleer-article-notes-pipeline
description: 完成 esleer 外语精读平台的「采集文章→生成笔记」完整流程。当需要将网页文章导入 esleer 并自动生成笔记时使用此技能。涉及：用 fetch-article.mjs 采集文章（含反爬处理）、触发 AI 全文精读、保存笔记到用户账号。
---

# Esleer 文章采集与笔记生成 Pipeline（PLAN3 版）

## 目标

替用户完成**采集文章 → 导入 esleer → AI 全文精读 → 保存笔记**的完整流程。

采集统一走 `fetch-article.mjs`（内置 elpais/elmundo 反爬处理），AI 生成走 Jobs API。

---

## ⚙️ Tool Registry（工具注册表）

> Agent 须在执行前读取本节，明确每个工具的调用方式和成功标准。

### Tool 0 · run-fetch-article-script

| 字段 | 内容 |
|------|------|
| **作用** | 采集文章 HTML、解析正文、写入 esleer DB |
| **调用** | subprocess：`node <script_dir>/scripts/fetch-article.mjs <URL> --job-mode` |
| **stdout** | 一行 JSON：`{"success": true, "articleId": 12345, "title": "..."}` 或 `{"success": false, "error": "..."}` |
| **stderr** | 进度日志，打印给用户看，不参与解析 |
| **超时** | 60 秒 |
| **成功判断** | exit code = 0 **且** `success = true` |
| **失败处理** | 提取 `error` 字段报告，立即停止 |

**常见失败原因：**
- `列表页/首页拒绝采集` → 用户提供的是首页/分类页，要求提供具体文章 URL
- `反爬限制` → 该域名今日已达 3 次上限，次日重试
- `正文不足` → 页面需 JS 渲染或被封锁
- `HTTP 403/4xx` → 站点封锁

---

### Tool 1 · from-article-confirm

| 字段 | 内容 |
|------|------|
| **作用** | 为已采集的文章创建 Job 并立即触发 AI 全文精读 |
| **API** | `POST http://localhost:3000/esleer/api/jobs/from-article/{articleId}/confirm` |
| **认证** | NextAuth Session Cookie（见「Session 自动刷新」） |
| **输入** | 无 body（articleId 在路径中） |
| **调用时机** | 仅在用户明确回复 `y` / `yes` / `继续` 后调用 |
| **成功响应** | `{ "jobId": "<cuid>", "status": "processing" }` |
| **成功判断** | HTTP 200 **且** `jobId` 为非空字符串 |
| **失败处理** | `401` Session 过期 → 刷新后重试；`403` 非管理员；`404` 文章不存在 |

> ⚠️ 此操作消耗 AI 额度，**必须经过用户确认后才能调用**

---

### Tool 2 · poll-job-status

| 字段 | 内容 |
|------|------|
| **作用** | 轮询 Job 状态，等待 AI 精读完成 |
| **API** | `GET http://localhost:3000/esleer/api/jobs/{jobId}` |
| **认证** | NextAuth Session Cookie |
| **轮询策略** | 每 3 秒一次，最多等 300 秒（100 次）|
| **等待目标** | `status === "completed"` 或 `status === "failed"` |
| **成功响应字段** | `jobId`, `status`, `articleId`, `articleTitle`, `notesGenerated`, `errorMessage` |
| **completed 时** | 提取 `notesGenerated` 报告结果 |
| **failed 时** | 提取 `errorMessage`，立即停止并报告 |

---

## 🚦 Execution Gates（执行检查门）

每步执行后必须通过对应 Gate 才能继续。Gate 不通过 = 立即停止 + 报告原因。

```
Tool 0: run-fetch-article-script（subprocess）
  │
  ├─ Gate 0: exit code = 0 且 success = true？
  │          ❌ 停止 → 报告 error（列表页 / 反爬限制 / 正文不足）
  │
  ├─ [CHECKPOINT] 向用户确认（见下方）
  │
Tool 1: from-article-confirm
  │
  ├─ Gate 1: HTTP 200 且 jobId 非空？
  │          ❌ 停止 → 报告错误（Session 过期 / 非管理员 / 文章不存在）
  │
Tool 2: poll-job-status（循环，3秒/次，最多300秒）
  │
  └─ Gate 2: status === "completed" 且 notesGenerated > 0？
             ❌ 停止 → 报告 errorMessage，文章已入库但笔记未生成
```

### Checkpoint（确认检查点）

在调用 Tool 1（消耗 AI 额度）前，**必须**向用户展示以下信息并等待确认：

```
📄 文章已导入成功
   标题：<title>
   ID：<articleId>
   访问：http://localhost:3000/esleer/reader/<articleId>

⚠️  即将消耗 AI 额度进行全文精读，是否继续？(y/n)
```

用户回复 `y` / `yes` / `继续` 才执行 Tool 1。否则停止，告知用户文章已入库，可手动触发精读。

---

## 前提条件

- esleer-next 运行在 `http://localhost:3000`（本地开发）
- 使用**管理员账号** Session（普通用户无权使用 Jobs API）
- 凭证保存在 `~/.config/esleer/credentials.json`（含 email 和 password）
- 笔记生成依赖 DeepSeek API（需要用户已在 esleer 配置过 API Key）
- Node.js 18+（运行 fetch-article.mjs）

### 凭证配置

首次使用时，将以下内容写入 `~/.config/esleer/credentials.json`：

```json
{
  "email": "你的管理员邮箱",
  "password": "你的密码"
}
```

---

## 完整 Pipeline 脚本（推荐直接运行）

```python
#!/usr/bin/env python3
"""
Esleer 文章采集 Pipeline（PLAN3 版）
用法: python3 pipeline.py <URL>
包含: Gate 0-2 + Checkpoint（AI 前确认）
"""
import subprocess, json, os, sys, time

CREDS_FILE = os.path.expanduser("~/.config/esleer/credentials.json")
BASE = "http://localhost:3000/esleer"
COOKIE_FILE = "/tmp/esleer_session.txt"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
FETCH_SCRIPT = os.path.join(SCRIPT_DIR, "scripts", "fetch-article.mjs")

# ── Session ──────────────────────────────────────────────────────────────────

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
    raise RuntimeError("❌ Session 获取失败，请检查 credentials.json 中的邮箱和密码")

# ── Tool 0: run-fetch-article-script ─────────────────────────────────────────

def run_fetch_script(url):
    print(f"\n📥 Tool 0: 采集文章")
    print(f"   URL: {url}")

    r = subprocess.run(
        ['node', FETCH_SCRIPT, url, '--job-mode'],
        capture_output=True, text=True, timeout=60
    )
    if r.stderr:
        print(r.stderr, end='', file=sys.stderr)

    try:
        data = json.loads(r.stdout.strip())
    except json.JSONDecodeError:
        raise SystemExit(f"❌ Gate 0 失败: 脚本输出非 JSON\n   {r.stdout[:200]}")

    if r.returncode != 0 or not data.get('success'):
        raise SystemExit(f"❌ Gate 0 失败: {data.get('error', '未知错误')}")

    print(f"   ✅ Gate 0 通过: articleId={data['articleId']}")
    return data['articleId'], data['title']

# ── Checkpoint: 用户确认 ───────────────────────────────────────────────────────

def checkpoint(article_id, title):
    print(f"\n{'─'*50}")
    print(f"📄 文章已导入成功")
    print(f"   标题: {title}")
    print(f"   ID: {article_id}")
    print(f"   访问: http://localhost:3000/esleer/reader/{article_id}")
    print(f"{'─'*50}")
    print(f"⚠️  即将消耗 AI 额度进行全文精读")

    answer = input("\n是否继续？(y/n): ").strip().lower()
    if answer not in ("y", "yes", "继续", "是"):
        raise SystemExit(
            f"⏸  已暂停。文章已保存，可随时手动触发精读：\n"
            f"   http://localhost:3000/esleer/reader/{article_id}"
        )

# ── Tool 1: from-article-confirm ─────────────────────────────────────────────

def from_article_confirm(article_id):
    print(f"\n🤖 Tool 1: 触发 AI 精读")

    r = subprocess.run(
        ['curl', '-s', '-X', 'POST',
         f'{BASE}/api/jobs/from-article/{article_id}/confirm',
         '-b', COOKIE_FILE],
        capture_output=True, text=True, timeout=15
    )
    try:
        result = json.loads(r.stdout)
    except json.JSONDecodeError:
        raise SystemExit(f"❌ Gate 1 失败: API 返回非 JSON\n   {r.stdout[:200]}")

    if result.get("error"):
        raise SystemExit(f"❌ Gate 1 失败: {result['error']}")

    job_id = result.get("jobId")
    if not job_id:
        raise SystemExit(f"❌ Gate 1 失败: 返回中无 jobId\n   {r.stdout[:200]}")

    print(f"   ✅ Gate 1 通过: jobId={job_id}")
    return job_id

# ── Tool 2: poll-job-status ───────────────────────────────────────────────────

def poll_job_status(job_id, max_seconds=300):
    print(f"\n⏳ Tool 2: 轮询 Job 状态（最多 {max_seconds} 秒）")
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
    raise SystemExit(f"❌ Gate 2 失败: 轮询超时（{max_seconds}秒），最后 status={status}")

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print("用法: python3 pipeline.py <URL>")
        sys.exit(1)

    url = sys.argv[1].strip()
    if not url.startswith("http"):
        raise SystemExit("❌ URL 必须以 http:// 或 https:// 开头")

    print(f"🔧 Esleer Pipeline（PLAN3）启动")
    print(f"   目标: {url}")

    print(f"\n🔑 获取 Session...")
    get_session()
    print(f"   Session OK")

    # Tool 0: 采集文章（含 Gate 0）
    article_id, title = run_fetch_script(url)

    # Checkpoint: 用户确认 AI 消耗
    checkpoint(article_id, title)

    # Tool 1: 触发 AI 精读（含 Gate 1）
    job_id = from_article_confirm(article_id)

    # Tool 2: 轮询直到 completed（含 Gate 2）
    final = poll_job_status(job_id, max_seconds=300)

    if final.get("status") == "failed":
        raise SystemExit(f"❌ Gate 2 失败: 精读失败\n   原因: {final.get('errorMessage', '未知')}")

    notes_generated = final.get("notesGenerated", 0)
    if notes_generated == 0:
        raise SystemExit("❌ Gate 2 失败: notesGenerated=0，笔记未生成")

    print(f"\n{'='*50}")
    print(f"✅ Pipeline 完成")
    print(f"   文章: {title}")
    print(f"   笔记: {notes_generated} 条")
    print(f"   查看: http://localhost:3000/esleer/reader/{article_id}")
    print(f"{'='*50}")

if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        print(f"\n{e}")
        sys.exit(1)
    except KeyboardInterrupt:
        print("\n\n⏸  用户中断")
        sys.exit(0)
    except Exception as e:
        print(f"\n❌ 未预期的错误: {e}")
        sys.exit(1)
```

---

## Session 自动刷新脚本

如果 API 返回 `{"error":"未授权"}`，单独运行以下命令刷新 session：

```python
python3 - << 'PYEOF'
import subprocess, json, os

CREDS_FILE = os.path.expanduser("~/.config/esleer/credentials.json")
with open(CREDS_FILE) as f:
    creds = json.load(f)

BASE = "http://localhost:3000/esleer"
COOKIE_FILE = "/tmp/esleer_session.txt"

r = subprocess.run(['curl', '-s', '-c', COOKIE_FILE, f'{BASE}/api/auth/csrf'],
                   capture_output=True, text=True)
csrf = json.loads(r.stdout)['csrfToken']

subprocess.run(['curl', '-s', '-L', '-c', COOKIE_FILE, '-b', COOKIE_FILE,
                '-X', 'POST', f'{BASE}/api/auth/callback/credentials',
                '-H', 'Content-Type: application/x-www-form-urlencoded',
                '-d', f"email={creds['email']}&password={creds['password']}&csrfToken={csrf}&callbackUrl=&json=true"],
               capture_output=True, text=True, timeout=30)

with open(COOKIE_FILE) as f:
    for line in f:
        if 'authjs.session-token' in line and not line.startswith('#'):
            cookie = line.strip().split()[-1]
            print(f'✅ Session 已刷新（{len(cookie)} chars）')
            break
PYEOF
```

---

## 关键文件路径

- 采集脚本: `esleer-article-collector/scripts/fetch-article.mjs`
- 凭证文件: `~/.config/esleer/credentials.json`
- 数据库: `~/Documents/GitHub/esleer/esleer-data/dev.db`
- 新 API 路由: `esleer-next/src/app/api/jobs/from-article/[articleId]/confirm/route.ts`

## 注意事项

- **需要管理员账号**：Jobs API 仅限管理员使用，普通用户调用返回 403
- **不要使用** `/api/jobs/collect` 采集 elpais/elmundo（反爬弱，必 403）
- AI 全文精读按段落计费，标准密度约 20-30 条笔记/篇（每篇耗时约 30-120 秒）
- **不要使用** `POST /api/ai/generate-notes`（那是选段高亮生成，不是全文精读）
- **不要使用** `POST /api/ai/auto-generate`（已废弃）
