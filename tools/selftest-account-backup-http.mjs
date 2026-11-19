import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-account-backup-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');
const { accountFromCredential, loadStore, saveStore, ACCOUNTS_PATH } = await import('../src/accounts.mjs');
const { defaultSettings, saveAutomationSettings, loadAutomationSettings, settingsFile } = await import('../src/automation-settings.mjs');
const { importAccountBackup, previewAccountImport } = await import('../src/account-backup.mjs');
const { createConsole } = await import('./fixtures/console-server.mjs');
const { GameClient } = await import('../src/client.mjs');
let connections = 0;
GameClient.prototype.connect = async () => { connections++; throw new Error('测试禁止连接游戏'); };
const make = (id, source = 'mitm') => ({ ...accountFromCredential({ url: 'wss://fixture.invalid/game',
  login: { eworldParams: { openId: id, token: 'fixture-secret', sign: 'fixture-sign' }, worldId: 9001 },
  source, loginFrameHex: 'abcd' }, { label: source + ' 测试账号' }), automation: { autoStart: false, enabled: false } });
const source = [make('shared'), make('shared', 'alipay'), make('shared', 'douyin-mitm')];
source[0].automation.tasks = { mail: false };
source[0].automation.everySeconds = 21;
source[0].automation.loginRecovery = { status: 'waiting', secret: 'runtime-only' };
saveStore({ version: 1, activeId: source[1].id, accounts: source });
let custom = defaultSettings();
custom.loop.everySeconds = 37;
custom.gather.fishingGoldReserve = 321;
custom = saveAutomationSettings(source[1].id, custom, { revision: 0 }).settings;
let app, root, passed = 0, only, full;
const test = async (name, work) => { await work(); passed++; console.log('通过：' + name); };
async function open() { app = createConsole({ port: 0, protocol: {} }); root = await app.listen(); }
async function close() { app.server.closeAllConnections(); await app.close(); }
async function api(route, body, status = 200) {
  const response = await fetch(root + '/api/' + route, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  const value = await response.json();
  assert.equal(response.status, status, JSON.stringify(value));
  return value;
}
async function restore(document) {
  const preview = await api('accounts/import/preview', { document });
  return api('accounts/import', { document, token: preview.token, confirm: true });
}
function files() { return [ACCOUNTS_PATH, settingsFile()].map(file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null); }
try {
  await open();
  await test('单账号和全部账号支持两种导出，凭据完整而运行状态不外带', async () => {
    only = await api('accounts/export', { all: true });
    assert.equal(only.includeSettings, false);
    assert.equal(only.accounts.length, 3);
    assert.equal(only.activeId, source[1].id);
    for (const account of only.accounts) {
      assert.equal(account.login.eworldParams.token, 'fixture-secret');
      assert.equal(account.loginFrameHex, 'abcd');
      assert.equal(Object.hasOwn(account, 'settings'), false);
      assert.equal(Object.hasOwn(account, 'automation'), false);
    }
    for (const includeSettings of [false, true]) {
      const single = await api('accounts/export', { id: source[1].id, includeSettings });
      assert.equal(single.accounts.length, 1);
      assert.equal(single.activeId, source[1].id);
      assert.equal(Object.hasOwn(single.accounts[0], 'settings'), includeSettings);
    }
    full = await api('accounts/export', { all: true, includeSettings: true });
    assert.deepEqual(full.accounts[1].settings.settings, custom);
    assert.equal(full.accounts[0].settings.settings.loop.everySeconds, 21, '旧账号快捷配置转换为详细配置');
    assert.equal(full.accounts[0].settings.settings.schedule.mail, false);
    assert.equal(JSON.stringify(full).includes('runtime-only'), false);
    await api('accounts/export', { id: 'missing' }, 400);
    await api('accounts/export', { all: true, includeSettings: 'yes' }, 400);
  });
  await test('多选导出只包含指定账号与对应配置，拒绝空选和失效账号', async () => {
    for (const includeSettings of [false, true]) {
      const subset = await api('accounts/export', { ids: [source[0].id, source[2].id], includeSettings });
      assert.deepEqual(subset.accounts.map(account => account.id), [source[0].id, source[2].id]);
      assert.equal(subset.activeId, source[0].id);
      assert.equal(subset.accounts.every(account => Object.hasOwn(account, 'settings') === includeSettings), true);
      if (includeSettings) assert.equal(subset.accounts[0].settings.settings.loop.everySeconds, 21);
    }
    const active = await api('accounts/export', { ids: [source[1].id, source[2].id], includeSettings: true });
    assert.equal(active.activeId, source[1].id);
    assert.deepEqual(active.accounts[0].settings.settings, custom);
    const repeated = await api('accounts/export', { ids: [source[1].id, source[1].id] });
    assert.equal(repeated.accounts.length, 1);
    for (const ids of [[], null, 'all', [null], [''], [source[0].id, 'missing']]) {
      await api('accounts/export', { ids }, 400);
    }
    await api('accounts/export', { ids: [], all: true }, 400);
    await api('accounts/export', { ids: [source[0].id], all: true }, 400);
    await api('accounts/export', { ids: [source[0].id], id: source[1].id }, 400);
  });
  await close();
  const existing = make('shared'); existing.label = '本机备注';
  existing.automation.paused = true;
  existing.automation.productionSyncRequired = true;
  const unrelated = make('unrelated');
  saveStore({ version: 1, activeId: unrelated.id, accounts: [existing, unrelated] });
  fs.unlinkSync(settingsFile());
  let local = defaultSettings(); local.loop.everySeconds = 88;
  local = saveAutomationSettings(existing.id, local, { revision: 0 }).settings;
  saveAutomationSettings(unrelated.id, local, { revision: 0 });
  const unrelatedBefore = loadAutomationSettings(unrelated.id);
  const ledgerFile = path.join(directory, 'automation-usage.json');
  const ledger = JSON.stringify({ version: 1, accounts: {} }); fs.writeFileSync(ledgerFile, ledger);
  await open();
  await test('导入预览不写文件，取消不会影响本机数据', async () => {
    const before = files();
    const preview = await api('accounts/import/preview', { document: full });
    assert.equal(preview.created, 2); assert.equal(preview.updated, 1); assert.equal(preview.settingsCount, 3);
    assert.deepEqual(files(), before);
    await api('accounts/import', { document: full, token: preview.token }, 400);
    assert.deepEqual(files(), before);
  });
  await test('仅账号导入按渠道去重，保留已有配置与暂停状态', async () => {
    const automationBeforeImport = structuredClone(loadStore().accounts.find(row => row.id === existing.id).automation);
    const result = await restore(only);
    assert.equal(result.created, 2); assert.equal(result.updated, 1); assert.equal(result.settingsCount, 0);
    assert.equal(loadStore().activeId, unrelated.id);
    assert.equal(loadStore().accounts.length, 4);
    assert.deepEqual(loadStore().accounts.find(row => row.id === existing.id).automation, automationBeforeImport);
    assert.deepEqual(loadAutomationSettings(existing.id).settings, local);
    assert.equal(loadAutomationSettings(source[1].id).revision, 0);
    assert.equal(loadStore().accounts.find(row => row.id === source[1].id).automation.autoStart, false);
  });
  await test('账号及配置按归属恢复，更新已有会话并保留账本与其他账号', async () => {
    await fetch(root + '/api/accounts');
    const result = await restore(full);
    assert.equal(result.created, 0); assert.equal(result.updated, 3); assert.equal(result.settingsCount, 3);
    assert.deepEqual(loadAutomationSettings(source[1].id).settings, custom);
    assert.equal(loadAutomationSettings(existing.id).revision, 2);
    assert.equal(app.sessions.get(existing.id).loop.everyMs, 21000);
    assert.deepEqual(loadAutomationSettings(unrelated.id), unrelatedBefore);
    assert.equal(fs.readFileSync(ledgerFile, 'utf8'), ledger);
    assert.equal(connections, 0);
    assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
  });
  await test('重复导入更新凭据，不重复添加账号', async () => {
    const updated = structuredClone(only); updated.accounts[0].login.eworldParams.token = 'refreshed-fixture-token';
    const result = await restore(updated);
    assert.equal(result.created, 0); assert.equal(loadStore().accounts.length, 4);
    assert.equal(loadStore().accounts.find(row => row.id === existing.id).login.eworldParams.token, 'refreshed-fixture-token');
  });
  await test('兼容旧版账号备份，忽略备份中的自动运行与恢复状态', async () => {
    const legacy = make('legacy'); legacy.automation = { enabled: true, autoStart: true, paused: false, loginBlocked: true };
    const result = await restore({ version: 1, activeId: legacy.id, accounts: [legacy] });
    assert.equal(result.created, 1);
    assert.deepEqual(loadStore().accounts.find(row => row.id === legacy.id).automation, { enabled: false, autoStart: false });
  });
  await test('任何一项格式或配置错误都整批拒绝，不产生部分导入', async () => {
    const cases = [
      document => { document.version = 2; },
      document => { document.format = 'other'; },
      document => { document.accounts = []; },
      document => { document.accounts[1].id = 'wrong'; },
      document => { document.accounts[1].source = 'mitm'; },
      document => { document.accounts[1].url = 'https://fixture.invalid'; },
      document => { document.accounts[1].login = {}; },
      document => { document.accounts[1].loginFrameHex = 'abc'; },
      document => { document.accounts.push(document.accounts[0]); },
      document => { document.accounts[1].settings.settings.loop.everySeconds = -1; },
      document => { delete document.accounts[1].settings; },
      document => { document.includeSettings = false; },
      document => { document.activeId = 'missing'; },
      document => { document.accounts[0].id = document.accounts[0].login.eworldParams.openId = '__proto__'; },
    ];
    const before = files();
    for (const change of cases) {
      const document = structuredClone(full); change(document);
      await api('accounts/import/preview', { document }, 400);
      await api('accounts/import', { document, confirm: true, token: 'invalid' }, 400);
      assert.deepEqual(files(), before);
    }
  });
  await test('预览后配置变化或导入文件变化时拒绝覆盖', async () => {
    const preview = await api('accounts/import/preview', { document: full });
    const saved = loadAutomationSettings(existing.id);
    saveAutomationSettings(existing.id, saved.settings, { revision: saved.revision });
    const before = files();
    await api('accounts/import', { document: full, token: preview.token, confirm: true }, 400);
    assert.deepEqual(files(), before);
    const fresh = await api('accounts/import/preview', { document: full });
    const changed = structuredClone(full); changed.accounts[0].label = 'changed';
    await api('accounts/import', { document: changed, token: fresh.token, confirm: true }, 400);
    assert.deepEqual(files(), before);
  });
  await test('账号落盘失败时回滚本次配置写入', () => {
    const before = files();
    const preview = previewAccountImport(full);
    const rename = fs.renameSync;
    fs.renameSync = function(from, to) {
      if (to === ACCOUNTS_PATH) throw new Error('injected account write failure');
      return rename.call(this, from, to);
    };
    try { assert.throws(() => importAccountBackup(full, preview.token), /injected account write failure/); }
    finally { fs.renameSync = rename; }
    assert.deepEqual(files(), before);
  });
  await test('非法JSON和超大文件给出明确错误且不泄漏凭据', async () => {
    const before = files();
    const response = await fetch(root + '/api/accounts/import', { method: 'POST', body: '{"secret":"private-broken-json' });
    const text = await response.text();
    assert.equal(response.status, 400); assert.equal(text.includes('private-broken-json'), false);
    await api('accounts/import/preview', { document: { padding: 'x'.repeat(10 * 1024 * 1024 + 1024) } }, 400);
    assert.deepEqual(files(), before);
  });
  await close();
  await test('空仓库恢复备份当前账号，重启回读配置且不自动连接', async () => {
    saveStore({ version: 1, activeId: null, accounts: [] });
    await open();
    await restore(full);
    assert.equal(loadStore().activeId, full.activeId);
    await close(); await open();
    assert.deepEqual(loadAutomationSettings(source[1].id).settings, custom);
    await fetch(root + '/api/accounts');
    assert.equal([...app.sessions.values()].some(session => session.loop.running), false);
    assert.equal(connections, 0);
  });
} finally {
  if (app?.server.listening) await close();
  fs.rmSync(directory, { recursive: true, force: true });
}
console.log(`账号备份 HTTP 自检 ${passed}/${passed} 通过`);
