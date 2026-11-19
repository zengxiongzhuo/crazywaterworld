// 隔离账号验证跟随名单的真实点击行为，不连接游戏。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-player-picker-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
process.env.CW_RESOURCE_AUTO_UPDATE = '0';
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');
const { saveStore } = await import('../src/accounts.mjs');
const { GameClient } = await import('../src/client.mjs');
const { createConsole } = await import('./fixtures/console-server.mjs');
const { loadAutomationSettings } = await import('../src/automation-settings.mjs');
let connections = 0;
GameClient.prototype.connect = async () => { connections++; throw new Error('名单测试禁止连接游戏'); };
saveStore({ activeId: 'player-picker', accounts: [{
  id: 'player-picker', label: '盟友名单测试', url: 'wss://fixture.invalid', login: {},
  automation: { enabled: false, autoStart: false, paused: true },
}] });
const app = createConsole({ port: 0, protocol: {} });
const output = path.resolve('output/playwright/player-picker');
fs.mkdirSync(output, { recursive: true });
const errors = [];
let browser;
try {
  const base = await app.listen();
  const executablePath = [process.env.CW_BROWSER_TEST_EXECUTABLE, chromium.executablePath(),
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(file => file && fs.existsSync(file));
  assert(executablePath, '未找到测试浏览器');
  browser = await chromium.launch({ executablePath, headless: true });
  for (const mobile of [false, true]) {
    const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile });
    const activate = locator => mobile ? locator.tap() : locator.click();
    page.setDefaultTimeout(5000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/settings/players?*', route => route.fulfill({ json: {
      guildName: '测试联盟', members: [
        { id: '9007199254740993', name: '测试盟友甲', online: true },
        { id: '9007199254740994', name: '测试盟友乙', online: false },
      ],
    } }));
    await page.goto(base + '/#config-group-treasure');
    await page.locator('#config-field-treasure-follow').waitFor();
    if (await page.locator('#config-field-treasure-follow').getAttribute('aria-checked') !== 'true') await activate(page.locator('#config-field-treasure-follow'));
    const disclosure = page.getByRole('button', { name: '跟随指定玩家，展开下级设置', exact: true });
    if (await disclosure.isVisible()) await activate(disclosure);
    const root = page.locator('#config-field-treasure-followPlayerIds');
    const summary = root.locator('summary');
    await activate(summary);
    const search = root.locator('input[type=search]');
    const first = root.locator('input[type=checkbox]').first();
    await first.waitFor();
    await activate(root.locator('.config-player-name').first());
    assert.equal(await first.isChecked(), true, '点击盟友名字应勾选');
    assert.equal(await root.locator('details').getAttribute('open'), '', '点击名字后应保持展开');
    await activate(root.locator('.config-player-name').first());
    assert.equal(await first.isChecked(), false, '再次点击名字应取消勾选');
    await search.fill('9007199254740994');
    await activate(root.locator('.config-option small'));
    assert.equal(await first.isChecked(), true, '点击角色 ID 应勾选');
    assert.equal(await search.isVisible(), true, '点击角色 ID 后列表应保持展开');
    await page.locator('#config-state').filter({ hasText: '配置已同步' }).waitFor();
    assert.deepEqual(loadAutomationSettings('player-picker').settings.treasure.followPlayerIds, ['9007199254740994']);
    // 首次保存可能规范化配置并重绘；重新展开后继续检查交互。
    if (!await search.isVisible()) await activate(summary);
    await search.fill('9007199254740994');
    await page.screenshot({ path: path.join(output, mobile ? 'selected-mobile.png' : 'selected-desktop.png'), animations: 'disabled' });
    await activate(first);
    assert.equal(await first.isChecked(), false, '直接点击勾选框仍能切换');
    await first.press('Space');
    assert.equal(await first.isChecked(), true, '键盘空格仍能切换');
    await first.press('Escape');
    assert.equal(await root.locator('details').getAttribute('open'), null, 'Escape 关闭列表');
    assert.equal(await summary.evaluate(node => node === document.activeElement), true, 'Escape 返回入口焦点');
    await activate(summary);
    await first.waitFor({ state: 'visible' });
    await activate(page.locator('#config-field-treasure-followNames'));
    assert.equal(await root.locator('details').getAttribute('open'), null, '点击外部仍关闭列表');
    await activate(summary);
    await search.press('Shift+Tab');
    await summary.press('Shift+Tab');
    assert.equal(await root.locator('details').getAttribute('open'), null, '键盘移出下拉框仍关闭列表');
    await activate(root.getByRole('button', { name: '从跟随名单移除测试盟友乙', exact: true }));
    await activate(page.locator('#config-field-treasure-follow'));
    await page.locator('#config-state').filter({ hasText: '配置已同步' }).waitFor();
    assert.deepEqual(loadAutomationSettings('player-picker').settings.treasure.followPlayerIds, []);
    await page.close();
    console.log('通过：' + (mobile ? '手机触屏' : '桌面鼠标') + '点击姓名/角色 ID 可选择及取消，自动保存、键盘操作和移出关闭正常');
  }
  assert.deepEqual(errors, []);
  assert.equal(connections, 0);
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) await page.screenshot({ path: path.join(output, 'failure.png'), animations: 'disabled' });
  throw error;
} finally {
  await browser?.close(); app.server.closeAllConnections(); await app.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
