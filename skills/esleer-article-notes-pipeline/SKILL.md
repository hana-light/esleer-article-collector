---
name: esleer-article-notes-pipeline
description: 完成 esleer 外语精读平台的「采集文章→生成笔记」完整流程。当需要将网页文章导入 esleer 并自动生成笔记时使用此技能。涉及：导入文章到 esleer、触发 AI 全文精读、保存笔记到用户账号。
---

# Esleer 文章采集与笔记生成 Pipeline

## 目标
小扎替小花完成**采集文章→导入 esleer→AI 全文精读→保存笔记**的完整流程。

## 前提
- esleer-next 运行在 `http://localhost:3000`（本地开发）
- esleer 账号凭证保存在 `~/.config/esleer/credentials.json`（含 email 和 password）
- 笔记生成依赖 DeepSeek API（需要用户已在 esleer 配置过 API Key）

## 凭证配置

首次使用时，将以下内容写入 `~/.config/esleer/credentials.json`：

```json
{
  "email": "你的邮箱",
  "password": "你的密码"
}
```

## 快速开始（自动化 Session）

调用此脚本自动完成登录 → 导入 → 全文精读 → 保存：

```python
# 见下方「完整 Pipeline 脚本」，无需手动获取 session
```

---

## Pipeline 步骤详解

### Step 1：采集文章（导入）

**API**: `POST /esleer/api/import/webpage`
**认证**: NextAuth Session Cookie（自动获取）

```bash
# 1. 下载文章 HTML
curl -s -L -o /tmp/article.html "https://elpais.com/chile/article.html" \
  -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"

# 2. 导入（session 从 ~/.config/esleer/session_cookie.txt 读取）
SESSION=$(cat ~/.config/esleer/session_cookie.txt)
curl -s -X POST http://localhost:3000/esleer/api/import/webpage \
  -b "authjs.session-token=$SESSION" \
  -F "file=@/tmp/article.html" \
  -F "originalUrl=https://elpais.com/chile/article.html"
```

**成功响应**:
```json
{ "success": true, "article": { "id": 123, "title": "文章标题" }, "message": "成功导入文章，节省空间 67%" }
```

---

### Step 2：AI 全文精读（自动生成笔记）

**API**: `POST /esleer/api/ai/auto-generate`
**认证**: NextAuth Session Cookie
**效果**: 与页面「更多 > AI全文精读 > 标准密度」完全一致

**请求参数**:
| 字段 | 类型 | 说明 |
|------|------|------|
| `paragraphs` | `Array<{id, text}>` | 文章所有段落，id 自选，text 为纯文本（不含 HTML） |
| `noteDensity` | `string` | `standard`（标准）/ `high`（高密度）/ `detailed`（详细） |
| `context.articleLanguage` | `string` | 文章语言，如 `es`（西班牙语）/ `en`（英语） |
| `context.examType` | `string` | 考试类型，如 `none` / `sat` / `toefl` |
| `context.scenario` | `string` | 使用场景，如 `daily` |

**成功响应**:
```json
{
  "data": {
    "notes": [
      {
        "id": "auto-xxx-y",
        "text": "原文句子",
        "color": "yellow",
        "content": "`释义` ...`作用` ...`易错` ...`写作` ...`语法` ..."
      }
    ]
  },
  "meta": { "quotaUsed": 5, "quotaRemaining": 95 }
}
```

**笔记结构**（与页面 AI全文精读一致）:
- `释义`：词语或句子的中文释义
- `作用`：该句在文中的作用和语境
- `语法`：语法结构分析
- `应用`：写作/口语应用场景
- `易错`：常见错误提示
- `写作`：写作参考

---

### Step 3：保存笔记到文章

**API**: `POST /esleer/api/articles`

---

## Session 自动刷新脚本

如果 API 返回 `{"error":"未授权"}`，运行以下脚本刷新 session（会自动读取 credentials.json）：

```python
python3 - << 'PYEOF'
import subprocess, json, re, os

CREDS_FILE = os.path.expanduser("~/.config/esleer/credentials.json")
with open(CREDS_FILE) as f:
    creds = json.load(f)

BASE = "http://localhost:3000/esleer"
COOKIE_FILE = "/tmp/esleer_session.txt"
SESSION_FILE = os.path.expanduser("~/.config/esleer/session_cookie.txt")

# 1. Get CSRF token
r = subprocess.run(['curl', '-s', '-c', COOKIE_FILE, f'{BASE}/api/auth/csrf'],
                   capture_output=True, text=True)
csrf = json.loads(r.stdout)['csrfToken']

# 2. Sign in via NextAuth credentials provider
subprocess.run(['curl', '-s', '-L', '-c', COOKIE_FILE, '-b', COOKIE_FILE,
                '-X', 'POST', f'{BASE}/api/auth/callback/credentials',
                '-H', 'Content-Type: application/x-www-form-urlencoded',
                '-d', f"email={creds['email']}&password={creds['password']}&csrfToken={csrf}&callbackUrl=&json=true"],
               capture_output=True, text=True, timeout=30)

# 3. Extract session cookie
with open(COOKIE_FILE) as f:
    for line in f:
        if 'authjs.session-token' in line and not line.startswith('#'):
            cookie = line.strip().split()[-1]
            with open(SESSION_FILE, 'w') as out:
                out.write(cookie)
            print(f'Session saved ({len(cookie)} chars)')
            break
PYEOF
```

---

## 完整 Pipeline 脚本（推荐直接运行）

以下脚本一站式完成：登录 → 下载HTML → 导入 → 全文精读 → 保存笔记。
**无需手动获取 session**，会自动从 credentials.json 读取密码并自动刷新 cookie。

```python
#!/usr/bin/env python3
import subprocess, json, sqlite3, re, os

CREDS_FILE = os.path.expanduser("~/.config/esleer/credentials.json")
BASE = "http://localhost:3000/esleer"
SESSION_FILE = os.path.expanduser("~/.config/esleer/session_cookie.txt")

with open(CREDS_FILE) as f:
    creds = json.load(f)

def get_session():
    """Auto-refresh NextAuth session cookie"""
    COOKIE_FILE = "/tmp/esleer_session.txt"
    # Get CSRF
    r = subprocess.run(['curl', '-s', '-c', COOKIE_FILE, f'{BASE}/api/auth/csrf'],
                      capture_output=True, text=True)
    csrf = json.loads(r.stdout)['csrfToken']
    # Sign in
    subprocess.run(['curl', '-s', '-L', '-c', COOKIE_FILE, '-b', COOKIE_FILE,
                   '-X', 'POST', f'{BASE}/api/auth/callback/credentials',
                   '-H', 'Content-Type: application/x-www-form-urlencoded',
                   '-d', f"email={creds['email']}&password={creds['password']}&csrfToken={csrf}&callbackUrl=&json=true"],
                  capture_output=True, text=True, timeout=30)
    # Extract
    with open(COOKIE_FILE) as f:
        for line in f:
            if 'authjs.session-token' in line and not line.startswith('#'):
                return line.strip().split()[-1]
    raise RuntimeError("Failed to obtain session cookie")

def curl_post(url, body, session):
    payload = json.dumps(body, ensure_ascii=False)
    r = subprocess.run(['curl', '-s', '-X', 'POST', url,
                        '-b', f'authjs.session-token={session}',
                        '-H', 'Content-Type: application/json; charset=utf-8',
                        '-d', payload],
                       capture_output=True, text=True, timeout=180)
    return json.loads(r.stdout)

def extract_paragraphs(html):
    paras = re.findall(r'<p[^>]*>(.*?)</p>', html, re.DOTALL)
    return [{"id": f"para-{i}", "text": re.sub(r'<[^>]+>', '', p).strip()}
            for i, p in enumerate(paras) if len(re.sub(r'<[^>]+>', '', p).strip()) > 30]

# === 1. Session ===
session = get_session()
print(f"Session OK: {session[:30]}...")

# === 2. Download article HTML ===
# Usage: 修改 ARTICLE_URL 为目标文章 URL
ARTICLE_URL = "https://elpais.com/chile/2026-05-06/cuando-la-ia-puede-predecir-un-delito.html"
html_file = "/tmp/pipeline_article.html"
subprocess.run(['curl', '-s', '-L', '-o', html_file, '-A', 'Mozilla/5.0', ARTICLE_URL],
               capture_output=True, timeout=30)
print(f"HTML downloaded: {os.path.getsize(html_file)} bytes")

# === 3. Import article ===
with open(html_file, 'rb') as f:
    html_bytes = f.read()
r = subprocess.run(['curl', '-s', '-X', 'POST', f'{BASE}/api/import/webpage',
                    '-b', f'authjs.session-token={session}',
                    '-F', f'file=@{html_file}',
                    '-F', f'originalUrl={ARTICLE_URL}'],
                   capture_output=True, text=True, timeout=30)
import_result = json.loads(r.stdout)
if "error" in import_result:
    # 可能已导入，查 DB 最新
    conn = sqlite3.connect(os.path.expanduser('~/Documents/git/esleer/esleer-data/dev.db'))
    a = conn.execute("SELECT id FROM Article WHERE source LIKE '%elpais%' ORDER BY id DESC LIMIT 1").fetchone()
    conn.close()
    article_id = a[0] if a else None
    print(f"Article already imported, using ID: {article_id}")
else:
    article_id = import_result["article"]["id"]
    print(f"Imported: ID={article_id}, {import_result.get('message')}")

# === 4. Read article content from DB ===
conn = sqlite3.connect(os.path.expanduser('~/Documents/git/esleer/esleer-data/dev.db'))
row = conn.execute('SELECT id, title, content FROM Article WHERE id = ?', (article_id,)).fetchone()
conn.close()
article_id, title, content = row
paragraphs = extract_paragraphs(content)
print(f"Article {article_id}: {title}, {len(paragraphs)} paragraphs")

# === 5. Auto-generate notes (AI全文精读-标准密度) ===
auto_result = curl_post(f'{BASE}/api/ai/auto-generate', {
    "paragraphs": paragraphs,
    "noteDensity": "standard",
    "context": {"articleLanguage": "es", "examType": "none", "scenario": "daily"}
}, session)

if "error" in auto_result:
    print(f"AI 精读失败: {auto_result['error']}")
else:
    notes = auto_result.get("data", {}).get("notes", [])
    print(f"AI 精读完成: {len(notes)} 条笔记")
    meta = auto_result.get("meta", {})
    print(f"AI 额度: 已用 {meta.get('quotaUsed')} / 剩余 {meta.get('quotaRemaining')}")

    # === 6. Save notes ===
    # ⚠️ 必须传入原 content，否则 /api/articles 会将 article.content 覆盖为空字符串
    # （notesOnlyMode 只对「他人文章」生效，自己的文章传空 content 会清空正文）
    save_payload = {
        "article": {"id": article_id, "title": title, "content": content},
        "notes": [{"noteId": n["id"], "highlightText": n["text"],
                   "title": n["text"][:50] + ("..." if len(n["text"]) > 50 else ""),
                   "noteContent": n["content"], "color": n["color"], "isHighlightOnly": False}
                  for n in notes]
    }
    save_result = curl_post(f'{BASE}/api/articles', save_payload, session)
    print(f"保存结果: {save_result}")
```

---

## 关键文件路径

- esleer-next: `~/Documents/git/esleer/esleer-next/`
- 凭证文件: `~/.config/esleer/credentials.json`
- Session 文件: `~/.config/esleer/session_cookie.txt`
- 数据库: `~/Documents/git/esleer/esleer-data/dev.db`

## 注意事项

- 导入限流：每天最多 N 篇，超额返回 429
- AI 全文精读按段落计费，标准密度约 20-30 条笔记/篇（每篇耗时约 30-60 秒）
- 所有 API 都需要有效的 NextAuth session，未登录返回 401
- `paragraphs` 需从文章 HTML 的 `<p>` 标签提取纯文本，不含 HTML 标签
- **不要使用** `POST /api/ai/generate-notes`（那是选段高亮生成，不是全文精读）
- Session 过期时运行上方「Session 自动刷新脚本」即可，无需重新配置密码
