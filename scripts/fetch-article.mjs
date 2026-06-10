#!/usr/bin/env node
/**
 * ESLEER 文章采集脚本（Node.js + Prisma）
 * 用法: node scripts/fetch-article.mjs <URL>
 *
 * 数据库: esleer-data/dev.db
 * 用户:   hiuva@outlook.com (id: cmmc0w0230000j6sjggm1mlir)
 *
 * 反爬策略:
 * - 同一域名 24 小时内最多采集 3 次，超限拒绝
 * - elmundo 等普通站点 → 普通 fetch
 * - elpais.com → Playwright（真实浏览器），绕过 Cloudflare JS 挑战
 *
 * 依赖:
 *   npm install
 *   npx playwright install chromium   # 首次运行前必须执行
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync } from 'fs';
import pkg from '@prisma/client';
const { PrismaClient } = pkg;
import * as cheerio from 'cheerio';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
// Default: sibling esleer repo. Override with ESLEER_DB_PATH env var.
const DB_PATH = process.env.ESLEER_DB_PATH ||
  path.resolve(PROJECT_ROOT, '..', 'esleer', 'esleer-data', 'dev.db');
const FETCH_LOG = path.resolve(__dirname, 'fetch-log.json');
const USER_ID = 'cmmc0w0230000j6sjggm1mlir';

// ---------------------------------------------------------------------------
// 反爬节流
// ---------------------------------------------------------------------------

function getToday() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function readLog() {
  try {
    return JSON.parse(readFileSync(FETCH_LOG, 'utf8'));
  } catch {
    return {};
  }
}

function writeLog(log) {
  writeFileSync(FETCH_LOG, JSON.stringify(log, null, 2), 'utf8');
}

/**
 * 检查域名今天还能不能采集，返回 { allowed, count, limit }
 */
function checkThrottle(hostname) {
  const log = readLog();
  const today = getToday();
  const entry = log[hostname] || {};
  const count = entry[today] || 0;
  const limit = 3;
  return { allowed: count < limit, count, limit };
}

/**
 * 记录一次采集
 */
function recordFetch(hostname) {
  const log = readLog();
  const today = getToday();
  if (!log[hostname]) log[hostname] = {};
  log[hostname][today] = (log[hostname][today] || 0) + 1;

  // 清理超过 7 天前的记录
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  for (const [dom, days] of Object.entries(log)) {
    for (const day of Object.keys(days)) {
      if (day < cutoffStr) delete days[day];
    }
    if (Object.keys(days).length === 0) delete log[dom];
  }

  writeLog(log);
}

// ---------------------------------------------------------------------------
// Prisma Client（直连本地 SQLite）
// 使用 PRISMA_DATABASE_URL 环境变量，与 esleer-next 保持一致
// ---------------------------------------------------------------------------

function createPrisma() {
  // 覆盖 env var，指向正确的 DB 路径
  process.env.PRISMA_DATABASE_URL = `file:${DB_PATH}`;
  return new PrismaClient();
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 采集
// ---------------------------------------------------------------------------

/**
 * 用 Playwright（真实浏览器）抓取页面 HTML。
 * 用于被 Cloudflare JS 挑战拦截的站点（如 elpais.com）。
 * 原理：Chromium 执行真实 JS，通过 Cloudflare 的 JS 挑战，拿到渲染后的 HTML。
 *
 * @param {string} url - 目标 URL
 * @returns {Promise<string>} - HTML 字符串
 */
async function fetchHtmlWithPlaywright(url) {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
      ],
    });
    const page = await browser.newPage();

    // 设置视口和 UA，伪装成真实浏览器
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
    });

    await page.goto(url, {
      waitUntil: 'networkidle',   // 等网络空闲（JS 渲染完成）
      timeout: 30000,
    });

    // 额外等 2 秒，确保动态内容完全加载
    await page.waitForTimeout(2000);

    const html = await page.content();
    await browser.close();
    return html;
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    throw new Error(`Playwright 采集失败: ${err.message}`);
  }
}

/**
 * 用普通 fetch 抓取页面 HTML。
 * 用于无 Cloudflare JS 挑战的站点（如 elmundo.es）。
 */
async function fetchHtmlWithFetch(url) {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Cache-Control': 'max-age=0',
    }
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
  }
  const buf = await resp.arrayBuffer();
  const contentType = resp.headers.get('content-type') || '';
  const encoding = contentType.includes('iso-8859-15') || contentType.includes('latin1') || contentType.includes('latin-1')
    ? 'iso-8859-15' : 'utf-8';
  return new TextDecoder(encoding).decode(buf);
}

/**
 * 统一入口：根据域名自动选择采集方式。
 * - elpais.com → Playwright（Cloudflare JS 挑战）
 * - 其他站点 → 普通 fetch
 */
async function fetchHtml(url) {
  const hostname = new URL(url).hostname;
  if (hostname.includes('elpais')) {
    return fetchHtmlWithPlaywright(url);
  }
  return fetchHtmlWithFetch(url);
}

// ---------------------------------------------------------------------------
// 正文提取
// ---------------------------------------------------------------------------

function extractArticle(htmlContent, url) {
  const $ = cheerio.load(htmlContent);

  // 移除干扰标签
  $('nav, header, footer, aside, form, script, style').remove();

  const hostname = new URL(url).hostname;

  // 标题
  let title =
    $('meta[property="og:title"]').attr('content') ||
    $('meta[name="twitter:title"]').attr('content') ||
    $('h1').first().text().trim() ||
    $('title').text().trim() ||
    '';
  if (!title) title = 'Untitled';

  // 作者
  let author =
    $('meta[name="author"]').attr('content') ||
    $('meta[property="article:author"]').attr('content') ||
    $('a[rel="author"]').first().text().trim() ||
    '';

  // 描述/副标题
  const subtitle =
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="description"]').attr('content') ||
    $('meta[property="twitter:description"]').attr('content') ||
    '';

  // 发布日期
  let publishDate = new Date().toISOString();
  const dateSrc =
    $('meta[property="article:published_time"]').attr('content') ||
    $('time[datetime]').attr('datetime') ||
    '';
  if (dateSrc) {
    try {
      publishDate = new Date(dateSrc).toISOString();
    } catch { /* keep default */ }
  }

  // 正文容器选择器
  const contentContainer =
    $('article[id*="cuerpo"]').first().length ||
    $('.articulo-cuerpo').first().length ||
    $('[data-dtm-region="articulo_cuerpo"]').first().length ||
    $('article').first().length ||
    $('main').first().length ||
    null;

  const badPatterns = [
    /^by\s+[a-z]/i,
    /^published\s*at/i,
    /^\d+\s+(minute|hour|day|week|month)s?\s+ago$/i,
    /^\d+\s+comments?$/i,
    /^media\s*caption,?$/i,
  ];

  const seen = new Set();
  const parts = [];

  if (contentContainer && contentContainer.length) {
    contentContainer.find('p, div').each((_, el) => {
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      if (text.length < 30 || seen.has(text)) return;
      if (text === title.trim()) return;
      if (badPatterns.some(p => p.test(text))) return;
      seen.add(text);
      const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      parts.push(`<p>${escaped}</p>`);
    });
  }

  // 兜底：从 body 抽所有 <p>
  if (parts.length === 0) {
    $('p').each((_, el) => {
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      if (text.length < 30 || seen.has(text)) return;
      if (badPatterns.some(p => p.test(text))) return;
      seen.add(text);
      const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      parts.push(`<p>${escaped}</p>`);
    });
  }

  const content = parts.join('');

  if (!content || content.length < 120) {
    throw new Error(
      `正文不足（${content.length} chars），页面可能需要 JS 渲染或被禁止访问`
    );
  }

  // 主题：从 URL 路径提取
  let topic = 'Inbox';
  try {
    const urlObj = new URL(url);
    const segments = urlObj.pathname.split('/').filter(Boolean);
    const datePat = /^\d{4}-\d{2}-\d{2}$|^\d{8}$/;
    for (const seg of segments) {
      if (datePat.test(seg) || /^\d+$/.test(seg)) continue;
      if (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(seg) && seg.length >= 2) {
        topic = seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase();
        break;
      }
    }
  } catch { /* keep default */ }

  return {
    title,
    subtitle,
    content,
    author: author || hostname,
    source: hostname,
    topic,
    publishDate: new Date(publishDate),
  };
}

// ---------------------------------------------------------------------------
// 写入数据库 + Prisma 验证
// ---------------------------------------------------------------------------

async function writeArticle(articleData) {
  const prisma = createPrisma();
  const now = new Date();

  try {
    const article = await prisma.article.create({
      data: {
        title: articleData.title,
        subtitle: articleData.subtitle || '',
        content: articleData.content,
        author: articleData.author || '',
        source: articleData.source || '',
        topic: articleData.topic || 'Inbox',
        publishDate: articleData.publishDate,
        userId: USER_ID,
        importSource: 'webpage',
        scope: 'personal',
        contentVersion: 1,
        createdAt: now,
        updatedAt: now,
      }
    });

    // Prisma 验证：读一次确认能查到
    const found = await prisma.article.findUnique({ where: { id: article.id } });
    if (!found) {
      throw new Error(`Prisma 验证失败：写入后查询返回 null（id=${article.id}）`);
    }

    return article.id;
  } finally {
    await prisma.$disconnect();
  }
}

// ---------------------------------------------------------------------------
// URL / 页面类型验证（拒绝列表页、首页、频道页）
// ---------------------------------------------------------------------------

const LIST_PAGE_PATTERNS = [
  // 首页 / 根路径
  /^https?:\/\/[^/]+\/?$/,
  // 带 /index 的路径
  /\/index\.(html?|php|aspx?)$/i,
  // 已知列表页 URL 结构
  // elmundo.es: secciones, ultima-hora 等
  /^https?:\/\/[^/]+\/secciones\//,
  /^https?:\/\/[^/]+\/noticia\//,
  /^https?:\/\/[^/]+\/el-mundo\//,
  // efe.com: 首页 / secciones
  /^https?:\/\/[^/]+\/efe\/?$/,
  /^https?:\/\/[^/]+\/secciones\//,
  /^https?:\/\/[^/]+\/news\/[^/]+\/[^/]+\/?$/,
  // elpais.com: 首页 / secciones
  /^https?:\/\/[^/]+\/elpais\/?$/,
  /^https?:\/\/[^/]+\/economia\//,
  /^https?:\/\/[^/]+\/politica\//,
  /^https?:\/\/[^/]+\/sociedad\//,
  /^https?:\/\/[^/]+\/internacional\//,
  /^https?:\/\/[^/]+\/cultura\//,
  /^https?:\/\/[^/]+\/opinion\//,
  /^https?:\/\/[^/]+\/deportes\//,
  /^https?:\/\/[^/]+\/tecnologia\//,
  /^https?:\/\/[^/]+\/ciencia\//,
  // bbc.com
  /^https?:\/\/[^/]+\/news\/?$/,
  /^https?:\/\/[^/]+\/news\/[a-z-]+\/?$/,
  // 通用: 路径只有分类标签，没有文章 slug
  /^https?:\/\/[^/]+\/[a-z]{2,}\/?$/,
  /^https?:\/\/[^/]+\/[a-z]{2,}\/[a-z-]+\/?$/,
];

/**
 * 检测 URL 是否为列表页 / 首页。
 *
 * 检查顺序（优先级从高到低）：
 * 1. 明显列表页特征（首页、/index.xxx）→ 直接拒绝
 * 2. 【关键修复】明显文章特征（.html 后缀 或 日期路径 /YYYY/MM/DD/）→ 直接放行
 *    这两类信号出现时，不论是否命中频道路径正则，都视为文章，不拦截。
 *    修复原因：/cultura/, /internacional/ 等频道路径正则过于宽泛，
 *    会错误拦截深层文章 URL（如 elmundo.es/cultura/cine/2026/06/04/slug.html）。
 *    加此检查后，第 3 步正则只做参考性提示，不误杀有文章特征的 URL。
 * 3. 频道路径正则匹配 → 做提示性检查
 * 4. 路径段数 ≤ 2 且无 slug/日期 → 兜底判为列表页
 *
 * 返回 { isListPage: boolean, reason: string }
 */
function detectListPage(url) {
  const parsed = new URL(url);
  const path = parsed.pathname;
  const segments = path.split('/').filter(Boolean);


  // ── 1. 首页：空路径或 / ──────────────────────────────────────────────
  if (!path || path === '/') {
    return { isListPage: true, reason: '首页（空路径）' };
  }

  // /index.xxx
  if (/\/index\.[a-z]+$/i.test(path)) {
    return { isListPage: true, reason: 'index 文件' };
  }

  // ── 2. 【文章强信号】有 .html 后缀 或 日期路径段 → 直接放行 ──────────
  //
  // .html 后缀：大多数站点的文章 URL 以 .html 结尾（elmundo, elpais 等）
  // 日期路径：elmundo 用 /YYYY/MM/DD/ 结构，elpais slug 内嵌日期
  // 只要 URL 含这两者之一，几乎可以确定是文章而非列表页。
  const hasHtmlSuffix = /\.html?$/i.test(path);                          // /xxx.html 或 /xxx.htm
  const hasDatePathSegment = /\/\d{4}\/\d{2}\/\d{2}\//.test(path);     // 含 /2026/06/04/ 日期路径
  if (hasHtmlSuffix || hasDatePathSegment) {
    return { isListPage: false, reason: '' };
  }

  // ── 3. 频道路径正则匹配（只做提示性检查，不拦截有文章特征的 URL）───────
  for (const pat of LIST_PAGE_PATTERNS) {
    if (pat.test(url)) {
      return { isListPage: true, reason: `列表页模式匹配: ${pat.toString()}` };
    }
  }

  // ── 4. 辅助判断：路径段少且没有 slug/日期 → 兜底判为列表页 ───────────
  if (segments.length <= 2) {
    const hasDateOrSlug = segments.some(seg =>
      /^\d{4}-\d{2}-\d{2}$/.test(seg) || // 日期 2024-01-01
      /^\d{8}$/.test(seg) ||               // 数字日期 20240101
      /^[a-z]+-\d+-[a-z]/.test(seg) ||     // elpais slug: algo-1234-title
      /^\d+-[a-z]/.test(seg)                // 类似 /62-noticia
    );
    if (!hasDateOrSlug) {
      return { isListPage: true, reason: `疑似列表页（路径段=${segments.join('/')}，无 slug/日期）` };
    }
  }

  return { isListPage: false, reason: '' };
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const JOB_MODE = args.includes('--job-mode');
  // logs go to stderr in job mode so stdout stays clean for JSON output
  const log = (...a) => JOB_MODE ? process.stderr.write(a.join(' ') + '\n') : console.log(...a);

  const url = args.find(a => !a.startsWith('--'))?.trim();
  if (!url) {
    console.error('用法: node scripts/fetch-article.mjs <URL> [--job-mode]');
    process.exit(1);
  }

  if (!url.startsWith('http')) {
    console.error('❌ URL 必须以 http:// 或 https:// 开头');
    process.exit(1);
  }

  const hostname = new URL(url).hostname;

  // 检查是否为列表页/首页
  const { isListPage, reason } = detectListPage(url);
  if (isListPage) {
    console.error(`❌ 列表页/首页拒绝采集：${reason}`);
    console.error(`   URL: ${url}`);
    console.error(`   请提供真实文章 URL（如包含文章标题/日期/slug 的路径）`);
    process.exit(1);
  }

  // 检查节流
  const { allowed, count, limit } = checkThrottle(hostname);
  if (!allowed) {
    console.error(
      `❌ 反爬限制：${hostname} 今天已采集 ${count}/${limit} 次，请明天再试`
    );
    process.exit(1);
  }

  log(`🌐 抓取: ${url}  (${hostname} 今天第 ${count + 1}/${limit} 次)`);

  const htmlContent = await fetchHtml(url);
  log(`  HTML 大小: ${htmlContent.length.toLocaleString()} chars`);

  const articleData = extractArticle(htmlContent, url);
  log(`  标题: ${articleData.title.slice(0, 60)}`);
  log(`  作者: ${articleData.author || 'N/A'}`);
  log(`  主题: ${articleData.topic}`);
  log(`  正文长度: ${articleData.content.length.toLocaleString()} chars`);

  let articleId;
  try {
    articleId = await writeArticle(articleData);
  } catch (err) {
    // 写入失败，不占 quota
    throw new Error(`写入数据库失败: ${err.message}`);
  }

  try {
    recordFetch(hostname);
  } catch (err) {
    log(`⚠ 记录节流日志失败（不影响文章保存）: ${err.message}`);
  }

  if (JOB_MODE) {
    console.log(JSON.stringify({ success: true, articleId, title: articleData.title }));
  } else {
    console.log(`\n✅ 已写入数据库，article_id = ${articleId}`);
    console.log(`   验证: http://localhost:3000/esleer/reader/${articleId}`);
  }
}

main().catch(err => {
  const JOB_MODE = process.argv.includes('--job-mode');
  if (JOB_MODE) {
    console.log(JSON.stringify({ success: false, error: err.message }));
  } else {
    console.error(`❌ 采集失败: ${err.message}`);
  }
  process.exit(1);
});
