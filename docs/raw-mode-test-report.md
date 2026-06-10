# Raw Mode 采集测试报告

> 测试时间：2026-06-10
> 测试人：小扎

---

## 1. 环境

- esleer-next：localhost:3000（运行中）
- 数据库：~/Documents/git/esleer/esleer-data/dev.db
- 采集脚本：`python3 scripts/fetch-article.py <URL> --mode=raw`

---

## 2. 测试文章列表

| # | 来源 | URL | article_id | content大小 | 采集结果 |
|---|------|-----|-----------|-----------|---------|
| 1 | elpais.com | https://elpais.com/espana/madrid/2026-06-09/condenados-a-35-anos-de-prision... | 89 | 28,858 chars | ✅ 成功 |
| 2 | lavanguardia.com | https://www.lavanguardia.com/vida/20260609/11559627/docentes-encaran-diez-dias-curso-ultima-huelga-2025-2026.html | 90 | 19,174 chars | ✅ 成功 |
| 3 | elmundo.es | https://www.elmundo.es/cataluna/2026/06/09/6a26d753e85eceda5b8b4591.html | 92 | 40,475 chars | ✅ 成功 |
| 4 | medium.com | — | — | — | ❌ 403 Forbidden（所有路径均封禁） |
| 5 | nationalgeographic.es | — | — | — | ❌ 403/404 Forbidden |
| 6 | clarin.com | — | — | — | ❌ Cloudflare 拦截（Playwright 也无法加载，显示"Un momento…"） |

**说明**：
- elpais 和 lavanguardia 的文章 URL 是从当日首页动态抓取的（2026-06-10 真实文章）
- elmundo 同上
- medium、nationalgeographic、clarin 均无法访问，需专项适配

---

## 3. 兼容性评级

| 来源 | 评级 | 说明 |
|------|------|------|
| elpais.com | ✅ 可接受 | `<article>` 结构干净，无固定定位、无广告壳，raw 模式零额外处理即可用 |
| lavanguardia.com | ⚠️ 轻微问题 | content 开头含 `<ins class="fixed bottom-0 ...">` 固定广告，extraStrip 的 `[style*="position:fixed"]` 无法删除 class 中的 fixed |
| elmundo.es | ⚠️ 轻微问题 | content 含 `<div class="skin-ad">`（空顶栏）和 `<div class="ue-l-article hidden-content">`（ue 广告壳），采集端未移除 |
| medium.com | ❌ 暂不支持 | 403，Python 和 Node fetch 均封禁，需改用 Playwright |
| nationalgeographic.es | ❌ 暂不支持 | 403，需改用 Playwright |
| clarin.com | ❌ 暂不支持 | Cloudflare JS 挑战，Playwright 也被拦截，需专用 Playwright 配置（stealth mode） |

---

## 4. 样式冲突问题定位

### 问题 A：lavanguardia 固定广告（class 方式）

**冲突元素**（出现在 `<article>` 内容最外层）：
```html
<ins class="bottom_ad flex-center fixed bottom-0 left-1/2 -translate-x-1/2 w-[320px] z-50 sm:hidden"
     data-ad-callback="adCloser" data-ad-fixed="true">
```

**根因**：`normalizeReaderHtml` extraStrip 只匹配 `[style*="position:fixed"]`（内联样式），此元素用 CSS class 定义 fixed 定位（Tailwind class），无法匹配。

**extraStrip 修复建议**：
```javascript
// 删除 class 中含 fixed + bottom/top 的广告元素
wrapper.querySelectorAll('[class*="fixed"][class*="bottom-0"], [class*="fixed"][class*="top-0"]')
  .forEach(el => el.remove())

// 删除已知广告 class
;['bottom_ad', 'ads-wall', 'ads-wall-container'].forEach(cls => {
  wrapper.querySelectorAll(`[class*="${cls}"]`).forEach(el => el.remove())
})
```

---

### 问题 B：elmundo 顶栏空 div

**冲突元素**（content 开头）：
```html
<div class="skin-ad"></div>
```

**根因**：Python 脚本 `_extract_content` 提取 `<article>` 元素时，BeautifulSoup 把同级前向空兄弟元素也保留了。

**采集端修复建议**：
```python
# 在 _extract_content 中，提取 best_block 后、返回前
for ad in best_block.find_all('div', class_=lambda c: c and 'skin-ad' in c):
    ad.decompose()
```

---

### 问题 C：elmundo ue-l-article 广告壳

**冲突元素**：
```html
<div class="ue-l-article hidden-content">
  <div class="ue-l-article__inner ue-l-article__inner--no-gutter">
    <div class="ue-c-section-title">...</div>
  </div>
</div>
```

**根因**：同上，`<article>` 提取时带了外层广告壳。`hidden-content` class 表示这是 ue-l 广告的隐藏叠层。

**采集端修复建议**：
```python
for shell in best_block.find_all('div', class_=lambda c: c and 'ue-l-article' in c):
    shell.decompose()
```

---

## 5. normalizeReaderHtml() 增强建议

在 `ReaderContent.tsx` 的 extraStrip 逻辑中增加：

```javascript
if (options?.extraStrip) {
  // 现有逻辑（删除内联 position:fixed）
  wrapper.querySelectorAll('[style*="position:fixed"], [style*="position: fixed"]')
    .forEach(el => el.remove())

  // 【新增】删除 class 中的 fixed 定位广告（lavanguardia 等）
  wrapper.querySelectorAll('[class*="fixed"][class*="bottom-0"], [class*="fixed"][class*="top-0"]')
    .forEach(el => el.remove())

  // 【新增】删除已知广告/站外壳 class
  ;['bottom_ad', 'skin-ad', 'ue-l-article', 'ads-wall', 'ads-wall-container',
    'ue-c-section-title'].forEach(cls => {
    wrapper.querySelectorAll(`[class*="${cls}"]`).forEach(el => el.remove())
  })

  // 【新增】删除超大字号（已有，保留）
  wrapper.querySelectorAll('[style*="font-size"]').forEach(el => { ... })
}
```

---

## 6. 来源支持建议

| 来源 | 推荐模式 | 原因 |
|------|---------|------|
| elpais.com | ✅ raw 直接可用 | `<article>` 结构干净 |
| lavanguardia.com | ⚠️ raw 可用（需增强 extraStrip） | 固定广告需 class 级清洗 |
| elmundo.es | ⚠️ raw 可用（需增强采集端） | 顶栏/广告壳需在采集端移除 |
| medium.com | ❌ 暂不支持 | 403，需 Playwright + 参考 elpais 实现 |
| nationalgeographic.es | ❌ 暂不支持 | 403，需 Playwright |
| clarin.com | ❌ 暂不支持 | Cloudflare JS 挑战，Playwright 也被挡 |

---

## 7. 结论

- **elpais 完美支持**：raw 模式零额外处理可用，高亮机制（TreeWalker）不受影响，方案A核心假设成立
- **lavanguardia / elmundo 需小修**：各加 2-3 行清洗规则（渲染端或采集端）即可
- **medium / nationalgeographic / clarin 均封禁**：三者均返回 403 或 Cloudflare 拦截，无法用普通 fetch，需要专用 Playwright 配置
- **重试机制验证通过**：所有失败 URL 均触发 3 次指数退避（2s→4s→8s），日志正常写入 `fetch-error.log`

---

## 8. 下一步（优先级排序）

| 优先级 | 负责人 | 任务 |
|--------|--------|------|
| P1 | engineer | `normalizeReaderHtml` extraStrip 增加 class 级固定广告清洗 |
| P1 | engineer | `fetch-article.py` 增加 elmundo 广告壳移除 |
| P2 | engineer | medium.com 添加 Playwright 支持（参考 elpais fetchHtmlWithPlaywright 实现） |
| P2 | product | 确认 nationalgeographic / clarin 是否核心需求，决定是否投入适配 |

---

*报告生成：2026-06-10 by 小扎*
