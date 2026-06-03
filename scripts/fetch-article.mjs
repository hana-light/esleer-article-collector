#!/usr/bin/env node
/**
 * ESLEER 文章采集脚本（Node.js + Prisma）
 * 用法: node scripts/fetch-article.mjs <URL>
 *
 * 数据库: esleer-data/dev.db
 * 用户:   hiuva@outlook.com (id: cmmc0w0230000j6sjggm1mlir)
 *
 * 反爬策略: 同一域名 24 小时内最多采集 3 次，超限拒绝
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync } from 'fs';
import { createClient } from '@libsql/client';
import { PrismaLibSQL } from '@prisma/adapter-libsql';
import { PrismaClient } from '@prisma/client';
import * as cheerio from 'cheerio';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.resolve(PROJECT_ROOT, 'esleer-data', 'dev.db');
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
// Prisma Client（通过 libsql adapter 直连本地 SQLite）
// ---------------------------------------------------------------------------

function createPrisma() {
  const libsql = createClient({ url: `file:${DB_PATH}` });
  const adapter = new PrismaLibSQL(libsql);
  return new PrismaClient({ adapter });
}

// ---------------------------------------------------------------------------
// 采集
// ---------------------------------------------------------------------------

async function fetchHtml(url) {
  const hostname = new URL(url).hostname;

  // 先打 elpais.com 首页建立 cookie 再采（解决 403）
  if (hostname.includes('elpais')) {
    try {
      await fetch('https://elpais.com/', {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
    } catch { /* ignore */ }
  }

  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Cache-Control': 'max-age=0',
    }
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
  }

  // 部分站点（如 elmundo.es）返回 iso-8859-15，通过 arrayBuffer + TextDecoder 统一处理
  const buf = await resp.arrayBuffer();
  const contentType = resp.headers.get('content-type') || '';
  let encoding = 'utf-8';
  if (
    contentType.includes('iso-8859-15') ||
    contentType.includes('latin1') ||
    contentType.includes('latin-1')
  ) {
    encoding = 'iso-8859-15';
  }
  return new TextDecoder(encoding).decode(buf);
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
 * 返回 { isListPage: boolean, reason: string }
 */
function detectListPage(url) {
  const parsed = new URL(url);
  const path = parsed.pathname;
  const segments = path.split('/').filter(Boolean);

  // 首页：空路径或 /
  if (!path || path === '/') {
    return { isListPage: true, reason: '首页（空路径）' };
  }

  // /index.xxx
  if (/\/index\.[a-z]+$/i.test(path)) {
    return { isListPage: true, reason: 'index 文件' };
  }

  // 模式匹配
  for (const pat of LIST_PAGE_PATTERNS) {
    if (pat.test(url)) {
      return { isListPage: true, reason: `列表页模式匹配: ${pat.toString()}` };
    }
  }

  // 辅助判断：路径段数量少且没有日期/article slug
  // 例如: /elpais/abc 可能是频道页
  // 如果只有 1-2 段且不含数字 ID / 年月日，判断为疑似列表页
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
  if (args.length < 1) {
    console.error('用法: node scripts/fetch-article.mjs <URL>');
    process.exit(1);
  }

  const url = args[0].trim();
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

  console.log(`🌐 抓取: ${url}  (${hostname} 今天第 ${count + 1}/${limit} 次)`);

  const htmlContent = await fetchHtml(url);
  console.log(`  HTML 大小: ${htmlContent.length.toLocaleString()} chars`);

  const articleData = extractArticle(htmlContent, url);
  console.log(`  标题: ${articleData.title.slice(0, 60)}`);
  console.log(`  作者: ${articleData.author || 'N/A'}`);
  console.log(`  主题: ${articleData.topic}`);
  console.log(`  正文长度: ${articleData.content.length.toLocaleString()} chars`);

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
    console.warn(`⚠ 记录节流日志失败（不影响文章保存）: ${err.message}`);
  }

  console.log(`\n✅ 已写入数据库，article_id = ${articleId}`);
  console.log(`   验证: http://localhost:3000/esleer/reader/${articleId}`);
}

main().catch(err => {
  console.error(`❌ 采集失败: ${err.message}`);
  process.exit(1);
});
