# esleer 文章自动采集 Pipeline — OpenClaw Agent 接入文档

> **读者定位**：本文档面向 OpenClaw agent，用于接入并驱动「采集文章 → AI 全文精读 → 笔记生成」完整流程。  
> **不需要读代码**，按本文档调用 API 即可完成全流程。

---

## 一、Pipeline 概述

```
用户给出文章链接
    ↓
[Tool 1] POST /api/jobs/collect        → 创建采集 Job（后台下载 HTML、解析正文、写入数据库）
    ↓
[Tool 2] GET  /api/jobs/{jobId}        → 轮询，等待 status = "imported"
    ↓
[CHECKPOINT] 向用户展示文章信息，确认是否消耗 AI 额度
    ↓
[Tool 3] POST /api/jobs/{jobId}/confirm → 触发 AI 全文精读（DeepSeek）
    ↓
[Tool 2] 继续轮询，等待 status = "completed"
    ↓
完成：文章 + 笔记已保存到用户账号
```

---

## 二、前提条件

| 条件 | 说明 |
|------|------|
| esleer-next 运行中 | `http://localhost:3000`（本地开发环境） |
| 管理员账号 | Jobs API 仅管理员可用，普通账号返回 403 |
| 凭证文件 | `~/.config/esleer/credentials.json` |
| DeepSeek API Key | 用户已在 esleer 前端设置中配置 |

### 凭证文件格式

路径：`~/.config/esleer/credentials.json`

```json
{
  "email": "管理员邮箱",
  "password": "密码"
}
```

---

## 三、认证：获取 Session Cookie

所有 API 调用均需要 NextAuth Session Cookie。流程如下：

### Step 1：获取 CSRF Token

```bash
curl -s -c /tmp/esleer_session.txt \
  http://localhost:3000/esleer/api/auth/csrf
# 返回: {"csrfToken": "xxxxxx"}
```

### Step 2：登录，写入 Cookie

```bash
curl -s -L \
  -c /tmp/esleer_session.txt \
  -b /tmp/esleer_session.txt \
  -X POST http://localhost:3000/esleer/api/auth/callback/credentials \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "email=<EMAIL>&password=<PASSWORD>&csrfToken=<CSRF_TOKEN>&callbackUrl=&json=true"
```

### Step 3：验证 Cookie 已写入

检查 `/tmp/esleer_session.txt` 中是否包含 `authjs.session-token`（不以 `#` 开头的行）。

未找到 → 邮箱或密码错误，停止并报告。

---

## 四、API 工具详情

### Tool 1：trigger-collection-job

创建采集 Job，后台自动下载 HTML 并导入文章。

```
POST http://localhost:3000/esleer/api/jobs/collect
Content-Type: application/json
Cookie: <session cookie>

{"url": "<完整文章 URL>"}
```

**成功响应（HTTP 200）：**
```json
{"jobId": "clxxxxxx", "status": "pending"}
```

**Gate 1（必须通过才能继续）：** HTTP 200 且 `jobId` 为非空字符串。

| HTTP 状态码 | 含义 | 处理方式 |
|------------|------|---------|
| 200 | 成功，Job 已创建 | 继续 |
| 400 | URL 无效或为列表页 | 立即停止，报告原因 |
| 401 | Session 过期 | 重新执行认证流程后重试 |
| 403 | 非管理员账号 | 停止，提示用户使用管理员账号 |

---

### Tool 2：poll-job-status

轮询 Job 状态。**在两个阶段使用**：等待文章导入、等待 AI 完成。

```
GET http://localhost:3000/esleer/api/jobs/{jobId}
Cookie: <session cookie>
```

**响应结构：**
```json
{
  "jobId": "clxxxxxx",
  "status": "imported",
  "articleId": "cmxxxxxx",
  "articleTitle": "文章标题",
  "notesGenerated": 25,
  "errorMessage": null,
  "expiresAt": "2026-06-07T12:00:00Z"
}
```

#### Job 状态机

```
pending
  ↓ 采集中（自动）
imported   ──→ [CHECKPOINT：等待用户确认]
  ↓ 用户确认后
processing
  ↓ AI 生成中（自动）
completed  ✅
  或
failed     ❌（任意阶段均可跳转）
```

#### 阶段一：等待文章导入

- 轮询间隔：**3 秒/次**
- 最大等待：**60 秒**（20 次）
- 目标状态：`imported` 或 `failed`
- Gate 2：status 必须为 `imported`，否则提取 `errorMessage` 停止报告

#### 阶段二：等待 AI 完成

- 轮询间隔：**3 秒/次**
- 最大等待：**300 秒**（100 次）
- 目标状态：`completed` 或 `failed`
- Gate 3：status 必须为 `completed` 且 `notesGenerated > 0`

---

### Tool 3：confirm-ai-generation

用户确认后调用。触发 AI 全文精读（消耗 DeepSeek 额度）。

```
POST http://localhost:3000/esleer/api/jobs/{jobId}/confirm
Cookie: <session cookie>
```

无请求 body。

**成功响应（HTTP 200）：**
```json
{"jobId": "clxxxxxx", "status": "processing"}
```

> **强制要求**：此接口必须在用户明确回复 `y` / `yes` / `继续` 后才能调用。

---

## 五、执行流程与检查门（Execution Gates）

```
[Tool 1] 触发采集 Job
    │
    ├─ Gate 1: HTTP 200 且 jobId 非空？
    │          ❌ 停止 → 报告 URL 无效 / Session 过期 / 非管理员
    │
[Tool 2] 轮询（3秒/次，最多60秒）
    │
    ├─ Gate 2: status === "imported"？（非 "failed"，非超时）
    │          ❌ 停止 → 报告 errorMessage 或轮询超时
    │
[CHECKPOINT] ─────────────────────────────────────────────
│  展示：                                                  │
│    📄 文章已导入成功                                     │
│       标题：<articleTitle>                               │
│       ID：<articleId>                                   │
│       访问：http://localhost:3000/esleer/reader/<id>    │
│    ⚠️  即将消耗 AI 额度进行全文精读，是否继续？(y/n)     │
│                                                         │
│  用户回复 y/yes/继续 → 继续                              │
│  用户回复 n 或其他  → 停止，告知文章已入库可手动精读      │
───────────────────────────────────────────────────────────
    │
[Tool 3] 确认 AI 精读
    │
[Tool 2] 继续轮询（3秒/次，最多300秒）
    │
    └─ Gate 3: status === "completed" 且 notesGenerated > 0？
               ❌ 停止 → 报告 errorMessage；文章已入库但笔记未生成
```

---

## 六、完整 Pipeline 脚本

可直接运行的 Python 脚本，包含所有 Gate 和 Checkpoint。

```python
#!/usr/bin/env python3
"""
Esleer 文章采集 Pipeline
用法: python3 pipeline.py <URL>
"""
import subprocess, json, os, sys, time

CREDS_FILE = os.path.expanduser("~/.config/esleer/credentials.json")
BASE = "http://localhost:3000/esleer"
COOKIE_FILE = "/tmp/esleer_session.txt"


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
    raise RuntimeError("❌ Session 获取失败，检查 credentials.json 中的邮箱和密码")


def trigger_collection_job(url):
    r = subprocess.run(
        ['curl', '-s', '-X', 'POST', f'{BASE}/api/jobs/collect',
         '-b', COOKIE_FILE,
         '-H', 'Content-Type: application/json',
         '-d', json.dumps({"url": url})],
        capture_output=True, text=True, timeout=15
    )
    result = json.loads(r.stdout)
    if result.get("error"):
        raise SystemExit(f"❌ Gate 1 失败: {result['error']}")
    job_id = result.get("jobId")
    if not job_id:
        raise SystemExit(f"❌ Gate 1 失败: 返回中无 jobId\n   原始返回: {r.stdout[:200]}")
    print(f"   ✅ Gate 1 通过: jobId={job_id}")
    return job_id


def poll_job_status(job_id, wait_for=("imported", "failed"), max_seconds=60):
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
        if status in wait_for:
            return result
    raise SystemExit(f"❌ 轮询超时（{max_seconds}秒），最后 status={status}")


def main():
    if len(sys.argv) < 2:
        sys.exit("用法: python3 pipeline.py <URL>")
    url = sys.argv[1].strip()

    print(f"🔑 获取 Session...")
    get_session()
    print(f"   Session OK")

    print(f"\n🚀 Tool 1: 触发采集 Job\n   URL: {url}")
    job_id = trigger_collection_job(url)

    print(f"\n⏳ Tool 2: 等待文章导入")
    job_data = poll_job_status(job_id, wait_for=("imported", "failed"), max_seconds=60)
    if job_data.get("status") == "failed":
        raise SystemExit(f"❌ Gate 2 失败: {job_data.get('errorMessage', '未知')}")

    article_id = job_data["articleId"]
    title = job_data.get("articleTitle", "（无标题）")
    print(f"   ✅ Gate 2 通过: {title}")

    print(f"\n{'─'*50}")
    print(f"📄 文章已导入成功")
    print(f"   标题: {title}")
    print(f"   ID: {article_id}")
    print(f"   访问: {BASE}/reader/{article_id}")
    print(f"{'─'*50}")
    answer = input("\n⚠️  即将消耗 AI 额度进行全文精读，是否继续？(y/n): ").strip().lower()
    if answer not in ("y", "yes", "继续", "是"):
        raise SystemExit(f"⏸  已暂停。文章已保存，可手动访问: {BASE}/reader/{article_id}")

    print(f"\n🤖 Tool 3: 确认 AI 精读")
    r = subprocess.run(
        ['curl', '-s', '-X', 'POST', f'{BASE}/api/jobs/{job_id}/confirm', '-b', COOKIE_FILE],
        capture_output=True, text=True, timeout=15
    )
    result = json.loads(r.stdout)
    if result.get("error"):
        raise SystemExit(f"❌ 确认失败: {result['error']}")
    print(f"   ✅ AI 精读已启动")

    print(f"\n⏳ 等待 AI 精读完成（最多 300 秒）")
    final = poll_job_status(job_id, wait_for=("completed", "failed"), max_seconds=300)
    if final.get("status") == "failed":
        raise SystemExit(f"❌ Gate 3 失败: {final.get('errorMessage', '未知')}")
    notes = final.get("notesGenerated", 0)
    if notes == 0:
        raise SystemExit("❌ Gate 3 失败: notesGenerated=0，笔记未生成")

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

## 七、错误处理参考

| 错误现象 | 原因 | 处理方式 |
|---------|------|---------|
| Gate 1 失败，`400` URL 无效 | URL 是首页 / 分类页 / 列表页，非具体文章 | 提示用户提供具体文章 URL（含标题 slug 或日期） |
| Gate 1 失败，`401` 未授权 | Session Cookie 过期 | 重新执行认证流程（获取 CSRF → 登录 → 写入 cookie） |
| Gate 1 失败，`403` 权限不足 | 当前账号不是管理员 | 告知用户需要管理员账号 |
| Gate 2 失败，`errorMessage` 含"正文不足" | 页面内容 < 120 字符（可能有 JS 渲染依赖） | 停止，建议用户手动复制文章正文导入 |
| Gate 2 失败，轮询超时 | 网络慢 / esleer-next 无响应 | 检查 esleer-next 是否运行在 localhost:3000 |
| Gate 3 失败，`errorMessage` 含"API" | DeepSeek API Key 未配置或余额不足 | 提示用户在 esleer 前端设置中检查 API Key |
| Gate 3 失败，`notesGenerated=0` | AI 生成空结果 | 报告问题，文章已入库，可尝试重新触发 |
| Session 获取失败（无 `authjs.session-token`） | 邮箱或密码错误 | 检查 `~/.config/esleer/credentials.json` |

---

## 八、约束与限制

| 项目 | 限制 | 备注 |
|------|------|------|
| 最小正文长度 | 120 字符 | 低于此值拒绝导入 |
| imported 状态有效期 | 24 小时 | 超期 Job 自动变 failed，需重新发起 |
| AI 笔记密度 | 约 20-30 条/篇 | 按段落粒度，DeepSeek 生成 |
| AI 生成耗时 | 约 30-120 秒 | 视文章长度，最多等待 300 秒 |
| Jobs API 权限 | 管理员账号 | 普通用户调用返回 403 |

---

## 九、禁止调用的端点

以下端点**不属于本 Pipeline**，不要调用：

| 端点 | 原因 |
|------|------|
| `POST /api/ai/generate-notes` | 选段高亮注释，不是全文精读 |
| `POST /api/ai/auto-generate` | 已废弃，由 batch-process 替代 |
| `POST /api/ai/batch-process` | 内部端点（batch 脚本用），Job API 已封装此逻辑 |

---

## 十、关键文件路径

| 文件 | 路径 |
|------|------|
| 凭证文件 | `~/.config/esleer/credentials.json` |
| Session Cookie | `/tmp/esleer_session.txt`（运行时生成） |
| 数据库（只读参考） | `~/Documents/GitHub/esleer/esleer-data/dev.db` |
| Pipeline 脚本 | `esleer-article-collector/skills/esleer-article-notes-pipeline/SKILL.md` |
| 本文档 | `esleer-article-collector/INTEGRATION.md` |
