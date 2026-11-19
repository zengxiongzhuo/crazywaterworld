// 真实控制台页面与 HTTP 操作链路；所有游戏请求由 protobuf 夹具处理。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-silicon-actions-browser-'));
process.env.CW_DATA_DIR = directory; process.env.CW_CONFIG_PACK = path.join(directory, 'config.json'); process.env.CW_RESOURCE_AUTO_UPDATE = '0';
const { siliconFixture } = await import('./fixtures/silicon.mjs');
const { defaultSettings, saveAutomationSettings, loadAutomationSettings } = await import('../src/automation-settings.mjs');
const { saveStore } = await import('../src/accounts.mjs');
const { createConsole } = await import('./fixtures/console-server.mjs');
const { GameClient } = await import('../src/client.mjs');
GameClient.prototype.connect = async () => { throw Error('快捷操作验收禁止建立真实游戏连接'); };
const f = siliconFixture();
fs.writeFileSync(process.env.CW_CONFIG_PACK, JSON.stringify(Object.entries(f.config.tables).map(([name, table], i) => [i, name, table])));
saveStore({ activeId: 'shortcut-ui', accounts: [{ id: 'shortcut-ui', label: '硅矿快捷操作验收', url: 'wss://invalid.invalid', login: {}, automation: { paused: true, enabled: false } }] });
const settings = defaultSettings(); settings.silicon.enabled = true; settings.silicon.fleets[0].enabled = true;
saveAutomationSettings('shortcut-ui', settings, { revision: 0 });
const beforeSettings = JSON.stringify(loadAutomationSettings('shortcut-ui'));
const app = createConsole({ port: 0, protocol: f.protocol }), base = await app.listen();
await fetch(base + '/api/settings?account=shortcut-ui'); const session = app.sessions.get('shortcut-ui');
session.client = f.client; session.player = f.player; session.paused = false;
const output = path.resolve('output/silicon-shortcuts'); fs.mkdirSync(output, { recursive: true });
const executablePath = [process.env.CW_BROWSER_TEST_EXECUTABLE, chromium.executablePath(), 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(file => file && fs.existsSync(file));
let browser; const errors = [];
try {
  browser = await chromium.launch({ executablePath, headless: true });
  for (const [name, width, theme] of [['desktop', 1440, 'light'], ['dark', 1440, 'dark'], ['mobile', 390, 'light'], ['small-mobile', 320, 'light']]) {
    for (const id of ['1远征船', '2远征船', '3远征船']) f.returnFleet(id);
    f.occupy('1远征船', 5000, 0, 2);
    const page = await browser.newPage({ viewport: { width, height: 1000 }, hasTouch: width <= 600, isMobile: width <= 600 }); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/world/overview?*', route => route.fulfill({ json: { checkedAt: Math.floor(Date.now() / 1000), scenario: 1, width: 1, height: 1, regions: [], owners: [], points: [], routes: [], fleets: [], cityWars: [], treasures: [], layers: {}, notes: [] } }));
    await page.route('**/api/overview?*', async route => { const status = await (await fetch(base + '/api/loop?account=shortcut-ui')).json(); await route.fulfill({ json: { player: { nickname: '硅矿验收船长', level: 36 }, resources: [], status } }); });
    await page.goto(base); await page.locator('#silicon-mines .silicon-mine').nth(2).waitFor();
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
    const orange = page.locator('.silicon-mine[data-tier=ORANGE]'), dialog = page.locator('#silicon-action-dialog');
    const openDispatch = async index => { const slot = orange.locator('.silicon-slot').nth(index); if (width <= 600) await slot.tap(); else await slot.click(); await page.locator('#silicon-slot-popover').getByRole('button', { name: '派遣采集', exact: true }).click(); };
    await openDispatch(1);
    await page.waitForFunction(() => siliconAction?.phase === 'ready');
    assert.match(await dialog.textContent(), /500 汽油/); assert.match(await dialog.textContent(), /撤回后可能再次派遣/);
    assert.equal(await dialog.locator('input[value="1远征船"]').isDisabled(), true);
    assert.equal(await dialog.locator('input[value="2远征船"]').isDisabled(), false);
    const beforeCancel = f.client.writes.length; await page.locator('#silicon-action-cancel').click(); assert.equal(f.client.writes.length, beforeCancel);
    await openDispatch(1); await page.waitForFunction(() => siliconAction?.phase === 'ready');
    await dialog.locator('input[value="3远征船"]').check();
    assert.equal(await dialog.evaluate(node => node.scrollWidth > node.clientWidth + 1), false, name + ' 确认框无横向溢出');
    const bounds = await dialog.boundingBox(); assert(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
    await dialog.screenshot({ path: path.join(output, 'dispatch-' + name + '.png') });
    const before = f.client.writes.length;
    await page.locator('#silicon-action-confirm').click(); await page.waitForFunction(() => !siliconAction && !siliconLoading);
    assert.equal(f.client.writes.length, before + 1); assert.equal(f.client.writes.at(-1).name, 'ChipMineSendFleetRequest'); assert.equal(f.client.writes.at(-1).body.fleetId, '3远征船');
    assert.match(await page.locator('#silicon-feedback').textContent(), /派遣已确认/);
    assert.match(await page.locator('.silicon-fleet').nth(2).textContent(), /前往硅矿/);
    await page.locator('.silicon-fleet').nth(0).getByRole('button', { name: '撤回舰队' }).click(); await page.waitForFunction(() => siliconAction?.phase === 'ready');
    assert.match(await dialog.textContent(), /不消耗汽油或钻石/);
    await dialog.screenshot({ path: path.join(output, 'retreat-' + name + '.png') });
    const fuel = f.state.fuel; await page.locator('#silicon-action-confirm').click(); await page.waitForFunction(() => !siliconAction && !siliconLoading);
    assert.match(await page.locator('#silicon-feedback').textContent(), /撤回已确认/); assert.equal(f.state.fuel, fuel); assert.equal(f.client.writes.at(-1).name, 'ChipMineRetreatRequest');
    assert.equal(await page.locator('.silicon-fleet').nth(0).getByRole('button', { name: '撤回舰队' }).count(), 0);
    f.occupy('2远征船', 3000, 111, 0);
    await page.locator('#silicon-refresh').click(); await page.waitForFunction(() => !siliconLoading);
    assert.equal(await page.locator('.silicon-fleet').nth(1).getByRole('button', { name: '撤回舰队' }).isDisabled(), true);
    const card = page.locator('[data-slot=card]').filter({ has: page.locator('#silicon-overview') });
    await card.screenshot({ path: path.join(output, 'overview-' + name + '.png') });
    if (name === 'desktop') {
      // 超时确认不能继续提交，切号会关闭确认窗口，迟到的预览不会重新打开。
      await openDispatch(2); await page.waitForFunction(() => siliconAction?.phase === 'ready');
      await page.evaluate(() => { siliconAction.quote.expiresAt = Date.now() - 1; });
      await page.waitForFunction(() => document.querySelector('#silicon-action-confirm').disabled);
      assert.match(await page.locator('#silicon-action-expiry').textContent(), /过期/); await page.locator('#silicon-action-cancel').click();
      let entered, release; const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
      await page.route('**/api/silicon/preview?*', async route => { const response = await route.fetch(); entered(); await gate; await route.fulfill({ response }); });
      await openDispatch(2); await started;
      await page.evaluate(() => { current = null; siliconAccountChanged(); });
      assert.equal(await dialog.isVisible(), false); release(); await page.waitForTimeout(80); assert.equal(await dialog.isVisible(), false);
    }
    assert.deepEqual(errors, []); await page.close(); console.log('通过：' + name + ' 确认/取消、选队派遣、零费用撤回、首奖禁用、布局与截图');
  }
  assert.equal(JSON.stringify(loadAutomationSettings('shortcut-ui')), beforeSettings);
  assert.deepEqual([...new Set(f.client.writes.map(row => row.name))].sort(), ['ChipMineRetreatRequest', 'ChipMineSendFleetRequest']);
  console.log('通过：完整页面链路、确认过期与迟到预览隔离；配置未改动，无真实游戏连接');
} finally {
  await browser?.close(); session.client = null; app.server.closeAllConnections(); await app.close();
  if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('cw-silicon-actions-browser-')) throw Error('拒绝清理意外目录');
  fs.rmSync(directory, { recursive: true, force: true });
}
