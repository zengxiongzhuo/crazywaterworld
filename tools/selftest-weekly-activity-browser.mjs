// 真浏览器验收周活动配置；隔离账号与数据目录，绝不连接游戏。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-weekly-browser-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
process.env.CW_RESOURCE_AUTO_UPDATE = '0';
fs.writeFileSync(process.env.CW_CONFIG_PACK, JSON.stringify([[1, 'HeroCfg', { data: [] }]]));
const { saveStore } = await import('../src/accounts.mjs');
const { defaultSettings, saveAutomationSettings, loadAutomationSettings } = await import('../src/automation-settings.mjs');
const { GameClient } = await import('../src/client.mjs');
const { createConsole } = await import('./fixtures/console-server.mjs');
let connections = 0;
GameClient.prototype.connect = async () => { connections++; throw Error('周活动配置验收禁止连接游戏'); };
saveStore({ version: 1, activeId: 'weekly-a', accounts: ['weekly-a', 'weekly-b'].map((id, index) => ({
  id, label: '周活动验收账号' + (index + 1), url: 'wss://fixture.invalid', login: {},
  automation: { enabled: false, autoStart: false, paused: true },
})) });
const initial = defaultSettings();
initial.farm.enabled = false; initial.heroes.heroIds = [];
initial.schedule.armsRaceRewards = true;
saveAutomationSettings('weekly-a', initial, { revision: 0 });
saveAutomationSettings('weekly-b', defaultSettings(), { revision: 0 });
const original = loadAutomationSettings('weekly-a').settings;
const other = loadAutomationSettings('weekly-b');
const output = path.resolve('output/playwright'); fs.mkdirSync(output, { recursive: true });
const app = createConsole({ port: 0, protocol: {} });
let browser;
const errors = [];
const kinds = ['farm', 'pet', 'antique', 'order', 'forge', 'hero'];
const field = (page, name) => page.locator('#config-field-weeklyActivity-' + name);
const branch = (page, kind) => page.locator('[data-config-branch="weeklyActivity.' + kind + 'Enabled"]');
const disclosure = (page, kind) => branch(page, kind).locator(':scope > .config-row .config-disclosure');
const expand = async (page, selected = kinds) => {
  for (const kind of selected) {
    const button = disclosure(page, kind);
    if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
  }
};
const saved = async page => {
  try { await page.locator('#config-state').filter({ hasText: '配置已同步' }).waitFor(); }
  catch (error) {
    console.error(await page.locator('#config-message').textContent(), await page.locator('.config-field-error:visible').allTextContents());
    throw error;
  }
};
const open = async page => {
  await page.locator('#account-picker-title').filter({ hasText: '周活动验收账号1' }).waitFor();
  await page.locator('#tabs [data-tab=settings]').click();
  await page.locator('[data-config-tab=daily]').click();
  await page.locator('#config-subtab-weekly-activities').click();
  await page.locator('#config-group-weekly-activities').waitFor(); await saved(page);
};
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
  let rankMode = 'active', rankCalls = 0, delayedRank = null, screenshotNames = false;
  const score = '9007199254740993', scoreText = '9,007,199,254,740,993';
  const rankData = account => ({ key: 'week-cross', label: '军备竞赛', scoreLabel: '积分', page: 1, totalPages: 1,
    checkedAt: Math.floor(Date.now()/1000), settleTime: Math.floor(Date.now()/1000)+3600, status: 'active', grouping: false,
    subjectId: account === 'weekly-b' ? 2 : 3, subjectName: account === 'weekly-b' ? '装备打造' : '海兽培养', roomLevel: 4, reason: '',
    rows: [
      { rank: 1, name: screenshotNames ? '海风船长' : '<img src=x onerror=alert(1)>', playerId: '101', score: 99999999, level: 40, own: false },
      { rank: 2, name: screenshotNames ? '远航水手' : '长昵称测试玩家－海风与远航', playerId: '102', score: 88888888, level: 39, own: false },
      { rank: 3, name: account === 'weekly-b' ? '装备玩家' : '海兽玩家', playerId: '103', score: account === 'weekly-b' ? 678 : score,
        scoreText: account === 'weekly-b' ? '678' : scoreText, level: 37, own: true },
    ], mine: { rank: 3, score: account === 'weekly-b' ? 678 : score, scoreText: account === 'weekly-b' ? '678' : scoreText },
  });
  const mockRank = async route => {
    rankCalls++; assert.equal(route.request().method(), 'GET');
    const account = new URL(route.request().url()).searchParams.get('account'), data = rankData(account);
    if (rankMode === 'delayed' && account === 'weekly-a') {
      await new Promise(resolve => { delayedRank = () => { data.subjectName = '旧账号迟到主题'; void route.fulfill({ json: data }).then(resolve); }; }); return;
    }
    if (rankMode === 'offline') return route.fulfill({ status: 400, json: { error: '游戏未连接，请先连接账号后刷新榜单' } });
    if (rankMode === 'grouping') return route.fulfill({ json: { ...data, status: 'grouping', grouping: true, rows: [], mine: null, reason: '活动正在分组，榜单尚未就绪' } });
    if (rankMode === 'empty') return route.fulfill({ json: { ...data, rows: [], mine: null, reason: '当前榜单暂无玩家记录' } });
    return route.fulfill({ json: data });
  };
  await page.route(url => url.pathname === '/api/activity-ranks/view', mockRank);
  await page.goto(base); await open(page);
  const ranking = page.locator('#config-weekly-ranking'), refreshRanks = page.locator('#config-weekly-ranking-refresh');
  const ranksReady = async () => { await refreshRanks.filter({ hasText: '刷新榜单' }).waitFor(); };
  await ranking.getByText('海兽培养', { exact: true }).waitFor();
  assert.match(await ranking.locator('#config-weekly-ranking-summary').textContent(), /第 3 名/);
  assert.match(await ranking.locator('#config-weekly-ranking-summary').textContent(), /9,007,199,254,740,993/);
  assert.equal(await ranking.locator('tbody tr').count(), 3);
  assert.equal(await ranking.locator('img').count(), 0, '排行榜昵称按纯文本显示');
  assert.equal(await ranking.getByRole('columnheader', { name: '等级', exact: true }).count(), 1);
  assert.equal(await ranking.locator('tbody tr').last().locator('td').last().textContent(), '37');
  assert.equal(await ranking.evaluate(node => !!(document.getElementById('config-form').compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)
    && !!(node.compareDocumentPosition(document.getElementById('config-preview-title')) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
  assert.deepEqual(loadAutomationSettings('weekly-a').settings, original, '读取排行不修改配置');
  const cachedCalls = rankCalls;
  await page.locator('#config-subtab-daily-actions').click(); assert.equal(await ranking.isVisible(), false);
  await page.locator('#config-subtab-weekly-activities').click(); await ranksReady(); assert.equal(rankCalls, cachedCalls);
  await page.locator('#tabs [data-tab=overview]').click();
  await page.locator('#tabs [data-tab=settings]').click(); await saved(page); await ranksReady();
  assert.equal(rankCalls, cachedCalls, '主导航30秒内返回复用榜单');
  await page.evaluate(() => { configWeeklyRanking.at -= 31000; });
  await page.locator('#tabs [data-tab=resources]').click(); await page.locator('#tabs [data-tab=settings]').click();
  await page.waitForFunction(() => configWeeklyRanking.pending === null && Date.now() - configWeeklyRanking.at < 30000);
  assert.equal(rankCalls, cachedCalls + 1, '主导航返回刷新过期榜单');
  const beforeSettleCalls = rankCalls;
  await page.evaluate(() => { configWeeklyRanking.data.settleTime = configWeeklyRanking.data.checkedAt - 1; });
  await page.locator('#config-subtab-daily-actions').click(); await page.locator('#config-subtab-weekly-activities').click();
  await ranksReady(); assert.equal(rankCalls, beforeSettleCalls + 1, '结算时间到达使30秒缓存失效');
  rankMode = 'offline'; await refreshRanks.click(); await ranksReady();
  assert.match(await ranking.locator('#config-weekly-ranking-status').textContent(), /未连接.*上次成功读取/);
  assert.equal(await ranking.locator('tbody tr').count(), 3);
  rankMode = 'grouping'; await refreshRanks.click(); await ranksReady();
  assert.match(await ranking.locator('#config-weekly-ranking-status').textContent(), /正在分组/);
  assert.equal(await ranking.locator('#config-weekly-ranking-table').isVisible(), false);
  assert.match(await ranking.locator('#config-weekly-ranking-summary').textContent(), /未返回/);
  rankMode = 'empty'; await refreshRanks.click(); await ranksReady();
  assert.match(await ranking.locator('#config-weekly-ranking-status').textContent(), /暂无玩家记录/);
  rankMode = 'active'; await refreshRanks.click(); await ranksReady();
  console.log('通过：排行位于执行预览前，只读显示精确大数、缓存/结算刷新、未连接旧榜提示、分组和空榜');
  assert.equal(await page.locator('[data-config-tab=daily]').getAttribute('aria-selected'), 'true');
  assert.equal(await page.getByRole('tab', { name: '军备竞赛', exact: true }).count(), 1);
  assert.equal(await page.locator('#config-subtab-military-week, #config-group-military-week').count(), 0);
  assert.equal(await page.getByRole('tab', { name: '周（每日）活动', exact: true }).count(), 0);
  const dailyTabs = await page.locator('#config-panel-daily [data-config-group]').evaluateAll(tabs => tabs.map(tab => tab.dataset.configGroup));
  assert.equal(dailyTabs.indexOf('ad-rewards'), dailyTabs.indexOf('daily-actions') + 1);
  const military = page.locator('#config-group-weekly-activities');
  assert.equal(await military.locator('details, .config-field-section').count(), 0, '每日主题直接平铺');
  assert.equal(await military.locator('.config-disclosure').count(), 6, '每个主题只有一个参数展开入口');
  assert.equal(await military.locator(':scope > .config-branch').evaluateAll(nodes => nodes.length === 6 && nodes.every(node => {
    const style = getComputedStyle(node);
    return ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderRadius', 'paddingLeft', 'paddingRight']
      .every(property => style[property] === '0px') && style.backgroundColor === 'rgba(0, 0, 0, 0)';
  })), true, '每日主题复用藏品平铺样式，无独立卡片边框和缩进');
  assert.equal(await military.locator('input[type=time], [data-config-key$="Start"], [data-config-key$="End"]').count(), 0);
  const reward = military.locator('[data-config-key="schedule.armsRaceRewards"]');
  assert.equal(await page.locator('[data-config-key="schedule.armsRaceRewards"]').count(), 1);
  assert.equal(await reward.getAttribute('aria-checked'), 'true'); await reward.click();
  assert.equal(await field(page, 'enabled').getAttribute('aria-checked'), 'false');
  for (const kind of kinds) {
    assert.equal(await field(page, kind + 'Enabled').count(), 1);
    const label = await military.locator('label[for="config-field-weeklyActivity-' + kind + 'Enabled"]').textContent();
    assert.equal(await military.getByText(label, { exact: true }).count(), 1, kind + ' 活动标题唯一');
    assert.equal(await field(page, kind + 'Enabled').getAttribute('aria-checked'), 'false');
    assert.equal(await field(page, kind + 'Stop').isVisible(), false);
    await field(page, kind + 'Enabled').click();
    assert.equal(await disclosure(page, kind).textContent(), '展开设置');
    assert.equal(await disclosure(page, kind).getAttribute('aria-expanded'), 'false');
    assert.equal(await field(page, kind + 'Stop').isVisible(), false, kind + ' 开启后参数默认收起');
    await expand(page, [kind]);
    assert.equal(await disclosure(page, kind).textContent(), '收起设置');
    assert.equal(await field(page, kind + 'Stop').isVisible(), true, kind + ' 点击展开后显示参数');
  }
  await field(page, 'enabled').click();
  for (const name of ['farmRecruitTimes','farmSpeedUp','petQualityOrder','forgeQualityOrder']) assert(await field(page, name).isVisible());
  assert(await field(page, 'farmStop').getByLabel('全天参与', { exact: true }).isChecked());
  await field(page, 'farmRecruitTimes').fill('15'); await field(page, 'farmSpeedUp').click();
  await field(page, 'petQualityOrder').getByLabel('从高到低', { exact: true }).check();
  assert.equal(await field(page, 'petScore').isVisible(), false);
  await field(page, 'petStop').getByLabel('达到积分值时', { exact: true }).check();
  assert(await field(page, 'petScore').isVisible()); await field(page, 'petScore').fill('20000');
  await saved(page);
  let persisted = loadAutomationSettings('weekly-a').settings;
  assert(kinds.every(kind => persisted.weeklyActivity[kind + 'Enabled']));
  assert.equal(persisted.weeklyActivity.farmStop, 'allDay');
  assert.equal(persisted.schedule.armsRaceRewards, false);
  assert.equal(persisted.weeklyActivity.farmRecruitTimes, 15);
  assert.equal(persisted.weeklyActivity.farmSpeedUp, true);
  assert.equal(persisted.weeklyActivity.petStop, 'score'); assert.equal(persisted.weeklyActivity.petScore, 20000);
  assert.equal(persisted.weeklyActivity.petQualityOrder, 'desc');
  const beforeCollapse = loadAutomationSettings('weekly-a');
  await disclosure(page, 'pet').click();
  assert.equal(await field(page, 'petScore').isVisible(), false);
  assert.equal(await field(page, 'petEnabled').getAttribute('aria-checked'), 'true');
  await expand(page, ['pet']);
  assert.equal(await field(page, 'petScore').inputValue(), '20000');
  assert.deepEqual(loadAutomationSettings('weekly-a'), beforeCollapse, '收起和展开不改配置或保存版本');
  assert.match(await page.locator('#config-usage').textContent(), /已配置 6 项全天活动；执行情况见日志/);
  assert.doesNotMatch(await page.locator('#config-usage').textContent(), /当前未开启具体执行项目/);
  console.log('通过：军备竞赛页签唯一且合并领奖，广告位于日常行动之后，无时间输入并自动保存积分');

  await page.reload(); await open(page);
  assert.equal(await military.locator('details').count(), 0);
  assert.equal(await military.locator('.config-disclosure').count(), 6);
  assert.equal(await field(page, 'petScore').isVisible(), false, '刷新后参数默认收起');
  await expand(page);
  assert(await field(page, 'petScore').isVisible(), '展开后恢复已保存的积分目标');
  assert.equal(await field(page, 'enabled').getAttribute('aria-checked'), 'true');
  assert(await field(page, 'farmStop').getByLabel('全天参与', { exact: true }).isChecked());
  assert.equal(await reward.getAttribute('aria-checked'), 'false');
  assert.equal(await field(page, 'petScore').inputValue(), '20000');
  assert(await field(page, 'petQualityOrder').getByLabel('从高到低', { exact: true }).isChecked());
  await field(page, 'petStop').getByLabel('全天参与', { exact: true }).check(); await saved(page);
  assert.equal(await field(page, 'petScore').isVisible(), false);
  assert.equal(loadAutomationSettings('weekly-a').settings.weeklyActivity.petScore, 20000);
  assert.equal(loadAutomationSettings('weekly-a').settings.weeklyActivity.petStop, 'allDay');
  await field(page, 'petStop').getByLabel('达到积分值时', { exact: true }).check(); await saved(page);
  assert.equal(await field(page, 'petScore').inputValue(), '20000');
  const beforeInvalid = loadAutomationSettings('weekly-a');
  await field(page, 'petScore').fill('-1');
  await page.waitForFunction(() => document.getElementById('config-field-weeklyActivity-petScore').getAttribute('aria-invalid') === 'true');
  assert.equal(loadAutomationSettings('weekly-a').revision, beforeInvalid.revision);
  await field(page, 'petScore').fill('20000'); await saved(page);
  console.log('通过：刷新回显全天模式及领奖选择，切换模式保留积分，无效积分不写盘');

  const accountSwitch = async (number) => {
    await page.locator('#account-picker-trigger').click();
    await page.locator('#account-picker-list [role=option]').filter({ hasText: '周活动验收账号' + number }).click();
    await page.locator('#config-account-name').filter({ hasText: '周活动验收账号' + number }).waitFor(); await saved(page);
  };
  rankMode = 'delayed'; await refreshRanks.click();
  await page.waitForResponse(() => false, { timeout: 100 }).catch(() => {});
  assert(delayedRank, '旧账号刷新请求已在途');
  rankMode = 'active'; await accountSwitch(2);
  await ranking.getByText('装备打造', { exact: true }).waitFor();
  assert.equal(await ranking.getByText('海兽玩家（我）', { exact: true }).count(), 0);
  const lateResponse = page.waitForResponse(response => response.url().includes('/api/activity-ranks/view') && response.url().includes('account=weekly-a'));
  delayedRank(); await (await lateResponse).finished();
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
  await page.waitForFunction(() => configWeeklyRanking.pending === null);
  assert.equal(await ranking.getByText('旧账号迟到主题', { exact: true }).count(), 0);
  assert.match(await ranking.locator('#config-weekly-ranking-summary').textContent(), /678/);
  await accountSwitch(1); await ranking.getByText('海兽培养', { exact: true }).waitFor();
  console.log('通过：切号清空旧榜，迟到回复不能覆盖新账号榜单，配置草稿不受影响');

  screenshotNames = true;
  await field(page, 'enabled').click(); await saved(page); await page.reload(); await open(page);
  assert.equal(await field(page, 'enabled').getAttribute('aria-checked'), 'false');
  persisted = loadAutomationSettings('weekly-a').settings;
  assert.equal(persisted.weeklyActivity.petScore, 20000);
  for (const key of ['farm', 'pet', 'antique', 'resident', 'forge', 'heroes', 'alliance']) assert.deepEqual(persisted[key], original[key]);
  assert.deepEqual(loadAutomationSettings('weekly-b'), other);
  await field(page, 'enabled').click(); await saved(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForFunction(() => scrollY === 0);
  await page.screenshot({ path: path.join(output, 'weekly-activity-collapsed.png'), fullPage: true, animations: 'disabled' });
  await expand(page, ['farm', 'pet']);
  assert(await field(page, 'farmRecruitTimes').isVisible()); assert(await field(page, 'petScore').isVisible());
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForFunction(() => scrollY === 0);
  await page.screenshot({ path: path.join(output, 'weekly-activity-desktop.png'), fullPage: true, animations: 'disabled' });
  console.log('通过：总开关暂停与刷新保留参数，基础配置和另一账号不受影响');

  const context = await browser.newContext({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true });
  const mobile = await context.newPage(); mobile.on('pageerror', error => errors.push(error.message));
  await mobile.route(url => url.pathname === '/api/activity-ranks/view', mockRank);
  await mobile.goto(base); await open(mobile);
  await mobile.locator('#config-weekly-ranking').getByText('海兽培养', { exact: true }).waitFor();
  assert.equal(await mobile.locator('#config-group-weekly-activities details').count(), 0);
  assert.equal(await mobile.locator('#config-group-weekly-activities .config-disclosure').count(), 6);
  assert.equal(await field(mobile, 'farmRecruitTimes').isVisible(), false);
  await expand(mobile);
  assert(await field(mobile, 'farmRecruitTimes').isVisible()); assert(await field(mobile, 'petScore').isVisible());
  for (const width of [320, 360, 390, 768]) {
    await mobile.setViewportSize({ width, height: 844 });
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, width + 'px 页面不能横向溢出');
    assert.equal(await mobile.locator('#config-group-weekly-activities').evaluate(section => [...section.querySelectorAll('input,button[role=switch],.config-radio,.config-disclosure')]
      .filter(node => node.getClientRects().length).every(node => { const box = node.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth + 1; })), true, width + 'px 参数控件完整显示');
    if (width === 360) {
      await mobile.evaluate(() => window.scrollTo(0, 0));
      await mobile.waitForFunction(() => scrollY === 0);
      await mobile.screenshot({ path: path.join(output, 'weekly-activity-mobile.png'), animations: 'disabled' });
      await mobile.locator('#config-weekly-ranking-table').evaluate(node => { node.scrollLeft = 0; });
      await mobile.locator('#config-weekly-ranking').scrollIntoViewIfNeeded();
      await mobile.screenshot({ path: path.join(output, 'weekly-activity-ranking-mobile.png'), animations: 'disabled' });
    }
    if (width <= 390) assert.equal(await mobile.locator('#config-weekly-ranking-table').evaluate(node => {
      const scrollable = node.scrollWidth > node.clientWidth; node.scrollLeft = 100; return scrollable && node.scrollLeft > 0;
    }), true, width + 'px 榜单可横向滚动且不撑破页面');
  }
  await field(mobile, 'farmRecruitTimes').fill('16'); await saved(mobile);
  assert.equal(loadAutomationSettings('weekly-a').settings.weeklyActivity.farmRecruitTimes, 16);
  assert.deepEqual(errors, []); assert.equal(connections, 0);
  console.log('通过：320–768px布局无溢出，手机编辑可保存，无脚本错误或游戏连接');
} finally {
  await browser?.close(); app.server.closeAllConnections(); await app.close();
  // Only the unique test directory created above is removed.
  assert(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(directory, { recursive: true, force: true });
}
