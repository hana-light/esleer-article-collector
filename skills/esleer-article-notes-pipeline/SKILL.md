---
name: esleer-article-notes-pipeline
description: 完成 esleer 外语精读平台的「采集文章→生成笔记」完整流程。当需要将网页文章导入 esleer 并自动生成笔记时使用此技能。涉及：导入文章到 esleer、触发 AI 全文精读、保存笔记到用户账号。
---

# Esleer 文章采集与笔记生成 Pipeline

## 目标
替用户完成**采集文章 → 导入 esleer → AI 全文精读 → 保存笔记**的完整流程。

---

## ⚙️ Tool Registry（工具注册表）

> Agent 须在执行前读取本节，明确每个工具的调用方式和成功标准。

### Tool 1 · trigger-collection-job

| 字段 | 内容 |
|------|------|
| **作用** | 创建采集 Job，后台自动下载 HTML 并导入文章 |
| **API** | `POST http://localhost:3000/esleer/api/jobs/collect` |
| **认证** | NextAuth Session Cookie（见「Session 自动刷新」） |
| **输入** | `{ "url": "<完整文章 URL>" }` |
| **成功响应** | `{ "jobId": "<cuid>", "status": "pending" }` |
| **成功判断** | HTTP 200 **且** `jobId` 为非空字符串 |
| **失败处理** | `400` URL 无效 → 立即停止；`401` Session 过期 → 刷新后重试；`403` 非管理员账号 |

### Tool 2 · poll-job-status

| 字段 | 内容 |
|------|------|
| **作用** | 轮询 Job 状态，等待文章导入完成 |
| **API** | `GET http://localhost:3000/esleer/api/jobs/{jobId}` |
| **认证** | NextAuth Session Cookie |
| **轮询策略** | 每 3 秒一次，最多等 60 秒（20 次）|
| **等待目标** | `status === "imported"` 或 `status === "failed"` |
| **成功响应字段** | `jobId`, `status`, `articleId`, `articleTitle`, `expiresAt` |
| **imported 时** | 提取 `articleTitle` 和 `articleId` 用于 Checkpoint |
| **failed 时** | 提取 `errorMessage`，立即停止并报告 |

### Tool 3 · confirm-ai-generation

| 字段 | 内容 |
|------|------|
| **作用** | 用户确认后触发 AI 全文精读 |
| **API** | `POST http://localhost:3000/esleer/api/jobs/{jobId}/confirm` |
| **认证** | NextAuth Session Cookie |
| **输入** | 无 body（jobId 在路径中） |
| **调用时机** | 仅在用户明确回复 `y` / `yes` / `继续` 后调用 |
| **成功响应** | `{ "jobId": "<cuid>", "status": "processing" }` |
| **调用后继续轮询** | 继续调用 Tool 2 轮询，直到 `status === "completed"` 或 `"failed"` |
| **completed 时** | 提取 `notesGenerated` 报告结果 |
| **注意** | ⚠️ 此操作消耗 AI 额度，**必须经过用户确认后才能调用** |

---

## 🚦 Execution Gates（执行检查门）

每步执行后必须通过对应 Gate 才能继续。Gate 不通过 = 立即停止 + 报告原因。

```
Tool 1: trigger-collection-job
  │
  ├─ Gate 1: HTTP 200 且 jobId 非空？
  │          ❌ 停止 → 报告错误（URL 无效 / Session 过期 / 非管理员）
  │
Tool 2: poll-job-status（循环，3秒/次，最多60秒）
  │
  ├─ Gate 2: status === "imported"（非 "failed" / 超时）？
  │          ❌ 停止 → 报告 errorMessage 或轮询超时
  │
  ├─ [CHECKPOINT] 向用户确认（见下方）
  │
Tool 3: confirm-ai-generation
  │
Tool 2: poll-job-status（继续轮询直到 completed / failed）
  │
  └─ Gate 3: status === "completed" 且 notesGenerated > 0？
             ❌ 停止 → 报告 errorMessage，文章已入库但笔记未生成
```

### Checkpoint（确认检查点）

在调用 Tool 3（消耗 AI 额度）前，**必须**向用户展示以下信息并等待确认：

```
📄 文章已导入成功
   标题：<articleTitle>
   ID：<articleId>
   访问：http://localhost:3000/esleer/reader/<articleId>

⚠️  即将消耗 AI 额度进行全文精读，是否继续？(y/n)
```

用户回复 `y` / `yes` / `继续` 才执行 Tool 3。否则停止，告知用户文章已入库，可手动触发精读。

---

## 前提条件

- esleer-next 运行在 `http://localhost:3000`（本地开发）
- 使用**管理员账号** Session（普通用户无权使用 Jobs API）
- 凭证保存在 `~/.config/esleer/credentials.json`（含 email 和 password）
- 笔记生成依赖 DeepSeek API（需要用户已在 esleer 配置过 API Key）

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

以下脚本实现完整流程，含所有 Gate 和 Checkpoint。

```python
#!/usr/bin/env python3
"""
Esleer 文章采集 Pipeline v2（Job API 版）
用法: python3 pipeline.py <URL>
包含: Gate 1-3 + Checkpoint（AI 前确认）
"""
import subprocess, json, os, sys, time

CREDS_FILE = os.path.expanduser("~/.config/esleer/credentials.json")
BASE = "http://localhost:3000/esleer"

# ── Session ──────────────────────────────────────────────────────────────────

def get_session():
    """自动从 credentials.json 获取 NextAuth Session Cookie"""
    with open(CREDS_FILE) as f:
        creds = json.load(f)
    COOKIE_FILE = "/tmp/esleer_session.txt"
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
                return line.strip().split()[-1], COOKIE_FILE
    raise RuntimeError("❌ Session 获取失败，请检查 credentials.json 中的邮箱和密码")

# ── Tool 1: trigger-collection-job ───────────────────────────────────────────

def trigger_collection_job(url, session, cookie_file):
    """创建采集 Job，Gate 1: 必须返回有效 jobId"""
    print(f"\n🚀 Tool 1: 触发采集 Job")
    print(f"   URL: {url}")

    r = subprocess.run(
        ['curl', '-s', '-X', 'POST', f'{BASE}/api/jobs/collect',
         '-b', f'{cookie_file}',
         '-H', 'Content-Type: application/json',
         '-d', json.dumps({"url": url})],
        capture_output=True, text=True, timeout=15
    )

    try:
        result = json.loads(r.stdout)
    except json.JSONDecodeError:
        raise SystemExit(f"❌ Gate 1 失败: API 返回非 JSON\n   原始返回: {r.stdout[:200]}")

    if result.get("error"):
        if "401" in str(r.stdout) or "未授权" in result.get("error", ""):
            raise SystemExit("❌ Gate 1 失败: Session 已过期（401）\n   修复: 运行 Session 刷新脚本后重试")
        if "403" in str(r.returncode) or "管理员" in result.get("error", ""):
            raise SystemExit("❌ Gate 1 失败: 当前账号无管理员权限（403）")
        raise SystemExit(f"❌ Gate 1 失败: {result.get('error', '未知错误')}")

    job_id = result.get("jobId")
    if not job_id:
        raise SystemExit(f"❌ Gate 1 失败: 返回中无 jobId\n   原始返回: {r.stdout[:200]}")

    print(f"   ✅ Gate 1 通过: jobId={job_id}")
    return job_id

# ── Tool 2: poll-job-status ───────────────────────────────────────────────────

def poll_job_status(job_id, cookie_file, wait_for=("imported", "failed"), max_seconds=60):
    """轮询 Job 状态，Gate 2: 等待 imported 或 failed"""
    print(f"\n⏳ Tool 2: 轮询 Job 状态（最多 {max_seconds} 秒）")

    for attempt in range(max_seconds // 3):
        time.sleep(3)
        r = subprocess.run(
            ['curl', '-s', f'{BASE}/api/jobs/{job_id}',
             '-b', f'{cookie_file}'],
            capture_output=True, text=True, timeout=10
        )
        try:
            result = json.loads(r.stdout)
        except json.JSONDecodeError:
            continue

        status = result.get("status", "unknown")
        print(f"   [{attempt+1}] status={status}")

        if status in wait_for:
            return result

    raise SystemExit(f"❌ Gate 2 失败: 轮询超时（{max_seconds}秒），最后 status={status}")

# ── Checkpoint: 用户确认 ───────────────────────────────────────────────────────

def confirm_ai_generation(article_id, title):
    """在消耗 AI 额度前，要求用户明确确认"""
    print(f"\n{'─'*50}")
    print(f"📄 文章已导入成功")
    print(f"   标题: {title}")
    print(f"   ID: {article_id}")
    print(f"   访问: http://localhost:3000/esleer/reader/{article_id}")
    print(f"{'─'*50}")
    print(f"⚠️  即将消耗 AI 额度进行全文精读")
    print(f"   预计生成 20-30 条笔记（标准密度）")

    answer = input("\n是否继续？(y/n): ").strip().lower()
    if answer not in ("y", "yes", "继续", "是"):
        raise SystemExit(
            f"⏸  已暂停。文章已保存，可随时手动触发精读：\n"
            f"   http://localhost:3000/esleer/reader/{article_id}"
        )

# ── Tool 3: confirm-ai-generation ────────────────────────────────────────────

def confirm_job(job_id, cookie_file):
    """触发 AI 精读"""
    print(f"\n🤖 Tool 3: 确认 AI 精读")

    r = subprocess.run(
        ['curl', '-s', '-X', 'POST', f'{BASE}/api/jobs/{job_id}/confirm',
         '-b', f'{cookie_file}'],
        capture_output=True, text=True, timeout=15
    )
    try:
        result = json.loads(r.stdout)
    except json.JSONDecodeError:
        raise SystemExit(f"❌ 确认失败: API 返回非 JSON\n   原始返回: {r.stdout[:200]}")

    if result.get("error"):
        raise SystemExit(f"❌ 确认失败: {result.get('error')}")

    print(f"   ✅ AI 精读已启动，继续轮询...")
    return result

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print("用法: python3 pipeline.py <URL>")
        sys.exit(1)

    url = sys.argv[1].strip()
    if not url.startswith("http"):
        raise SystemExit("❌ URL 必须以 http:// 或 https:// 开头")

    print(f"🔧 Esleer Pipeline v2 启动")
    print(f"   目标: {url}")

    # Step 1: Session
    print(f"\n🔑 获取 Session...")
    session, cookie_file = get_session()
    print(f"   Session OK: {session[:20]}...")

    # Step 2: Tool 1 - 触发采集（含 Gate 1）
    job_id = trigger_collection_job(url, session, cookie_file)

    # Step 3: Tool 2 - 轮询等待 imported（含 Gate 2）
    job_data = poll_job_status(job_id, cookie_file, wait_for=("imported", "failed"))

    if job_data.get("status") == "failed":
        raise SystemExit(f"❌ Gate 2 失败: 采集失败\n   原因: {job_data.get('errorMessage', '未知')}")

    article_id = job_data["articleId"]
    title = job_data.get("articleTitle", "（无标题）")
    print(f"   ✅ Gate 2 通过: article_id={article_id}, 标题={title}")

    # Step 4: Checkpoint - 用户确认 AI 消耗
    confirm_ai_generation(article_id, title)

    # Step 5: Tool 3 - 确认 AI 精读
    confirm_job(job_id, cookie_file)

    # Step 6: 继续轮询直到 completed（含 Gate 3）
    print(f"\n⏳ 等待 AI 精读完成（最多 300 秒）...")
    final = poll_job_status(job_id, cookie_file, wait_for=("completed", "failed"), max_seconds=300)

    if final.get("status") == "failed":
        raise SystemExit(f"❌ Gate 3 失败: AI 精读失败\n   原因: {final.get('errorMessage', '未知')}")

    notes_generated = final.get("notesGenerated", 0)
    if notes_generated == 0:
        raise SystemExit("❌ Gate 3 失败: notesGenerated=0，笔记未生成")

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

- esleer-next: `~/Documents/GitHub/esleer/esleer-next/`
- 凭证文件: `~/.config/esleer/credentials.json`
- 数据库: `~/Documents/GitHub/esleer/esleer-data/dev.db`

## 注意事项

- **需要管理员账号**：Jobs API 仅限管理员使用，普通用户调用返回 403
- 导入限流：每天最多 N 篇，超额返回相应错误
- AI 全文精读按段落计费，标准密度约 20-30 条笔记/篇（每篇耗时约 30-60 秒）
- imported 状态有 24 小时确认期，超期后 Job 自动变为 failed
- **不要使用** `POST /api/ai/generate-notes`（那是选段高亮生成，不是全文精读）
- **不要使用** `POST /api/ai/auto-generate`（已由 batch-process 替代）
