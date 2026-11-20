import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const temporaryRoot = fs.realpathSync(os.tmpdir());
const directory = fs.mkdtempSync(path.join(temporaryRoot, 'cw-console-auth-browser-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');
const { GameClient } = await import('../src/client.mjs');
let connections = 0;
GameClient.prototype.connect = async () => { connections++; throw Error('浏览器验收禁止连接游戏'); };
const { saveStore } = await import('../src/accounts.mjs');
saveStore({ activeId: null, accounts: [] });
const { createConsole } = await import('../src/server.mjs');
const app = createConsole({ port: 0, protocol: {} });
const output = path.resolve('output/console-auth');
fs.mkdirSync(output, { recursive: true });
let browser, passed = 0;
const errors = [], dialogs = [];
async function test(name, work) { await work(); passed++; console.log('通过：' + name); }
try {
  const base = await app.listen();
  const executablePath = [process.env.CW_BROWSER_TEST_EXECUTABLE, chromium.executablePath(),
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
    .find(file => file && fs.existsSync(file));
  assert(executablePath, '未找到浏览器，可设置 CW_BROWSER_TEST_EXECUTABLE');
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 850 } });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { dialogs.push(dialog.type()); void dialog.dismiss(); });
  const signIn = async () => {
    await page.locator('#console-password').fill('123456');
    await page.locator('#console-login-submit').click();
    await page.waitForURL(base + '/');
    await page.locator('#console-logout').waitFor();
  };
  await test('未登录打开控制台跳转密码页，错误反馈可见且密码清空', async () => {
    await page.goto(base);
    assert.equal(page.url(), base + '/login');
    await page.locator('#console-password').fill('wrong');
    await page.locator('#console-login-submit').click();
    await page.locator('#console-login-error').waitFor({ state: 'visible' });
    assert.match(await page.locator('#console-login-error').textContent(), /密码错误/);
    assert.equal(await page.locator('#console-password').inputValue(), '');
    await page.locator('#console-password').fill('a');
    assert.equal(await page.locator('#console-login-error').isVisible(), false);
    await page.locator('#console-password').fill('');
    await page.screenshot({ path: path.join(output, 'login-desktop.png') });
  });
  await test('正确密码进入界面，刷新保持登录，会话不暴露给页面脚本', async () => {
    await signIn();
    const session = (await context.cookies()).find(cookie => cookie.name === 'cw_console_session');
    assert(session?.httpOnly); assert.equal(session.sameSite, 'Strict');
    assert.equal(await page.evaluate(() => document.cookie.includes('cw_console_session')), false);
    await page.reload(); await page.locator('#console-logout').waitFor(); assert.equal(page.url(), base + '/');
  });
  await test('退出使同一会话的其他页同步回到密码页，接口也被拦截', async () => {
    const second = await context.newPage();
    await second.goto(base); await second.locator('#console-logout').waitFor();
    await page.locator('#console-logout').click();
    await page.waitForURL(base + '/login'); await second.waitForURL(base + '/login');
    assert.equal((await context.request.get(base + '/api/accounts')).status(), 401);
    await second.close();
  });
  await test('401在配置保存中也能直接返回登录页，临时断网保持当前页面', async () => {
    await signIn();
    await context.setOffline(true); await page.waitForTimeout(100); assert.equal(page.url(), base + '/');
    await context.setOffline(false);
    await page.evaluate(() => { configEditor.saving = true; });
    await context.clearCookies();
    await Promise.all([page.waitForURL(base + '/login'), page.evaluate(async () => { try { await window.call('/api/accounts'); } catch {} })]);
    assert.deepEqual(dialogs, []);
  });
  await test('手机深色登录页没有横向溢出，键盘可提交', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => localStorage.setItem('cw-theme', 'dark')); await page.reload();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(output, 'login-mobile-dark.png') });
    await page.locator('#console-password').fill('123456'); await page.locator('#console-password').press('Enter');
    await page.waitForURL(base + '/'); await page.locator('#console-logout').waitFor();
  });
  assert.deepEqual(errors, []); assert.equal(connections, 0);
  console.log(`控制台密码页浏览器验收 ${passed}/${passed} 通过（零游戏连接）`);
} finally {
  await browser?.close(); app.server.closeAllConnections(); await app.close();
  assert.equal(path.dirname(path.resolve(directory)), temporaryRoot);
  fs.rmSync(directory, { recursive: true, force: true });
}
