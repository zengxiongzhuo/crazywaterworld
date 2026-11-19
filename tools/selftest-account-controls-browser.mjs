// 真实页面与 HTTP 启停链路，使用临时账号和假客户端，绝不连接游戏。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const temporaryRoot = fs.realpathSync(os.tmpdir());
const directory = fs.mkdtempSync(path.join(temporaryRoot, 'cw-account-controls-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
process.env.CW_RESOURCE_DIR = path.join(directory, 'resources');
process.env.CW_RESOURCE_AUTO_UPDATE = '0';
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');
const { accountFromCredential, saveStore, loadStore } = await import('../src/accounts.mjs');
const { saveAutomationSettings, settingsFromNative } = await import('../src/automation-settings.mjs');
const { automationTasks } = await import('../src/automation.mjs');
const { GameClient } = await import('../src/client.mjs');
const { createConsole } = await import('./fixtures/console-server.mjs');
const rows = ['first', 'second'].map((id, index) => ({
  ...accountFromCredential({ url: 'wss://fixture.invalid', source: 'mitm',
    login: { eworldParams: { openId: id } } }, { label: index ? '第二个验收账号' : '当前验收账号' }),
  lastSeen: { nickname: index ? '星海船长' : '海风船长', level: 5, worldId: 9001, worldName: '验收1服' },
}));
saveStore({ version: 1, activeId: rows[0].id, accounts: rows });
const tasks = Object.fromEntries(automationTasks.map(task => [task.key, task.key === 'mail']));
for (const row of rows) saveAutomationSettings(row.id, settingsFromNative(tasks, { everySeconds: 3600 }), { revision: 0 });
const live = new Set();
const logins = [];
let mailReads = 0;
Object.defineProperty(GameClient.prototype, 'connected', { get() { return live.has(this); } });
GameClient.prototype.connect = async function (login) {
  const index = rows.findIndex(row => row.id === login.eworldParams.openId);
  assert.ok(index >= 0, '只能连接隔离测试账号');
  logins.push(rows[index].id);
  live.add(this);
  return { result: 0, playerInfo: { playerId: index + 1, worldId: 9001, level: 5, nickname: rows[index].lastSeen.nickname } };
};
GameClient.prototype.request = async name => {
  if (name === 'EmailBoxRequest') { mailReads++; return { email: [] }; }
  return name === 'OnWaterRequest' ? { building: [] } : name === 'AllItemRequest' ? { items: [] } : {};
};
GameClient.prototype.send = () => {};
GameClient.prototype.sendWatch = async () => ({});
GameClient.prototype.stop = function () { live.delete(this); };
const protocol = Object.fromEntries(['OnWaterRequest', 'OnWaterResponse', 'AllItemRequest', 'AllItemResponse'].map(name => [name, true]));
const app = createConsole({ port: 0, protocol });
const output = path.resolve('output/account-controls');
fs.mkdirSync(output, { recursive: true });
let browser;
const errors = [];
try {
  const root = await app.listen();
  assert.deepEqual(logins, [], '新账号启动控制台不连接挂机');
  const executablePath = [process.env.CW_BROWSER_TEST_EXECUTABLE, chromium.executablePath(),
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(file => file && fs.existsSync(file));
  assert.ok(executablePath, '未找到验收浏览器');
  browser = await chromium.launch({ executablePath, headless: true });
  for (const width of [1280, 360, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 768, hasTouch: width < 768 });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(10000);
    await page.goto(root);
    await page.locator('#account-picker-title').filter({ hasText: '当前验收账号' }).waitFor();
    await page.locator('#tabs [data-tab="account"]').click();
    const cards = page.locator('#accounts .account-card');
    const first = cards.nth(0).locator('[data-account-action="loop"]');
    const second = cards.nth(1).locator('[data-account-action="loop"]');
    async function checkStatus(index, expected) {
      await page.locator('#account-picker-trigger').click();
      await page.waitForFunction(({ index, expected }) => {
        const card = document.querySelectorAll('#accounts .account-card')[index];
        const option = document.querySelectorAll('#account-picker-list [role="option"]')[index];
        return card?.querySelector('[data-account-field="status"]').textContent === expected
          && option?.querySelector('[data-picker-field="status"]').textContent === expected
          && (index !== 0 || document.querySelector('#account-picker-status').textContent === expected);
      }, { index, expected });
      await page.locator('#account-picker-trigger').click();
    }
    await second.filter({ hasText: '开始挂机' }).waitFor();
    assert.equal(loadStore().activeId, 'first');
    assert.equal(app.sessions.get('first')?.loop.running ?? false, false);
    assert.equal(app.sessions.get('second')?.loop.running ?? false, false);
    if (width === 1280) assert.equal(mailReads, 0, '打开页面读取资料不会执行挂机任务');

    // No render function is called: a store update must reach all DOM consumers.
    await page.locator('#account-picker-trigger').click();
    const storeViews = await page.evaluate(async () => {
      const { actions, accountsById } = window.cwConsoleStore.getState();
      const original = accountsById.first.status;
      const views = [];
      try {
        for (const looping of [true, false]) {
          actions.patchStatus('first', { connected: true, looping, loopStopping: false });
          // The DOM subscription paints in a microtask. Inspect before the next
          // server poll can correctly replace this synthetic test status.
          await Promise.resolve();
          views.push([
            document.querySelector('#account-picker-status').textContent,
            document.querySelector('#account-picker-list [data-picker-field="status"]').textContent,
            document.querySelector('#accounts [data-account-field="status"]').textContent,
            document.querySelector('#loop-toggle').textContent,
          ]);
        }
      } finally {
        actions.setStatus('first', original);
      }
      return views;
    });
    assert.deepEqual(storeViews, [
      ['挂机中', '挂机中', '挂机中', '暂停挂机'],
      ['已连接 · 未挂机', '已连接 · 未挂机', '已连接 · 未挂机', '开始挂机'],
    ]);
    await page.locator('#account-picker-trigger').click();

    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let requests = 0;
    await page.route('**/api/accounts/pause?account=second', async route => {
      requests++;
      await gate;
      await route.continue();
    });
    await second.click();
    await second.filter({ hasText: '处理中…' }).waitFor();
    assert.equal(await second.isDisabled(), true);
    await second.evaluate(button => button.click());
    release();
    await second.filter({ hasText: '暂停挂机' }).waitFor();
    assert.equal(requests, 1, '重复点击不会提交多次开始');
    assert.equal(loadStore().activeId, 'first', '开始非当前账号不改变选中账号');
    assert.equal(app.sessions.get('second').loop.running, true);
    assert.equal(app.sessions.get('first')?.loop.running ?? false, false);
    assert.equal(loadStore().accounts[1].automation.autoStart, true);
    assert.match(await page.locator('#account-picker-title').textContent(), /当前验收账号/);
    assert.equal(await page.locator('#loop-toggle').textContent(), '开始挂机');
    await checkStatus(0, '已连接 · 未挂机');
    await checkStatus(1, '挂机中');
    await page.unroute('**/api/accounts/pause?account=second');

    await cards.nth(0).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, 'accounts-' + width + '.png'), fullPage: true, animations: 'disabled' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, '页面无横向溢出');
    for (const card of await cards.all()) {
      const layout = await card.locator('.account-card-actions').evaluate(actions => {
        const box = actions.getBoundingClientRect();
        return [...actions.children].map(button => {
          const rect = button.getBoundingClientRect();
          return { top: rect.top, fits: rect.left >= box.left - 1 && rect.right <= box.right + 1,
            textFits: button.scrollWidth <= button.clientWidth && button.scrollHeight <= button.clientHeight };
        });
      });
      assert.ok(layout.every(button => button.fits && button.textFits), width + 'px按钮及文字完整可见');
      assert.ok(layout.every(button => Math.abs(button.top - layout[0].top) < 1), width + 'px卡片按钮保持单行');
    }

    await second.click();
    await second.filter({ hasText: '开始挂机' }).waitFor();
    assert.equal(app.sessions.get('second').loop.running, false);
    assert.equal(app.sessions.get('second').client.connected, true, '暂停挂机保留连接');
    assert.equal(loadStore().accounts[1].automation.autoStart, false);
    await checkStatus(1, '已连接 · 未挂机');
    await first.click();
    await first.filter({ hasText: '暂停挂机' }).waitFor();
    assert.equal(await page.locator('#loop-toggle').textContent(), '暂停挂机');
    await checkStatus(0, '挂机中');
    if (width === 1280) {
      await page.locator('#account-picker-trigger').click();
      await page.screenshot({ path: path.join(output, 'account-status-consistency.png'), fullPage: true, animations: 'disabled' });
      await page.locator('#account-picker-trigger').click();
    }
    await first.click();
    await first.filter({ hasText: '开始挂机' }).waitFor();
    assert.equal(loadStore().accounts[0].automation.autoStart, false);
    await checkStatus(0, '已连接 · 未挂机');
    await page.reload();
    await page.locator('#tabs [data-tab="account"]').click();
    await first.filter({ hasText: '开始挂机' }).waitFor();
    assert.equal(app.sessions.get('first').loop.running, false, '刷新不重启已暂停的挂机');
    console.log('通过：' + width + 'px账号启停、单行按钮、请求锁及当前账号隔离');
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('账号启停浏览器验收通过，截图目录 ' + output);
} finally {
  if (browser) await browser.close();
  const jobs = [...app.sessions.values()].map(session => session.loop.job);
  app.server.closeAllConnections();
  await app.close();
  await Promise.allSettled(jobs);
  assert.equal(path.dirname(directory), temporaryRoot);
  fs.rmSync(directory, { recursive: true, force: true });
}
