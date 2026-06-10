#!/usr/bin/env python3
"""
ESLEER 文章采集脚本
用法：
  python3 fetch-article.py <URL>
  python3 fetch-article.py <URL> --mode=raw

模式说明：
  --mode=default  纯文本 <p> 输出（默认，兼容翻译等功能）
  --mode=raw      保留 <article>/<main> 内完整 HTML（含内联样式），删除所有 <link> 标签

目标库：esleer-next/esleer-data/dev.db
写入用户：hiuva@outlook.com (id: cmmc0w0230000j6sjggm1mlir)

只写不改，不动任何现有数据。
"""

import sys
import re
import sqlite3
import html
import warnings
import argparse
from datetime import datetime
from pathlib import Path
import json
from urllib.parse import urlparse

warnings.filterwarnings("ignore")

DB_PATH = Path(__file__).parent.parent / "esleer-data" / "dev.db"
ADMIN_USER_ID = "cmmc0w0230000j6sjggm1mlir"
FETCH_ERROR_LOG = Path(__file__).parent / "fetch-error.log"


def log_fetch_error(url: str, error_type: str, error_message: str):
    """Write a fetch error to fetch-error.log in JSON Lines format."""
    entry = {
        "url": url,
        "errorType": error_type,
        "errorMessage": error_message,
        "timestamp": datetime.now().isoformat(),
    }
    try:
        with open(FETCH_ERROR_LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass


def fetch_html(url: str) -> str:
    import requests

    session = requests.Session()
    # 用 session 先打 elpais.com 首页拿 cookie，解决 403
    try:
        session.get("https://elpais.com/", headers={"User-Agent": "Mozilla/5.0"}, timeout=5)
    except Exception as e:
        print(f"[fetch-article.py] 首页预热失败（不影响采集）: {e}")

    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Cache-Control": "max-age=0",
    }

    # Exponential backoff: 3 retries, intervals 2s/4s/8s
    max_retries = 3
    backoff = [2, 4, 8]
    last_err = None
    for attempt in range(max_retries + 1):
        try:
            resp = session.get(url, headers=headers, timeout=20)
            resp.raise_for_status()
            return resp.text
        except requests.exceptions.RequestException as err:
            last_err = err
            if attempt < max_retries:
                wait = backoff[attempt]
                print(f"[fetch-article.py] 重试第{attempt + 1}次，等待{wait}s: {err}")
                import time
                time.sleep(wait)
            # else: final attempt failed, will log below

    log_fetch_error(url, "requests", str(last_err))
    raise last_err


def extract_article(html_content: str, url: str, mode: str = "default") -> dict:
    from bs4 import BeautifulSoup
    from bs4 import Comment

    soup = BeautifulSoup(html_content, "lxml")

    # 移除干扰标签
    for tag in soup.find_all(["nav", "header", "footer", "aside", "form"]):
        tag.decompose()
    for comment in soup.find_all(string=lambda t: isinstance(t, Comment)):
        comment.extract()

    hostname = __import__("urllib.parse", fromlist=["urlparse"]).urlparse(url).hostname or ""

    # 标题
    title_tag = (
        soup.find("meta", property="og:title") or
        soup.find("meta", attrs={"name": "twitter:title"}) or
        soup.find("h1") or
        soup.find("title")
    )
    title = ((title_tag.get("content", "") or title_tag.get_text()) if title_tag else "").strip()
    if not title:
        title = "Untitled"

    # 作者
    author_tag = (
        soup.find("meta", attrs={"name": "author"}) or
        soup.find("meta", property="article:author") or
        soup.find("meta", attrs={"name": "twitter:creator"}) or
        soup.find("a", rel="author")
    )
    author = ((author_tag.get("content", "") or author_tag.get_text()) if author_tag else "").strip()

    # 描述
    desc_tag = (
        soup.find("meta", property="og:description") or
        soup.find("meta", attrs={"name": "description"}) or
        soup.find("meta", attrs={"name": "twitter:description"})
    )
    desc = (desc_tag.get("content", "") if desc_tag else "").strip()

    # 发布日期
    date_tag = soup.find("meta", property="article:published_time") or soup.find("time", datetime=True)
    if date_tag:
        dt = date_tag.get("content") or date_tag.get("datetime") or ""
        try:
            pub_date = datetime.fromisoformat(dt.replace("Z", "+00:00")).isoformat()
        except Exception:
            pub_date = datetime.now().isoformat()
    else:
        pub_date = datetime.now().isoformat()

    # 正文
    content = _extract_content(soup, title, mode)

    if not content or len(content.strip()) < 120:
        raise ValueError(
            f"正文不足（{len(content) if content else 0} chars），"
            "页面可能需要 JS 渲染或被禁止访问。"
        )

    topic = _extract_topic_from_url(url)

    return {
        "title": title,
        "subtitle": desc,
        "excerpt": desc,
        "author": author or hostname,
        "content": content,
        "siteName": hostname,
        "publishDate": pub_date,
        "source": hostname,
        "topic": topic,
    }


def _extract_topic_from_url(url: str) -> str:
    try:
        from urllib.parse import urlparse
        path = urlparse(url).path
        segments = [s for s in path.split("/") if s]
        date_pat = re.compile(r"^\d{4}-\d{2}-\d{2}$|^\d{8}$")
        for seg in segments:
            if date_pat.match(seg) or seg.isdigit():
                continue
            if re.match(r"^[a-zA-Z][a-zA-Z0-9_-]*$", seg) and len(seg) >= 2:
                return seg.capitalize()
    except Exception:
        pass
    return "Inbox"


def _extract_content(soup, title: str, mode: str = "default") -> str:
    # 找正文容器
    candidates = soup.find_all(["article", "main", "[role='main']"])
    best_block = None
    best_score = 0

    for tag in candidates:
        paragraphs = tag.find_all("p")
        score = sum(len(p.get_text(strip=True)) for p in paragraphs if len(p.get_text(strip=True)) > 30)
        if score > best_score:
            best_score = score
            best_block = tag

    if not best_block:
        best_block = soup

    # ── raw 模式：保留完整 HTML ────────────────────────────────
    if mode == "raw":
        # 删除所有 <link> 标签（外部 CSS 采集时失效）
        for link in best_block.find_all("link"):
            link.decompose()

        # 删除干扰内容（社交关注按钮、评论区等小尺寸元素）
        for tag in best_block.find_all(["nav", "footer", "aside", "form"]):
            tag.decompose()

        # 只保留 article/main 容器内的 HTML，保留子元素的完整结构（含内联样式）
        result = ""
        for child in best_block.children:
            if hasattr(child, "name") and child.name:
                result += str(child)
            else:
                result += str(child)
        return result or best_block.decode_contents()

    # ── default 模式：纯文本 <p> ─────────────────────────────
    bad_patterns = [
        re.compile(r"^by\s+[a-z]", re.I),
        re.compile(r"^published\s*at", re.I),
        re.compile(r"^\d+\s+(minute|hour|day|week|month)s?\s+ago$", re.I),
        re.compile(r"^\d+\s+comments?$", re.I),
        re.compile(r"^media\s*caption", re.I),
    ]


    seen = set()
    parts = []
    for p in best_block.find_all(["p", "div", "section"]):
        text = p.get_text(separator=" ", strip=True)
        if len(text) < 30 or text in seen or text == title.strip():
            continue
        if any(pat.match(text) for pat in bad_patterns):
            continue
        seen.add(text)
        parts.append(f"<p>{html.escape(text)}</p>")


    return "".join(parts)


def write_to_db(article_data: dict, mode: str = "default") -> int:
    """写入 dev.db，返回 article id"""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    now = datetime.now().isoformat()

    cursor.execute("""
        INSERT INTO "Article" (
            "title", "subtitle", "content", "author", "source", "topic",
            "publishDate", "userId", "importSource", "firstImageUrl", "scope",
            "createdAt", "updatedAt", "import_mode"
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        article_data["title"],
        article_data.get("subtitle") or "",
        article_data["content"],
        article_data.get("author") or "",
        article_data.get("source") or "",
        article_data.get("topic") or "Inbox",
        article_data.get("publishDate") or now,
        ADMIN_USER_ID,
        "webpage",
        None,
        "personal",
        now,
        now,
        mode,  # import_mode
    ))

    article_id = cursor.lastrowid
    conn.commit()
    conn.close()
    return article_id


def main():
    parser = argparse.ArgumentParser(description="ESLEER 文章采集脚本")
    parser.add_argument("url", help="文章 URL")
    parser.add_argument("--mode", default="default", choices=["default", "raw"],
                        help="default=纯文本 <p> 输出；raw=保留原始 HTML（含内联样式）")
    args = parser.parse_args()

    url = args.url.strip()
    mode = args.mode

    print(f"🌐 抓取: {url}  [mode={mode}]")

    html_content = fetch_html(url)
    print(f"  HTML 大小: {len(html_content):,} chars")

    article_data = extract_article(html_content, url, mode)
    print(f"  标题: {article_data['title'][:60]}")
    print(f"  作者: {article_data.get('author', 'N/A')}")
    print(f"  主题: {article_data.get('topic', 'Inbox')}")
    print(f"  正文长度: {len(article_data['content']):,} chars")

    article_id = write_to_db(article_data, mode)
    print(f"\n✅ 已写入数据库，article_id = {article_id}")
    print(f"   访问: http://localhost:3000/reader/{article_id}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"❌ 采集失败: {e}")
        sys.exit(1)