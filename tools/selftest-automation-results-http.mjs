import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cw-results-http-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');
const { GameClient } = await import('../src/client.mjs');
const { createConsole } = await import('./fixtures/console-server.mjs');
const { saveStore, upsertAccount } = await import('../src/accounts.mjs');
const { automationTasks } = await import('../src/automation.mjs');
const { defaultRotationSettings } = await import('../src/role-rotation.mjs');
let clock = Date.parse('2026-11-18T23:59:00+08:00'), calls = 0, passed = 0, app, root;
const live = new Set(), mailGot = new Set();
Object.defineProperty(GameClient.prototype, 'connected', { get() { return live.has(this); } });
GameClient.prototype.connect = async function(login) {
  this.login = login; this.gold = 100; this.seq = 0; this.stopping = false; live.add(this);
  return { result: 0, playerInfo: { playerId: String(login.worldId), bornWorldId: login.worldId, worldId: login.worldId, nickname: '成果测试' + login.worldId, level: 5 } };
};
GameClient.prototype.request = async function(name) {
  calls++; assert(this.connected);
  if (name === 'OnWaterRequest') return { building: [] };
  if (name === 'AllItemRequest') return { items: [] };
  if (name === 'AllResourceRequest') return { list: [{ res: 3, amount: this.gold }] };
  if (name === 'EmailBoxRequest') return { total: 1, email: [{ emailId: '1', status: mailGot.has(this.login.worldId) ? 1 : 2, attachment: true, got: mailGot.has(this.login.worldId) }] };
  return {};
};
GameClient.prototype.send = function() { assert(this.connected); };
GameClient.prototype.sendWatch = async function(name) {
  calls++; this.emit('frame', { dir: 'out', name, seq: 0, bytes: Buffer.alloc(0) });
  if (name === 'QuickGotReadEmailRequest') { mailGot.add(this.login.worldId); this.gold += 30; this.emit('message', { name: 'SCUpdateResource', seq: ++this.seq, body: { list: [{ res: 3, amount: this.gold }] } }); }
  return {};
};
GameClient.prototype.stop = function() { this.stopping = true; this.state = 'STOPPED'; live.delete(this); this.emit('close'); };
GameClient.prototype.interleaveRead = work => work();
const store = { version: 2, accounts: [], activeId: null, selectedRoles: {} };
function add(worldId, loginId = 'shared') {
  const { account } = upsertAccount(store, { url: 'ws://fixture.invalid', source: 'mitm', login: { worldId, eworldParams: { openId: loginId, token: 'DO_NOT_EXPORT_SECRET' } } },
    { role: { id: String(worldId), bornWorldId: worldId, worldId, nickname: '成果测试' + worldId, level: 5 } });
  account.automation = { autoStart: false, tasks: Object.fromEntries(automationTasks.map(task => [task.key, task.key === 'mail'])), everySeconds: 3600 };
  return account.id;
}
const a = add(100), b = add(200), other = add(300, 'other'); saveStore(store);
const test = async (name, work) => { await work(); passed++; console.log('通过：' + name); };
async function api(route, body, account = a) {
  const response = await fetch(root + '/api/' + route + (route.includes('?') ? '&' : '?') + 'account=' + encodeURIComponent(account), { ...(body ? { method: 'POST', body: JSON.stringify({ confirm: true, ...body }) } : {}), signal: AbortSignal.timeout(10000) });
  return { status: response.status, data: await response.json() };
}
const ok = result => { assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; };
const results = async (query = '', account = a) => ok(await api('automation-results' + (query ? '?' + query : ''), null, account));
async function until(check) { const deadline = Date.now() + 10000; while (!await check()) { assert(Date.now() < deadline, '等待成果记录超时：' + JSON.stringify([...app.sessions.values()].map(session => ({ id: session.id, error: session.loop.error, messages: session.log.slice(-12).map(entry => entry.message) })))); await sleep(20); } }
async function launch() { app = createConsole({ port: 0, protocol: { OnWaterRequest: true, OnWaterResponse: true, AllItemRequest: true, AllItemResponse: true, AllResourceRequest: true, AllResourceResponse: true }, rotationNow: () => clock, rotationAutomatic: false }); root = await app.listen(); }
async function close() { app.server.closeAllConnections(); await app.close(); }
try {
  await launch();
  await test('成果查询不创建连接、不触发游戏请求，筛选及账号校验正常', async () => {
    const before = calls, sessionsBefore = app.sessions.size;
    assert.equal((await results()).run, null); assert.equal(calls, before);
    assert.equal(app.sessions.size, sessionsBefore); assert.equal(live.size, 0);
    assert.equal((await api('automation-results?scope=all')).status, 400);
    assert.equal((await api('automation-results', null, 'missing')).status, 400);
  });
  await test('真实HTTP启动模拟挂机，邮件确认产生动作和准确金币收益', async () => {
    ok(await api('loop/start', { rounds: 0, everySeconds: 3600 })); await until(async () => (await results()).totals.completed === 1);
    const data = await results(); assert.equal(data.totals.gains.GOLD, 30); assert.equal(data.materials.GOLD.name, '金币');
    const before = calls; await results('scope=login'); assert.equal(calls, before); assert.equal((await results('', other)).totals.completed, 0);
    assert(!JSON.stringify(data).includes('DO_NOT_EXPORT_SECRET'));
    ok(await api('loop/stop', {})); assert((await results()).run.endedAt);
  });
  await test('轮换跨午夜分日、多区服汇总、重新进入同一区服保留本次成果', async () => {
    mailGot.clear(); const settings = { ...defaultRotationSettings(), enabled: true, allDay: true, roles: [{ id: a, enabled: true, minutes: 1 }, { id: b, enabled: true, minutes: 1 }] };
    ok(await api('role-rotations/save', { loginId: 'shared', revision: 0, settings }));
    await until(async () => (await results()).totals.completed === 1); const run = (await results()).run.id;
    clock += 60000; await app.roleRotations.tick('shared'); await until(async () => (await results('scope=login')).totals.completed === 2);
    assert.equal((await results('period=today&scope=login')).totals.gains.GOLD, 30);
    clock += 60000; await app.roleRotations.tick('shared'); await until(() => app.sessions.get(a)?.loop.running);
    const data = await results('scope=login'); assert.equal(data.run.id, run); assert.equal(data.totals.gains.GOLD, 60); assert.equal(data.roles.length, 2);
    assert.equal((await results()).totals.gains.GOLD, 30);
  });
  await test('后台重启保留战报，运行空档不计在线时长，暂停保留累计', async () => {
    const before = await results('scope=login'); await close(); clock += 30000; await launch(); await app.roleRotations.tick('shared');
    const after = await results('scope=login'); assert.equal(after.run.id, before.run.id); assert.equal(after.totals.gains.GOLD, 60); assert.equal(after.totals.onlineMs, before.totals.onlineMs);
    ok(await api('role-rotations/pause', { loginId: 'shared', paused: true }));
    assert((await results()).run.endedAt); assert.equal((await results('scope=login')).totals.gains.GOLD, 60);
    app.automationResults.flush(); assert(!fs.readFileSync(path.join(directory, 'automation-results.json'), 'utf8').includes('DO_NOT_EXPORT_SECRET'));
  });
  if (process.argv.includes('--browser')) await test('桌面与手机成果页筛选、明细、空状态和布局正常', async () => {
    const last = await results();
    app.automationResults.record(last.run.id, a, { kind: 'assets', label: '收获工厂成品与排产', category: '生产', gains: { 木材: 100, EXP: 120 }, costs: { 木材: 80, RUBY: 5 } });
    const { chromium } = await import('playwright-core');
    const executablePath = [process.env.CW_BROWSER_TEST_EXECUTABLE, chromium.executablePath(), 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(file => file && fs.existsSync(file));
    assert(executablePath); const browser = await chromium.launch({ executablePath, headless: true });
    const output = path.resolve('output/automation-results'); fs.mkdirSync(output, { recursive: true });
    try {
      for (const width of [1280, 360]) {
        const context = await browser.newContext({ viewport: { width, height: 1000 }, isMobile: width < 768, hasTouch: width < 768 });
        const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.goto(root); await page.locator('#tabs [data-tab="results"]').click();
        await page.locator('#results-scope').selectOption('login'); await page.waitForFunction(() => document.querySelectorAll('#results-roles .results-role').length === 2);
        await page.locator('#results-gains').getByText('金币', { exact: true }).waitFor();
        assert(await page.locator('#results-current').evaluate(node => { const style = getComputedStyle(node); return style.color !== style.backgroundColor; }), '选中的时间范围文字必须可见');
        const wood = page.locator('#results-gains details').filter({ hasText: '木材' }); await wood.locator('summary').click(); await wood.locator('.results-asset-sources').getByText('收获工厂成品与排产 · +100', { exact: true }).waitFor(); await wood.locator('summary').click();
        await page.screenshot({ path: path.join(output, 'results-' + width + '.png'), fullPage: true });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '手机或桌面存在横向溢出');
        await page.locator('#results-today').click(); await page.waitForFunction(() => document.querySelector('#results-run').textContent.includes('今日累计'));
        await page.locator('#results-current').click(); await page.waitForFunction(() => document.querySelector('#results-run').textContent.includes('区服轮换'));
        assert.deepEqual(errors, []); await context.close();
      }
    } finally { await browser.close(); }
  });
  console.log('挂机成果HTTP验证通过：' + passed + '/' + passed);
} finally {
  if (app) await close();
  assert(directory.startsWith(path.join(fs.realpathSync(os.tmpdir()), 'cw-results-http-')));
  fs.rmSync(directory, { recursive: true, force: true });
}
