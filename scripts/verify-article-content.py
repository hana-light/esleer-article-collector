#!/usr/bin/env python3
"""
ESLEER 采集内容质量验收脚本

检查入库文章的 content 是否干净（无按钮文字、广告、作者元数据、脚本等），
用于采集后验收与回归测试。

用法：
  python3 scripts/verify-article-content.py 84 85 86 87   # 指定文章 ID
  python3 scripts/verify-article-content.py --all-raw      # 检查所有 raw 模式文章
  python3 scripts/verify-article-content.py --latest 5     # 检查最近 5 篇

退出码：0 = 全部通过；1 = 存在 ERROR 级问题
"""

import re
import sys
import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).parent.parent.parent / "esleer" / "esleer-data" / "dev.db"

# ── ERROR 级：出现即判失败 ────────────────────────────────────────────
FORBIDDEN_TAGS = [
    "script", "style", "iframe", "svg", "button", "form",
    "input", "select", "textarea", "noscript", "link", "nav", "ins",
]

JUNK_CLASS_FRAGMENTS = [
    # elpais
    "a_md", "w_rs", "_btn", "a_com", "w-ae", "outbrain", "taboola", "trc_",
    # bbc
    "dotcom-ad", "recommendations", "podcast-promo",
    # elmundo
    "skin-ad", "hidden-content", "ue-c-section-title",
    "ue-c-article__bar", "ue-c-article__author", "ue-c-popular-links",
    "comments-panel", "fixed-button",
    # lavanguardia / 通用广告
    "bottom_ad", "ads-wall", "adsbygoogle",
    "article_info", "related_item", "related_details",
    "signature_author", "author_bio", "tags-container",
]

JUNK_TEXT_ERROR = [
    r"Compartir en (Whatsapp|Facebook|Twitter|X)",
    r"Copiar enlace",
    r"CONTENIDO PATROCINADO",
    r"Archivado En",
    r"Información del artículo",
    r"Más leídas",
    r"Saltar .{0,30} y continuar leyendo",
    r"Ir a los comentarios",
    r"Suscríbete aquí",
    r"Haz clic aquí para leer",
    r"También puedes seguirnos en",
    r"recibir notificaciones",
    r"Follow BBC News",
]

# ERROR 级：按 CSS selector 检查（class 混淆的站点用语义属性定位）
JUNK_SELECTORS = [
    '[data-component="headline-block"]',
    '[data-component="byline-block"]',
    '[data-component="tag-list-block"]',
    '[data-e2e="advertisement"]',
    '[data-e2e="recommendations-wrapper"]',
    '[data-e2e="podcast-promo"]',
    '[data-testid="byline"]',
]

# ── WARN 级：可能正常出现在正文，仅提示 ──────────────────────────────
JUNK_TEXT_WARN = [
    r"\bNewsletter\b",
    r"\bPublicidad\b",
    r"Te puede interesar",
    r"Lee también",
    r"Sigue leyendo",
]

INLINE_STYLE_ERROR = [
    r"position\s*:\s*fixed",
]

MIN_TEXT_LENGTH = 500
MIN_PARAGRAPHS = 3


def check_article(row) -> tuple[list, list]:
    """返回 (errors, warnings)"""
    from bs4 import BeautifulSoup

    article_id, title, source, import_mode, content = row
    errors, warnings = [], []

    if not content or not content.strip():
        return [f"content 为空"], []

    soup = BeautifulSoup(content, "lxml")

    # 1) 禁用标签
    for tag in FORBIDDEN_TAGS:
        found = soup.find_all(tag)
        if found:
            errors.append(f"含禁用标签 <{tag}> × {len(found)}")

    # 2) 垃圾 class
    for frag in JUNK_CLASS_FRAGMENTS:
        found = soup.select(f'[class*="{frag}"]')
        if found:
            sample = " ".join(found[0].get("class", []))[:60]
            errors.append(f'含垃圾 class "{frag}" × {len(found)}（如 {sample}）')

    # 2b) 垃圾 selector（语义属性定位）
    for sel in JUNK_SELECTORS:
        found = soup.select(sel)
        if found:
            errors.append(f"含垃圾元素 {sel} × {len(found)}")

    # 3) 垃圾文本（ERROR）
    text = soup.get_text(" ", strip=True)
    for pat in JUNK_TEXT_ERROR:
        m = re.search(pat, text, re.I)
        if m:
            errors.append(f'含垃圾文本 "{m.group(0)[:50]}"')

    # 4) 垃圾文本（WARN）
    for pat in JUNK_TEXT_WARN:
        m = re.search(pat, text, re.I)
        if m:
            ctx_start = max(0, m.start() - 40)
            warnings.append(f'疑似推广文本 "{m.group(0)}"（上下文: …{text[ctx_start:m.end() + 40]}…）')

    # 5) 内联样式
    for pat in INLINE_STYLE_ERROR:
        found = [el for el in soup.select("[style]") if re.search(pat, el.get("style", ""), re.I)]
        if found:
            errors.append(f"含 {pat} 内联样式 × {len(found)}")

    # 6) aria-hidden 可见文本（raw 模式下会渲染出来）
    hidden_with_text = [
        el for el in soup.select('[aria-hidden="true"]')
        if el.get_text(strip=True) and not el.find("img")
    ]
    if hidden_with_text:
        warnings.append(f'aria-hidden 元素含文本 × {len(hidden_with_text)}')

    # 7) 结构健全性
    if len(text) < MIN_TEXT_LENGTH:
        errors.append(f"纯文本过短（{len(text)} < {MIN_TEXT_LENGTH} chars），可能采集失败")
    n_para = len(soup.find_all("p"))
    if n_para < MIN_PARAGRAPHS:
        errors.append(f"段落过少（{n_para} < {MIN_PARAGRAPHS}）")

    return errors, warnings


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(1)

    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    base_sql = 'SELECT id, title, source, importMode, content FROM "Article"'

    if args[0] == "--all-raw":
        rows = cur.execute(f"{base_sql} WHERE importMode = 'raw' ORDER BY id").fetchall()
    elif args[0] == "--latest":
        n = int(args[1]) if len(args) > 1 else 5
        rows = cur.execute(f"{base_sql} ORDER BY id DESC LIMIT ?", (n,)).fetchall()
    else:
        ids = [int(a) for a in args]
        placeholders = ",".join("?" * len(ids))
        rows = cur.execute(f"{base_sql} WHERE id IN ({placeholders}) ORDER BY id", ids).fetchall()
    conn.close()

    if not rows:
        print("未找到匹配的文章")
        sys.exit(1)

    total_errors = 0
    for row in rows:
        article_id, title, source, import_mode, _ = row
        errors, warnings = check_article(row)
        status = "❌ FAIL" if errors else ("⚠️ WARN" if warnings else "✅ PASS")
        print(f"\n{status}  [{article_id}] {source} ({import_mode}) {title[:50]}")
        for e in errors:
            print(f"    ERROR: {e}")
        for w in warnings:
            print(f"    warn:  {w}")
        total_errors += len(errors)

    print(f"\n{'─' * 60}")
    print(f"共检查 {len(rows)} 篇，{total_errors} 个 ERROR")
    sys.exit(1 if total_errors else 0)


if __name__ == "__main__":
    main()
