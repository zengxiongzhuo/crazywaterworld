// 隔离账号验证刷新后的导航恢复；仅操作界面，不连接游戏或保存配置。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-navigation-browser-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
process.env.CW_RESOURCE_AUTO_UPDATE = '0';
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');
const { saveStore } = await import('../src/accounts.mjs');
const { defaultSettings, saveAutomationSettings, loadAutomationSettings } = await import('../src/automation-settings.mjs');
const { GameClient } = await import('../src/client.mjs');
const { createConsole } = await import('../src/server.mjs');
let connections = 0;
const originalConnect = GameClient.prototype.connect;
GameClient.prototype.connect = async () => { connections++; throw new Error('导航验收禁止连接游戏'); };
const account = 'navigation-browser', label = '导航验收账号';
saveStore({ activeId: account, accounts: [{ id: account, label, url: 'wss://fixture.invalid', login: {},
  automation: { enabled: false, autoStart: false, paused: true } }] });
saveAutomationSettings(account, defaultSettings(), { revision: 0 });
const baseline = loadAutomationSettings(account);
const app = createConsole({ port: 0, protocol: {} });
let browser;
const errors = [];
let settingsWrites = 0;
try {
  const base = await app.listen();
  const executablePath = process.env.CW_BROWSER_TEST_EXECUTABLE || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find(fs.existsSync);
  assert(executablePath, '未找到测试浏览器');
  browser = await chromium.launch({ executablePath, headless: true });
  for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/settings') settingsWrites++;
    });
    const tab = async (id, resource) => {
      await page.locator('#account-picker-title').filter({ hasText: label }).waitFor();
      await page.locator('#tabs [data-tab="' + id + '"][aria-current="page"]').waitFor();
      await page.locator('#tab-' + (resource || id)).waitFor({ state: 'visible' });
      if (resource) await page.locator('[data-resource-tab="' + resource + '"][aria-current="page"]').waitFor();
    };
    const config = async (category, group) => {
      await tab('settings');
      await page.locator('[data-config-tab="' + category + '"][aria-selected="true"]').waitFor();
      await page.locator('#config-group-' + group).waitFor({ state: 'visible' });
      await page.locator('#config-state').filter({ hasText: '配置已同步' }).waitFor();
    };
    const main = async id => { await page.locator('#tabs [data-tab="' + id + '"]').click(); };
    const cityWar = async () => {
      await main('settings');
      await page.locator('[data-config-tab="world"]').click();
      await page.locator('[data-config-group="cityWar"]').click();
      await config('world', 'cityWar');
    };
    const reloadFrom = async (state, hash = '') => {
      await page.evaluate(({ state, hash }) => history.replaceState(state, '', location.pathname + location.search + hash), { state, hash });
      await page.reload({ waitUntil: 'domcontentloaded' });
    };

    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await tab('overview');
    assert.equal(await page.locator('#tabs [data-tab="activities"]').getAttribute('aria-label'), '活动');
    assert.equal(await page.locator('#tabs [data-tab="resources"]').getAttribute('aria-label'), '杂项');
    assert.deepEqual(await page.locator('[data-resource-tab]').allTextContents(), ['联盟', '仓库', '英雄与装备', '礼包兑换']);
    await main('settings');
    await config('base', 'building');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await config('base', 'building');

    await cityWar();
    assert.equal(new URL(page.url()).hash, '#config-group-cityWar');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await config('world', 'cityWar');
    await page.locator('[data-config-tab="base"]').click();
    await page.locator('[data-config-family="production"]').click();
    await page.locator('[data-config-group="farm"]').click();
    await config('base', 'farm');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await config('base', 'farm');

    // 已载入的草稿返回配置时可能不重绘，仍须恢复当前分组的 URL。
    await cityWar();
    await main('overview');
    await tab('overview');
    assert.equal(new URL(page.url()).hash, '');
    await main('settings');
    await config('world', 'cityWar');
    assert.equal(new URL(page.url()).hash, '#config-group-cityWar');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await config('world', 'cityWar');
    await main('overview');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await tab('overview');
    assert.equal(new URL(page.url()).hash, '');

    await cityWar();
    await main('resources');
    await page.locator('[data-resource-tab="heroes"]').click();
    await tab('resources', 'heroes');
    assert.equal(new URL(page.url()).hash, '');
    await main('settings');
    await config('world', 'cityWar');
    assert.equal(new URL(page.url()).hash, '#config-group-cityWar');
    await main('resources');
    await tab('resources', 'heroes');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await tab('resources', 'heroes');

    // 活动独立为顶级页面，返回杂项继续显示原子页。
    await main('activities');
    await tab('activities');
    assert.equal(await page.locator('#resource-tabs').isVisible(), false);
    await main('resources');
    await tab('resources', 'heroes');
    await main('activities');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await tab('activities');
    assert.equal(await page.locator('#resource-tabs').isVisible(), false);

    // 旧版保存在资源与玩法中的活动位置迁移到顶级活动；杂项仍默认打开联盟。
    await reloadFrom({ consoleView: { tab: 'resources', resource: 'activities' } });
    await tab('activities');
    assert.equal(await page.locator('#resource-tabs').isVisible(), false);
    await page.waitForFunction(() => history.state?.consoleView?.tab === 'activities');
    await main('resources');
    await tab('resources', 'guild');

    // 独立登录设置入口已并入账号，旧页面记录恢复到账号列表。
    await reloadFrom({ consoleView: { tab: 'login-settings', resource: 'guild' } });
    await tab('account');
    assert.equal(await page.locator('#tabs [data-tab="login-settings"]').count(), 0);
    await page.locator('#accounts [data-account-action="login-settings"]').waitFor();
    assert.equal(await page.locator('#account-login-dialog').isVisible(), false);
    await page.waitForFunction(() => history.state?.consoleView?.tab === 'account');

    // 显式配置深链优先于原来的主页面；旧版分组链接沿用现有迁移。
    await reloadFrom({ consoleView: { tab: 'overview', resource: 'guild' } }, '#config-group-cityWar');
    await config('world', 'cityWar');
    await reloadFrom({ consoleView: { tab: 'resources', resource: 'heroes' } }, '#config-group-equipment-legacy');
    await config('equipment', 'forge');
    await reloadFrom({ consoleView: { tab: 'missing-page', resource: 'heroes' } });
    await tab('overview');
    await page.waitForFunction(() => history.state?.consoleView?.tab === 'overview');
    await reloadFrom({ consoleView: { tab: 'resources', resource: 'missing-resource' } });
    await tab('resources', 'guild');
    await reloadFrom(null, '#journal');
    await tab('overview');
    await page.locator('#journal-dialog[open]').waitFor();
    await page.keyboard.press('Escape');
    await main('resources');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await tab('resources', 'guild');
    assert.equal(new URL(page.url()).hash, '');
    await reloadFrom(null, '#pirate-first-kill');
    await tab('stages');
    await main('overview');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await tab('overview');
    assert.equal(new URL(page.url()).hash, '');
    await context.close();
    console.log('通过：' + name + ' 首次配置、分类和生产分组刷新恢复，缓存返回、切离配置、顶级活动、杂项子页、旧活动迁移、深链与无效状态回退');
  }
  assert.deepEqual(errors, []);
  assert.equal(settingsWrites, 0, '导航不保存配置');
  assert.equal(connections, 0, '导航不连接游戏');
  const after = loadAutomationSettings(account);
  assert.equal(after.revision, baseline.revision);
  assert.deepEqual(after.settings, baseline.settings);
  for (const session of app.sessions.values()) {
    assert.equal(session.client, null);
    assert.equal(session.loop.running, false);
  }
  console.log('通过：零配置写入、零游戏连接，导航恢复不改变账号设置');
} finally {
  await browser?.close();
  app.server.closeAllConnections();
  await app.close();
  GameClient.prototype.connect = originalConnect;
  if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('cw-navigation-browser-')) throw new Error('拒绝清理意外目录');
  fs.rmSync(directory, { recursive: true, force: true });
}
