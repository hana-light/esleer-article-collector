#!/usr/bin/env node
/**
 * ESLEER Session Cookie 获取脚本
 * 用 Playwright 打开浏览器 → 用户手动登录 → 提取 next-auth session cookie
 * 保存到 scripts/session-cookie.json
 *
 * 用法: node scripts/get-session-cookie.mjs
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { createRequire } from 'module';

// 从项目根目录解析 playwright（解决 scripts/ 目录下 node_modules 不可达问题）
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test');

const COOKIE_FILE = path.resolve(__dirname, 'session-cookie.json');
const APP_URL = 'http://localhost:3000/esleer';

// 检查已存在的 cookie（支持 __Secure-next-auth.session-token）
function loadExistingCookie() {
  if (!existsSync(COOKIE_FILE)) return null;
  try {
    const data = JSON.parse(readFileSync(COOKIE_FILE, 'utf8'));
    if (!data.cookie) return null;
    const hasSession =
      /next-auth\.session-token|__Secure-next-auth\.session-token/.test(data.cookie);
    if (hasSession) return data;
    return null;
  } catch {
    return null;
  }
}

async function main() {
  console.log('🔍 检查已有 cookie...');
  const existing = loadExistingCookie();
  if (existing) {
    console.log('✅ session-cookie.json 已存在且包含 session token，将复用');
    console.log(`   文件: ${COOKIE_FILE}`);
    console.log('   如需重新登录，请先删除该文件');
    return;
  }

  console.log('🚀 启动 Playwright 浏览器（请在打开的页面中登录）');
  console.log(`   目标: ${APP_URL}`);
  console.log('   登录后脚本将自动提取 session cookie');
  console.log('   超时: 5 分钟\n');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  // 监听新 cookie 出现
  let sessionCookie = null;
  let intervalId = null;

  const checkCookies = async () => {
    const cookies = await context.cookies();
    sessionCookie = cookies.find(
      (c) => c.name === 'next-auth.session-token' || c.name === '__Secure-next-auth.session-token'
    );
  };

  // 轮询检查（每 1 秒）
  intervalId = setInterval(async () => {
    await checkCookies();
    if (sessionCookie && sessionCookie.value) {
      clearInterval(intervalId);
    }
  }, 1000);

  // 超时 5 分钟
  const timeoutId = setTimeout(() => {
    clearInterval(intervalId);
  }, 5 * 60 * 1000);

  await page.goto(APP_URL, { waitUntil: 'networkidle' });

  // 等待 cookie 出现或超时
  await new Promise((resolve) => {
    const check = async () => {
      await checkCookies();
      if (sessionCookie && sessionCookie.value) {
        clearTimeout(timeoutId);
        resolve();
      } else {
        setTimeout(check, 1000);
      }
    };
    check();
  });

  await browser.close();

  if (!sessionCookie || !sessionCookie.value) {
    console.error('❌ 未找到 next-auth session cookie，请确认已成功登录');
    process.exit(1);
  }

  const cookieStr = `${sessionCookie.name}=${sessionCookie.value}`;
  const saved = {
    cookie: cookieStr,
    name: sessionCookie.name,
    extractedAt: new Date().toISOString(),
    expires: sessionCookie.expires
      ? new Date(sessionCookie.expires * 1000).toISOString()
      : 'session',
  };

  writeFileSync(COOKIE_FILE, JSON.stringify(saved, null, 2), 'utf8');
  console.log(`\n✅ Cookie 已保存到: ${COOKIE_FILE}`);
  console.log(`   Cookie 名: ${sessionCookie.name}`);
  console.log(`   有效期至: ${saved.expires}`);
}

main().catch((err) => {
  console.error('❌ 失败:', err.message);
  process.exit(1);
});
