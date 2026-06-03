#!/usr/bin/env node
/**
 * ESLEER 文章自动化流水线脚本
 * 触发：AI全文精读 → AI校验笔记
 *
 * 用法: node scripts/auto-process-articles.mjs [--limit N]
 *
 * 数据库: esleer-data/dev.db
 * 用户:   hiuva@outlook.com (hiuva@outlook.com)
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@libsql/client';
import { PrismaLibSQL } from '@prisma/adapter-libsql';
import { PrismaClient } from '@prisma/client';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.resolve(PROJECT_ROOT, 'esleer-data', 'dev.db');
const API_BASE = 'http://localhost:3000/esleer/api';

// ---------------------------------------------------------------------------
// DB Access
// ---------------------------------------------------------------------------

function createPrisma() {
  const libsql = createClient({ url: `file:${DB_PATH}` });
  const adapter = new PrismaLibSQL(libsql);
  return new PrismaClient({ adapter });
}

// ---------------------------------------------------------------------------
// API Call (batch-process route，服务端直调，不需要 cookie)
// ---------------------------------------------------------------------------

async function apiCall(articleId) {
  const resp = await fetch(`${API_BASE}/ai/batch-process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ articleId }),
  });
  return { status: resp.status, data: await resp.json() };
}

// ---------------------------------------------------------------------------
// Process single article
// ---------------------------------------------------------------------------

async function processArticle(prisma, article) {
  const { id: articleId, title } = article;
  console.log(`\n📄 [${articleId}] ${title?.slice(0, 60)}`);

  // 调用 batch-process route，一步完成：提取段落 → autoGenerateNotes → 写Note → verifyNotes
  console.log(`  🤖 调用 batch-process...`);
  const result = await apiCall(articleId);

  if (result.status !== 200) {
    const errMsg = result.data?.error || `HTTP ${result.status}`;
    console.log(`  ❌ batch-process 失败: ${errMsg}`);
    await prisma.article.update({
      where: { id: articleId },
      data: { aiNotesGenerationError: errMsg, updatedAt: new Date() },
    });
    return;
  }

  const { notesGenerated, verifyError } = result.data.data || {};
  if (verifyError) {
    console.log(`  ⚠️  batch-process 完成，但 verify 有误: ${verifyError}`);
    console.log(`  ✅ 笔记生成成功: ${notesGenerated} 条`);
  } else {
    console.log(`  ✅ 全部完成，笔记 ${notesGenerated} 条`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const limitArg = args.find((a) => a.startsWith('--limit='));
  const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : 3;

  console.log(`🔧 ESLEER 自动化流水线`);
  console.log(`   数据库: ${DB_PATH}`);
  console.log(`   每批处理: ${LIMIT} 篇文章\n`);

  const prisma = createPrisma();

  try {
    // Query articles: aiNotesGeneratedAt IS NULL, source IS NOT NULL, content LENGTH > 1000
    const articles = await prisma.$queryRawUnsafe(`
      SELECT id, title, content, source
      FROM Article
      WHERE "aiNotesGeneratedAt" IS NULL
        AND source IS NOT NULL
        AND source != ''
        AND LENGTH(content) > 1000
      ORDER BY id DESC
      LIMIT ${LIMIT}
    `);

    if (!articles || articles.length === 0) {
      console.log('✅ 没有待处理文章（aiNotesGeneratedAt IS NULL 且 content 长度 > 1000）');
      return;
    }

    console.log(`📋 待处理文章: ${articles.length} 篇\n`);

    for (const article of articles) {
      try {
        await processArticle(prisma, article);
      } catch (err) {
        console.error(`  ❌ 处理文章 ${article.id} 异常:`, err.message);
        try {
          await prisma.article.update({
            where: { id: article.id },
            data: {
              aiNotesGenerationError: err.message,
              updatedAt: new Date(),
            },
          });
        } catch {}
      }
    }

    console.log('\n✅ 批次完成');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('❌ 流水线失败:', err.message);
  process.exit(1);
});
