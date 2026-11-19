// 使用隔离账号和真实网页验证日志筛选；不连接游戏、不读取用户账号。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-log-filters-browser-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
process.env.CW_RESOURCE_AUTO_UPDATE = '0';
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');
const { saveStore, loadStore } = await import('../src/accounts.mjs');
const { GameClient } = await import('../src/client.mjs');
const { createConsole } = await import('./fixtures/console-server.mjs');
let connections = 0;
GameClient.prototype.connect = async () => { connections++; throw new Error('日志验收禁止连接游戏'); };
const longTitle = '远航舰队的超长账号备注 · 第一海域与基地生产测试';
saveStore({ version: 1, activeId: 'logs-a', accounts: ['logs-a', 'logs-b'].map((id, index) => ({
  id, label: index ? '远航舰队' : longTitle, url: 'wss://fixture.invalid', login: {},
  automation: { enabled: false, autoStart: false, paused: true },
})) });
const app = createConsole({ port: 0, protocol: {} });
const output = path.resolve('output/log-filters'); fs.mkdirSync(output, { recursive: true });
let browser;
const errors = [];
const streams = new Set();
app.server.on('request', (request, response) => { if (request.url.startsWith('/api/events')) streams.add(response); });
async function checkTagStrip(page, id, expectOverflow = false) {
  const layout = await page.locator('#' + id).evaluate(node => {
    const bounds = node.getBoundingClientRect(), first = node.firstElementChild.getBoundingClientRect();
    return { height: bounds.height, singleRow: [...node.children].every(tag => Math.abs(tag.getBoundingClientRect().top - first.top) <= 1), scrolls: node.scrollWidth > node.clientWidth, verticalOverflow: node.scrollHeight > node.clientHeight };
  });
  assert(layout.singleRow && layout.height <= 52 && !layout.verticalOverflow, id + ': ' + JSON.stringify(layout));
  if (expectOverflow) assert(layout.scrolls, id + '应允许横向滚动');
  return layout;
}
async function checkSelectedTagVisible(page, id) {
  const layout = await page.locator('#' + id).evaluate(node => {
    const bounds = node.getBoundingClientRect(), selected = node.querySelector('[aria-selected=true], [aria-pressed=true]').getBoundingClientRect();
    return { visible: selected.left >= bounds.left && selected.right <= bounds.right, left: bounds.left, right: bounds.right, selectedLeft: selected.left, selectedRight: selected.right, scrollLeft: node.scrollLeft, scrollWidth: node.scrollWidth };
  });
  assert(layout.visible, id + '选中的Tag应完整滚入可见区域：' + JSON.stringify(layout));
}
async function swipeTagStrip(page, id) {
  const bounds = await page.locator('#' + id).boundingBox();
  const session = await page.context().newCDPSession(page);
  const y = bounds.y + 16, start = bounds.x + bounds.width - 18, distance = bounds.width - 36;
  try {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: start, y, id: 0 }] });
    for (let step = 1; step <= 8; step++) await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start - distance * step / 8, y, id: 0 }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForFunction(id => document.getElementById(id).scrollLeft > 0, id);
  } finally { await session.detach(); }
}
try {
  const base = await app.listen();
  const executablePath = process.env.CW_BROWSER_TEST_EXECUTABLE || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find(fs.existsSync);
  assert(executablePath, '未找到测试浏览器');
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.locator('#account-picker-title').filter({ hasText: longTitle }).waitFor();
  const a = app.sessions.get('logs-a'), b = app.sessions.get('logs-b');
  app.emit(a, 'info', '工厂完成木板生产', { category: 'production' });
  app.emit(b, 'warn', '城战舰队等待维修', { category: 'alliance' });
  app.emit(null, 'info', '系统资源检查完成');
  await page.locator('#logs-open').click();
  await page.locator('#log .row').filter({ hasText: '城战舰队等待维修' }).waitFor();
  assert.equal(await page.locator('#log-account-tabs [aria-pressed=true]').getAttribute('data-log-account'), 'all');
  assert.deepEqual(await page.locator('#log-account-tabs [data-log-account]').evaluateAll(nodes => nodes.map(node => node.dataset.logAccount)), ['all', 'logs-a', 'logs-b']);
  assert.equal(await page.locator('#journal select, #log-account, #log-category').count(), 0, '分类和账号统一使用Tag，不再保留下拉筛选');
  assert.equal(await page.locator('#log-account-tabs [data-log-account="logs-a"]').getAttribute('title'), longTitle);
  assert.equal(await page.locator('#journal a[href*="github.com"]').count(), 0);
  assert(await page.locator('#log-clear').isDisabled());
  assert.equal(await page.locator('#log .row').filter({ hasText: '工厂完成木板生产' }).locator('.log-account').textContent(), longTitle);
  assert.equal(await page.locator('#log .row').filter({ hasText: '城战舰队等待维修' }).locator('.log-account').textContent(), '远航舰队');
  assert.doesNotMatch(await page.locator('#journal').textContent(), /logs-a|logs-b/, '内部ID不占用页面空间');
  assert.match(await page.locator('#log [data-account=logs-a] .log-account').getAttribute('title'), /logs-a/);
  assert.equal(await page.locator('#log [data-account=logs-a] .log-category-tag').getAttribute('data-tone'), 'green');
  assert.equal(await page.locator('#log [data-account=logs-b] .log-category-tag').getAttribute('data-tone'), 'blue');
  assert.equal(await page.locator('#log [data-account=logs-b] .log-level-tag').getAttribute('data-tone'), 'warning');
  await page.locator('#log [data-account=logs-b] .log-account').click();
  assert.equal(await page.locator('#log-account-tabs [aria-pressed=true]').getAttribute('data-log-account'), 'logs-b');
  assert.equal(await page.locator('#log .row:visible').count(), 1);
  await page.locator('#log-account-tabs [data-log-account="all"]').click();
  await page.locator('#log-tabs [data-log-group="基地与资源"]').click();
  assert.equal(await page.locator('#log .row:visible').count(), 1);
  assert.match(await page.locator('#log .row:visible').textContent(), /木板生产/);
  assert.deepEqual(await page.locator('#log-account-tabs [data-log-account-count]').allTextContents(), ['1', '1', '0'], '账号计数跟随分类筛选');
  await page.locator('#log-issues').click();
  assert(await page.locator('#log-empty').isVisible());
  await page.locator('#log-tabs [data-log-group="世界与联盟"]').click();
  assert.equal(await page.locator('#log .row:visible').count(), 1);
  await page.locator('#log-account-tabs [data-log-account="logs-a"]').click();
  assert(await page.locator('#log-empty').isVisible());
  assert.equal(await page.locator('#log-tabs [data-log-group="世界与联盟"] [data-log-group-count]').textContent(), '0', '分类计数跟随账号和等级筛选');
  assert.deepEqual(await page.locator('#log-account-tabs [data-log-account-count]').allTextContents(), ['1', '0', '1'], '未选中账号仍显示当前分类与等级下的计数');
  await page.locator('#log-account-tabs [data-log-account="logs-b"]').click();
  assert.equal(await page.locator('#log .row:visible').count(), 1);
  await page.locator('#log-tabs [data-log-group="基地与资源"]').click();
  assert.equal(await page.locator('#log-tabs [aria-selected=true]').getAttribute('data-log-group'), '基地与资源');
  await page.locator('#log-tabs [data-log-group=all]').click();
  await page.locator('#log-all').click();
  await page.locator('#log-account-tabs [data-log-account="all"]').click();
  await page.locator('#log-tabs [data-log-group="系统"]').click();
  assert(await page.locator('#log .row:visible').count() > 0);
  assert.equal(await page.locator('#log .log-system-tag').first().evaluate(node => node.tagName), 'SPAN');
  await page.locator('#log .log-system-tag').first().click();
  assert.equal(await page.locator('#log-account-tabs [aria-pressed=true]').getAttribute('data-log-account'), 'all', '系统标签不再创建虚拟账号筛选');
  assert.equal(await page.locator('#log-account-tabs [data-log-account=system]').count(), 0);
  console.log('通过：分类与账号Tag、等级组合筛选，账号与分类标识清晰显示');

  await page.locator('#log-account-tabs [data-log-account="all"]').click();
  await page.locator('#log-tabs [data-log-group=all]').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#log-tabs [aria-selected=true]').getAttribute('data-log-group'), '系统');
  await page.keyboard.press('End');
  assert.equal(await page.locator('#log-tabs [aria-selected=true]').getAttribute('data-log-group'), '日常与活动');
  await page.keyboard.press('Home');
  await page.locator('#log-account-tabs [data-log-account="all"]').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#log-account-tabs [aria-pressed=true]').getAttribute('data-log-account'), 'logs-a');
  await page.keyboard.press('End');
  assert.equal(await page.locator('#log-account-tabs [aria-pressed=true]').getAttribute('data-log-account'), 'logs-b');
  await page.keyboard.press('ArrowLeft');
  const focusedAccount = await page.locator('#log-account-tabs [data-log-account="logs-a"]').elementHandle();
  app.emit(a, 'info', '标签更新验证', { category: 'daily' });
  await page.locator('#log .row').filter({ hasText: '标签更新验证' }).waitFor();
  assert(await focusedAccount.evaluate(node => node.isConnected && node === document.activeElement), '实时日志更新保留账号Tag节点与键盘焦点');
  await focusedAccount.dispose();
  await page.keyboard.press('Home');
  assert.equal(await page.locator('#log-account-tabs [aria-pressed=true]').getAttribute('data-log-account'), 'all');
  await page.locator('#logs-close').click();
  const subscriptions = streams.size;
  await page.evaluate(() => selectLoadedAccount('logs-b'));
  await page.locator('#logs-open').click();
  assert.equal(streams.size, subscriptions, '顶部切号不创建重复订阅');
  assert.equal(await page.locator('#log-account-tabs [aria-pressed=true]').getAttribute('data-log-account'), 'all');
  assert.equal(await page.locator('#log .row').filter({ hasText: '工厂完成木板生产' }).count(), 1);
  console.log('通过：页签支持方向键与首尾导航，顶部切号保留日志和独立筛选');

  const batch = { batch: 'same-batch', factory: '木材厂', product: '木板', category: 'production' };
  app.emit(a, 'info', '甲排产', batch); app.emit(b, 'info', '乙排产', batch);
  app.emit(a, 'info', '甲等待', { waitKey: 'same-wait', category: 'production' });
  app.emit(b, 'info', '乙等待', { waitKey: 'same-wait', category: 'production' });
  app.emit(a, 'warn', '甲等待错误', { waitKey: 'same-wait', category: 'production' });
  app.emit(a, 'info', '甲等待再次检查', { waitKey: 'same-wait', category: 'production' });
  await page.locator('#log .row').filter({ hasText: '甲等待再次检查' }).waitFor();
  assert.equal(await page.locator('#log [data-batch=same-batch]').count(), 2);
  assert.equal(await page.locator('#log [data-wait-key=same-wait]').count(), 3);
  assert.match(await page.locator('#log [data-account=logs-a][data-wait-key=same-wait].info .log-message').textContent(), /累计 2 次/);
  assert.match(await page.locator('#log [data-account=logs-b][data-wait-key=same-wait] .log-message').textContent(), /乙等待/);
  console.log('通过：同名排产与等待日志按账号和等级隔离合并');

  await page.route('**/api/log-fixture-error*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '测试账号请求失败' }) }));
  await page.evaluate(() => call('/api/log-fixture-error?account=logs-a').catch(() => {}));
  assert.equal(await page.locator('#log .row').filter({ hasText: '测试账号请求失败' }).count(), 1);
  assert.equal(await page.locator('#log .row').filter({ hasText: '测试账号请求失败' }).getAttribute('data-account'), 'logs-a');
  assert.equal(await page.evaluate(() => current), 'logs-b');
  await page.unroute('**/api/log-fixture-error*');
  const identities = await page.evaluate(() => {
    accounts.push({ id: 'same-prefix-a', label: '同名账号' }, { id: 'same-prefix-b', label: '同名账号' });
    const labels = ['same-prefix-a', 'same-prefix-b'].map(logAccountLabel);
    accounts.splice(-2); return labels;
  });
  assert.notEqual(...identities);
  assert.deepEqual(identities, ['同名账号（1）', '同名账号（2）']);
  console.log('通过：跨账号请求错误归属明确，同名且编号前缀相同的账号仍可区分');

  await page.locator('#log-account-tabs [data-log-account="logs-a"]').click();
  await page.locator('#log-clear').click();
  await page.waitForFunction(() => !document.querySelector('#log [data-account="logs-a"]'));
  assert.equal(a.log.length, 0);
  assert(b.log.length > 0);
  assert.equal(await page.evaluate(() => current), 'logs-b', '日志筛选不切换正在操作的账号');
  await page.locator('#log-account-tabs [data-log-account="all"]').click();
  assert(await page.locator('#log [data-account=logs-b]').count() > 0);
  assert(await page.locator('#log .row').filter({ hasText: '系统资源检查完成' }).isVisible());
  app.emit(a, 'info', '清空后重新生产', { category: 'production' });
  await page.locator('#log .row').filter({ hasText: '清空后重新生产' }).waitFor();
  await page.evaluate(() => appendLog({ id: 1, t: 1, account: 'logs-a', level: 'info', message: '已清空迟到日志' }));
  assert.equal(await page.getByText('已清空迟到日志', { exact: true }).count(), 0);
  console.log('通过：清空使用筛选账号，保留其他账号及系统日志，并拒绝迟到旧记录');

  const store = loadStore(); store.accounts[0].label = '已修改的账号备注'; saveStore(store);
  await page.locator('#logs-close').click(); await page.evaluate(() => loadAccounts(false));
  await page.locator('#logs-open').click();
  assert.match(await page.locator('#log [data-account=logs-a] .log-account').textContent(), /已修改的账号备注/);
  assert.equal(await page.locator('#log-account-tabs [data-log-account="logs-a"] [data-log-account-name]').textContent(), '已修改的账号备注');
  const xss = app.emit(a, 'info', '<img src=x onerror=alert(1)>', { category: 'production' });
  await page.locator('#log .log-message').filter({ hasText: xss.message }).waitFor();
  assert.equal(await page.locator('#log img').count(), 0);
  // 多窗口：清空推送到全部账号视图，断线后的重放不复活旧记录。
  const second = await browser.newPage(); await second.goto(base);
  await second.locator('#account-picker-title').filter({ hasText: '已修改的账号备注' }).waitFor();
  await second.locator('#logs-open').click();
  await second.locator('#log-account-tabs [data-log-account="logs-b"]').click();
  await second.locator('#log-clear').click();
  await page.waitForFunction(() => !document.querySelector('#log [data-account="logs-b"]'));
  for (const response of streams) response.destroy();
  app.emit(b, 'info', '重连后收到乙账号新日志', { category: 'alliance' });
  await page.locator('#log .log-message').filter({ hasText: '重连后收到乙账号新日志' }).waitFor();
  assert.equal(await page.locator('#log .log-message').filter({ hasText: '城战舰队等待维修' }).count(), 0);
  await second.close();
  console.log('通过：备注刷新、文本安全渲染、多窗口清空与SSE重连回放');

  await page.evaluate(() => {
    const now = Date.now();
    for (let index = 0; index < 450; index++) appendLog({ id: 10000 + index, t: now + index, account: index % 2 ? 'logs-a' : 'logs-b', category: 'production', level: 'info', message: '缓存容量检查' + index });
  });
  assert.equal(await page.locator('#log .row').count(), 400);
  assert.equal(await page.locator('#log-top-count').textContent(), '400');
  await page.locator('#log-account-tabs [data-log-account="logs-a"]').click();
  assert.equal(await page.locator('#log .row:visible').count(), 200);
  assert.equal(await page.locator('#log-count').textContent(), '200');
  const scrolled = await page.evaluate(() => {
    logEl.scrollTop = 1000;
    const row = [...logEl.children].find(item => !item.hidden && item.getBoundingClientRect().bottom > logEl.getBoundingClientRect().top);
    const before = row.getBoundingClientRect().top;
    appendLog({ id: 10500, t: Date.now() + 1000, account: 'logs-a', category: 'production', level: 'info', message: '浏览历史期间的新记录' });
    return Math.abs(row.getBoundingClientRect().top - before);
  });
  assert(scrolled <= 1, '新日志不应打断正在查看的历史位置');
  await page.locator('#log-account-tabs [data-log-account="all"]').click();
  await page.evaluate(() => { seen.clear(); clear(logEl); updateLogSummary(); });
  app.emit(a, 'info', '工厂完成木板生产', { category: 'production' });
  app.emit(b, 'warn', '城战舰队等待维修', { category: 'alliance' });
  app.emit(null, 'info', '系统资源检查完成');
  const renamed = loadStore(); renamed.accounts[0].label = longTitle; saveStore(renamed);
  app.emit(b, 'info', '英雄招募完成', { category: 'heroes' });
  app.emit(b, 'error', '领取奖励失败，请稍后重试', { category: 'daily' });
  await page.locator('#logs-close').click(); await page.evaluate(() => loadAccounts(false));
  await page.locator('#logs-open').click();
  await page.locator('#log .row').filter({ hasText: '系统资源检查完成' }).waitFor();
  assert.equal(await page.locator('#log .row').filter({ hasText: '英雄招募完成' }).locator('.log-category-tag').getAttribute('data-tone'), 'purple');
  assert.equal(await page.locator('#log .row').filter({ hasText: '领取奖励失败' }).locator('.log-level-tag').getAttribute('data-tone'), 'error');
  console.log('通过：列表与计数上限400条，账号计数正确，新日志保持历史滚动位置');

  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: width > 768 ? 1000 : 844 });
    await page.screenshot({ path: path.join(output, 'logs-' + width + '.png'), animations: 'disabled' });
    const layout = await page.evaluate(() => {
      const rect = id => { const r = document.getElementById(id).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height }; };
      return { dialog: rect('journal-dialog'), log: rect('log'), groups: rect('log-tabs'), account: rect('log-account-tabs'), issues: rect('log-issues'), clear: rect('log-clear'), width: innerWidth, height: innerHeight };
    });
    assert(layout.dialog.left >= -1 && layout.dialog.right <= layout.width + 1, JSON.stringify(layout));
    assert(layout.account.right <= layout.dialog.right && layout.clear.right <= layout.dialog.right, JSON.stringify(layout));
    assert(layout.log.height >= 100 && layout.log.bottom <= layout.height + 1, JSON.stringify(layout));
    assert(Math.abs((layout.clear.top + layout.clear.bottom) / 2 - (layout.issues.top + layout.issues.bottom) / 2) <= 1, '清空按钮与等级筛选保持同一行');
    assert(layout.account.top >= layout.groups.bottom && layout.account.bottom <= layout.clear.top, '账号Tag独立一排，位于分类和操作栏之间');
    assert.equal(await page.locator('#log').evaluate(node => node.scrollWidth > node.clientWidth), false, '长账号名称和日志不能横向溢出');
    const compact = await page.locator('#log .log-account-name').evaluateAll(nodes => nodes.every(node => getComputedStyle(node).whiteSpace === 'nowrap' && getComputedStyle(node).textOverflow === 'ellipsis'));
    assert(compact, '长账号名应单行省略，完整名称可从提示读取');
    await checkTagStrip(page, 'log-tabs', width < 768);
    await checkTagStrip(page, 'log-account-tabs', width === 320);
    const accountTag = await page.locator('#log-account-tabs [data-log-account="logs-a"] [data-log-account-name]').evaluate(node => ({ clipped: node.scrollWidth > node.clientWidth, ellipsis: getComputedStyle(node).textOverflow }));
    assert(accountTag.clipped && accountTag.ellipsis === 'ellipsis', '筛选Tag的长账号名单行省略');
  }
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.screenshot({ path: path.join(output, 'logs-dark.png'), animations: 'disabled' });
  const touch = await browser.newPage({ viewport: { width: 320, height: 740 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  touch.on('pageerror', error => errors.push(error.message));
  await touch.goto(base); await touch.locator('#logs-open').click();
  await touch.locator('#log .row').filter({ hasText: '领取奖励失败' }).waitFor();
  await touch.screenshot({ path: path.join(output, 'logs-touch-320.png'), animations: 'disabled' });
  const touchLayout = await touch.evaluate(() => {
    const log = $('log').getBoundingClientRect(), actions = document.querySelector('.log-actions').getBoundingClientRect();
    const clear = $('log-clear').getBoundingClientRect(), issues = $('log-issues').getBoundingClientRect();
    return { logBottom: log.bottom, logHeight: log.height, right: actions.right, width: innerWidth, height: innerHeight, sameRow: Math.abs((clear.top + clear.bottom - issues.top - issues.bottom) / 2) <= 1 };
  });
  await checkTagStrip(touch, 'log-tabs', true);
  const accountStrip = await checkTagStrip(touch, 'log-account-tabs', true);
  assert(touchLayout.right <= touchLayout.width, JSON.stringify(touchLayout));
  assert(touchLayout.logHeight >= 400 && touchLayout.logBottom <= touchLayout.height, JSON.stringify(touchLayout));
  assert(touchLayout.sameRow, '触屏清空按钮不独占一行');
  await swipeTagStrip(touch, 'log-tabs');
  await swipeTagStrip(touch, 'log-account-tabs');
  assert.equal(await touch.locator('#log-tabs [aria-selected=true]').getAttribute('data-log-group'), 'all', '滑动分类不会误触筛选');
  assert.equal(await touch.locator('#log-account-tabs [aria-pressed=true]').getAttribute('data-log-account'), 'all', '滑动账号不会误触筛选');
  await touch.locator('#log-tabs [data-log-group="日常与活动"]').click();
  assert.equal(await touch.locator('#log .row:visible').count(), 2);
  await checkSelectedTagVisible(touch, 'log-tabs');
  const manyAccounts = loadStore();
  manyAccounts.accounts.push(...Array.from({ length: 10 }, (_, index) => ({
    id: 'extra-' + index, label: '多账号测试的长备注 · 舰队 ' + (index + 1), url: 'wss://fixture.invalid', login: {},
    automation: { enabled: false, autoStart: false, paused: true },
  })));
  saveStore(manyAccounts);
  await touch.evaluate(() => loadAccounts(false));
  await touch.locator('#log-tabs [data-log-group=all]').click();
  await touch.locator('#log-account-tabs [data-log-account="extra-9"]').waitFor({ state: 'attached' });
  assert.equal(await touch.locator('#log-account-tabs [data-log-account]').count(), 13);
  await touch.screenshot({ path: path.join(output, 'logs-many-accounts-320.png'), animations: 'disabled' });
  const manyLayout = await touch.evaluate(() => {
    const account = $('log-account-tabs'), log = $('log').getBoundingClientRect();
    return { accountHeight: account.getBoundingClientRect().height, logHeight: log.height, logBottom: log.bottom, height: innerHeight };
  });
  await checkTagStrip(touch, 'log-account-tabs', true);
  assert.equal(manyLayout.accountHeight, accountStrip.height, '增加账号不增加筛选区高度');
  assert(manyLayout.logHeight >= 400 && manyLayout.logBottom <= manyLayout.height, JSON.stringify(manyLayout));
  await touch.locator('#log-account-tabs [data-log-account="all"]').focus();
  await touch.keyboard.press('End');
  assert.equal(await touch.locator('#log-account-tabs [aria-pressed=true]').getAttribute('data-log-account'), 'extra-9', '末尾账号可滚动选择');
  await checkSelectedTagVisible(touch, 'log-account-tabs');
  assert(await touch.locator('#log-empty').isVisible());
  assert.equal(await touch.locator('#log-clear').isDisabled(), false);
  await touch.evaluate(() => { $('log-account-tabs').scrollLeft = 0; });
  await touch.locator('#logs-close').click(); await touch.locator('#logs-open').click();
  await checkSelectedTagVisible(touch, 'log-account-tabs');
  await touch.locator('#log-account-tabs [data-log-account="all"]').click();
  const scrollLeft = await touch.evaluate(() => { const tags = $('log-account-tabs'); tags.scrollLeft = tags.scrollWidth; return tags.scrollLeft; });
  app.emit(b, 'info', '滑动浏览期间的新日志', { category: 'alliance' });
  await touch.locator('#log .row').filter({ hasText: '滑动浏览期间的新日志' }).waitFor();
  assert.equal(await touch.locator('#log-account-tabs').evaluate(node => node.scrollLeft), scrollLeft, '实时更新不重置正在浏览的标签位置');
  await touch.locator('#log .row').filter({ hasText: '滑动浏览期间的新日志' }).locator('.log-account').click();
  await checkSelectedTagVisible(touch, 'log-account-tabs');
  assert.equal(await touch.locator('#log-account-tabs [aria-pressed=true]').getAttribute('data-log-account'), 'logs-b');
  await touch.locator('#log-account-tabs [data-log-account="all"]').click();
  saveStore(renamed);
  await touch.evaluate(() => loadAccounts(false));
  await touch.locator('#log-tabs [data-log-group=all]').click();
  assert.equal(await touch.locator('#log-account-tabs [data-log-account]').count(), 3, '已移除且没有日志的账号不残留在筛选栏');
  await touch.close();
  assert.deepEqual(errors, []);
  assert.equal(connections, 0);
  console.log('通过：320–1440px单行标签、原生触屏滑动、多账号单行、选中可见和深色截图检查，全程无页面异常与游戏连接');
} finally {
  await browser?.close(); await app.close(); fs.rmSync(directory, { recursive: true, force: true });
}
