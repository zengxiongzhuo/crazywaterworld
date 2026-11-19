// 使用隔离账号和真实浏览器核对排序、自动保存及触屏行为；禁止连接游戏。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-dispatch-order-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
process.env.CW_RESOURCE_AUTO_UPDATE = '0';
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');
const { saveStore } = await import('../src/accounts.mjs');
const { defaultSettings, saveAutomationSettings, loadAutomationSettings } = await import('../src/automation-settings.mjs');
const { GameClient } = await import('../src/client.mjs');
const { createConsole } = await import('./fixtures/console-server.mjs');
let connections = 0;
GameClient.prototype.connect = async () => { connections++; throw new Error('排序验收禁止连接游戏'); };
const accountId = 'dispatch-browser';
saveStore({ version: 1, activeId: accountId, accounts: [{
  id: accountId, label: '舰队排序验收', url: 'wss://fixture.invalid', login: {},
  automation: { enabled: false, autoStart: false, paused: true },
}] });
saveAutomationSettings(accountId, defaultSettings(), { revision: 0 });
const original = defaultSettings().fleetDispatch.priority;
const app = createConsole({ port: 0, protocol: {} });
const output = path.resolve('output/playwright');
fs.mkdirSync(output, { recursive: true });
const rootSelector = '#config-field-fleetDispatch-priority';
const rowSelector = rootSelector + ' .config-dispatch-sortable';
const handleSelector = value => rowSelector + '[data-dispatch="' + value + '"] .config-dispatch-handle';
const order = () => loadAutomationSettings(accountId).settings.fleetDispatch.priority;
const displayedOrder = page => page.locator(rowSelector).evaluateAll(rows => rows.map(row => row.dataset.dispatch));
const synced = page => page.locator('#config-state').filter({ hasText: '配置已同步' }).waitFor();
const saved = page => page.waitForResponse(response => new URL(response.url()).pathname === '/api/settings'
  && response.request().method() === 'POST');
const openConfig = async page => {
  await page.locator('#account-picker-title').filter({ hasText: '舰队排序验收' }).waitFor();
  await page.locator('#tabs [data-tab=settings]').click();
  await synced(page);
  await page.locator('[data-config-tab=world]').click();
  await page.locator('[data-config-group=fleet-dispatch]').click();
  await page.locator(rootSelector).waitFor();
};
const points = async (page, value, targetIndex, after = false) => {
  await page.locator(rootSelector).scrollIntoViewIfNeeded();
  const from = await page.locator(handleSelector(value)).boundingBox();
  const to = await page.locator(rowSelector).nth(targetIndex).boundingBox();
  assert(from && to, '起点和落位行应可见');
  return { x: from.x + from.width / 2, y: from.y + from.height / 2,
    targetY: to.y + to.height * (after ? 0.8 : 0.2) };
};
let browser;
const errors = [];
let posts = 0;
try {
  const base = await app.listen();
  const executablePath = process.env.CW_BROWSER_TEST_EXECUTABLE || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find(fs.existsSync);
  assert(executablePath, '未找到测试浏览器');
  browser = await chromium.launch({ executablePath, headless: true });
  const observe = page => {
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (new URL(request.url()).pathname === '/api/settings' && request.method() === 'POST') posts++;
    });
  };
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  observe(page); await page.goto(base); await openConfig(page);
  assert.deepEqual(await displayedOrder(page), original);
  const labels = await page.locator(rowSelector + ' .config-order-name').allTextContents();
  assert.equal(labels.length, 8); assert(labels.every(label => label.trim().length > 0));
  assert.equal(labels[6], '硅矿采集');
  assert.equal(labels[7], '资源田占领');
  assert.equal(await page.getByRole('button', { name: '资源田占领下移', exact: true }).isDisabled(), true);
  console.log('通过：默认八项完整显示，硅矿和资源田名称与无障碍按钮完整');

  const mouse = await points(page, 'silicon', 0);
  const beforeMouse = posts;
  await page.mouse.move(mouse.x, mouse.y); await page.mouse.down();
  await page.mouse.move(mouse.x, mouse.targetY, { steps: 12 });
  assert.deepEqual(order(), original, '拖动途中不提前保存');
  assert.deepEqual(await displayedOrder(page), original, '预览落点时不替换正在捕获指针的节点');
  const mouseSave = saved(page); await page.mouse.up();
  assert.equal((await mouseSave).status(), 200); await synced(page);
  const mouseOrder = ['silicon', ...original.filter(value => value !== 'silicon')];
  assert.deepEqual(order(), mouseOrder); assert.deepEqual(await displayedOrder(page), mouseOrder);
  assert.equal(posts, beforeMouse + 1, '一次落位只自动保存一次');
  await page.reload(); await openConfig(page);
  assert.deepEqual(await displayedOrder(page), mouseOrder);
  console.log('通过：鼠标从第七位拖至第一位，经HTTP自动保存且刷新保留');

  const keyboardSave = saved(page);
  await page.locator(handleSelector('silicon')).focus(); await page.keyboard.press('ArrowDown');
  assert.equal((await keyboardSave).status(), 200); await synced(page);
  assert.equal(order()[1], 'silicon');
  assert.equal(await page.locator(handleSelector('silicon')).evaluate(node => document.activeElement === node), true);
  const buttonSave = saved(page);
  await page.getByRole('button', { name: '硅矿采集下移', exact: true }).focus(); await page.keyboard.press('Enter');
  assert.equal((await buttonSave).status(), 200); await synced(page);
  assert.equal(order()[2], 'silicon');
  const restoreSave = saved(page);
  await page.getByRole('button', { name: '硅矿采集上移', exact: true }).focus(); await page.keyboard.press('Space');
  assert.equal((await restoreSave).status(), 200); await synced(page);
  assert.equal(order()[1], 'silicon');
  console.log('通过：手柄方向键及上移下移按钮支持键盘并保留焦点');

  const beforeCancel = [...order()], cancelPosts = posts;
  const cancel = await points(page, 'silicon', 6, true);
  await page.mouse.move(cancel.x, cancel.y); await page.mouse.down();
  await page.mouse.move(cancel.x, cancel.targetY, { steps: 10 });
  await page.keyboard.press('Escape'); await page.mouse.up();
  await page.waitForTimeout(750);
  assert.deepEqual(order(), beforeCancel); assert.deepEqual(await displayedOrder(page), beforeCancel);
  assert.equal(posts, cancelPosts); assert.equal(await page.locator(rowSelector + '[data-dragging]').count(), 0);
  assert.equal(await page.locator(rowSelector + '[data-drop]').count(), 0);
  await page.screenshot({ path: path.join(output, 'dispatch-order-desktop.png'), animations: 'disabled' });
  console.log('通过：Esc取消拖动不保存，也不残留落点和拖动状态');

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mobile = await context.newPage(); observe(mobile); await mobile.goto(base); await openConfig(mobile);
  const cdp = await context.newCDPSession(mobile);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ x, y, radiusX: 5, radiusY: 5 }],
  });
  const mobilePoints = await points(mobile, 'silicon', 0);
  const touchSave = saved(mobile);
  await touch('touchStart', mobilePoints.x, mobilePoints.y);
  await touch('touchMove', mobilePoints.x, mobilePoints.targetY);
  await touch('touchEnd');
  assert.equal((await touchSave).status(), 200); await synced(mobile);
  assert.equal(order()[0], 'silicon'); assert.deepEqual(await displayedOrder(mobile), order());
  const beforeTouchCancel = [...order()], touchCancelPosts = posts;
  const mobileCancel = await points(mobile, 'silicon', 2, true);
  await touch('touchStart', mobileCancel.x, mobileCancel.y);
  await touch('touchMove', mobileCancel.x, mobileCancel.targetY);
  await touch('touchCancel'); await mobile.waitForTimeout(750);
  assert.deepEqual(order(), beforeTouchCancel); assert.deepEqual(await displayedOrder(mobile), beforeTouchCancel);
  assert.equal(posts, touchCancelPosts); assert.equal(await mobile.locator(rowSelector + '[data-dragging]').count(), 0);
  console.log('通过：真实触屏指针可排序，系统取消触摸时不保存');

  for (const width of [320, 390, 768]) {
    await mobile.setViewportSize({ width, height: 844 });
    await mobile.locator(rootSelector).scrollIntoViewIfNeeded();
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, width + 'px 页面无横向溢出');
    const layout = await mobile.locator(rowSelector).evaluateAll(rows => rows.map(row => {
      const bounds = row.getBoundingClientRect();
      return [...row.children].every(child => {
        const box = child.getBoundingClientRect();
        return box.left >= bounds.left - 1 && box.right <= bounds.right + 1;
      });
    }));
    assert(layout.every(Boolean), width + 'px 每行手柄、编号、名称和按钮均在行内');
    await mobile.screenshot({ path: path.join(output, 'dispatch-order-' + width + '.png'), animations: 'disabled' });
  }
  assert.deepEqual(errors, []); assert.equal(connections, 0);
  console.log('通过：320/390/768px 无横向溢出，无脚本错误或游戏连接');
} finally {
  await browser?.close(); app.server.closeAllConnections(); await app.close();
  assert(directory.startsWith(path.join(fs.realpathSync(os.tmpdir()), 'cw-dispatch-order-')));
  fs.rmSync(directory, { recursive: true, force: true });
}
