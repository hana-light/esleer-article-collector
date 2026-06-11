# Raw Mode 采集 + 清洗验收报告（第二轮）

> 测试时间：2026-06-11
> 前一轮报告：[raw-mode-test-report.md](raw-mode-test-report.md)（2026-06-10）
> 本轮目标：① 补齐 BBC 支持；② 修复 El País 正文混入按钮/作者图/作者名的问题；③ 全面验收清洗质量

---

## 1. 结论速览

| 来源 | 采集方式 | 评级 | 说明 |
|------|---------|------|------|
| bbc.com/mundo（西语） | Python / Node 普通 fetch | ✅ 完全支持 | 新增。byline、广告、推荐区、订阅推广全部清除 |
| bbc.com/news（英语） | Python / Node 普通 fetch | ✅ 完全支持 | 新增。英文版用 data-component 钩子，与 Mundo 规则并存 |
| elpais.com | **必须 fetch-article.mjs（Playwright）** | ✅ 完全支持 | 作者块/分享按钮/评论/标签云/赞助内容全清。见 §4 DataDome 说明 |
| lavanguardia.com | 普通 fetch | ✅ 完全支持 | 作者+日期块、Lee también、文末作者简介、Etiquetas 全清 |
| elmundo.es | 普通 fetch | ✅ 完全支持 | 署名栏、kicker、重复标题、站点导航、评论面板全清 |

**验收结果：6 篇 raw 文章（id 84/85/89/91/92/93）全部 PASS，0 ERROR。**

---

## 2. 本轮交付的架构变更

### 2.1 清洗规则配置化（核心变更）

新增 **`config/strip-rules.json`**：按域名分组的清洗规则，Python 与 Node 采集脚本共享。
**清洗发生在入库前**——存进数据库的内容本身就是干净的，不再依赖渲染端补救。

三类规则：
- `removeTags`：按标签名删（script/iframe/svg/button/form/ins 等）
- `selectors`：按 CSS selector 删（站点专属：作者区、分享栏、广告壳）
- `textPatterns`：按正则删整段（无 class 钩子的推广文案，限 300 字符内防误删正文）

新站点适配流程：抓一篇文章 → 找垃圾元素的 class/data-* 钩子 → 往 strip-rules.json 加一组规则 → 跑验收脚本确认。**两端脚本零代码改动。**

### 2.2 脚本变更

| 文件 | 变更 |
|------|------|
| `scripts/fetch-article.py` | raw 模式接入 strip-rules.json；首页预热泛化到目标站点；**修复 DateTime 写入格式**（改为 ISO 8601 UTC 带 Z，之前写本地时间无时区，属于 prisma-datetime-troubleshooting.md 中的格式 2 污染） |
| `scripts/fetch-article.mjs` | 新增 `--mode=raw`；写入 `importMode` 字段；Prisma 改为 @libsql/client 直连（不再依赖跨仓库生成 client）；新增 `--html-file=<path>` 手动导入兜底；修复 `/news/articles/<id>` 被列表页正则误杀的 bug |
| `scripts/verify-article-content.py` | **新增**。内容质量验收脚本，见 §5 |

### 2.3 渲染端（esleer-next，防御层）

- **修复根因 bug**：`reader/[id]/page.tsx` 构造 article props 时漏传 `importMode`，导致 raw 模式的 extraStrip 分支从未执行——这就是上一轮 strip 规则"不生效"的原因（reader-strip-debug-report.md 中未确认的疑点）
- `readerStripRules.ts` 补齐 bbc/lavanguardia/elmundo 规则，与 strip-rules.json 同步
- `ReaderContent.tsx` 域名匹配兼容 `www.` 前缀（Article.source 存的是 `www.bbc.com` 这类完整 hostname）

> 渲染端规则现在只是防御层。新采集的文章在数据层已干净。

---

## 3. 测试文章清单

| id | 来源 | mode | 正文长度 | 验收 |
|----|------|------|---------|------|
| 84 | www.bbc.com (Mundo) | raw | 26,355 | ✅ PASS |
| 85 | elpais.com | raw | 6,540 | ✅ PASS |
| 89 | www.elmundo.es | raw | 14,9xx | ✅ PASS |
| 91 | www.bbc.com (News EN) | raw | 20,651 | ✅ PASS |
| 92 | www.lavanguardia.com | raw | 14,4xx | ✅ PASS |
| 93 | elpais.com（线上 Playwright） | raw | 9,768 | ✅ PASS |

人工抽查每篇开头/结尾：均以正文或图片说明开头、以正文结尾，无元数据、按钮文字、推广段落。

---

## 4. El País / DataDome 注意事项

- elpais.com 文章页对普通 requests/fetch 一律 403（上一轮 Python 可直抓的情况已失效），**必须走 fetch-article.mjs 的 Playwright 路径**
- El País 使用 **DataDome** 反爬：短时间内连续命中会被按 IP 标记，标记期间连 Playwright（含有头模式）都返回 403 验证码页；约 10-20 分钟后自动衰减
- 脚本自带 3 次/天/域名节流，正常使用不会触发标记；**不要在短时间内反复重试**
- 被拦截时的兜底：浏览器手动打开文章 → 保存 HTML → `node scripts/fetch-article.mjs <URL> --mode=raw --html-file=<保存的文件>`（不计节流额度）

---

## 5. 验收脚本用法

```bash
python3 scripts/verify-article-content.py 84 85 91      # 指定 ID
python3 scripts/verify-article-content.py --all-raw      # 全部 raw 文章
python3 scripts/verify-article-content.py --latest 5     # 最近 5 篇
```

检查项：
1. 禁用标签（script/iframe/svg/button/form/ins…）
2. 已知垃圾 class（a_md/w_rs/dotcom-ad/skin-ad/article_info/signature_author…）
3. 垃圾 selector（data-component="byline-block" 等语义钩子）
4. 垃圾文本正则（"Compartir en…"、"Archivado En"、"Follow BBC News"、"Suscríbete aquí"…）
5. position:fixed 内联样式
6. aria-hidden 含文本元素（WARN）
7. 结构健全性（纯文本 ≥500 字符、段落 ≥3）

ERROR 退出码 1，可接入 CI/采集后自动校验。

**标准采集验收流程**：采集 → `verify-article-content.py <id>` → PASS 才算完成；FAIL 时按 §2.1 流程补规则重采。

---

## 6. 上一轮遗留问题状态

| 问题 | 状态 |
|------|------|
| lavanguardia 固定广告（class 方式） | ✅ 已修（strip-rules.json class 组合 selector） |
| elmundo skin-ad / ue-l-article 广告壳 | ✅ 已修（配置化，且补了署名栏/导航/评论面板） |
| medium.com 403 | ⏸ 未动（mjs 已路由到 Playwright，未实测） |
| nationalgeographic / clarin | ⏸ 未动（待产品确认是否核心需求） |
| normalizeReaderHtml 不生效 | ✅ 根因已修（page.tsx 漏传 importMode） |

---

## 7. 第三轮：图片相关修复（2026-06-12）

用户在阅读器实际验收后反馈 3 个图片问题，全部修复：

| 问题 | 根因 | 修复 |
|------|------|------|
| BBC 图片来源与页脚之间大段空行（id 84） | 图片容器的 `padding-bottom:56.25%` 纵横比占位样式，脱离站点 CSS（img 绝对定位）后变成空白 | 两端 raw 清洗增加"style 手术"：剥除 `padding-top/bottom: N%` 声明（保留 style 里其他属性） |
| El País 正文图片丢失（id 85/93） | 头图在 `<header class="a_e">` 内，文档级预清洗删了所有 `<header>` | raw 模式保留 `<header>`；标题/副标题重复改由站点规则清除（elpais 加 `h1.a_t`/`p.a_st`） |
| BBC 英文版开头灰色图片（id 91） | 渐进式加载的占位图（`static.files.bbci.co.uk`），真图在 `ichef.bbci.co.uk` | bbc.com 规则增加 `img[src*="static.files.bbci.co.uk"]` |

**保留 header 引出的回归（同轮修复）**：
- lavanguardia：header 内重复标题块（`.article_header .titles`）、付费墙角标（`.freemium`）
- elmundo：标签块（`.ue-c-article__tags-container`）、无法播放的视频块只剩署名残留（`.ue-c-article__media--video`）
- lavanguardia 头部视频的 jwplayer poster 图作为头图保留（合理的视觉替代）

**验收**：5 篇重采后全部 PASS（0 ERROR），图片审计 0 占位图、0 padding 占位、0 重复 h1；内容已原地写回原 article id（84/85/89/91/92），用户链接不变。

**遗留**：id 93（El País 线上）重采时再次被 DataDome 拦截，正文干净但缺头图。待标记衰减后重跑：
```bash
node scripts/fetch-article.mjs "https://elpais.com/internacional/2026-06-11/los-intercambios-de-fuego-entre-estados-unidos-e-iran-abren-una-peligrosa-nueva-fase-en-la-guerra.html" --mode=raw
```
或浏览器手动保存 HTML 后用 `--html-file` 导入，再用 §7 同款 SQL 把 content 写回 id 93。

---

*报告生成：2026-06-11，第三轮更新：2026-06-12 by Claude*
