# esleer-article-collector

小v文章自动采集流程：链接 → esleer → AI精读 → 笔记生成

## 概述

当你发一个文章链接给小v（article-collector），它自动完成：

1. **采集** 下载文章 HTML → 解析正文 → 写入 esleer 数据库
2. **AI精读** 调用 DeepSeek API 生成全文笔记
3. **保存** 笔记写入用户账号

## 工作原理

```
你发链接 → article-collector agent → fetch-article.py 采集 → esleer 数据库
                                         → /api/ai/auto-generate AI精读
                                         → /api/articles 保存笔记
```

## 文件结构

```
├── scripts/
│   ├── fetch-article.py      # Python 采集脚本（支持 list page 检测）
│   ├── fetch-article.mjs     # Node.js 采集脚本（带节流保护）
│   ├── auto-process.mjs      # AI 精读 + 保存笔记 pipeline
│   └── get-session-cookie.mjs # 刷新 NextAuth session
├── skills/
│   └── esleer-article-notes-pipeline/SKILL.md  # agent 用 skill
├── config/
│   └── credentials.example.json  # 凭证模板
└── README.md
```

## 依赖

- Python 3.10+ (fetch-article.py)
- Node.js 18+ (fetch-article.mjs, auto-process.mjs)
- esleer-next 运行在 `http://localhost:3000`
- 数据库：`~/Documents/git/esleer/esleer-data/dev.db`
- DeepSeek API Key（在 esleer 前端配置）

## 快速开始

### 1. 配置凭证

```bash
cp config/credentials.example.json ~/.config/esleer/credentials.json
# 编辑填入你的 esleer 账号 email 和 password
```

### 2. 采集文章

```bash
# Python 版本（带列表页检测）
python3 scripts/fetch-article.py <URL>

# Node.js 版本（带节流保护，同一域名每天最多 3 次）
node scripts/fetch-article.mjs <URL>
```

### 3. AI 精读 + 保存笔记

```bash
# 手动跑 pipeline（article_id 从第2步获取）
node scripts/auto-process.mjs <article_id>

# 或通过 agent 自动完成
```

## 凭证说明

登录 `http://localhost:3000/esleer` 后，浏览器会创建 `authjs.session-token` cookie。

首次运行后 session 自动保存在 `~/.config/esleer/session_cookie.txt`，之后自动刷新。

如果 session 过期，重新登录 esleer 即可（打开浏览器访问 localhost:3000）。

## 反爬策略

- **Python 版本**：检测列表页/首页，拒绝非文章 URL
- **Node.js 版本**：同一域名 24 小时内最多采集 3 次，超限拒绝