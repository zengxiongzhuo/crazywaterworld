// 真实标记与界面脚本，所有游戏响应均为本机虚构夹具。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { overviewPage, templates } from '../src/ui/dist/console.mjs';
import { PAGE } from '../src/page.mjs';
const fleets = [
  { id: '1远征船', name: '探索一队', durability: 960, power: 320000, available: true, reason: '' },
  { id: '2远征船', name: '探索二队', durability: 0, power: 600000, available: false, reason: '舰队正在维修' },
];
const field = (grid, resourceId, level, perHour) => ({ grid, resourceId, name: resourceId === '汽油' ? '海上油井' : resourceId === '种子' ? '海上农庄' : '研究所', cityName: '风栖港', level, perHour, product: resourceId + ' ' + perHour + '/小时', recommendedPower: 250000 });
const fixture = {
  checkedAt: Math.floor(Date.now() / 1000), count: 2, maxNum: 4, remaining: 1, cost: 300, fuel: 12000, pendingFuel: 0, automatic: false,
  totals: [{ id: '汽油', name: '汽油', perHour: 660 }, { id: '种子', name: '种子', perHour: 0 }, { id: '公会科技点', name: '科技点', perHour: null }],
  owned: [{ ...field(101, '汽油', 6, 660), active: true, productionStatus: '持续产出' }, { ...field(102, '种子', 4, 420), active: false, productionStatus: '城市失守，暂停产出' }],
  candidates: [field(201, '汽油', 6, 660), field(202, '汽油', 3, 360), field(203, '种子', 6, 720), field(204, '公会科技点', 5, 600), ...Array.from({ length: 6 }, (_, index) => field(210 + index, '汽油', 2, 220))],
  fleets, pending: [{ grid: 305, fleetId: '3远征船', confirmed: false, reason: '放弃结果待确认，尚未出征' }], notes: ['基础产量不含加成'], reason: '',
};
const css = PAGE.match(/<style>([\s\S]*?)<\/style>/)[1];
const script = fs.readFileSync('src/resource-fields-ui.js', 'utf8');
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><body><main class="deck"><section id="tab-overview">${overviewPage()}</section></main>${templates()}<script>
const $=id=>document.getElementById(id),fmt=value=>Number(value).toLocaleString('zh-CN');
function el(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n;}
function clear(node){node.textContent='';return node;}
function smallButton(text){const button=$('ui-button').content.firstElementChild.cloneNode(true);button.textContent=text;return button;}
let current='first',snapshot={connected:true,paused:false};const disconnected=new Set();
async function call(url,options){const r=await fetch(url,options);const data=await r.json();if(!r.ok)throw Error(data.error);return data;}
${script}
maybeRefreshResourceFields();
</script></body></html>`;
let payload = fixture, fail = false, actionResult = { ok: true, status: 'confirmed', reason: '派遣已确认，最终占领请刷新查看' }, requests = [], gate = null, previewGate = null, actionGate = null;
const server = createServer(async (req, res) => {
  if (!req.url.startsWith('/api/resource-fields/')) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); return; }
  let text = ''; for await (const chunk of req) text += chunk;
  const body = text ? JSON.parse(text) : null; requests.push({ url: req.url, body });
  let response, status = 200;
  if (req.url.includes('/overview')) {
    response = structuredClone(payload); if (gate) await gate;
    if (fail) { status = 503; response = { error: '模拟读取失败' }; }
  } else if (req.url.includes('/preview')) {
    if (body.kind === 'giveUp') response = { kind: 'giveUp', gridIdx: body.gridIdx, field: payload.owned.find(row => row.grid === body.gridIdx), available: true, automatic: payload.automatic,
      token: 'giveup-' + body.gridIdx, expiresAt: Date.now() + 120000, cost: 0, reason: '' };
    else {
      const target = fixture.candidates.find(row => row.grid === body.gridIdx);
      response = { ...target, gridIdx: target.grid, cost: 300, fuel: 12000, token: 'quote-' + body.gridIdx, expiresAt: Date.now() + 120000, reason: '', fleets,
        replacement: fixture.owned.find(row => row.grid === body.replaceGridIdx) || null };
    }
    if (previewGate) await previewGate;
  } else { response = actionResult; if (actionGate) await actionGate; }
  res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(response));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = 'http://127.0.0.1:' + server.address().port;
const executablePath = [process.env.CW_BROWSER_TEST_EXECUTABLE, chromium.executablePath(), 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(file => file && fs.existsSync(file));
assert(executablePath, '未找到验收浏览器');
const output = path.resolve('output/playwright/resource-fields'); fs.mkdirSync(output, { recursive: true });
let browser; const errors = [];
const waitIdle = page => page.waitForFunction(() => !resourceFieldsAction && !resourceFieldsLoading);
const waitReady = page => page.waitForFunction(() => resourceFieldsAction?.phase === 'ready');
const openManager = (page, id = '汽油') => page.locator('[data-resource-manage="' + id + '"]').click();
try {
  browser = await chromium.launch({ executablePath, headless: true });
  for (const [name, width, theme] of [['desktop', 1440, 'light'], ['dark', 1440, 'dark'], ['mobile', 390, 'light'], ['small-mobile', 320, 'light']]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, hasTouch: width < 600, isMobile: width < 600 }); page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message)); await page.goto(url); await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
    await page.locator('[data-resource-manage="汽油"]').waitFor();
    const card = page.locator('[data-slot=card]').filter({ has: page.locator('#resource-fields-overview') }), dialog = page.locator('#resource-fields-action-dialog');
    assert.match(await page.locator('#resource-fields-capacity').textContent(), /已占 2 \/ 4.*在途 1/);
    assert.equal(await page.locator('[data-resource-details]').count(), 3);
    assert.equal(await page.locator('[data-resource-details][open]').count(), 0);
    assert.equal(await page.locator('#resource-fields-overview [data-resource-field]').count(), 0, '总览不渲染候选列表');
    assert.match(await page.locator('[data-resource-type="种子"] summary').textContent(), /已占 1 · 失效 1/);
    assert.match(await page.locator('[data-resource-type="公会科技点"] summary').textContent(), /未同步/);
    assert.equal(await page.locator('.resource-fields-help').evaluate(node => node.open), false);
    assert((await card.boundingBox()).height < (width < 600 ? 700 : 450), '总览默认保持紧凑');
    await card.screenshot({ path: path.join(output, name + '.png') });
    await page.locator('[data-resource-type="种子"] summary').click();
    assert.match(await page.locator('[data-resource-type="种子"] .resource-fields-owned').textContent(), /暂停产出/);
    await page.locator('#resource-fields-refresh').click(); await waitIdle(page);
    assert.equal(await page.locator('[data-resource-details="种子"]').evaluate(node => node.open), true, '刷新保留展开状态');
    await page.locator('[data-resource-type="种子"] summary').click();
    await openManager(page);
    assert.equal(await dialog.isVisible(), true); assert.equal(await page.locator('dialog[open]').count(), 1);
    assert.equal(await page.locator('#resource-fields-replace-bar').isVisible(), false, '默认新增，不自动替用户选旧田');
    assert.equal(await page.locator('#resource-fields-owned-table [data-owned-field]').count(), 2);
    assert.equal(await page.locator('#resource-fields-owned-table').isVisible(), true, '弹窗默认展示已占表');
    assert.match(await page.locator('#resource-fields-owned-table').textContent(), /种子.*海上农庄/);
    await page.locator('#resource-fields-resource').selectOption('公会科技点');
    assert.equal(await page.locator('#resource-fields-owned-table [data-owned-field]').count(), 2, '切换候选类型不隐藏其它已占田');
    await page.locator('#resource-fields-resource').selectOption('汽油');
    assert.equal(await page.locator('[data-resource-field]').count(), 6); assert.match(await page.locator('#resource-fields-page-state').textContent(), /1 \/ 2/);
    await page.locator('#resource-fields-page-next').click(); assert.equal(await page.locator('[data-resource-field]').count(), 2);
    await page.locator('#resource-fields-page-prev').click();
    await page.locator('#resource-fields-level').fill('5'); assert.equal(await page.locator('[data-resource-field]').count(), 1);
    await page.locator('#resource-fields-level').fill('1');
    await dialog.evaluate(node => node.scrollTop = 0); await dialog.screenshot({ path: path.join(output, 'manager-' + name + '.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, name + ' 页面不能横向溢出');
    assert.equal(await dialog.evaluate(node => node.scrollWidth > node.clientWidth + 2), false, name + ' 管理弹窗不能横向溢出');
    if (width < 600) {
      const scroll = page.locator('.resource-fields-table-scroll').first();
      await scroll.evaluate(node => node.scrollLeft = node.scrollWidth);
      assert(await scroll.evaluate(node => node.scrollLeft > 0), '手机仅表格局部横向滚动');
      const outer = await scroll.boundingBox(), operation = await page.locator('[data-resource-give-up="101"]').boundingBox();
      assert(operation.x >= outer.x && operation.x + operation.width <= outer.x + outer.width + 1, '横滚后行操作仍可触达');
      await scroll.evaluate(node => node.scrollLeft = 0);
    }
    await page.locator('[data-resource-field="201"]').click(); await waitReady(page);
    assert.equal(await page.locator('dialog[open]').count(), 1, '确认复用同一弹窗');
    assert.equal(await page.locator('#resource-fields-manager').isVisible(), false);
    assert.match(await dialog.textContent(), /本次消耗 300 汽油/);
    assert.equal(await dialog.locator('input[value="2远征船"]').isDisabled(), true);
    const before = requests.filter(row => row.url.includes('/action')).length;
    await page.locator('#resource-fields-action-confirm').click(); await waitIdle(page);
    assert.equal(requests.filter(row => row.url.includes('/action')).length, before + 1);
    assert.deepEqual(requests.filter(row => row.url.includes('/action')).at(-1).body, { confirm: true, token: 'quote-201', fleetId: '1远征船' });
    assert.match(await page.locator('#resource-fields-feedback').textContent(), /派遣已确认/);
    await openManager(page, '种子'); await page.locator('[data-resource-replace="102"]').click();
    assert.match(await page.locator('#resource-fields-replace-bar').textContent(), /格 102/);
    await page.locator('#resource-fields-replace-cancel').click(); assert.equal(await page.locator('#resource-fields-replace-bar').isVisible(), false);
    await page.locator('[data-resource-replace="102"]').click();
    await page.locator('[data-resource-field="203"]').click(); await waitReady(page);
    assert.deepEqual(requests.filter(row => row.url.includes('/preview')).at(-1).body, { gridIdx: 203, replaceGridIdx: 102 });
    assert.match(await dialog.textContent(), /先放弃旧田/); assert.match(await dialog.textContent(), /预计 种子 \+720\/小时/);
    assert.match(await dialog.textContent(), /不会自动恢复旧田/); assert.equal(await dialog.locator('img').count(), 0);
    assert.equal(await page.locator('#resource-fields-action-confirm').textContent(), '放弃旧田并派遣');
    await dialog.evaluate(node => node.scrollTop = 0); await dialog.screenshot({ path: path.join(output, 'replacement-' + name + '.png') });
    await page.locator('#resource-fields-action-back').click(); assert.equal(await page.locator('#resource-fields-manager').isVisible(), true);
    await page.locator('#resource-fields-resource').selectOption('汽油'); await page.locator('[data-resource-field="201"]').click(); await waitReady(page);
    assert.match(await dialog.textContent(), /跨资源替换/); assert.doesNotMatch(await dialog.textContent(), /预计 汽油 \+/);
    await page.locator('#resource-fields-action-cancel').click();
    await openManager(page); await page.locator('[data-resource-give-up="101"]').click(); await waitReady(page);
    assert.deepEqual(requests.filter(row => row.url.includes('/preview')).at(-1).body, { kind: 'giveUp', gridIdx: 101 });
    assert.match(await dialog.textContent(), /放弃后减少 汽油 660\/小时/);
    assert.equal(await dialog.locator('input[name="resource-field-fleet"]').count(), 0);
    assert.match(await dialog.textContent(), /不需要舰队，不消耗汽油/);
    await dialog.evaluate(node => node.scrollTop = 0); await dialog.screenshot({ path: path.join(output, 'give-up-' + name + '.png') });
    actionResult = { kind: 'giveUp', ok: true, status: 'confirmed', reason: '资源田已放弃，名额已释放' };
    await page.locator('#resource-fields-action-confirm').click(); await waitIdle(page);
    assert.deepEqual(requests.filter(row => row.url.includes('/action')).at(-1).body, { confirm: true, token: 'giveup-101' });
    assert.match(await page.locator('#resource-fields-feedback').textContent(), /资源田已放弃/);
    actionResult = { ok: true, status: 'confirmed', reason: '派遣已确认，最终占领请刷新查看' };
    if (name === 'desktop') {
      await openManager(page); await page.locator('[data-resource-field="201"]').click(); await waitReady(page);
      await page.evaluate(() => { resourceFieldsAction.quote.expiresAt = Date.now() - 1; });
      await page.waitForFunction(() => document.querySelector('#resource-fields-action-confirm').disabled);
      await page.locator('#resource-fields-action-back').click(); await page.locator('#resource-fields-action-cancel').click();
      payload = { ...fixture, candidates: fixture.candidates.map(row => row.grid === 201 ? { ...row, reason: '已有占领任务待确认' } : row) };
      await page.locator('#resource-fields-refresh').click(); await waitIdle(page); await openManager(page);
      assert.equal(await page.locator('[data-resource-field="201"]').count(), 0, '不可占目标整行隐藏，不留下禁用按钮');
      assert.doesNotMatch(await page.locator('#resource-fields-candidates').textContent(), /格 201|已有占领任务待确认/);
      assert.match(await page.locator('#resource-fields-candidate-count').textContent(), /^7 块/);
      assert.match(await page.locator('#resource-fields-page-state').textContent(), /1 \/ 2/);
      assert.deepEqual(await page.locator('[data-resource-field]').evaluateAll(nodes => nodes.map(node => Number(node.dataset.resourceField))), [202, 210, 211, 212, 213, 214]);
      await page.locator('#resource-fields-page-next').click();
      assert.deepEqual(await page.locator('[data-resource-field]').evaluateAll(nodes => nodes.map(node => Number(node.dataset.resourceField))), [215]);
      assert.equal(await page.locator('#resource-fields-page-next').isDisabled(), true);
      await page.locator('#resource-fields-level').fill('5');
      assert.equal(await page.locator('[data-resource-field]').count(), 0); assert.match(await page.locator('#resource-fields-candidate-count').textContent(), /^0 块/);
      assert.match(await page.locator('#resource-fields-page-state').textContent(), /1 \/ 1/);
      await page.locator('#resource-fields-action-cancel').click();
      payload = { ...fixture, candidates: fixture.candidates.map(row => [201, 202].includes(row.grid) ? { ...row, reason: '本日已尝试' } : row) };
      await page.locator('#resource-fields-refresh').click(); await waitIdle(page); await openManager(page);
      assert.equal(await page.locator('[data-resource-field]').count(), 6);
      assert.match(await page.locator('#resource-fields-candidate-count').textContent(), /^6 块/);
      assert.match(await page.locator('#resource-fields-page-state').textContent(), /1 \/ 1/);
      assert.equal(await page.locator('#resource-fields-page-next').isDisabled(), true, '过滤后刚好一页不保留空的第二页');
      await page.locator('#resource-fields-action-cancel').click();
      for (const unavailable of [{ reason: '城池归属未同步' }, { fuel: 299 }, { fuel: 600, pendingFuel: 301 }]) {
        payload = { ...fixture, ...unavailable };
        await page.locator('#resource-fields-refresh').click(); await waitIdle(page); await openManager(page);
        assert.equal(await page.locator('[data-resource-field]').count(), 0, JSON.stringify(unavailable));
        assert.match(await page.locator('#resource-fields-candidate-count').textContent(), /^0 块/);
        assert.match(await page.locator('#resource-fields-page-state').textContent(), /1 \/ 1/);
        assert.equal(await page.locator('#resource-fields-page-next').isDisabled(), true);
        assert.equal(await page.locator('#resource-fields-owned-table [data-owned-field]').count(), 2, '候选隐藏不隐藏已占田');
        assert.equal(await page.locator('[data-resource-give-up="101"]').isDisabled(), false, '无法占领时仍可放弃已占田');
        await page.locator('#resource-fields-action-cancel').click();
      }
      payload = { ...fixture, fuel: 600, pendingFuel: 300 };
      await page.locator('#resource-fields-refresh').click(); await waitIdle(page); await openManager(page);
      assert.equal(await page.locator('[data-resource-field]').count(), 6, '扣除待确认消耗后恰好够一次费用时保留候选');
      assert.match(await page.locator('#resource-fields-candidate-count').textContent(), /^8 块/);
      await page.locator('#resource-fields-action-cancel').click();
      payload = { ...fixture, maxNum: 2, remaining: 0, pending: [] };
      await page.locator('#resource-fields-refresh').click(); await waitIdle(page); await openManager(page);
      assert.equal(await page.locator('[data-resource-field]').count(), 0, '满额且未选择旧田时不显示候选');
      assert.match(await page.locator('#resource-fields-candidate-count').textContent(), /^0 块/);
      assert.equal(await page.locator('[data-resource-give-up="101"]').isDisabled(), false);
      await page.locator('[data-resource-replace="101"]').click();
      assert.equal(await page.locator('[data-resource-field="201"]').isDisabled(), false);
      assert.equal(await page.locator('[data-resource-field]').count(), 6, '选中有效旧田后恢复可替换候选');
      assert.match(await page.locator('#resource-fields-candidate-count').textContent(), /^8 块/);
      await page.locator('#resource-fields-replace-cancel').click();
      assert.equal(await page.locator('[data-resource-field]').count(), 0, '取消替换后恢复满额空列表');
      assert.match(await page.locator('#resource-fields-candidate-count').textContent(), /^0 块/);
      await page.locator('[data-resource-replace="101"]').click();
      await page.locator('[data-resource-field="201"]').click(); await waitReady(page);
      actionResult = { ok: false, status: 'unknown', partial: true, released: true, reason: '舰队状态已变化，新田尚未出征' };
      let release; actionGate = new Promise(resolve => { release = resolve; });
      const writesBefore = requests.filter(row => row.url.includes('/action')).length;
      await page.locator('#resource-fields-action-confirm').click(); await page.evaluate(() => { void submitResourceFieldAction(); });
      while (requests.filter(row => row.url.includes('/action')).length === writesBefore) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(requests.filter(row => row.url.includes('/action')).length, writesBefore + 1, '重复确认仅发一次'); release(); actionGate = null; await waitIdle(page);
      assert.match(await page.locator('#resource-fields-feedback').textContent(), /旧田已放弃/); assert.match(await page.locator('#resource-fields-feedback').textContent(), /舰队状态已变化/);
      await openManager(page); await page.locator('[data-resource-replace="101"]').click(); await page.locator('[data-resource-field="201"]').click(); await waitReady(page);
      actionResult = { ok: false, status: 'unknown', partial: false, released: false, reason: '放弃结果待确认，尚未出征' };
      await page.locator('#resource-fields-action-confirm').click(); await waitIdle(page);
      assert.equal(await page.locator('#resource-fields-feedback').textContent(), '放弃结果待确认，尚未出征');
      payload = fixture; actionResult = { ok: true, status: 'confirmed', reason: '派遣已确认，最终占领请刷新查看' };
      payload = { ...fixture, candidates: fixture.candidates.map(row => row.grid === 203 ? { ...row, name: '<img src=x onerror=alert(1)>' } : row) };
      await page.locator('#resource-fields-refresh').click(); await waitIdle(page); await openManager(page, '种子');
      assert.match(await page.locator('#resource-fields-candidates').textContent(), /<img src=x onerror=alert\(1\)>/);
      assert.equal(await page.locator('#resource-fields-candidates img').count(), 0);
      await page.locator('#resource-fields-action-cancel').click(); payload = fixture;
      fail = true; await page.locator('#resource-fields-refresh').click(); await waitIdle(page);
      assert.equal(await page.locator('[data-resource-manage="汽油"]').isDisabled(), true); fail = false;
      await page.locator('#resource-fields-refresh').click(); await waitIdle(page);
      const beforeHidden = requests.length;
      await page.evaluate(() => { $('tab-overview').classList.add('hidden'); resourceFieldsLastAttempt = 0; maybeRefreshResourceFields(); });
      assert.equal(requests.length, beforeHidden); await page.evaluate(() => { $('tab-overview').classList.remove('hidden'); resourceFieldsLastAttempt = Date.now(); });
      await openManager(page); const beforeDialog = requests.length;
      await page.evaluate(() => { resourceFieldsLastAttempt = 0; maybeRefreshResourceFields(); }); assert.equal(requests.length, beforeDialog, '管理中暂停自动刷新');
      await page.locator('#resource-fields-action-cancel').click();
      gate = new Promise(resolve => { release = resolve; }); await page.evaluate(() => { void refreshResourceFieldsOverview(); });
      while (requests.length === beforeDialog) await new Promise(resolve => setTimeout(resolve, 10));
      await page.evaluate(() => { current = 'second'; resourceFieldsAccountChanged(); resourceFieldsLastAttempt = Date.now(); });
      assert.equal(await page.locator('[data-resource-manage]').count(), 0); release(); gate = null; await page.waitForTimeout(80);
      assert.equal(await page.locator('[data-resource-manage]').count(), 0, '旧账号响应不能覆盖');
      await page.locator('#resource-fields-refresh').click(); await waitIdle(page); assert.equal(await page.locator('[data-resource-details][open]').count(), 0);
      await openManager(page); previewGate = new Promise(resolve => { release = resolve; });
      const beforePreview = requests.length; await page.locator('[data-resource-field="201"]').click();
      while (requests.length === beforePreview) await new Promise(resolve => setTimeout(resolve, 10));
      await page.evaluate(() => { current = 'third'; resourceFieldsAccountChanged(); resourceFieldsLastAttempt = Date.now(); });
      release(); previewGate = null; await page.waitForTimeout(80); assert.equal(await dialog.isVisible(), false);
      payload = { ...fixture, candidates: [], count: null, maxNum: null, remaining: null, owned: [], totals: [], reason: '世界玩法尚未开放' };
      await page.locator('#resource-fields-refresh').click(); await waitIdle(page); assert.match(await page.locator('#resource-fields-capacity').textContent(), /未同步 \/ 未同步/);
      payload = { ...fixture, owned: [...fixture.owned, { grid: 999, resourceId: null, active: null }], count: 3 };
      await page.locator('#resource-fields-refresh').click(); await waitIdle(page); assert.match(await page.locator('#resource-fields-capacity').textContent(), /类型待同步 1/); payload = fixture;
      payload = { ...fixture, owned: fixture.owned.map(row => row.grid === 101 ? { ...row, replacementReason: '已有替换任务待确认' } : row) };
      await page.locator('#resource-fields-refresh').click(); await waitIdle(page); await openManager(page);
      assert.equal(await page.locator('[data-resource-replace="101"]').isDisabled(), true);
      assert.match(await page.locator('[data-owned-field="101"]').textContent(), /已有替换任务待确认/);
      await page.locator('#resource-fields-action-cancel').click(); payload = fixture;
      payload = { ...fixture, fleets: [], automatic: true, reason: '暂无可用舰队' };
      await page.locator('#resource-fields-refresh').click(); await waitIdle(page); await openManager(page);
      assert.equal(await page.locator('[data-resource-field]').count(), 0, '没有可用舰队时隐藏全部候选');
      assert.match(await page.locator('#resource-fields-candidate-count').textContent(), /^0 块/);
      assert.equal(await page.locator('[data-resource-give-up="102"]').isDisabled(), false, '放弃不需要可用舰队');
      await page.locator('[data-resource-give-up="102"]').click(); await waitReady(page);
      assert.deepEqual(requests.filter(row => row.url.includes('/preview')).at(-1).body, { kind: 'giveUp', gridIdx: 102 });
      assert.match(await dialog.textContent(), /放弃后减少 种子 0\/小时/); assert.match(await dialog.textContent(), /自动占领仍开启/);
      await page.evaluate(() => { resourceFieldsAction.quote.expiresAt = Date.now() - 1; });
      await page.waitForFunction(() => document.querySelector('#resource-fields-action-confirm').disabled);
      await page.locator('#resource-fields-action-back').click(); await page.locator('[data-resource-give-up="102"]').click(); await waitReady(page);
      actionResult = { kind: 'giveUp', ok: false, status: 'unknown', reason: '放弃结果待确认，不会重复发送' };
      actionGate = new Promise(resolve => { release = resolve; });
      const beforeGiveUp = requests.filter(row => row.url.includes('/action')).length;
      await page.locator('#resource-fields-action-confirm').click(); await page.evaluate(() => { void submitResourceFieldAction(); });
      while (requests.filter(row => row.url.includes('/action')).length === beforeGiveUp) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(requests.filter(row => row.url.includes('/action')).length, beforeGiveUp + 1);
      payload = { ...payload, owned: fixture.owned.map(row => row.grid === 102 ? { ...row, giveUpReason: '放弃结果待确认', replacementReason: '放弃结果待确认' } : row) };
      release(); actionGate = null; await waitIdle(page); assert.match(await page.locator('#resource-fields-feedback').textContent(), /放弃结果待确认/);
      await openManager(page); assert.equal(await page.locator('[data-resource-give-up="102"]').isDisabled(), true);
      assert.equal(await page.locator('[data-resource-give-up="101"]').isDisabled(), false);
      await page.locator('#resource-fields-action-cancel').click();
      payload = fixture; actionResult = { ok: true, status: 'confirmed', reason: '派遣已确认，最终占领请刷新查看' };
      payload = { ...fixture, owned: fixture.owned.map(row => row.grid === 101 ? { ...row, active: null, perHour: null } : row) };
      await page.locator('#resource-fields-refresh').click(); await waitIdle(page); await openManager(page);
      await page.locator('[data-resource-give-up="101"]').click(); await waitReady(page);
      assert.match(await dialog.textContent(), /该田当前产量未同步，放弃后会失去其产出/);
      assert.doesNotMatch(await dialog.textContent(), /放弃后减少 汽油 0/);
      await page.locator('#resource-fields-action-cancel').click(); payload = fixture;
      await page.evaluate(() => { snapshot.paused = true; resourceFieldsAccountChanged(); }); assert.equal(await page.locator('#resource-fields-refresh').isDisabled(), true);
    }
    await page.close(); console.log('通过：' + name + ' 紧凑汇总、已占及候选表、分页、占领/替换/逐块放弃');
  }
  assert.deepEqual(errors, []); console.log('通过：仅显示可占领候选、过滤后计数与分页、汽油和待确认消耗、满额替换恢复/取消、收益比较、跨资源替换、逐行绑定、无舰队放弃、自动占领提醒、未知产量、部分失败、未知放弃、重复确认、过期、账号隔离与停刷；未连接游戏');
  console.log('截图：' + output);
} finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
