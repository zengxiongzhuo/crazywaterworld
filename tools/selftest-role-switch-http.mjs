// Isolated HTTP regression: fake game clients enforce the official one-login rule.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cw-role-switch-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
fs.writeFileSync(process.env.CW_CONFIG_PACK, JSON.stringify([[0, 'HeroCfg', { data:
  Array.from({ length: 4 }, (_, index) => ({ id: 'hero-' + index, name: '测试英雄' + index, quality: 'BLUE' })),
}]]));
const { GameClient } = await import('../src/client.mjs');
const { createConsole } = await import('./fixtures/console-server.mjs');
const { loadStore, saveStore, ACCOUNTS_PATH, upsertAccount, rememberWorlds } = await import('../src/accounts.mjs');
const { defaultSettings, saveAutomationSettings, loadAutomationSettings, createUsageLedger } = await import('../src/automation-settings.mjs');
const { exportAccountBackup, parseAccountBackup, importAccountBackup, previewAccountImport } = await import('../src/account-backup.mjs');
const protocol = { OnWaterRequest: true, OnWaterResponse: true, AllItemRequest: true, AllItemResponse: true };
const worlds = [
  { worldId: 100, roleInfo: { id: '11', bornWorldId: 100, worldId: 100, nickname: '甲', level: 5 } },
  { worldId: 200, roleInfo: { id: '9007199254740993', bornWorldId: 200, worldId: 300, nickname: '乙', level: 6 } },
  { worldId: 400, roleInfo: { id: '13', bornWorldId: 400, worldId: 300, nickname: '丙', level: 7 } },
  { worldId: 999 },
];
const live = new Set(), connections = [];
let gate = null, failWorld = null, wrongRole = false;
Object.defineProperty(GameClient.prototype, 'connected', { get() { return live.has(this); } });
GameClient.prototype.connect = async function(login) {
  assert.equal([...live].filter(client => client.login.eworldParams.openId === login.eworldParams.openId).length, 0,
    '同一账号新登录之前，旧连接必须已关闭');
  this.login = structuredClone(login);
  this.stopping = false;
  connections.push(this);
  if (gate?.worldId === login.worldId) await gate.promise;
  if (this.stopping) throw new Error('连接已取消');
  if (failWorld === login.worldId) throw Object.assign(new Error('模拟目标区服登录失败'), { recoverable: false });
  const role = login.eworldParams.openId === 'other'
    ? { id: '21', worldId: 500, bornWorldId: 500, nickname: '独立账号', level: 5 }
    : (worlds.find(world => world.worldId === login.worldId) || worlds[0]).roleInfo;
  live.add(this);
  this.state = 'READY';
  const { id, ...fields } = role;
  return { result: 0, playerInfo: { ...fields, playerId: wrongRole && login.worldId === 400 ? '99' : id } };
};
GameClient.prototype.stop = function() { live.delete(this); this.stopping = true; this.state = 'STOPPED'; };
GameClient.prototype.send = function() { assert(this.connected); };
GameClient.prototype.sendWatch = async function() { assert(this.connected); return {}; };
GameClient.prototype.request = async function(name) {
  assert(this.connected, '已断开的旧连接不能继续发送请求');
  if (name === 'GameWorldListRequest') return { latestGroupId: 1, recentWorlds: worlds };
  if (name === 'OnWaterRequest') return { building: [] };
  if (name === 'AllItemRequest') return { items: [] };
  if (name === 'EmailBoxRequest') return { email: [] };
  return {};
};
GameClient.prototype.interleaveRead = work => work();
const credential = token => ({ url: 'ws://fixture.invalid', source: 'mitm',
  login: { worldId: 100, eworldParams: { openId: 'shared', token } } });
// A version 1 row must retain its ID and its existing settings/ledger.
fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify({ version: 1, activeId: 'shared', accounts: [
  { id: 'shared', ...credential('old'), label: '主号', lastSeen: { nickname: '甲', worldId: 100 }, automation: { autoStart: false } },
  { id: 'other', url: 'ws://fixture.invalid', login: { worldId: 500, eworldParams: { openId: 'other' } }, automation: { autoStart: false } },
] }));
const settings = defaultSettings();
settings.resources.diamondDailyLimit = 17;
saveAutomationSettings('shared', settings, { revision: 0 });
createUsageLedger('shared').reserve({ diamonds: 3 }, { diamonds: 17 });
let app = createConsole({ port: 0, protocol });
let root = await app.listen(), passed = 0;
const test = async (name, work) => { await work(); passed++; console.log('通过：' + name); };
async function api(route, body, id = 'shared') {
  const response = await fetch(root + '/api/' + route + '?account=' + encodeURIComponent(id), {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify({ confirm: true, ...body }) }),
    signal: AbortSignal.timeout(10000),
  });
  return { status: response.status, data: await response.json() };
}
const ok = result => { assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; };
const roleId = world => loadStore().accounts.find(account => account.bornWorldId === world).id;
async function until(check) {
  const deadline = Date.now() + 3000;
  while (!check()) { assert(Date.now() < deadline, '等待切换状态超时'); await sleep(5); }
}
const close = async () => { app.server.closeAllConnections(); await app.close(); };

try {
  await test('旧数据原位迁移、角色分别保存、合服后仍保留两个角色、凭证只保存一份', async () => {
    ok(await api('connect', {}));
    ok(await api('worlds'));
    const store = loadStore();
    assert.equal(roleId(100), 'shared');
    assert.equal(store.accounts.length, 4, '空区服不能生成角色卡片');
    assert.equal(store.accounts.find(account => account.bornWorldId === 200).roleId, '9007199254740993');
    assert.notEqual(roleId(200), roleId(400), '合服后同一区服的不同角色仍分别展示');
    assert.equal(loadAutomationSettings('shared').settings.resources.diamondDailyLimit, 17);
    assert.equal(createUsageLedger('shared').pendingCounters().diamonds, 3);
    assert.equal(createUsageLedger(roleId(200)).pendingCounters().diamonds, undefined);
    const raw = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8'));
    assert.equal(raw.version, 2);
    assert.equal(Object.keys(raw.loginAccounts).length, 2);
    assert.equal(raw.accounts.some(account => Object.hasOwn(account, 'login')), false);
  });

  await test('同账号各区服独立读写完整配置、阵容、登录策略和互助预设，保存不清除其他区服用量', async () => {
    const ids = ['shared', roleId(200), roleId(400), 'other'];
    for (const id of ids.slice(1)) {
      assert.equal(loadAutomationSettings(id).revision, 0, '新角色不继承旧角色配置');
      assert.deepEqual(loadAutomationSettings(id).settings, defaultSettings());
    }
    const expected = new Map(ids.map(id => [id, loadAutomationSettings(id)]));
    const assertOtherSettings = id => {
      for (const other of ids.filter(other => other !== id)) {
        assert.deepEqual(loadAutomationSettings(other), expected.get(other), '不能改写其他区服的配置或版本');
      }
    };
    const beforeConnections = connections.length;
    for (const [index, id] of ids.entries()) {
      const current = ok(await api('settings', undefined, id));
      const next = structuredClone(current.settings);
      next.resources.diamondDailyLimit = 17 + index * 10;
      next.factory.keepStock = 101 + index;
      next.loop.everySeconds = 61 + index;
      next.heroes.heroIds = ['hero-' + index];
      const saved = ok(await api('settings', { settings: next, revision: current.revision, baseRevision: current.baseRevision }, id));
      assert.deepEqual(saved.settings, next);
      assertOtherSettings(id);

      const lineups = ok(await api('lineup-presets/save', { revision: saved.revision, name: '区服阵容' + index,
        formation: { presetId: 1, heroPositions: [{ heroId: 'hero-' + index, pos: { x: 4, y: 4 } }], petUid: '0' } }, id));
      assert.equal(lineups.presets.length, 1);
      assert.equal(lineups.presets[0].name, '区服阵容' + index);
      assertOtherSettings(id);

      const login = ok(await api('login-settings', undefined, id));
      login.settings.baseDelaySeconds = 901 + index;
      ok(await api('login-settings', { settings: login.settings, revision: login.revision }, id));
      assertOtherSettings(id);
      const preset = ok(await api('guild/mutual/preset', { target: index + 1, mode: 'selected', memberIds: [String(index + 1)] }, id)).preset;
      assert.equal(preset.target, index + 1);
      expected.set(id, loadAutomationSettings(id));
      assert.deepEqual(ok(await api('settings/export', undefined, id)).settings, expected.get(id).settings);
    }
    const pending = createUsageLedger(roleId(200)).reserve({ diamonds: 5 }, { diamonds: 27 });
    for (const [index, id] of ids.entries()) {
      const view = ok(await api('settings', undefined, id));
      assert.deepEqual(view.settings, expected.get(id).settings);
      assert.deepEqual(app.sessions.get(id).preferences, view.settings);
      assert.equal(ok(await api('lineup-presets', undefined, id)).presets[0].name, '区服阵容' + index);
      assert.equal(ok(await api('login-settings', undefined, id)).settings.baseDelaySeconds, 901 + index);
      assert.equal(ok(await api('guild/mutual', undefined, id)).preset.target, index + 1);
      assert.equal(view.pendingUsage.diamonds, index === 0 ? 3 : index === 1 ? 5 : undefined);
    }
    assert.equal(connections.length, beforeConnections, '编辑未选中区服的配置不能切服或登录');
    createUsageLedger(roleId(200)).cancel(pending);
  });

  await test('切服先关闭旧连接、重复点击共用登录、并发其他切换被拒绝、迟到读取不能抢回旧服', async () => {
    ok(await api('connect', {}, 'other'));
    const otherClient = app.sessions.get('other').client;
    const oldClient = app.sessions.get('shared').client;
    let release;
    gate = { worldId: 200, promise: new Promise(resolve => { release = resolve; }) };
    const before = connections.length;
    const switching = api('accounts/active', { id: roleId(200), connect: true });
    await until(() => connections.length > before);
    assert.equal(oldClient.connected, false);
    assert.equal(otherClient.connected, true);
    assert.equal(loadStore().activeId, 'shared', '登录确认前不更新当前角色');
    const duplicate = api('accounts/active', { id: roleId(200), connect: true });
    const conflict = await api('accounts/active', { id: roleId(400), connect: true });
    assert.equal(conflict.status, 400);
    assert.match(conflict.data.error, /正在切换/);
    const stale = await api('overview', undefined, 'shared');
    assert.equal(stale.status, 400);
    assert.match(stale.data.error, /其他区服/);
    release();
    ok(await switching); ok(await duplicate); gate = null;
    assert.equal(connections.length - before, 1, '重复点击不能重复登录');
    assert.equal(app.sessions.get(roleId(200)).player.worldId, 300);
    assert.equal(app.sessions.get(roleId(200)).client.login.worldId, 200, '合服角色使用原区服入口');
    assert.equal(loadStore().activeId, roleId(200));
  });

  await test('旧角色的后台连接被拦截，目标登录失败会恢复原连接和选择', async () => {
    const before = connections.length;
    const implicit = await api('loop', undefined, 'shared');
    assert.equal(implicit.status, 200, '读取旧角色保存的挂机状态不需要登录');
    assert.equal(connections.length, before);
    failWorld = 400;
    const failed = await api('accounts/active', { id: roleId(400), connect: true });
    assert.equal(failed.status, 400);
    assert.match(failed.data.error, /模拟目标区服/);
    assert.equal(loadStore().activeId, roleId(200));
    assert.equal(loadStore().selectedRoles.shared, roleId(200));
    assert(app.sessions.get(roleId(200)).client.connected);
    failWorld = null;
  });

  await test('登录返回其他角色时拒绝成功，旧角色恢复后仍可再次切换', async () => {
    wrongRole = true;
    const failed = await api('accounts/active', { id: roleId(400), connect: true });
    assert.equal(failed.status, 400);
    assert.match(failed.data.error, /角色与所选区服不一致/);
    wrongRole = false;
    ok(await api('worlds/enter', { worldId: 100 }, roleId(200)));
    assert.equal(loadStore().activeId, 'shared');
    assert(app.sessions.get('shared').client.connected);
    assert.equal(app.sessions.get(roleId(200)).client?.connected ?? false, false);
    assert.equal(loadAutomationSettings('shared').settings.resources.diamondDailyLimit, 17);
    const absent = await api('worlds/enter', { worldId: 999 });
    assert.equal(absent.status, 400);
    assert.match(absent.data.error, /没有已确认的角色/);
  });

  await test('刷新凭证同步所有区服，备份往返保留独立角色标识和配置', async () => {
    const store = loadStore();
    upsertAccount(store, credential('fresh'));
    saveStore(store);
    assert(loadStore().accounts.filter(account => account.loginAccountId === 'shared').every(account => account.login.eworldParams.token === 'fresh'));
    const backup = exportAccountBackup(loadStore(), { all: true, includeSettings: true });
    assert.equal(parseAccountBackup(backup).accounts.length, 4);
    const preview = previewAccountImport(backup);
    importAccountBackup(backup, preview.token);
    assert.equal(loadStore().accounts.length, 4);
    assert.equal(loadAutomationSettings('shared').settings.resources.diamondDailyLimit, 17);
    const reloaded = loadStore();
    rememberWorlds(reloaded, reloaded.accounts.find(account => account.id === 'shared'), {
      recentWorlds: worlds.map(world => ({ ...world, role: world.roleInfo })),
    });
    assert.equal(reloaded.accounts.length, 4, '再次读取不会重复生成角色');
    // 不同机器可能把不同角色保存在旧账号 ID 下，导入按角色身份匹配。
    const foreign = exportAccountBackup(loadStore(), { id: roleId(200), includeSettings: true });
    foreign.accounts[0].id = 'shared'; foreign.activeId = 'shared';
    foreign.accounts[0].settings.settings.resources.diamondDailyLimit = 88;
    const foreignPreview = previewAccountImport(foreign);
    importAccountBackup(foreign, foreignPreview.token);
    assert.equal(loadStore().accounts.length, 4);
    assert.equal(loadAutomationSettings(roleId(200)).settings.resources.diamondDailyLimit, 88);
    assert.equal(loadAutomationSettings('shared').settings.resources.diamondDailyLimit, 17, '导入其他区服不能覆盖本机原角色配置');
  });

  if (process.env.CW_ROLE_BROWSER === '1' || process.argv.includes('--browser')) await test('桌面和手机页面分别展示区服，卡片与页头切换一致，失败保留原角色', async () => {
    const { chromium } = await import('playwright-core');
    const executablePath = [process.env.CW_BROWSER_TEST_EXECUTABLE, chromium.executablePath(),
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(file => file && fs.existsSync(file));
    assert(executablePath, '未找到验收浏览器');
    const browser = await chromium.launch({ executablePath, headless: true });
    const output = path.resolve('output/role-switch');
    fs.mkdirSync(output, { recursive: true });
    try {
      for (const width of [1280, 360]) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 768, hasTouch: width < 768 });
        const page = await context.newPage(), errors = [];
        page.setDefaultTimeout(20000);
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(root);
        await page.locator('#tabs [data-tab="account"]').click();
        await page.locator('#account-count').filter({ hasText: '2 个登录账号 · 4 个区服角色' }).waitFor();
        assert.equal(await page.locator('#accounts .account-card').count(), 4);
        const card = nickname => page.locator('#accounts .account-card').filter({ has: page.locator('[data-account-field="role"]').filter({ hasText: nickname }) });
        const currentIs = async nickname => {
          await page.waitForFunction(name => document.querySelector('#account-picker-title')?.textContent.includes(name), nickname);
          await page.waitForFunction(() => [...document.querySelectorAll('[data-account-action="select"]')]
            .filter(button => !button.textContent.includes('当前')).every(button => !button.disabled));
        };
        await card('乙').locator('[data-account-action="select"]').click();
        await currentIs('乙');
        assert.equal(loadStore().selectedRoles.shared, roleId(200));
        failWorld = 400;
        await card('丙').locator('[data-account-action="select"]').click();
        await page.waitForFunction(() => ![...document.querySelectorAll('[data-account-action="select"]')].some(button => button.textContent.includes('切换中')));
        assert((await page.locator('#account-picker-title').textContent()).includes('乙'));
        assert.equal(loadStore().selectedRoles.shared, roleId(200));
        failWorld = null;
        await card('甲').locator('[data-account-action="select"]').click();
        await currentIs('甲');
        await page.locator('#account-picker-trigger').click();
        assert.equal(await page.locator('#account-picker-list [role="option"]').count(), 4);
        await page.locator('#account-picker-list [role="option"]').filter({ hasText: '乙' }).click();
        await currentIs('乙');
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: path.join(output, 'role-cards-' + width + '.png'), fullPage: true });
        await card('甲').locator('[data-account-action="select"]').click();
        await currentIs('甲');
        assert.deepEqual(errors, []);
        await context.close();
      }
    } finally { failWorld = null; await browser.close(); }
  });

  await test('控制台重启只恢复同账号选中的一个区服', async () => {
    await close();
    const store = loadStore();
    store.selectedRoles.shared = roleId(200);
    for (const account of store.accounts) {
      account.automation = { ...account.automation, autoStart: account.loginAccountId === 'shared', enabled: false };
      if (account.loginAccountId === 'shared') {
        const current = loadAutomationSettings(account.id);
        current.settings.schedule.mail = true;
        saveAutomationSettings(account.id, current.settings, { revision: current.revision });
      }
    }
    saveStore(store);
    app = createConsole({ port: 0, protocol }); root = await app.listen();
    await until(() => app.sessions.get(roleId(200))?.client?.connected);
    assert.equal([...live].filter(client => client.login.eworldParams.openId === 'shared').length, 1);
    assert.equal(app.sessions.get('shared')?.loop.running ?? false, false);
    assert.equal(app.sessions.get(roleId(400))?.loop.running ?? false, false);
    for (const id of ['shared', roleId(200), roleId(400), 'other']) {
      const view = ok(await api('settings', undefined, id));
      assert.deepEqual(view.settings, loadAutomationSettings(id).settings, '重启读取当前角色自己的完整配置');
      assert.deepEqual(app.sessions.get(id).preferences, view.settings);
    }
    assert.equal(app.sessions.get(roleId(200)).preferences.resources.diamondDailyLimit, 88);
    assert.equal(app.sessions.get('shared').preferences.resources.diamondDailyLimit, 17);
    assert.equal(app.sessions.get(roleId(400)).preferences.resources.diamondDailyLimit, 37);
    assert.equal(app.sessions.get('shared').loop.everyMs, 61000);
    assert.equal(app.sessions.get(roleId(200)).loop.everyMs, 62000);
    assert.equal(app.sessions.get(roleId(400)).loop.everyMs, 63000);
  });
  await test('直接开始其他区服挂机会交接连接，旧区服循环不能再抢登录', async () => {
    const previous = app.sessions.get(roleId(200));
    const oldController = previous.loop.controller;
    ok(await api('accounts/pause', { paused: false, start: true }, roleId(400)));
    await until(() => app.sessions.get(roleId(400))?.client?.connected);
    assert.equal(loadStore().selectedRoles.shared, roleId(400));
    assert.equal(previous.client?.connected ?? false, false);
    assert(oldController.signal.aborted);
    assert.equal([...live].filter(client => client.login.eworldParams.openId === 'shared').length, 1);
    ok(await api('loop/stop', {}, roleId(400)));
    await app.sessions.get(roleId(400)).loop.job;
  });
  console.log(`区服切换专项 ${passed}/${passed} 通过`);
} finally {
  gate = null;
  await close();
  fs.rmSync(directory, { recursive: true, force: true });
}
