// 用隔离账号检查真实弹层的可见区域和命中结果，禁止连接游戏。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-dropdowns-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
process.env.CW_RESOURCE_AUTO_UPDATE = '0';
fs.writeFileSync(process.env.CW_CONFIG_PACK, JSON.stringify([[0, 'BuildingCfg', {
  data: Array.from({ length: 30 }, (_, i) => ({ buildingType: String(i + 1), name: '验收建筑' + (i + 1) })),
}]]));
const { saveStore } = await import('../src/accounts.mjs');
const { defaultSettings, saveAutomationSettings, loadAutomationSettings } = await import('../src/automation-settings.mjs');
const { GameClient } = await import('../src/client.mjs');
const { createConsole } = await import('../src/server.mjs');
let connections = 0;
GameClient.prototype.connect = async () => { connections++; throw new Error('下拉框验收禁止连接游戏'); };
saveStore({ version: 1, activeId: 'dropdown-test', accounts: [{
  id: 'dropdown-test', label: '下拉框验收账号', url: 'wss://fixture.invalid', login: {},
  automation: { enabled: false, autoStart: false, paused: true },
}] });
saveAutomationSettings('dropdown-test', defaultSettings(), { revision: 0 });
const app = createConsole({ port: 0, protocol: {} });
const output = path.resolve('output/dropdowns');
fs.mkdirSync(output, { recursive: true });
let browser;
const errors = [];

// 四角与中心必须能命中面板自身；仅有 bounding box 无法发现祖先裁切。
async function assertPanel(page, selector) {
  await page.waitForFunction(selector => {
    const panel = document.querySelector(selector);
    if (!panel) return false;
    const rect = panel.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10 || rect.left < 0 || rect.top < 0 || rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1) return false;
    return [[rect.left + 8, rect.top + 8], [rect.right - 8, rect.top + 8], [rect.left + 8, rect.bottom - 8], [rect.right - 8, rect.bottom - 8], [(rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2]]
      .every(([x, y]) => panel.contains(document.elementFromPoint(x, y)));
  }, selector, { timeout: 2500 });
}

try {
  const base = await app.listen();
  const executablePath = [process.env.CW_BROWSER_TEST_EXECUTABLE, chromium.executablePath(),
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(file => file && fs.existsSync(file));
  assert(executablePath, '未找到测试浏览器');
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.locator('#account-picker-title').filter({ hasText: '下拉框验收账号' }).waitFor();
  await page.locator('#tabs [data-tab=settings]').click();
  await page.locator('#config-field-building-disabledTypes').waitFor();
  const root = '#config-field-building-disabledTypes';
  const panel = root + ' .config-multi-panel';
  await page.locator(root + ' > summary').click();
  await page.screenshot({ path: path.join(output, 'building-desktop.png'), animations: 'disabled' });
  await assertPanel(page, panel);
  console.log('通过：禁止建筑下拉完整越过配置卡片边界，四角和中心均可操作');
  assert.match(await page.locator('#tabs [data-tab=settings]').textContent(), /挂机配置/);
  assert.match(await page.locator('#config-account-name').textContent(), /的挂机配置$/);
  await page.locator(panel + ' input[type=search]').fill('验收建筑30');
  await page.locator(panel + ' input[type=checkbox]').check();
  await page.locator('#config-state').filter({ hasText: '配置已同步' }).waitFor();
  assert.match(await page.locator(root + ' > summary').textContent(), /验收建筑30/);
  await page.locator(panel + ' input[type=search]').fill('');
  await assertPanel(page, panel);
  await page.setViewportSize({ width: 1440, height: 800 });
  await assertPanel(page, panel);
  assert.equal(await page.locator(root).evaluate(node => node.classList.contains('open-up')), true);
  await page.screenshot({ path: path.join(output, 'building-up.png'), animations: 'disabled' });
  await page.evaluate(() => window.scrollBy(0, 60));
  await assertPanel(page, panel);
  await page.waitForFunction(selector => {
    const node = document.querySelector(selector);
    const trigger = node.querySelector('summary').getBoundingClientRect();
    const menu = node.querySelector('.config-multi-panel').getBoundingClientRect();
    return Math.min(Math.abs(menu.top - trigger.bottom - 4), Math.abs(trigger.top - menu.bottom - 4)) < 2;
  }, root);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator(root).getAttribute('open'), null);
  assert.equal(await page.locator(root + ' > summary').evaluate(node => node === document.activeElement), true);
  console.log('通过：搜索、勾选、自动保存、向上展开、滚动跟随及 Escape 返回焦点');

  for (const viewport of [{ width: 360, height: 800 }, { width: 900, height: 440 }]) {
    await page.setViewportSize(viewport);
    await page.locator(root + ' > summary').scrollIntoViewIfNeeded();
    await page.locator(root + ' > summary').click();
    await assertPanel(page, panel);
    await page.locator(panel + ' .config-option-list').evaluate(node => { node.scrollTop = node.scrollHeight; });
    await page.locator(panel + ' input[type=checkbox]').last().click();
    await assertPanel(page, panel);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(output, 'building-' + viewport.width + '.png'), animations: 'disabled' });
    await page.keyboard.press('Escape');
  }
  console.log('通过：360px 窄屏和矮窗口完整显示，列表底部选项可滚动点击');

  const types = page.locator('#config-field-treasure-qualities');
  const selectAll = types.getByRole('button', { name: '全选常规参与货轮类型' });
  const clearTypes = types.getByRole('button', { name: '清空选择', exact: true });
  const openTypes = async () => {
    await page.evaluate(() => {
      configActivate('world'); configActivateGroup('treasure');
      configCollapsed.clear(); configUpdateVisibility();
    });
    await types.locator('summary').click();
    await clearTypes.waitFor();
  };
  const savedTypes = async expected => {
    await page.locator('#config-state').filter({ hasText: '配置已同步' }).waitFor();
    assert.deepEqual(loadAutomationSettings('dropdown-test').settings.treasure.qualities, expected);
  };
  for (const viewport of [{ width: 1440, height: 1200 }, { width: 360, height: 800 }]) {
    await page.setViewportSize(viewport);
    await openTypes();
    assert.equal(await types.locator('input:checked').count(), 3);
    assert.equal(await selectAll.isDisabled(), true, '全部勾选时禁用全选按钮');
    assert.equal(await clearTypes.isEnabled(), true);
    const menu = await types.locator('.config-multi-panel').boundingBox();
    const first = await selectAll.boundingBox(), second = await clearTypes.boundingBox();
    for (const box of [first, second]) {
      assert(box.x >= menu.x && box.x + box.width <= menu.x + menu.width + 1);
      assert(box.y >= menu.y && box.y + box.height <= menu.y + menu.height + 1);
    }
    const gap = second.x - (first.x + first.width);
    assert(gap >= 0 && gap <= 16 && Math.abs(first.y - second.y) <= 1, '底部操作按钮应并排相邻');
    if (viewport.width === 1440) await types.locator('.config-multi-panel').screenshot({
      path: path.join(output, 'treasure-types-footer.png'), animations: 'disabled',
    });
    await clearTypes.click();
    assert.equal(await types.locator('input:checked').count(), 0);
    assert.equal(await clearTypes.isDisabled(), true, '空选时禁用清空按钮');
    assert.equal(await selectAll.isEnabled(), true);
    await savedTypes([]);
    await page.reload();
    await page.locator('#tabs [data-tab=settings]').click();
    await types.waitFor({ state: 'attached' });
    await openTypes();
    assert.equal(await clearTypes.isDisabled(), true);
    await types.getByRole('checkbox', { name: '中型货轮' }).check();
    assert.equal(await selectAll.isEnabled(), true);
    assert.equal(await clearTypes.isEnabled(), true);
    await selectAll.press('Enter');
    assert.equal(await types.locator('input:checked').count(), 3);
    assert.equal(await selectAll.isDisabled(), true);
    await savedTypes(['ORANGE', 'PURPLE', 'BLUE']);
    await page.keyboard.press('Escape');
    assert.equal(await types.getAttribute('open'), null);
  }
  console.log('通过：货轮类型底部按钮在宽屏与窄屏相邻，随勾选更新，鼠标清空与键盘全选均保存');

  await page.setViewportSize({ width: 1440, height: 1200 });
  // 实际配置分组逐一检查；展开参数折叠区，但不改变业务开关。
  const groups = await page.evaluate(() => [...configEditor.groups.keys()]);
  let inspected = 0;
  for (const id of groups) {
    await page.evaluate(id => {
      const group = configEditor.groups.get(id);
      configActivate(group.category, false, false); configActivateGroup(id, false, false);
      configCollapsed.clear(); configUpdateVisibility();
      for (const section of document.querySelectorAll('#config-group-' + id + ' details.config-field-section')) section.open = true;
    }, id);
    const summaries = page.locator('#config-group-' + id + ' details.config-multi > summary:visible');
    for (let i = 0; i < await summaries.count(); i++) {
      const summary = summaries.nth(i);
      const menuId = await summary.evaluate(node => node.parentElement.id);
      await summary.click();
      await assertPanel(page, '#' + menuId + ' .config-multi-panel');
      await page.keyboard.press('Escape');
      inspected++;
    }
  }
  assert(inspected >= 10, '需要覆盖多个配置分组');
  console.log('通过：逐一检查 ' + inspected + ' 个可见配置多选下拉');
  await page.locator('#config-preview-scope').click();
  await page.locator('#config-preview-scope option').last().scrollIntoViewIfNeeded();
  await assertPanel(page, '#config-preview-scope option:last-child');
  await page.keyboard.press('Escape');
  console.log('通过：原生单选下拉的末尾选项完整可见，不受卡片边界裁切');

  // 复用真实渲染器，分别覆盖盟友异步刷新、活动详情、联盟互助的调用路径。
  await page.evaluate(() => {
    const host = document.createElement('div'); host.id = 'dropdown-fixture'; host.style.cssText = 'overflow:clip;padding:16px;margin-top:30px;border:1px solid;width:400px';
    document.querySelector('#tab-settings').append(host);
    const members = Array.from({ length: 24 }, (_, i) => ({ id: String(1000 + i), name: '验收盟友' + i }));
    configEditor.playerData = { members, guildName: '验收联盟' };
    host.append(configPlayerPicker({ key: 'treasure.followPlayerIds', label: '跟随名单' }, 'player-fixture'));
    renderActivitySettingsFields(host, {
      data: { settings: { guildShip: { disabledMaterials: [] } }, catalog: { materials: members.map(row => ({ value: Number(row.id), label: row.name })) } },
      fields: [{ key: 'guildShip.disabledMaterials', label: '禁止消耗物料', kind: 'multi', catalog: 'materials' }],
      saving: false, prefix: 'activity-fixture', dataset: 'guildShipSetting', save: () => {}, title: '联盟商船', note: '',
    });
    mutualDrafts.set(current, { target: 20, mode: 'selected', memberIds: [], askEnabled: false, askTarget: 20, askItemId: '', checkEverySeconds: 15,
      data: { members, materials: [] }, loading: false, version: 0, savedVersion: 0, valid: true, saving: null, saveError: '' });
    renderGuildMutual(host, {}, current);
  });
  const fixtureSummaries = page.locator('#dropdown-fixture details.config-multi > summary');
  assert.equal(await fixtureSummaries.count(), 3);
  for (let i = 0; i < 3; i++) {
    const summary = fixtureSummaries.nth(i);
    await summary.click();
    const selector = '#dropdown-fixture details.config-multi[open] .config-multi-panel';
    await assertPanel(page, selector);
    if (i === 0) {
      await page.locator(selector + ' input[type=checkbox]').first().check();
      await assertPanel(page, selector);
      assert.equal(await page.locator('#player-fixture .config-player-tag').count(), 1);
    }
    await page.screenshot({ path: path.join(output, 'shared-' + i + '.png'), animations: 'disabled' });
    await page.keyboard.press('Escape');
  }
  await fixtureSummaries.first().click();
  await page.evaluate(() => { document.querySelector('#dropdown-fixture').hidden = true; });
  await page.waitForFunction(() => !document.querySelector('.config-multi-panel:popover-open'));
  await page.evaluate(() => { document.querySelector('#dropdown-fixture').hidden = false; });
  await fixtureSummaries.first().click();
  await page.evaluate(() => document.querySelector('#dropdown-fixture').remove());
  await page.waitForFunction(() => !document.querySelector('.config-multi-panel:popover-open'));
  console.log('通过：跟随盟友、活动物料及联盟互助共用弹层；父容器隐藏或移除后无残留');

  for (const viewport of [{ width: 1440, height: 1000 }, { width: 360, height: 800 }]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator('#account-picker-trigger').click();
    await assertPanel(page, '#account-picker-list');
    await page.keyboard.press('Escape');
    await page.locator('#theme-trigger').click();
    await assertPanel(page, '#theme-menu');
    await page.keyboard.press('Escape');
    await page.locator('#tabs [data-tab=account]').click();
    await page.locator('.account-card-menu > summary').first().click();
    await assertPanel(page, '.account-card-menu[open] .account-menu-content');
    await page.locator('.account-card-menu > summary').first().click();
  }
  const mobile = await browser.newPage({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true });
  mobile.on('pageerror', error => errors.push(error.message));
  await mobile.goto(base);
  await mobile.locator('#account-picker-title').filter({ hasText: '下拉框验收账号' }).waitFor();
  await mobile.locator('#tabs [data-tab=settings]').tap();
  await mobile.locator(root + ' > summary').tap();
  await assertPanel(mobile, panel);
  await mobile.screenshot({ path: path.join(output, 'building-touch.png'), animations: 'disabled' });
  await mobile.locator('#tabs [data-tab=account]').tap();
  await mobile.waitForFunction(() => !document.querySelector('.config-multi-panel:popover-open'));
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []); assert.equal(connections, 0);
  console.log('通过：桌面和手机的账号选择、主题、更多账号操作菜单均无遮挡；触屏展开及切页收起正常，无脚本错误或游戏连接');
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) {
    await page.screenshot({ path: path.join(output, 'failure.png'), animations: 'disabled' });
    console.error(await page.evaluate(() => ({ state: document.querySelector('#config-state')?.textContent, errors: configEditor.errors })), errors);
  }
  throw error;
} finally {
  await browser?.close(); app.server.closeAllConnections(); await app.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
