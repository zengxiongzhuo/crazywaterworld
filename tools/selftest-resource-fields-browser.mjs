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
  candidates: [field(201, '汽油', 6, 660), field(202, '汽油', 3, 360), field(203, '种子', 6, 720), { ...field(204, '公会科技点', 5, 600), name: '工厂', cityName: '堡垒F2' }, ...Array.from({ length: 6 }, (_, index) => field(210 + index, '汽油', 2, 220))],
  fleets, pending: [{ grid: 305, fleetId: '3远征船', confirmed: false, reason: '放弃结果待确认，尚未出征' }], notes: ['基础产量不含加成'], reason: '',
};
const extraDetailFields = [
  { ...field(103, '种子', 10, 900), cityName: '绿洲港', active: true, productionStatus: '产出中' },
  { ...field(104, '种子', 12, 1020), cityName: '蓝湾', active: true, productionStatus: '产出中' },
  { ...field(105, '种子', 15, 1200), cityName: '太阳岛', active: null, productionStatus: '归属未同步' },
];
const detailFixture = { ...fixture, count: 5, maxNum: 7, owned: [...fixture.owned, ...extraDetailFields],
  totals: fixture.totals.map(row => row.id === '种子' ? { ...row, perHour: null } : row) };
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
const confirmedDispatch = { ok: true, status: 'confirmed', reason: '派遣已确认，最终占领以资源田列表为准' };
let payload = fixture, fail = false, actionResult = confirmedDispatch, requests = [], gate = null, previewGate = null, actionGate = null;
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
      const target = payload.candidates.find(row => row.grid === body.gridIdx);
      response = { ...target, gridIdx: target.grid, cost: 300, fuel: 12000, token: 'quote-' + body.gridIdx, expiresAt: Date.now() + 120000, reason: '', fleets,
        replacement: payload.owned.find(row => row.grid === body.replaceGridIdx) || null };
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
const waitReady = async page => {
  await page.waitForFunction(() => resourceFieldsAction?.phase === 'ready');
  const dialog = page.locator('#resource-fields-action-dialog');
  assert.equal(await dialog.getByRole('button', { name: /关闭/ }).count(), 1);
  assert.equal(await dialog.locator('#resource-fields-owned-hint:visible, #resource-fields-candidate-count:visible, #resource-fields-candidate-fuel:visible').count(), 0, '确认时隐藏列表摘要');
};
const openManager = (page, id = '汽油') => page.locator('[data-resource-manage="' + id + '"]').click();
async function checkListHeading(dialog, title, countLabel) {
  assert.deepEqual(await dialog.getByRole('heading').allTextContents(), [title]);
  const header = dialog.locator('[data-slot=dialog-header]');
  const heading = await header.getByRole('heading', { name: title }).boundingBox();
  const count = await header.getByText(countLabel, { exact: true }).boundingBox();
  assert(count && heading && count.x >= heading.x + heading.width - 1 && count.y < heading.y + heading.height
    && heading.y < count.y + count.height, '列表数量与弹窗标题同行');
}
async function checkOwnedTableLayout(dialog, mobile) {
  const table = dialog.locator('table.resource-fields-owned-table');
  assert.deepEqual(await table.getByRole('columnheader').allTextContents(), ['地块', '等级', '有效时产', '操作']);
  const layout = await table.evaluate(node => {
    const rect = cell => {
      const { x, y, width, height } = cell.getBoundingClientRect();
      return { x, y, width, height };
    };
    const visibleCells = row => Array.from(row.cells, rect).filter(cell => cell.width > 0);
    return { header: rect(node.tHead), columns: visibleCells(node.tHead.rows[0]),
      rows: Array.from(node.tBodies[0].rows, row => ({ height: rect(row).height, columns: visibleCells(row) })) };
  });
  assert(layout.header.height >= 18 && layout.header.width > 150, '列标题占据可读的表头行');
  assert(layout.columns.length >= 4 && layout.rows.length > 1, '多个地块共用标题列');
  for (const row of layout.rows) {
    assert(row.height <= 65, '每块田以紧凑行展示，实际行高 ' + row.height);
    assert.equal(row.columns.length, layout.columns.length);
    for (const [index, cell] of row.columns.entries()) {
      const column = layout.columns[index];
      assert(Math.abs(cell.x - column.x) <= 1 && Math.abs(cell.width - column.width) <= 1,
        '地块信息与对应表头对齐');
      assert(Math.abs(cell.y - row.columns[0].y) <= 1, '每块田的信息都在同一行');
    }
  }
  if (mobile) {
    const scroll = table.locator('..');
    await scroll.evaluate(node => node.scrollLeft = node.scrollWidth);
    const bounds = await scroll.boundingBox();
    for (const button of await table.locator('[data-owned-field="103"] button').all()) {
      const operation = await button.boundingBox();
      assert(operation.x >= bounds.x && operation.x + operation.width <= bounds.x + bounds.width + 1,
        '手机可触达该地块的放弃按钮');
    }
    await scroll.evaluate(node => node.scrollLeft = 0);
  }
}
try {
  browser = await chromium.launch({ executablePath, headless: true });
  for (const [name, width, theme] of [['desktop', 1440, 'light'], ['dark', 1440, 'dark'], ['mobile', 390, 'light'], ['small-mobile', 320, 'light']]) {
    payload = detailFixture;
    const page = await browser.newPage({ viewport: { width, height: 1000 }, hasTouch: width < 600, isMobile: width < 600 }); page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message)); await page.goto(url); await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
    await page.locator('[data-resource-manage="汽油"]').waitFor();
    const card = page.locator('[data-slot=card]').filter({ has: page.locator('#resource-fields-overview') }), dialog = page.locator('#resource-fields-action-dialog');
    assert.match(await page.locator('#resource-fields-capacity').textContent(), /已占 5 \/ 7.*在途 1/);
    const types = page.locator('#resource-fields-summary [data-resource-type]');
    const cardBounds = () => types.evaluateAll(nodes => nodes.map(node => {
      const { x, y, right, bottom, height } = node.getBoundingClientRect();
      return { x, y: y + scrollY, right, bottom: bottom + scrollY, height };
    }));
    const boxes = await cardBounds();
    assert.deepEqual(await types.evaluateAll(nodes => nodes.map(node => node.dataset.resourceType)), ['公会科技点', '种子', '汽油']);
    for (let i = 1; i < boxes.length; i++) {
      const prev = boxes[i - 1], next = boxes[i];
      if (width < 600) assert(next.y >= prev.bottom && next.x === prev.x, '手机上的卡片纵向排列');
      else assert(next.x >= prev.right && next.y === prev.y, '桌面上的三张卡片并列');
    }
    for (const [i, label] of ['工厂', '绿洲', '油罐'].entries()) {
      assert((await types.nth(i).locator('button[data-resource-view]').innerText()).includes(label));
      assert.equal(await types.nth(i).locator('[data-resource-manage]').textContent(), '占领');
    }
    const oil = page.locator('button[data-resource-view="汽油"]'), seed = page.locator('button[data-resource-view="种子"]');
    const tech = page.locator('button[data-resource-view="公会科技点"]');
    assert.match(await oil.textContent(), /汽油/);
    assert.match(await oil.textContent(), /有效基础时产/);
    assert.match(await oil.textContent(), /660/);
    assert.equal(await page.locator('#resource-fields-overview [data-resource-field]').count(), 0, '总览不渲染候选列表');
    assert.match(await seed.textContent(), /已占 4 · 失效 1/);
    assert.match(await tech.textContent(), /未同步/);
    assert.equal(await card.getByText('同步状态与玩法说明', { exact: true }).count(), 0);
    assert((await card.boundingBox()).height < (width < 600 ? 700 : 450), '总览默认保持紧凑');
    await card.screenshot({ path: path.join(output, name + '.png') });
    await seed.focus(); await seed.press('Enter');
    const ownedTable = dialog.locator('#resource-fields-owned-table'), targets = dialog.locator('#resource-fields-targets');
    const candidateRows = dialog.locator('#resource-fields-candidates [data-candidate-field]');
    const replaceTarget = grid => dialog.locator('[data-resource-replace="' + grid + '"]');
    const selectOld = grid => dialog.locator('[data-resource-select-old="' + grid + '"]');
    const closeDialog = async () => {
      const close = dialog.getByRole('button', { name: /关闭/ });
      assert.equal(await close.count(), 1);
      await close.click();
    };
    const replace = async (targetGrid, oldGrid) => {
      await replaceTarget(targetGrid).click();
      await selectOld(oldGrid).click();
      await waitReady(page);
    };
    assert.equal(await page.locator('dialog[open]').count(), 1);
    await checkListHeading(dialog, '已占资源田', '共 4 块');
    assert.equal(await targets.isVisible(), false);
    const ownedGrids = () => ownedTable.locator('[data-owned-field]').evaluateAll(rows => rows.map(row => Number(row.dataset.ownedField)));
    assert.deepEqual(await ownedGrids(), [105, 104, 103, 102]);
    const detail = await ownedTable.innerText();
    assert.doesNotMatch(detail, /暂停产出|产出中|归属未同步/);
    assert.match(detail, /风栖港/);
    assert.deepEqual(await ownedTable.locator('td:first-child').allInnerTexts(), ['太阳岛', '蓝湾', '绿洲港', '风栖港']);
    assert.match(detail, /\b0\s*\/\s*小时/);
    assert.doesNotMatch(detail, /420\s*\/\s*小时/);
    assert.deepEqual(await ownedTable.getByRole('button').allTextContents(), Array(4).fill('放弃'));
    assert.equal(await dialog.getByRole('button', { name: /关闭/ }).count(), 1);
    assert.equal(await dialog.locator('#resource-fields-owned-prev,#resource-fields-owned-next').count(), 0);
    assert.deepEqual(await cardBounds(), boxes, '查看明细时保持卡片原有尺寸与排列');
    assert.equal(await dialog.evaluate(node => node.scrollWidth > node.clientWidth + 2), false, name + ' 明细弹窗不能横向溢出');
    await checkOwnedTableLayout(dialog, width < 600);
    await dialog.screenshot({ path: path.join(output, 'details-' + name + '.png') });
    const writesBeforeShortcuts = requests.filter(row => row.url.includes('/action')).length;
    await ownedTable.locator('[data-resource-give-up="102"]').click(); await waitReady(page);
    assert.equal(await page.locator('#resource-fields-action-title').textContent(), '确认放弃资源田');
    assert.deepEqual(requests.filter(row => row.url.includes('/preview')).at(-1).body, { kind: 'giveUp', gridIdx: 102 });
    await page.locator('#resource-fields-action-back').click();
    assert.equal(await targets.isVisible(), false);
    assert.equal(await ownedTable.locator('[data-owned-field]').count(), 4);
    await closeDialog();
    assert.equal(await dialog.isVisible(), false);
    assert.equal(await seed.evaluate(node => node === document.activeElement), true, '关闭详情后焦点回到卡片');
    assert.deepEqual(await cardBounds(), boxes, '关闭后卡片尺寸与排列一致');
    assert.equal(requests.filter(row => row.url.includes('/action')).length, writesBeforeShortcuts, '详情操作先预览，取消无写入');
    await tech.click();
    assert.equal(await ownedTable.locator('[data-owned-field]').count(), 0);
    assert.match(await ownedTable.innerText(), /暂无/);
    assert.equal(await targets.isVisible(), false);
    await page.keyboard.press('Escape');
    const extraCandidates = Array.from({ length: 65 }, (_, index) => field(400 + index, '汽油', 7 + index % 4, 720 + 60 * (index % 4)));
    payload = { ...fixture, candidates: [...extraCandidates, ...fixture.candidates] };
    await page.locator('#resource-fields-refresh').click(); await waitIdle(page);
    await openManager(page);
    assert.equal(await dialog.isVisible(), true); assert.equal(await page.locator('dialog[open]').count(), 1);
    await checkListHeading(dialog, '占领资源田', '73 块可选');
    assert.match(await dialog.locator('[data-slot=dialog-header]').innerText(), /每队 300 汽油 · 库存 12,000/);
    assert.equal(await ownedTable.isVisible(), false, '管理只展示候选田');
    assert.equal(await dialog.locator('#resource-fields-resource,#resource-fields-level,#resource-fields-replace-select,#resource-fields-page-state').count(), 0);
    assert.deepEqual(await targets.getByRole('columnheader').allTextContents(), ['田地 / 等级', '基础时产', '推荐战力', '操作']);
    const expected = [...extraCandidates.sort((a, b) => b.level - a.level || a.grid - b.grid).map(field => field.grid), 201, 202, 210, 211, 212, 213, 214, 215];
    assert.deepEqual(await candidateRows.evaluateAll(rows => rows.map(row => Number(row.dataset.candidateField))), expected);
    const pane = targets.locator('.resource-fields-table-scroll');
    const heights = await candidateRows.evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height));
    assert(Math.max(...heights) - Math.min(...heights) <= 1, name + ' 候选行等高');
    const headerTop = (await targets.locator('th').first().boundingBox()).y;
    await pane.evaluate(node => node.scrollTop = node.scrollHeight);
    assert(await pane.evaluate(node => node.scrollTop > 0), '长列表在表内滚动');
    assert(Math.abs((await targets.locator('th').first().boundingBox()).y - headerTop) <= 2, name + ' 滚动后表头固定');
    await pane.evaluate(node => node.scrollTop = 0);
    if (width < 600) {
      await pane.evaluate(node => node.scrollLeft = node.scrollWidth);
      const bounds = await pane.boundingBox();
      for (const button of await candidateRows.first().getByRole('button').all()) {
        const rect = await button.boundingBox();
        assert(rect.x >= bounds.x && rect.x + rect.width <= bounds.x + bounds.width + 1, '手机上横滚后可触达两项操作');
      }
      await pane.evaluate(node => node.scrollLeft = 0);
    }
    assert.equal(await replaceTarget(201).isVisible(), true);
    assert.equal(await dialog.getByRole('button', { name: /关闭/ }).count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, name + ' 页面不能横向溢出');
    assert.equal(await dialog.evaluate(node => node.scrollWidth > node.clientWidth + 2), false, name + ' 管理弹窗不能横向溢出');
    await dialog.screenshot({ path: path.join(output, 'manager-' + name + '.png') });
    await closeDialog();
    await openManager(page, '公会科技点');
    assert.deepEqual(await candidateRows.evaluateAll(rows => rows.map(row => row.dataset.candidateField)), ['204']);
    const factoryPlot = candidateRows.first().locator('td').first();
    assert.equal(await factoryPlot.innerText(), '堡垒F2\nLv.5 工厂');
    for (const line of await factoryPlot.locator('strong, small').all()) {
      assert(await line.evaluate(node => node.scrollWidth <= node.clientWidth), '窄屏也能直接读到城名、等级和建筑类型');
    }
    await closeDialog(); payload = fixture; await page.locator('#resource-fields-refresh').click(); await waitIdle(page);
    await openManager(page); await page.locator('[data-resource-field="201"]').click(); await waitReady(page);
    assert.equal(await page.locator('dialog[open]').count(), 1, '确认复用同一弹窗');
    assert.equal(await page.locator('#resource-fields-manager').isVisible(), false);
    assert.match(await dialog.textContent(), /本次消耗 300 汽油/);
    assert.equal(await dialog.locator('input[value="2远征船"]').isDisabled(), true);
    const before = requests.filter(row => row.url.includes('/action')).length;
    await page.locator('#resource-fields-action-confirm').click(); await waitIdle(page);
    assert.equal(requests.filter(row => row.url.includes('/action')).length, before + 1);
    assert.deepEqual(requests.filter(row => row.url.includes('/action')).at(-1).body, { confirm: true, token: 'quote-201', fleetId: '1远征船' });
    assert.equal(await page.locator('#resource-fields-feedback').isVisible(), false, '占领派遣成功后不显示提示');
    await openManager(page, '种子');
    const beforeSelection = requests.length;
    await replaceTarget(203).click();
    assert.equal(await targets.isVisible(), false);
    assert.equal(await selectOld(101).isVisible(), true, '跨资源旧田可选');
    assert.equal(await selectOld(102).isVisible(), true);
    await dialog.screenshot({ path: path.join(output, 'choose-old-' + name + '.png') });
    await page.locator('#resource-fields-action-back').click();
    assert.equal(await targets.isVisible(), true);
    assert.equal(requests.length, beforeSelection, '选择旧田前返回不会产生预览或写入');
    await replace(203, 102);
    assert.deepEqual(requests.filter(row => row.url.includes('/preview')).at(-1).body, { gridIdx: 203, replaceGridIdx: 102 });
    assert.match(await dialog.textContent(), /先放弃旧田/); assert.match(await dialog.textContent(), /预计 种子 \+720\/小时/);
    assert.match(await dialog.textContent(), /不会自动恢复旧田/); assert.equal(await dialog.locator('img').count(), 0);
    assert.equal(await page.locator('#resource-fields-action-confirm').textContent(), '放弃旧田并派遣');
    await dialog.evaluate(node => node.scrollTop = 0); await dialog.screenshot({ path: path.join(output, 'replacement-' + name + '.png') });
    await page.locator('#resource-fields-action-back').click(); assert.equal(await selectOld(102).isVisible(), true);
    await closeDialog();
    await openManager(page); await replace(201, 102);
    assert.match(await dialog.textContent(), /跨资源替换/); assert.doesNotMatch(await dialog.textContent(), /预计 汽油 \+/);
    actionResult = { ...confirmedDispatch, released: true, partial: false, reason: '旧田已放弃，新田派遣已确认，最终占领以资源田列表为准' };
    await page.locator('#resource-fields-action-confirm').click(); await waitIdle(page);
    assert.equal(await page.locator('#resource-fields-feedback').isVisible(), false, '替换派遣成功后不显示提示');
    await oil.click(); await page.locator('[data-resource-give-up="101"]').click(); await waitReady(page);
    assert.deepEqual(requests.filter(row => row.url.includes('/preview')).at(-1).body, { kind: 'giveUp', gridIdx: 101 });
    assert.match(await dialog.textContent(), /放弃后减少 汽油 660\/小时/);
    assert.equal(await dialog.locator('input[name="resource-field-fleet"]').count(), 0);
    assert.match(await dialog.textContent(), /不需要舰队，不消耗汽油/);
    await dialog.evaluate(node => node.scrollTop = 0); await dialog.screenshot({ path: path.join(output, 'give-up-' + name + '.png') });
    actionResult = { kind: 'giveUp', ok: true, status: 'confirmed', reason: '资源田已放弃，名额已释放' };
    await page.locator('#resource-fields-action-confirm').click(); await waitIdle(page);
    assert.deepEqual(requests.filter(row => row.url.includes('/action')).at(-1).body, { confirm: true, token: 'giveup-101' });
    assert.match(await page.locator('#resource-fields-feedback').textContent(), /资源田已放弃/);
    actionResult = confirmedDispatch;
    if (name === 'desktop') {
      const extraSeeds = [[111, 9], [110, 9], [112, null], [113, 7], [114, 4], [115, 3]]
        .map(([grid, level]) => ({ ...fixture.owned[1], grid, level }));
      payload = { ...fixture, owned: [...fixture.owned, ...extraSeeds], count: 8, maxNum: 10 };
      await page.locator('#resource-fields-refresh').click(); await waitIdle(page);
      await seed.click();
      assert.deepEqual(await ownedGrids(), [110, 111, 113, 102, 114, 115, 112]);
      await ownedTable.locator('[data-resource-give-up="115"]').click(); await waitReady(page);
      assert.deepEqual(requests.filter(row => row.url.includes('/preview')).at(-1).body, { kind: 'giveUp', gridIdx: 115 });
      await page.locator('#resource-fields-action-back').click();
      assert.equal(await ownedTable.locator('[data-owned-field]').count(), 7);
      await page.keyboard.press('Escape');
      await openManager(page);
      await replaceTarget(201).click();
      assert.equal(await selectOld(115).isVisible(), true);
      assert.deepEqual(await ownedGrids(), [110, 111, 113, 101, 102, 114, 115, 112], '所有已占类型的旧田统一按等级降序展示');
      assert.doesNotMatch(await ownedTable.innerText(), /海上油井|海上农庄|格\s*\d+/);
      await selectOld(115).click(); await waitReady(page);
      assert.deepEqual(requests.filter(row => row.url.includes('/preview')).at(-1).body, { gridIdx: 201, replaceGridIdx: 115 });
      await page.keyboard.press('Escape');
      payload = fixture; await page.locator('#resource-fields-refresh').click(); await waitIdle(page);
      await openManager(page); await page.locator('[data-resource-field="201"]').click(); await waitReady(page);
      await page.evaluate(() => { resourceFieldsAction.quote.expiresAt = Date.now() - 1; });
      await page.waitForFunction(() => document.querySelector('#resource-fields-action-confirm').disabled);
      await page.locator('#resource-fields-action-back').click(); await closeDialog();
      payload = { ...fixture, candidates: fixture.candidates.map(row => row.grid === 201 ? { ...row, reason: '已有占领任务待确认' } : row) };
      await page.locator('#resource-fields-refresh').click(); await waitIdle(page); await openManager(page);
      assert.equal(await page.locator('[data-resource-field="201"]').count(), 0, '不可占目标整行隐藏，不留下禁用按钮');
      assert.doesNotMatch(await page.locator('#resource-fields-candidates').textContent(), /格 201|已有占领任务待确认/);
      assert.match(await page.locator('#resource-fields-candidate-count').textContent(), /^7 块/);
      assert.deepEqual(await candidateRows.evaluateAll(rows => rows.map(row => Number(row.dataset.candidateField))), [202, 210, 211, 212, 213, 214, 215]);
      await closeDialog();
      for (const unavailable of [{ reason: '城池归属未同步' }, { fuel: 299 }, { fuel: 600, pendingFuel: 301 }]) {
        payload = { ...fixture, ...unavailable };
        await page.locator('#resource-fields-refresh').click(); await waitIdle(page); await openManager(page);
        assert.equal(await page.locator('[data-resource-field]').count(), 0, JSON.stringify(unavailable));
        assert.match(await page.locator('#resource-fields-candidate-count').textContent(), /^0 块/);
        assert.equal(await dialog.locator('[data-resource-replace]').count(), 0);
        await closeDialog(); await oil.click();
        assert.equal(await ownedTable.locator('[data-owned-field]').count(), 1, '无可占田时仍可查看自己的田');
        assert.equal(await page.locator('[data-resource-give-up="101"]').isDisabled(), false);
        await closeDialog();
      }
      payload = { ...fixture, fuel: 600, pendingFuel: 300 };
      await page.locator('#resource-fields-refresh').click(); await waitIdle(page); await openManager(page);
      assert.equal(await page.locator('[data-resource-field]').count(), 8, '扣除待确认消耗后恰好够一次费用时保留候选');
      assert.match(await page.locator('#resource-fields-candidate-count').textContent(), /^8 块/);
      await closeDialog();
      payload = { ...fixture, maxNum: 2, remaining: 0, pending: [] };
      await page.locator('#resource-fields-refresh').click(); await waitIdle(page);
      assert.deepEqual(await types.locator('[data-resource-manage]').allTextContents(), ['换田', '换田', '换田']);
      await openManager(page);
      assert.equal(await page.locator('[data-resource-field]').count(), 0, '满额时可换田但不可新增');
      assert.equal(await dialog.locator('[data-resource-replace]').count(), 8);
      assert.match(await page.locator('#resource-fields-candidate-count').textContent(), /^8 块/);
      await replace(201, 101);
      actionResult = { ok: false, status: 'unknown', partial: true, released: true, reason: '舰队状态已变化，新田尚未出征' };
      let release; actionGate = new Promise(resolve => { release = resolve; });
      const writesBefore = requests.filter(row => row.url.includes('/action')).length;
      await page.locator('#resource-fields-action-confirm').click(); await page.evaluate(() => { void submitResourceFieldAction(); });
      while (requests.filter(row => row.url.includes('/action')).length === writesBefore) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(requests.filter(row => row.url.includes('/action')).length, writesBefore + 1, '重复确认仅发一次'); release(); actionGate = null; await waitIdle(page);
      assert.match(await page.locator('#resource-fields-feedback').textContent(), /旧田已放弃/); assert.match(await page.locator('#resource-fields-feedback').textContent(), /舰队状态已变化/);
      await openManager(page); await replace(201, 101);
      actionResult = { ok: false, status: 'unknown', partial: false, released: false, reason: '放弃结果待确认，尚未出征' };
      await page.locator('#resource-fields-action-confirm').click(); await waitIdle(page);
      assert.equal(await page.locator('#resource-fields-feedback').textContent(), '放弃结果待确认，尚未出征');
      payload = fixture; actionResult = confirmedDispatch;
      payload = { ...fixture, candidates: fixture.candidates.map(row => row.grid === 203 ? { ...row, name: '<img src=x onerror=alert(1)>' } : row) };
      await page.locator('#resource-fields-refresh').click(); await waitIdle(page); await openManager(page, '种子');
      assert.match(await page.locator('#resource-fields-candidates').textContent(), /<img src=x onerror=alert\(1\)>/);
      assert.equal(await page.locator('#resource-fields-candidates img').count(), 0);
      await closeDialog(); payload = fixture;
      fail = true; await page.locator('#resource-fields-refresh').click(); await waitIdle(page);
      assert.match(await page.locator('#resource-fields-feedback').innerText(), /资源田同步失败.*模拟读取失败/);
      assert.equal(await page.locator('[data-resource-manage="汽油"]').isDisabled(), true);
      await seed.click();
      assert.equal(await ownedTable.locator('[data-resource-give-up="102"]').isDisabled(), true, '同步失败后可查看明细，放弃禁用');
      await page.keyboard.press('Escape');
      fail = false;
      await page.locator('#resource-fields-refresh').click(); await waitIdle(page);
      const beforeHidden = requests.length;
      await page.evaluate(() => { $('tab-overview').classList.add('hidden'); resourceFieldsLastAttempt = 0; maybeRefreshResourceFields(); });
      assert.equal(requests.length, beforeHidden); await page.evaluate(() => { $('tab-overview').classList.remove('hidden'); resourceFieldsLastAttempt = Date.now(); });
      await openManager(page); const beforeDialog = requests.length;
      await page.evaluate(() => { resourceFieldsLastAttempt = 0; maybeRefreshResourceFields(); }); assert.equal(requests.length, beforeDialog, '管理中暂停自动刷新');
      await closeDialog();
      gate = new Promise(resolve => { release = resolve; }); await page.evaluate(() => { void refreshResourceFieldsOverview(); });
      while (requests.length === beforeDialog) await new Promise(resolve => setTimeout(resolve, 10));
      await page.evaluate(() => { current = 'second'; resourceFieldsAccountChanged(); resourceFieldsLastAttempt = Date.now(); });
      assert.equal(await page.locator('[data-resource-manage]').count(), 0); release(); gate = null; await page.waitForTimeout(80);
      assert.equal(await page.locator('[data-resource-manage]').count(), 0, '旧账号响应不能覆盖');
      await page.locator('#resource-fields-refresh').click(); await waitIdle(page); assert.equal(await dialog.isVisible(), false);
      await seed.click(); previewGate = new Promise(resolve => { release = resolve; });
      const beforePreview = requests.length; await ownedTable.locator('[data-resource-give-up="102"]').click();
      while (requests.length === beforePreview) await new Promise(resolve => setTimeout(resolve, 10));
      await page.evaluate(() => { current = 'third'; resourceFieldsAccountChanged(); resourceFieldsLastAttempt = Date.now(); });
      release(); previewGate = null; await page.waitForTimeout(80); assert.equal(await dialog.isVisible(), false);
      payload = { ...fixture, candidates: [], count: null, maxNum: null, remaining: null, owned: [], totals: [], reason: '世界玩法尚未开放' };
      await page.locator('#resource-fields-refresh').click(); await waitIdle(page); assert.match(await page.locator('#resource-fields-capacity').textContent(), /未同步 \/ 未同步/);
      payload = { ...fixture, owned: [...fixture.owned, { grid: 999, resourceId: null, active: null }], count: 3 };
      await page.locator('#resource-fields-refresh').click(); await waitIdle(page); assert.match(await page.locator('#resource-fields-capacity').textContent(), /类型待同步 1/); payload = fixture;
      payload = { ...fixture, owned: fixture.owned.map(row => row.grid === 101 ? { ...row, replacementReason: '已有替换任务待确认' } : row) };
      await page.locator('#resource-fields-refresh').click(); await waitIdle(page); await openManager(page);
      await replaceTarget(201).click();
      assert.equal(await selectOld(101).isDisabled(), true, '已有任务的地块不能选为替换旧田');
      await closeDialog(); payload = fixture;
      payload = { ...fixture, fleets: [], automatic: true, reason: '暂无可用舰队' };
      await page.locator('#resource-fields-refresh').click(); await waitIdle(page); await openManager(page);
      assert.equal(await page.locator('[data-resource-field]').count(), 0, '没有可用舰队时隐藏全部候选');
      assert.match(await page.locator('#resource-fields-candidate-count').textContent(), /^0 块/);
      await closeDialog(); await seed.click();
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
      await seed.click(); assert.equal(await page.locator('[data-resource-give-up="102"]').isDisabled(), true);
      await closeDialog(); await oil.click();
      assert.equal(await page.locator('[data-resource-give-up="101"]').isDisabled(), false);
      await closeDialog();
      payload = fixture; actionResult = confirmedDispatch;
      payload = { ...fixture, owned: fixture.owned.map(row => row.grid === 101 ? { ...row, active: null, perHour: null } : row) };
      await page.locator('#resource-fields-refresh').click(); await waitIdle(page); await oil.click();
      await page.locator('[data-resource-give-up="101"]').click(); await waitReady(page);
      assert.match(await dialog.textContent(), /该田当前产量未同步，放弃后会失去其产出/);
      assert.doesNotMatch(await dialog.textContent(), /放弃后减少 汽油 0/);
      await closeDialog(); payload = fixture;
      await page.evaluate(() => { snapshot.paused = true; resourceFieldsAccountChanged(); }); assert.equal(await page.locator('#resource-fields-refresh').isDisabled(), true);
    }
    await page.close(); console.log('通过：' + name + ' 资源田卡片、分类明细全量展示、单行放弃、逐行换田、全量候选与确认');
  }
  assert.deepEqual(errors, []); console.log('通过：仅显示可占领候选、按资源过滤及等级降序、汽油和待确认消耗、满额替换恢复/取消、收益比较、跨资源替换、逐行绑定、无舰队放弃、自动占领提醒、未知产量、部分失败、未知放弃、重复确认、过期、账号隔离与停刷；未连接游戏');
  console.log('截图：' + output);
} finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
