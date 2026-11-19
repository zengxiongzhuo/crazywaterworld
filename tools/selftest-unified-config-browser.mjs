// 隔离账号验证模块启停与配置共页；禁止连接真实游戏。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-unified-config-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
process.env.CW_RESOURCE_AUTO_UPDATE = '0';
fs.writeFileSync(process.env.CW_CONFIG_PACK, JSON.stringify([[1, 'HeroCfg', { data: [
  { id: '瑞文', name: '骑士瑞文', quality: 'PURPLE', type: '英雄' },
  { id: '波奇', name: '波奇', quality: 'PURPLE', type: '英雄' },
  { id: '训练目标', name: '训练木人', quality: 'PURPLE', type: 'NPC' },
] }], [2, 'BuildingUnlockCfg', { data: [1, 2, 3].map(id => ({ buildingType: '远征船', buildingId: id + '远征船' })) }]]));
const { saveStore } = await import('../src/accounts.mjs');
const { defaultSettings, saveAutomationSettings, loadAutomationSettings, settingsUiRules } = await import('../src/automation-settings.mjs');
const { GameClient } = await import('../src/client.mjs');
const { observeOwnedFleets } = await import('../src/fleet-catalog.mjs');
const { createConsole } = await import('../src/server.mjs');
let connections = 0;
GameClient.prototype.connect = async () => { connections++; throw new Error('配置验收禁止连接游戏'); };
saveStore({ version: 1, activeId: 'config-a', accounts: ['config-a', 'config-b'].map((id, index) => ({
  id, label: '配置验收账号' + (index + 1), url: 'wss://fixture.invalid', login: {},
  automation: { enabled: false, autoStart: false, paused: true },
})) });
const settings = defaultSettings();
settings.factory.enabled = true; settings.factory.produce = false; settings.factory.keepStock = 321;
settings.heroes.enabled = true; settings.loop.heroes = false; settings.heroes.level = false; settings.heroes.star = true;
settings.heroes.needsSelection = true;
settings.antique.maxActions = 7; settings.antique.checkEverySeconds = 90;
settings.museum.runEnabled = true; settings.museum.enabled = settings.museum.upgrade = false;
settings.lineups.presets = [
  { id: 'boss-first', name: '世界Boss一队', formation: { presetId: 1, heroPositions: [{ heroId: '瑞文', pos: { x: 4, y: 4 } }], petUid: '0' } },
  { id: 'boss-second', name: '世界Boss二队', formation: { presetId: 1, heroPositions: [{ heroId: '波奇', pos: { x: 4, y: 4 } }], petUid: '0' } },
];
saveAutomationSettings('config-a', settings, { revision: 0 });
const otherSettings = defaultSettings();
otherSettings.heroes.heroIds = ['训练目标'];
saveAutomationSettings('config-b', otherSettings, { revision: 0 });
const otherBefore = loadAutomationSettings('config-b');
const output = path.resolve('output/unified-config'); fs.mkdirSync(output, { recursive: true });
const museumOutput = path.resolve('output/playwright/unified-config'); fs.mkdirSync(museumOutput, { recursive: true });
const app = createConsole({ port: 0, protocol: {} });
let browser;
const errors = [];
try {
  const base = await app.listen();
  await fetch(base + '/api/settings?account=config-a');
  const bossSession = app.sessions.get('config-a');
  bossSession.player = { playerId: 123, worldId: 1001001 };
  observeOwnedFleets(bossSession, [1, 2, 3].map(id => ({ buildingId: id + '远征船' })), { complete: true });
  const executablePath = process.env.CW_BROWSER_TEST_EXECUTABLE || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find(fs.existsSync);
  assert(executablePath, '未找到测试浏览器');
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  const saved = () => page.locator('#config-state').filter({ hasText: '配置已同步' }).waitFor();
  const openConfig = async () => {
    await page.locator('#account-picker-title').filter({ hasText: '配置验收账号' }).waitFor();
    await page.locator('#tabs [data-tab=settings]').click();
    await page.locator('#config-field-building-enabled').waitFor({ state: 'attached' }); await saved();
  };
  const group = async id => {
    await page.evaluate(id => {
      const item = configEditor.groups.get(id);
      configActivate(item.category); configActivateGroup(id);
    }, id);
    await page.locator('#config-group-' + id).waitFor();
  };
  await page.goto(base); await openConfig();
  assert.equal(await page.locator('#tabs [data-tab=idle], #tab-idle').count(), 0);
  assert.equal(await page.locator('#tabs [data-tab=lineups]').count(), 1);
  assert.equal(await page.getByText('前往挂机启停', { exact: true }).count(), 0);
  for (const control of settingsUiRules().moduleControls) {
    const selector = '[data-config-key="' + control.key + '"]';
    assert.equal(await page.locator(selector).count(), 1, control.key + ' 唯一');
    assert.equal(await page.locator('#config-group-' + control.configTarget + ' ' + selector).count(), 1, control.key + ' 配置归属');
  }
  assert.equal(await page.locator('[data-config-key="loop.heroes"]').count(), 0);
  for (const key of ['guildAidCollect', 'guildAidHelp', 'petCollect', 'petBreed', 'museumCollect', 'museumExplore', 'museumRevenue', 'museumAchievements', 'radarAuto', 'radarRepair', 'worldBossDamage']) {
    assert.equal(await page.locator('[data-config-key="schedule.' + key + '"]').count(), 0, '退役开关不再显示：' + key);
  }
  assert.equal(await page.locator('#config-root').getByText(/沿用原规则|旧规则/).count(), 0, '实际配置页面没有兼容规则文案');
  for (const key of ['alliance.mutual', 'alliance.autoHelp', 'alliance.autoAsk']) {
    assert.equal(await page.locator('#config-group-alliance [data-config-key="' + key + '"]').count(), 1, '互助只保留统一入口');
  }
  assert.equal(await page.locator('#config-root').getByRole('button', { name: /重新载入/ }).count(), 0);
  assert.equal(await page.locator('#config-root').getByText(/上次保存/).count(), 0);
  console.log('通过：30个模块开关各自归位，旧导航与跨页跳转移除');

  await group('resourceFields');
  const fieldConfig = page.locator('#config-group-resourceFields');
  const refillAfterLoss = fieldConfig.getByRole('switch', { name: '失地后自动补齐', exact: true });
  const ratioMode = fieldConfig.getByRole('radio', { name: '按比例' });
  const quotaMode = fieldConfig.getByRole('radio', { name: '按配额' });
  const fieldCount = (resource, mode) => fieldConfig.getByRole('spinbutton', { name: resource + mode, exact: true });
  assert(await ratioMode.isChecked());
  assert.equal(await refillAfterLoss.isChecked(), false);
  await refillAfterLoss.click(); await saved();
  assert.equal(loadAutomationSettings('config-a').settings.resourceFields.refillAfterLoss, true);
  assert.equal(loadAutomationSettings('config-a').settings.resourceFields.enabled, false);
  assert.equal(await fieldCount('汽油', '比例').inputValue(), '3');
  assert.equal(await fieldCount('种子', '比例').inputValue(), '1');
  assert.equal(await fieldCount('科技点', '比例').inputValue(), '6');
  assert.equal(await fieldCount('汽油', '配额').count(), 0);
  await fieldCount('汽油', '比例').fill('0'); await saved();
  await quotaMode.check(); await fieldCount('种子', '配额').fill('2'); await saved();
  assert.equal(await fieldCount('汽油', '比例').count(), 0);
  await page.reload(); await openConfig(); await group('resourceFields');
  assert(await quotaMode.isChecked());
  assert(await refillAfterLoss.isChecked());
  assert.equal(await fieldCount('种子', '配额').inputValue(), '2');
  await ratioMode.check(); await saved();
  assert.equal(await fieldCount('汽油', '比例').inputValue(), '0');
  await fieldConfig.screenshot({ path: path.join(museumOutput, 'resource-fields-ratio.png'), animations: 'disabled' });
  console.log('通过：资源田可保存零比例和独立配额，刷新保留分配模式、两套数值及失地补齐开关');

  await group('worldBoss');
  const bossReward = page.locator('#config-field-schedule-worldBossRewards');
  assert.equal(await page.locator('[data-config-key="schedule.worldBossRewards"]').count(), 1);
  assert.equal(await page.locator('#config-group-worldBoss [data-config-key="schedule.worldBossRewards"]').count(), 1);
  assert.equal(await page.locator('#config-group-worldBoss').getByText('每日首战自动派遣', { exact: true }).count(), 1);
  assert.equal(await page.locator('#config-field-worldBoss-enabled').getAttribute('aria-checked'), 'false');
  await bossReward.click(); await saved();
  assert.equal(loadAutomationSettings('config-a').settings.schedule.worldBossRewards, true);
  assert.equal(loadAutomationSettings('config-a').settings.worldBoss.enabled, false);
  await page.reload(); await openConfig(); await group('worldBoss');
  assert.equal(await bossReward.getAttribute('aria-checked'), 'true');
  await page.screenshot({ path: path.join(museumOutput, 'world-boss-rewards.png'), animations: 'disabled' });
  await bossReward.click(); await saved();
  assert.equal(loadAutomationSettings('config-a').settings.schedule.worldBossRewards, false);
  assert(!Object.hasOwn(loadAutomationSettings('config-a').settings.schedule, 'worldBossDamage'));
  await group('daily-challenges');
  assert.deepEqual(await page.locator('#config-group-daily-challenges [data-config-key]').evaluateAll(nodes => nodes.map(node => node.dataset.configKey)),
    ['schedule.leagueCollect', 'schedule.leaguePassRewards']);
  console.log('通过：世界Boss只有一个领奖入口，自动保存及刷新保留选择，首战派遣保持独立');

  await group('worldBoss');
  const bossFleets = page.locator('#config-field-worldBoss-fleetIds');
  const bossLineups = page.locator('#config-field-worldBoss-fleetPresets');
  const bossDisclosure = page.getByRole('button', { name: /^首战参与舰队，(?:展开|收起)下级设置$/ });
  const fleetLineup = id => bossLineups.locator('[data-lineup-binding="fleet:' + id + '远征船"]');
  assert.equal(await bossDisclosure.getAttribute('aria-expanded'), 'false');
  assert.equal(await bossLineups.isVisible(), false, '逐队阵容设置默认收起');
  await bossDisclosure.click();
  assert.equal(await bossDisclosure.getAttribute('aria-expanded'), 'true');
  assert.equal(await bossLineups.getByText('请先勾选参与舰队以逐队指定阵容。', { exact: true }).isVisible(), true);
  await bossFleets.locator('summary').click();
  await bossFleets.getByRole('button', { name: '全选首战参与舰队', exact: true }).click();
  await bossFleets.locator('summary').click(); await saved();
  assert.deepEqual(loadAutomationSettings('config-a').settings.worldBoss.fleetIds, ['1远征船', '2远征船', '3远征船']);
  assert.equal(await bossLineups.locator('select:visible').count(), 3);
  await fleetLineup(1).selectOption('boss-first');
  await fleetLineup(2).selectOption('boss-second'); await saved();
  assert.equal(await fleetLineup(3).inputValue(), '', '未指定的舰队沿用当前阵容');
  const expectedFleetPresets = [{ buildingId: '1远征船', presetId: 'boss-first' }, { buildingId: '2远征船', presetId: 'boss-second' }];
  assert.deepEqual(loadAutomationSettings('config-a').settings.worldBoss.fleetPresets, expectedFleetPresets);
  const beforeCollapse = loadAutomationSettings('config-a');
  await bossDisclosure.click();
  assert.equal(await bossDisclosure.getAttribute('aria-expanded'), 'false');
  assert.equal(await bossLineups.isVisible(), false);
  assert.deepEqual(loadAutomationSettings('config-a'), beforeCollapse, '收起仅改变显示，不保存或清空舰队与阵容');
  await bossDisclosure.click();
  assert.equal(await fleetLineup(1).inputValue(), 'boss-first');
  assert.equal(await fleetLineup(2).inputValue(), 'boss-second');
  await bossFleets.locator('summary').click();
  await bossFleets.getByRole('checkbox', { name: '远征舰队 1 队', exact: true }).uncheck(); await saved();
  assert.equal(await fleetLineup(1).isVisible(), false);
  assert.equal(await fleetLineup(2).inputValue(), 'boss-second');
  await bossFleets.getByRole('checkbox', { name: '远征舰队 1 队', exact: true }).check(); await saved();
  assert.equal(await fleetLineup(1).inputValue(), 'boss-first', '重新勾选恢复此前阵容选择');
  await bossFleets.getByRole('button', { name: '清空选择', exact: true }).click(); await saved();
  assert.deepEqual(loadAutomationSettings('config-a').settings.worldBoss.fleetIds, []);
  assert.deepEqual(loadAutomationSettings('config-a').settings.worldBoss.fleetPresets, expectedFleetPresets);
  assert.match(await bossFleets.locator('summary').textContent(), /自动选一支空闲舰队/);
  assert.equal(await bossLineups.getByText('请先勾选参与舰队以逐队指定阵容。', { exact: true }).isVisible(), true);
  assert.equal(await bossLineups.locator('select:visible').count(), 0);
  await bossFleets.getByRole('button', { name: '全选首战参与舰队', exact: true }).click();
  await bossFleets.locator('summary').click(); await saved();
  await page.reload(); await openConfig(); await group('worldBoss');
  assert.equal(await bossDisclosure.getAttribute('aria-expanded'), 'false', '重新打开页面默认收起');
  assert.equal(await bossLineups.isVisible(), false);
  await page.screenshot({ path: path.join(museumOutput, 'world-boss-collapsed.png'), animations: 'disabled' });
  await bossDisclosure.click();
  assert.equal(await fleetLineup(1).inputValue(), 'boss-first');
  assert.equal(await fleetLineup(2).inputValue(), 'boss-second');
  assert.equal(await fleetLineup(3).inputValue(), '');
  assert.equal(await page.locator('#config-field-worldBoss-enabled').getAttribute('aria-checked'), 'false');
  await page.screenshot({ path: path.join(museumOutput, 'world-boss-fleets.png'), animations: 'disabled' });
  await page.screenshot({ path: path.join(museumOutput, 'world-boss-expanded.png'), animations: 'disabled' });
  console.log('通过：世界Boss阵容默认收起且可展开，收起保留选择，舰队全选、逐队选阵容及刷新保存正确');
  await group('building');

  await page.locator('[data-config-family=production]').click();
  const factory = page.locator('#config-field-factory-enabled');
  await factory.click(); await page.locator('#config-field-factory-keepStock').fill('432'); await saved();
  assert.equal(await factory.getAttribute('aria-checked'), 'false');
  assert.equal(await page.locator('#config-field-factory-produce').getAttribute('aria-checked'), 'false');
  assert.equal(loadAutomationSettings('config-a').settings.factory.enabled, false);
  assert.equal(loadAutomationSettings('config-a').settings.factory.keepStock, 432);
  assert.equal(loadAutomationSettings('config-a').settings.factory.produce, false);
  await page.screenshot({ path: path.join(output, 'factory-desktop.png'), animations: 'disabled' });
  await page.reload(); await openConfig(); await page.locator('[data-config-family=production]').click();
  assert.equal(await factory.getAttribute('aria-checked'), 'false');
  assert.equal(await page.locator('#config-field-factory-keepStock').inputValue(), '432');
  await factory.focus(); await page.keyboard.press('Space'); await saved();
  assert.equal(loadAutomationSettings('config-a').settings.factory.enabled, true);
  assert.equal(loadAutomationSettings('config-a').settings.factory.produce, false);
  console.log('通过：模块暂停与参数一同保存，刷新、键盘启用不改细项');

  await page.locator('#tabs [data-tab=resources]').click();
  await page.locator('[data-resource-tab=heroes]').click();
  assert.equal(await page.locator('#hero-plan, #hero-run, #hero-view, #hero-table, #formation-view').count(), 0);
  assert.equal(await page.locator('#tab-heroes').getByRole('link', { name: '养成设置' }).count(), 0);
  for (const title of ['英雄任命', '英雄装备', '装备制造']) {
    assert.equal(await page.locator('#tab-heroes [data-slot=card-title]').filter({ hasText: title }).isVisible(), true);
  }
  await page.locator('#tabs [data-tab=settings]').click();
  await page.locator('[data-config-tab=heroes]').click();
  await page.locator('#config-group-heroes').waitFor();
  const picker = page.locator('#config-field-heroes-heroIds');
  assert.match(await picker.locator('summary').textContent(), /重新选择/);
  await picker.locator('summary').click();
  assert.equal(await picker.getByRole('checkbox', { name: '训练木人' }).count(), 0);
  await picker.getByRole('searchbox').fill('骑士');
  await picker.getByRole('checkbox', { name: '骑士瑞文' }).check();
  await picker.locator('summary').click(); await saved();
  assert.deepEqual(loadAutomationSettings('config-a').settings.heroes.heroIds, ['瑞文']);
  assert.equal(loadAutomationSettings('config-a').settings.heroes.needsSelection, false);
  const advanced = page.locator('#config-group-heroes details').filter({ has: page.getByText('高级设置', { exact: true }) });
  assert.equal(await advanced.getAttribute('open'), null);
  await advanced.locator('summary').click();
  await advanced.getByLabel('目标等级', { exact: true }).fill('35');
  await advanced.locator('summary').click();
  const newActions = ['skillAdvance', 'exclusiveLevel', 'exclusiveStar', 'showSkillReward'];
  for (const action of newActions) {
    const toggle = page.locator('#config-field-heroes-' + action);
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    await toggle.click();
  }
  await saved();
  await page.locator('[data-config-tab=equipment]').click();
  assert.equal(await page.locator('#config-subtab-equipment-growth, #config-group-equipment-growth').count(), 0);
  assert.equal(await page.locator('#config-subtab-equipment-legacy, #config-group-equipment-legacy').count(), 0);
  assert.equal(await page.locator('[data-config-key="schedule.equipmentCollect"], [data-config-key="schedule.equipmentCraft"]').count(), 0);
  assert.equal(await page.locator('#config-group-forge').isVisible(), true);
  assert.equal(await page.locator('#config-group-forge [data-config-key="forge.enabled"]').count(), 1);
  await page.reload(); await openConfig();
  await page.locator('[data-config-tab=equipment]').click();
  assert.equal(await page.locator('#config-subtab-equipment-growth, #config-group-equipment-growth').count(), 0);
  assert.equal(await page.locator('#config-group-forge').isVisible(), true);
  await page.locator('[data-config-tab=heroes]').click();
  await picker.waitFor();
  const growth = loadAutomationSettings('config-a').settings.heroes;
  assert(newActions.every(action => growth[action])); assert.equal(growth.targetLevel, 35);
  await picker.locator('summary').click(); await picker.getByRole('button', { name: '清空选择' }).click();
  await picker.locator('summary').click(); await saved();
  assert.equal(await picker.locator('summary').textContent(), '留空则暂停培养，不影响技能展示领奖');
  assert.deepEqual(loadAutomationSettings('config-a').settings.heroes.heroIds, []);
  console.log('通过：资源页移除手动养成和远征舰队编队并保留其余功能，挂机配置仍可按名称选英雄、保存独立动作及目标、清空名单');
  const hero = page.locator('#config-field-heroes-enabled');
  assert.equal(await hero.getAttribute('aria-checked'), 'false', '组合字段有一项关闭时显示暂停');
  await hero.click(); await saved();
  let stored = loadAutomationSettings('config-a').settings;
  assert.equal(stored.heroes.enabled, true); assert.equal(stored.loop.heroes, true);
  await hero.click(); await saved(); stored = loadAutomationSettings('config-a').settings;
  assert.equal(stored.heroes.enabled, false); assert.equal(stored.loop.heroes, false);
  assert.equal(stored.heroes.level, false); assert.equal(stored.heroes.star, true);
  await group('museum');
  assert.match(await page.locator('#config-field-museum-runEnabled-note').textContent(), /尚未选择执行动作/);
  const museum = page.locator('#config-group-museum');
  const autoExplore = museum.locator('#config-field-museum-enabled');
  for (const key of ['upgrade', 'revenue', 'achievements', 'display']) {
    const action = museum.locator('#config-field-museum-' + key);
    assert(await action.isVisible(), key + ' 在同组直接展示');
    assert.equal(await action.getAttribute('aria-checked'), 'false');
    await action.click(); await saved();
    assert.equal(loadAutomationSettings('config-a').settings.museum[key], true);
    assert.equal(loadAutomationSettings('config-a').settings.museum.enabled, false, key + ' 不依赖自动探宝');
    assert.equal(await page.locator('#config-field-museum-runEnabled-note').isVisible(), false);
    await action.click(); await saved();
  }
  assert.equal(await museum.locator('#config-field-museum-claim, #config-field-museum-explore').count(), 0, '领奖和派遣使用同一个开关');
  assert.equal(await museum.getByRole('switch', { name: '自动探宝', exact: true }).count(), 1);
  assert.equal(await museum.locator('#config-field-museum-factor').isVisible(), false, '探宝关闭时参数隐藏');
  await autoExplore.click(); await saved();
  assert.equal(await page.locator('#config-field-museum-runEnabled-note').isVisible(), false);
  assert.equal(loadAutomationSettings('config-a').settings.museum.enabled, true);
  assert.equal(await museum.locator('#config-field-museum-factor').isVisible(), false, '开启探宝后参数默认折叠');
  await museum.getByRole('button', { name: '自动探宝，展开下级设置', exact: true }).click();
  for (const key of ['factorMode', 'factor', 'maxDispatches', 'maps', 'useGuide']) {
    assert.equal(await museum.locator('#config-field-museum-' + key).isVisible(), true, key + ' 参数直接随自动探宝展开');
  }
  await museum.locator('#config-field-museum-factor').selectOption('2');
  await museum.locator('#config-field-museum-maxDispatches').fill('1'); await saved();
  assert.equal(loadAutomationSettings('config-a').settings.museum.factor, 2, '常规倍率保存数字');
  await museum.locator('#config-field-museum-materialFactor').click();
  await museum.getByRole('button', { name: '根据材料调整倍数，展开下级设置', exact: true }).click();
  await museum.locator('#config-field-museum-matchedFactor').selectOption('3'); await saved();
  assert.equal(loadAutomationSettings('config-a').settings.museum.matchedFactor, 3, '命中倍率保存数字');
  await museum.locator('#config-field-museum-materialFactor').click(); await saved();
  await museum.locator('#config-field-museum-factorMode').selectOption('recommended'); await saved();
  assert.equal(loadAutomationSettings('config-a').settings.museum.factorMode, 'recommended');
  assert.equal(await museum.locator('#config-field-museum-factor').isVisible(), false);
  assert.equal(await museum.locator('#config-field-museum-materialFactor').isVisible(), false);
  assert.equal(await museum.locator('#config-field-museum-fullRecommendedFactor').inputValue(), '3');
  assert.equal(await museum.locator('#config-field-museum-partialRecommendedFactor').inputValue(), '2');
  const fallback = museum.locator('#config-field-museum-noRecommendedFallback');
  const fallbackFactor = museum.locator('#config-field-museum-noRecommendedFactor');
  assert.equal(await fallback.getAttribute('aria-checked'), 'false');
  assert.equal(await fallbackFactor.isVisible(), false);
  await fallback.click(); await saved();
  await museum.getByRole('button', { name: '无推荐英雄时兜底，展开下级设置', exact: true }).click();
  assert.equal(await fallbackFactor.inputValue(), '1');
  await museum.screenshot({ path: path.join(museumOutput, 'museum-recommended-desktop.png'), animations: 'disabled' });
  await museum.locator('#config-field-museum-fullRecommendedFactor').selectOption('2');
  await museum.locator('#config-field-museum-partialRecommendedFactor').selectOption('1');
  await fallbackFactor.selectOption('3'); await saved();
  let factors = loadAutomationSettings('config-a').settings.museum;
  assert.equal(factors.fullRecommendedFactor, 2); assert.equal(factors.partialRecommendedFactor, 1); assert.equal(factors.noRecommendedFactor, 3);
  await fallback.click(); await saved();
  assert.equal(await fallbackFactor.isVisible(), false);
  assert.equal(loadAutomationSettings('config-a').settings.museum.noRecommendedFactor, 3, '关闭兜底保留倍率');
  assert.equal(await museum.locator('#config-field-museum-maps').isVisible(), true);
  await museum.locator('#config-field-museum-factorMode').selectOption('materials'); await saved();
  assert.equal(await museum.locator('#config-field-museum-factor').inputValue(), '2');
  assert.equal(await museum.locator('#config-field-museum-fullRecommendedFactor').isVisible(), false);
  assert.equal(await fallback.isVisible(), false); assert.equal(await fallbackFactor.isVisible(), false);
  assert.equal(loadAutomationSettings('config-a').settings.museum.fullRecommendedFactor, 2);
  assert.equal(loadAutomationSettings('config-a').settings.museum.partialRecommendedFactor, 1);
  await museum.screenshot({ path: path.join(museumOutput, 'museum-actions-desktop.png'), animations: 'disabled' });
  await autoExplore.click(); await saved();
  assert.equal(await museum.locator('#config-field-museum-factor').isVisible(), false);
  assert.equal(loadAutomationSettings('config-a').settings.museum.factor, 2, '暂停自动探宝保留倍数');
  assert.equal(loadAutomationSettings('config-a').settings.museum.enabled, false);
  await page.reload(); await openConfig(); await group('museum');
  assert.equal(await autoExplore.getAttribute('aria-checked'), 'false');
  assert.equal(await museum.locator('#config-field-museum-factor').isVisible(), false);
  await autoExplore.click(); await saved();
  await museum.getByRole('button', { name: '自动探宝，展开下级设置', exact: true }).click();
  assert.equal(await museum.locator('#config-field-museum-factor').inputValue(), '2');
  const savedMuseum = loadAutomationSettings('config-a').settings.museum;
  assert.equal(savedMuseum.enabled, true);
  assert(!Object.hasOwn(savedMuseum, 'claim') && !Object.hasOwn(savedMuseum, 'explore'), '保存后没有拆分动作字段');
  await museum.locator('#config-field-museum-factorMode').selectOption('recommended'); await saved();
  assert.equal(await museum.locator('#config-field-museum-fullRecommendedFactor').inputValue(), '2');
  assert.equal(await museum.locator('#config-field-museum-partialRecommendedFactor').inputValue(), '1');
  assert.equal(await fallback.getAttribute('aria-checked'), 'false');
  await fallback.click(); await saved();
  await museum.getByRole('button', { name: '无推荐英雄时兜底，展开下级设置', exact: true }).click();
  assert.equal(await fallbackFactor.inputValue(), '3');
  console.log('通过：兼容开关和拆分动作开关移除，自动探宝一个开关控制领奖及派遣，参数直接展开且暂停刷新保留');
  console.log('博物馆截图：' + path.join(museumOutput, 'museum-actions-desktop.png'));

  await page.locator('[data-config-tab=antique]').click();
  const antiques = page.locator('#config-group-antique');
  assert.equal(await antiques.locator('#config-field-antique-maxActions, #config-field-antique-checkEverySeconds').count(), 0);
  const antiqueMaster = antiques.getByRole('switch', { name: '藏品养成总开关', exact: true });
  assert.equal(await antiques.locator('fieldset, legend').count(), 0);
  assert.equal(await antiques.locator('.config-disclosure').count(), 4);
  for (const key of ['activate', 'star', 'master', 'suit']) {
    const toggle = antiques.locator('#config-field-antique-' + key);
    assert(await toggle.isVisible() && await toggle.isEnabled());
  }
  await antiqueMaster.click(); await saved();
  assert.match(await antiques.locator('#config-field-antique-enabled-note').textContent(), /尚未选择执行动作/);
  const masterLevel = antiques.locator('#config-field-antique-master');
  await masterLevel.click(); await saved();
  await antiqueMaster.click(); await saved();
  assert.equal(loadAutomationSettings('config-a').settings.antique.enabled, false);
  assert.equal(await masterLevel.getAttribute('aria-checked'), 'true');
  await masterLevel.click(); await saved();
  const savedAntique = loadAutomationSettings('config-a').settings.antique;
  assert.equal(savedAntique.master, false);
  assert.equal(savedAntique.maxActions, 7);
  assert.equal(savedAntique.checkEverySeconds, 90);
  console.log('通过：藏品总开关可单独保存，暂停时四个养成动作可见可编辑');

  assert.equal(await page.locator('[data-config-tab=runtime], #config-field-loop-rounds, #config-group-runtime').count(), 0);
  assert.deepEqual(await page.locator('[data-config-tab]').allTextContents(), ['基地', '世界', '英雄', '藏品', '装备', '日常与活动']);
  await page.locator('#account-picker-trigger').click();
  await page.locator('#account-picker-list [role=option]').filter({ hasText: '配置验收账号2' }).click();
  await page.locator('#config-account-name').filter({ hasText: '配置验收账号2' }).waitFor(); await saved();
  assert.deepEqual(loadAutomationSettings('config-b'), otherBefore, '另一个账号不受编辑影响');
  await group('heroes'); await picker.locator('summary').click();
  const retiredTarget = picker.getByRole('checkbox', { name: '训练木人' });
  assert.equal(await retiredTarget.isChecked(), true);
  await retiredTarget.click(); await saved();
  assert.equal(await retiredTarget.count(), 0);
  assert.deepEqual(loadAutomationSettings('config-b').settings.heroes.heroIds, []);
  await group('factory');
  assert.equal(await page.locator('#config-field-factory-keepStock').inputValue(), String(otherBefore.settings.factory.keepStock));
  await page.locator('#account-picker-trigger').click();
  await page.locator('#account-picker-list [role=option]').filter({ hasText: '配置验收账号1' }).click();
  await page.locator('#config-account-name').filter({ hasText: '配置验收账号1' }).waitFor(); await saved();
  await group('factory');
  assert.equal(await page.locator('#config-field-factory-keepStock').inputValue(), '432');
  console.log('通过：运行安排入口移除，切换账号隔离且保留已保存配置');

  // 外部页面改变版本后，组合开关的本地修改不能静默覆盖它。
  const external = loadAutomationSettings('config-a'); external.settings.factory.keepStock = 876;
  saveAutomationSettings('config-a', external.settings, { revision: external.revision });
  await factory.click();
  await page.locator('#config-state').filter({ hasText: '配置有冲突' }).waitFor();
  assert.match(await page.locator('#config-message').textContent(), /刷新页面.*未保存/);
  assert.equal(loadAutomationSettings('config-a').settings.factory.enabled, true);
  assert.equal(loadAutomationSettings('config-a').settings.factory.keepStock, 876);
  assert.equal(await factory.getAttribute('aria-checked'), 'false', '本地草稿仍保留供处理');
  console.log('通过：合并后的模块开关仍受配置版本冲突保护');

  const context = await browser.newContext({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true });
  const mobile = await context.newPage(); mobile.on('pageerror', error => errors.push(error.message));
  await mobile.goto(base); await mobile.locator('#account-picker-title').filter({ hasText: '配置验收账号1' }).waitFor();
  await mobile.locator('#tabs [data-tab=settings]').tap();
  await mobile.locator('#config-field-building-enabled').waitFor();
  await mobile.locator('[data-config-tab=world]').tap();
  await mobile.locator('#config-field-cityWar-enabled').waitFor();
  await mobile.screenshot({ path: path.join(output, 'world-mobile.png'), animations: 'disabled' });
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mobile.locator('[data-config-tab=base]').tap();
  await mobile.locator('[data-config-family=production]').tap();
  await mobile.locator('#config-field-factory-enabled').tap();
  await mobile.locator('#config-state').filter({ hasText: '配置已同步' }).waitFor();
  assert.equal(loadAutomationSettings('config-a').settings.factory.enabled, false);
  await mobile.screenshot({ path: path.join(output, 'factory-mobile.png'), animations: 'disabled' });
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mobile.locator('#config-state').filter({ hasText: '配置已同步' }).waitFor();
  for (const width of [320, 360, 390, 430, 768]) {
    await mobile.setViewportSize({ width, height: 844 });
    await mobile.evaluate(() => {
      window.scrollTo(0, 0);
      document.querySelector('#log-top-count').textContent = '99999';
      document.querySelector('#loop-every').value = '86400';
    });
    const layout = await mobile.evaluate(() => {
      const controls = ['loop-every', 'loop-toggle', 'account-pause', 'logs-open'].map(id => {
        const node = document.getElementById(id), box = node.getBoundingClientRect();
        return { id, top: box.top, bottom: box.bottom, left: box.left, right: box.right, height: box.height, overflow: node.scrollWidth > node.clientWidth + 1 };
      });
      const bar = document.querySelector('.config-tabs').getBoundingClientRect();
      const tabs = [...document.querySelectorAll('[data-config-tab]')].map(node => {
        const box = node.getBoundingClientRect();
        return { top: box.top, left: box.left, right: box.right, visible: box.left >= bar.left && box.right <= bar.right + 1 && box.top >= bar.top && box.bottom <= bar.bottom + 1, overflow: node.scrollWidth > node.clientWidth + 1 };
      });
      return { controls, tabs, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    assert.equal(layout.overflow, false, width + 'px 页面无横向溢出');
    assert(layout.controls.every(item => Math.abs(item.top - layout.controls[0].top) <= 1 && item.height >= 40 && item.left >= 0 && item.right <= width && !item.overflow), JSON.stringify({ width, layout }));
    assert.equal(layout.tabs.length, 6);
    assert(layout.tabs.every(item => item.visible && !item.overflow && Math.abs(item.top - layout.tabs[0].top) <= 1), JSON.stringify({ width, layout }));
    assert.equal(await mobile.evaluate(() => [...document.querySelectorAll('.config-subtabs,.config-families')].filter(node => node.getClientRects().length).every(bar => {
      const bounds = bar.getBoundingClientRect();
      return [...bar.children].filter(node => node.getClientRects().length).every(node => {
        const box = node.getBoundingClientRect(); return box.top >= bounds.top && box.bottom <= bounds.bottom + 1;
      });
    })), true, width + 'px 触屏子页签的按钮完整位于底座内');
    for (const category of ['daily', 'equipment', 'antique', 'heroes', 'world', 'base']) {
      await mobile.locator('[data-config-tab=' + category + ']').tap();
      assert.equal(await mobile.locator('[data-config-tab=' + category + ']').getAttribute('aria-selected'), 'true');
    }
    await mobile.screenshot({ path: path.join(output, 'header-tabs-' + width + '.png'), animations: 'disabled' });
  }
  console.log('通过：320–768px 手机顶部四项操作同排，六个配置分类完整显示并可点击，大日志数和最大间隔不撑破布局');
  assert.deepEqual(errors, []); assert.equal(connections, 0);
  console.log('通过：360px手机导航、启停和参数无横向溢出，无脚本错误或游戏连接');
} finally {
  await browser?.close(); app.server.closeAllConnections(); await app.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
