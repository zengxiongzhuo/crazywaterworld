// 隔离控制台账号，模拟世界地图与城池接口，覆盖选择和确认期间的竞态。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-city-actions-browser-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
process.env.CW_RESOURCE_AUTO_UPDATE = '0';
const { saveStore } = await import('../src/accounts.mjs');
const { createConsole } = await import('./fixtures/console-server.mjs');
const { GameClient } = await import('../src/client.mjs');
GameClient.prototype.connect = async () => { throw Error('界面验收禁止连接游戏'); };
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');
const account = 'map-owner', second = 'map-other';
saveStore({ activeId: account, accounts: [account, second].map(id => ({ id, label: id, url: 'wss://invalid.invalid', login: {}, automation: { enabled: false, paused: true } })) });
const app = createConsole({ port: 0, protocol: {} }), base = await app.listen();
await fetch(base + '/api/settings?account=' + account);
const session = app.sessions.get(account);
Object.assign(session, { client: { connected: true, request: async () => ({}) }, player: { playerId: '1', worldId: 1001, scenarioId: 1 }, paused: false });
const points = [11, 12, 13, 14, 15].map((cityId, i) => ({
  cityId, key: 'city-' + cityId, name: ['南港', '西港', '要塞E6', '要塞F3', '山景城'][i], owner: 2, detail: '', layer: 'cities',
  x: [20, 980, 400, 550, 680][i], y: [130, 220, 390, 240, 250][i],
  cityInfo: { owner: '青盟', status: '当前无宣战', declared: [], fighters: [], attack: 0, defence: 0 },
}));
Object.assign(points[2], { declared: true, fighting: true });
Object.assign(points[2].cityInfo, {
  status: '交战中', declared: [{ attack: '赤盟', defence: '青盟' }],
  priorityAttack: 2, attack: 7, priorityDefence: 3, defence: 11,
  fighters: [{ index: 1, attack: '赤帆', defence: '海卫' }],
});
const hillCity = points[4];
Object.assign(hillCity.cityInfo, { owner: '风栖港', status: '当前非城战时间', priorityDefence: 0, defence: 455 });
const executablePath = [process.env.CW_BROWSER_TEST_EXECUTABLE, chromium.executablePath(), 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(file => file && fs.existsSync(file));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
async function waitForGate(gate) {
  let timer;
  try {
    await Promise.race([gate.started.promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('等待地图操作请求超时')), 8000);
    })]);
  } finally { clearTimeout(timer); }
}
async function checkFleetSummary(page, mobile, fleets) {
  const summary = page.locator('#world-map-fleets');
  const headers = summary.locator('thead th');
  await page.evaluate(() => refreshWorldMap());
  assert.deepEqual(await headers.allTextContents(), ['舰队','耐久','状态','征程','操作']);
  assert.equal(await summary.locator('td[data-label="操作"] button').count(), 0, '主城空闲时没有正在执行的行军或维修');
  const columnEdges = () => headers.evaluateAll(nodes => nodes.map(node => {
    const rect = node.getBoundingClientRect();
    return [rect.left, rect.right];
  }));
  const initial = await columnEdges();
  const checkWidth = async () => {
    if (mobile) {
      assert(await summary.evaluate(root => root.scrollWidth <= root.clientWidth + 1 &&
        [...root.querySelectorAll('tbody td')].every(cell => cell.getBoundingClientRect().right <= window.innerWidth + 1)),
      '窄屏下舰队信息和操作应在视口内');
    } else {
      const updated = await columnEdges();
      for (const [i, limits] of updated.entries()) {
        assert(limits[1] > limits[0] && limits.every((edge, j) => Math.abs(edge - initial[i][j]) < 1),
          '征程和操作变化时，第 ' + (i + 1) + ' 列的边界应保持稳定');
      }
    }
  };
  const now = Math.floor(Date.now() / 1000);
  fleets[0].state = '城战 · 行军';
  fleets[0].journey = {from:'联盟主城',to:'来自海峡另一侧的特别长的目的城池名称',startAt:now-80,endAt:now+65};
  const role = {worldId:'1001',playerId:'1'};
  fleets[0].speedTarget = {...role,buildingId:fleets[0].id,mode:'march',start:now-80,target:12,targetCityId:12,targetGridIdx:38,cargo:'0'};
  fleets[1].state = '维修';
  fleets[1].durability = 10;
  fleets[1].speedTarget = {...role,buildingId:fleets[1].id,mode:'repair',start:now-21,target:2200};
  await page.evaluate(() => refreshWorldMap());
  const journey = summary.locator('.world-journey').first();
  await journey.filter({hasText:'特别长'}).waitFor();
  await checkWidth();
  const previous = await journey.innerText();
  await page.waitForFunction(old => document.querySelector('#world-map-fleets .world-journey').textContent !== old, previous);
  await checkWidth();

  const previews = [], submissions = [];
  const costs = {march:30, repair:24};
  await page.route('**/api/world/fleet-speed/preview?*', async route => {
    const request = route.request(), target = request.postDataJSON();
    assert.equal(request.method(), 'POST');
    assert.equal(new URL(request.url()).searchParams.get('account'), account);
    previews.push(target);
    await route.fulfill({json:{token:target.mode+'-'+previews.length,maxCost:costs[target.mode],expiresAt:Date.now()+120000}});
  });
  const gate = {started:deferred(), release:deferred()};
  await page.route('**/api/world/fleet-speed/action?*', async route => {
    const request = route.request(), payload = request.postDataJSON();
    assert.equal(request.method(), 'POST');
    assert.equal(new URL(request.url()).searchParams.get('account'), account);
    submissions.push(payload);
    const target = previews[Number(payload.token.split('-')[1])-1];
    if (target.mode === 'march') {gate.started.resolve(); await gate.release.promise;}
    const fleet = fleets.find(row => row.id === target.buildingId);
    Object.assign(fleet, {journey:null,speedTarget:null,state:target.mode==='repair'?'主城空闲':'驻守在外',durability:2200});
    await route.fulfill({json:{status:'completed',message:fleet.name+'加速已完成'}});
  });
  const ok = page.locator('#m-ok'), modal = page.locator('#modal');
  for (const [index,label] of ['派遣加速','维修加速'].entries()) {
    const fleet = fleets[index], target = {...fleet.speedTarget};
    const row = summary.locator('tbody tr').filter({has:page.getByRole('button',{name:'定位舰队'+(index+1),exact:true})});
    const action = row.getByRole('button',{name:label,exact:true});
    assert.equal(await row.locator('td[data-label="操作"] button').count(), 1);
    if (mobile) await action.tap(); else await action.click();
    await modal.waitFor();
    assert.deepEqual(previews.at(-1), target, '预览应绑定点击行的舰队及当前任务');
    assert.match(await modal.innerText(), new RegExp(costs[target.mode]+'\\s*钻石'));
    if (index === 0) {
      await page.locator('#m-cancel').click();
      assert.equal(submissions.length, 0, '取消报价不应执行加速');
      await action.click(); await modal.waitFor();
    } else {
      fleet.speedTarget = {...target,start:target.start+1};
      await page.evaluate(() => refreshWorldMap());
      if (await modal.isVisible()) await ok.click();
      assert.equal(submissions.length, index, '报价期间舰队改为另一项维修，不得套用旧报价');
      await action.click(); await modal.waitFor();
      assert.deepEqual(previews.at(-1), fleet.speedTarget);
    }
    const expectedToken = target.mode+'-'+previews.length;
    await ok.evaluate(button => {button.click(); button.click();});
    if (index === 0) {
      try {
        await waitForGate(gate);
        await page.evaluate(() => refreshWorldMap());
        assert(await action.isDisabled(), '提交期间地图刷新后仍防止重复加速');
      } finally {gate.release.resolve();}
    }
    await row.getByText(target.mode==='repair'?'主城空闲':'驻守在外',{exact:true}).waitFor();
    assert.equal(await action.count(), 0, '本次任务完成后移除对应操作');
    assert.equal(submissions.length, index+1);
    assert.deepEqual(submissions.at(-1), {confirm:true,token:expectedToken,confirmedCost:costs[target.mode]});
    await checkWidth();
  }
}
async function checkActionLayout(panel, mobile, expectedLabels) {
  const layout = await panel.evaluate(root => {
    const controls = [...root.querySelectorAll('select, button')].map(node => {
      const { left, right, top, bottom, width } = node.getBoundingClientRect();
      return { label: node.tagName === 'SELECT' ? node.getAttribute('aria-label') : node.textContent.trim(),
        left, right, top, bottom, width };
    });
    return { controls, width: root.getBoundingClientRect().width, fits: root.scrollWidth <= root.clientWidth + 1 };
  });
  assert.deepEqual(layout.controls.map(control => control.label).sort(), [...expectedLabels].sort());
  assert(layout.fits, '操作区不能横向溢出');
  const ordered = layout.controls.sort((a, b) => mobile ? a.top - b.top : a.left - b.left);
  for (const [index, control] of ordered.entries()) {
    if (mobile) {
      assert(Math.abs(control.width - layout.width) <= 2, control.label + ' 在手机端应占满一行');
      if (index) assert(control.top >= ordered[index - 1].bottom - 1, '手机端控件应分行显示');
    } else {
      const middle = (control.top + control.bottom) / 2;
      assert(Math.abs(middle - (ordered[0].top + ordered[0].bottom) / 2) <= 2, '桌面端控件应在同一行');
      if (index) assert(control.left >= ordered[index - 1].right - 1, '桌面端相邻控件不能重叠');
    }
  }
}
let browser;
try {
  browser = await chromium.launch({ executablePath, headless: true });
  for (const width of [1280, 360, 320]) {
    const mobile = width < 500;
    const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: mobile });
    page.setDefaultTimeout(8000);
    const errors = [], posts = [], defenderReads = [], tokens = new Map();
    let previewGate, writeGate, sequence = 0, member = false, enemyWar = true, rallied = false, recruited = false;
    let expireNextQuote = false, defending = true;
    const ownFleets = [
      { buildingId:'1远征船', name:'远征舰队 1 队', status:'行军中' },
      { buildingId:'2远征船', name:'远征舰队 2 队', status:'空闲' },
      { buildingId:'3远征船', name:'远征舰队 3 队', status:'空闲' },
    ];
    const nearbyFleets = ownFleets.slice(1).map(f => ({
      layer: 'fleets', key: 'fleet-' + f.buildingId, name: f.name, grid: 103, x: hillCity.x, y: hillCity.y,
      fleetInfo: { state: '主城空闲', task: '空闲', durability: 2200, maxDura: 2200 },
    }));
    const now = Math.floor(Date.now() / 1000);
    const motion = { start: { x: 398, y: 390 }, end: { x: 402, y: 390 }, from: '北港', to: '要塞E6', startAt: now - 30, endAt: now + 300 };
    const traffic = { layer: 'traffic', key: 'traffic-7:1远征船', name: '海鸥 · 舰队1',
      x: motion.start.x, y: motion.start.y, motion, detail: '行军至 要塞E6 · 耐久 1,900/2,200' };
    let speedFleets = ownFleets.map(f => ({id:f.buildingId,name:f.name,state:'主城空闲',durability:2200,maxDura:2200}));
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/world/overview?*', route => route.fulfill({ json: { checkedAt: Date.now() / 1000, scenario: 1,
      width: 1000, height: 500, regions: [], owners: [], points: [...points, ...nearbyFleets, traffic], routes: [],
      fleets: speedFleets ?? ownFleets.map(f => ({ id:f.buildingId, name:f.name, state:f.status })),
      cityWars: [], treasures: [], layers: {}, notes: ['情报未同步'] } }));
    await page.route('**/api/overview?*', async route => {
      await route.fulfill({ json: { player: { nickname: '地图测试', level: 36 }, resources: [], status: { connected: true, paused: false } } });
    });
    await page.route('**/api/world/city-defence*', async route => {
      defenderReads.push(route.request().url());
      await route.abort();
    });
    await page.route('**/api/world/city-actions?*', async route => {
      const request = route.request(), params = new URL(request.url()).searchParams;
      assert.equal(params.get('account'), account);
      if (request.method() === 'POST') {
        posts.push(request.postDataJSON());
        if (writeGate) { writeGate.started.resolve(); await writeGate.release.promise; }
        const action=posts.at(-1).action;
        if (action === 'dispatch') ownFleets.find(f=>f.buildingId===posts.at(-1).buildingId).status='行军中';
        if (action === 'cancelDeclare') enemyWar = false;
        if (action === 'assemble') rallied = true;
        if (action === 'recruit') recruited = true;
        if (action === 'declare') enemyWar = true;
        await route.fulfill({ json: { message: '操作已确认' } }); return;
      }
      assert.equal(params.get('scenarioId'), '1');
      assert.equal(params.get('includeDefenders'), '0', '点城时只预览可用操作');
      const city = Number(params.get('cityId'));
      if (previewGate && city === previewGate.city) { previewGate.started.resolve(); await previewGate.release.promise; }
      const home = city === 11, enemy = city === 12, owned = home || city === 14;
      const fleetChoices = ownFleets.map(f => ({ ...f, available: f.status === '空闲' && (owned || (enemy && enemyWar)) }));
      const fleets = fleetChoices.filter(f => f.available).map(({ buildingId, name }) => ({ buildingId, name }));
      const token = city === 13 ? null : city + '-' + (++sequence);
      tokens.set(city, token);
      const expiresAt = Date.now() + (expireNextQuote ? -1000 : 120000);
      expireNextQuote = false;
      await route.fulfill({ json: { token, expiresAt,
        dispatch: { fleets, fleetChoices, reason: city === 13 ? '本盟尚未向该城宣战' : '', intent: owned ? (home && defending ? 'reinforce' : 'relocate') : 'attack', cost: owned ? 0 : 300 },
        defence: { deferred: true },
        declare: { allowed: !member && enemy && !enemyWar, visible: !member, owner: 3, count: 1, limit: 3 },
        cancelDeclare: { visible: !member && enemy && enemyWar, allowed: !member && enemy && enemyWar, cost: 200 },
        assemble: { visible:!member && home, allowed:!member && home && !rallied, currentCityId:12, currentName:'西港', role:'defence' },
        recruit: { visible:home, allowed:home && !recruited, pending:home && recruited, stock:2, cost:1, gain:10, itemId:'联盟募兵令' }
      } });
    });
    await page.goto(base);
    const marker = id => page.locator('[data-world-target="city-' + id + '"]');
    const detail = page.locator('#world-map-detail'), panel = detail.locator('#world-map-city-actions');
    const close = detail.getByRole('button', { name: '关闭地图详情' });
    const openCity = id => mobile ? marker(id).tap() : marker(id).click();
    async function closeCity() {
      if (mobile) await close.tap(); else await close.click();
      await detail.waitFor({ state: 'hidden' });
    }
    const fleet = panel.getByRole('combobox', { name: '请选择空闲舰队', exact: true });
    const declare = panel.getByRole('button', { name: '宣战', exact: true });
    const send = panel.getByRole('button', { name: '进攻', exact: true });
    const cancelWar = panel.getByRole('button', { name: '取消宣战', exact: true });
    await marker(11).waitFor();
    await checkFleetSummary(page, mobile, speedFleets);
    speedFleets = null;
    await page.locator('#world-map-scroll').evaluate(node => node.scrollIntoView({ block: 'center' }));
    const emptyHillBox = async () => {
      const measurement = await detail.evaluate(async node => {
        await Promise.all(node.getAnimations().map(animation => animation.finished));
        const actions = node.querySelector('#world-map-city-actions');
        const { x, y, width, height } = node.getBoundingClientRect();
        return { text: actions.innerText.trim(), actionHeight: actions.getBoundingClientRect().height,
          overflowY: node.scrollHeight - node.clientHeight, box: { x, y, width, height } };
      });
      assert.equal(measurement.actionHeight, 0, '普通城读取操作和无操作时均不应占位：' + measurement.text);
      assert(measurement.overflowY <= 1, '读取操作不应使双舰队弹窗出现纵向滚动条');
      return measurement.box;
    };
    let popup;
    for (const phase of ['首次打开', '舰队状态刷新']) {
      previewGate = { city: hillCity.cityId, started: deferred(), release: deferred() };
      if (phase === '首次打开') await openCity(hillCity.cityId);
      else {
        ownFleets[0].status = '维修中';
        await page.evaluate(() => refreshWorldMap());
      }
      await waitForGate(previewGate);
      let pendingBox;
      try {
        pendingBox = await emptyHillBox();
      } finally { previewGate.release.resolve(); }
      await page.waitForFunction(() => !callsInFlight);
      const readyBox = await emptyHillBox();
      for (const key of ['x', 'y', 'width', 'height']) {
        assert(Math.abs(pendingBox[key] - readyBox[key]) <= 1, phase + '收到空操作前后，弹窗的 ' + key + ' 应保持稳定');
        if (popup) assert(Math.abs(popup[key] - readyBox[key]) <= 1, '后台刷新保留弹窗的 ' + key);
      }
      popup = readyBox;
    }
    previewGate = null; ownFleets[0].status = '行军中';
    const idleCards = detail.getByRole('article');
    assert.equal(await idleCards.count(), 2);
    const [firstCard, secondCard] = await idleCards.evaluateAll(cards => cards.map(card => card.getBoundingClientRect().toJSON()));
    const overflow = await detail.evaluate(node => ({ x: node.scrollWidth - node.clientWidth, y: node.scrollHeight - node.clientHeight }));
    assert(overflow.x <= 1 && popup.x >= 0 && popup.x + popup.width <= width + 1, '两支舰队的弹窗应在屏内且没有横向滚动');
    if (!mobile) {
      assert(Math.abs(firstCard.top - secondCard.top) <= 1 && firstCard.right <= secondCard.left, '桌面两支舰队应并排');
      assert(overflow.y <= 1 && secondCard.bottom <= popup.y + popup.height + 1, '普通城的两支舰队应完整显示，无需向下滚动');
    }
    await closeCity();
    for (const point of nearbyFleets) Object.assign(point, { x: points[2].x, y: points[2].y });
    await page.evaluate(() => refreshWorldMap());
    if (!mobile) {
      // 让城池靠近视口下沿，舰队选择框出现时会跨过旧定位算法的上下翻转临界点。
      const west = marker(12);
      await west.evaluate(node => {
        const bottom = node.lastElementChild.getBoundingClientRect().bottom;
        window.scrollBy(0, bottom - (innerHeight - 194));
      });
      const popupPosition = () => detail.evaluate(async node => {
        await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
        const popup = node.getBoundingClientRect();
        const marker = document.querySelector('[data-world-target="city-12"]').lastElementChild.getBoundingClientRect();
        return { left: popup.left - marker.left, right: popup.right - marker.right, top: popup.top - marker.top, above: popup.top < marker.top };
      });
      const assertPosition = (actual, initial, phase, firstLoad = false) => {
        assert.equal(actual.above, initial.above, phase + '时弹窗应留在城池同一侧');
        const edges = firstLoad ? ['right', 'top'] : ['right', 'top', 'left'];
        assert(edges.every(edge => Math.abs(actual[edge] - initial[edge]) <= 1),
          phase + '时弹窗移动了 ' + JSON.stringify({ initial, actual }));
      };
      previewGate = { city: 12, started: deferred(), release: deferred() };
      await openCity(12); await waitForGate(previewGate);
      const loading = await popupPosition();
      previewGate.release.resolve(); await fleet.waitFor();
      const initial = await popupPosition();
      // 右侧城池的其他操作从固定的右边缘向地图内部展开。
      assertPosition(initial, loading, '首次加载舰队', true);
      assert(await detail.evaluate(node => node.scrollHeight <= node.clientHeight + 1), '上方空间足够时，读回的操作按钮应完整可见');
      previewGate = { city: 12, started: deferred(), release: deferred() };
      ownFleets[0].status = '维修中';
      await page.evaluate(() => refreshWorldMap()); await waitForGate(previewGate);
      const refreshing = await popupPosition();
      const controlsWhileLoading = {
        busy: await panel.getAttribute('aria-busy'),
        fleetDisabled: await fleet.isVisible() && await fleet.isDisabled(),
        sendDisabled: await send.isVisible() && await send.isDisabled(),
      };
      previewGate.release.resolve();
      await page.waitForFunction(() => !callsInFlight);
      assertPosition(refreshing, initial, '重新读取舰队状态');
      assertPosition(await popupPosition(), initial, '刷新舰队操作');
      assert.deepEqual(controlsWhileLoading, { busy: 'true', fleetDisabled: true, sendDisabled: true });
      assert.equal(await panel.getAttribute('aria-busy'), 'false');
      assert(await fleet.isEnabled() && await send.isEnabled(), '刷新后恢复舰队操作');
      previewGate = null;
      ownFleets[1].status = ownFleets[2].status = '行军中';
      await page.evaluate(() => refreshWorldMap()); await fleet.waitFor({ state: 'detached' });
      assertPosition(await popupPosition(), initial, '所有舰队变忙后收起选择框');
      ownFleets[1].status = ownFleets[2].status = '空闲';
      await page.evaluate(() => refreshWorldMap()); await fleet.waitFor();
      assertPosition(await popupPosition(), initial, '舰队恢复空闲后显示选择框');
      await closeCity(); ownFleets[0].status = '行军中';
    }
    assert.equal(await page.locator('#world-map-notes').innerText(), '情报未同步');
    assert.doesNotMatch(await page.locator('#tab-overview').textContent(), /行军位置按已同步|未同步的行军不作推测/);
    const fortress = marker(13).locator('.map-symbol');
    if (!mobile) {
      await fortress.hover();
      await page.waitForTimeout(500); // 覆盖旧悬停延时。
      assert(!await detail.isVisible(), '停留在城池上不打开详情');
      assert(!tokens.has(13), '悬停不读取城池操作');
    }
    if (mobile) await fortress.tap(); else await fortress.click();
    await detail.waitFor();
    await page.waitForFunction(() => !callsInFlight);
    const facts = detail.locator('#world-map-target-facts');
    assert.match(await facts.innerText(), /当前归属\s+青盟\s+城战\s+交战中/);
    assert.match(await facts.innerText(), /宣战\s+赤盟 → 青盟/);
    assert.match(await facts.innerText(), /进攻\s+优先 2 \+ 排队 7/);
    assert.match(await facts.innerText(), /驻防\s+优先 3 \+ 普通 11/);
    assert.deepEqual(await facts.getByRole('columnheader').allTextContents(), ['交战位','进攻方','防守方']);
    assert.deepEqual(await facts.getByRole('cell').allTextContents(), ['1','赤帆','海卫']);
    assert.equal(await panel.getByRole('button').count(), 0);
    assert.equal(await fleet.count(), 0);
    assert.equal(await panel.getByRole('button', {name:'刷新条件'}).count(), 0);
    assert.equal((await panel.textContent()).trim(), '', '没有操作时不显示空态提示');
    const nearby = facts.locator('section.world-nearby-fleets');
    const secondFleet = nearby.getByRole('article', { name: '远征舰队 2 队' });
    const thirdFleet = nearby.getByRole('article', { name: '远征舰队 3 队' });
    const marchingFleet = nearby.getByRole('article', { name: traffic.name });
    await secondFleet.waitFor(); await thirdFleet.waitFor(); await marchingFleet.waitFor();
    assert.equal(await nearby.getByRole('article').count(), 3);
    assert.equal(await nearby.locator('details, summary, button').count(), 0, '附近舰队直接展示，无需另开详情');
    assert.match(await secondFleet.innerText(), /主城空闲/);
    assert.match(await secondFleet.innerText(), /2,200\s*\/\s*2,200/);
    assert.match(await secondFleet.innerText(), /任务\s*空闲/);
    assert.match(await marchingFleet.innerText(), /北港\s*→\s*要塞E6/);
    assert(await detail.evaluate(node => node.scrollWidth <= node.clientWidth + 1), '舰队卡片在弹窗内不横向溢出');
    Object.assign(nearbyFleets[1].fleetInfo, { state: '维修中', task: '维修', durability: 899 });
    await page.evaluate(() => refreshWorldMap());
    await thirdFleet.getByText('维修中', { exact: true }).waitFor();
    assert.match(await thirdFleet.innerText(), /899\s*\/\s*2,200/);
    assert.equal(await detail.locator('#world-map-target-name').innerText(), '要塞E6', '舰队刷新保留正在查看的城池');
    if (mobile) {
      assert(await detail.evaluate(node => node.matches(':modal') && node.contains(document.activeElement)));
      await page.touchscreen.tap(2,2); await detail.waitFor({state:'hidden'});
    } else {
      assert(!await detail.evaluate(node => node.matches(':modal')));
      const anchor = await marker(13).boundingBox(), popover = await detail.boundingBox();
      const gapX = Math.max(anchor.x - (popover.x + popover.width), popover.x - (anchor.x + anchor.width), 0);
      const gapY = Math.max(anchor.y - (popover.y + popover.height), popover.y - (anchor.y + anchor.height), 0);
      assert(Math.hypot(gapX,gapY)<48,'详情面板紧邻所选城池');
      await marker(11).hover();
      await page.waitForTimeout(500);
      assert.equal(await detail.locator('#world-map-target-name').innerText(), '要塞E6', '悬停另一城池不会切换详情');
      assert(!tokens.has(11), '悬停另一城池不会读取操作');
    }
    previewGate = { city: 11, started: deferred(), release: deferred() };
    await openCity(11);
    await waitForGate(previewGate);
    assert.match(await facts.innerText(), /城战\s+当前无宣战/);
    assert.match(await facts.innerText(), /驻防\s+优先 未同步 \+ 普通 0/);
    assert.doesNotMatch(await facts.innerText(), /赤帆|海卫/);
    if (mobile) await closeCity();
    await openCity(12); await fleet.waitFor();
    previewGate.release.resolve(); await page.waitForFunction(() => !callsInFlight); previewGate = null;
    assert.equal(await detail.locator('strong').first().textContent(), '西港');
    assert.equal(await fleet.inputValue(), '2远征船', '默认选中第一支可派舰队');
    assert.deepEqual(await fleet.locator('option').evaluateAll(nodes => nodes.map(o => [o.value,o.text,o.disabled])), [
      ['1远征船','远征舰队 1 队 · 行军中',true],
      ['2远征船','远征舰队 2 队 · 空闲',false],
      ['3远征船','远征舰队 3 队 · 空闲',false],
    ]);
    assert.equal(await send.isEnabled(), true);
    if (!mobile) {
      await page.mouse.move(2, 2); await page.waitForTimeout(500);
      assert(await detail.isVisible(), '打开详情后移开鼠标仍可查看');
    }
    await fleet.selectOption('3远征船');
    await page.evaluate(() => refreshWorldMap());
    assert.equal(await fleet.inputValue(), '3远征船', '地图刷新保留主动选择');
    ownFleets[2].status='维修中';
    await page.evaluate(() => refreshWorldMap()); await page.waitForFunction(() => !callsInFlight);
    assert.equal(await fleet.inputValue(), '3远征船', '已选舰队变忙后仍显示该舰队的最新状态');
    assert(await fleet.locator('option:checked').isDisabled());
    assert.match(await fleet.locator('option:checked').innerText(), /维修中/);
    assert(await send.isDisabled(), '仍有其他可选舰队时不能擅自换队发出');
    await send.evaluate(button => button.click());
    assert.deepEqual(posts, []);
    await fleet.selectOption('2远征船');
    assert(await send.isEnabled(), '主动改选空闲舰队恢复派遣');
    ownFleets[2].status='空闲';
    await page.evaluate(() => refreshWorldMap()); await page.waitForFunction(() => !callsInFlight);
    await fleet.selectOption('3远征船');
    ownFleets[1].status='行军中';
    await page.evaluate(() => refreshWorldMap()); await page.waitForFunction(() => !callsInFlight);
    assert.equal(await fleet.inputValue(), '3远征船');
    const token = tokens.get(12);
    assert.equal(await detail.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
    const bounds = await detail.boundingBox(); assert(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
    await checkActionLayout(panel, mobile, ['请选择空闲舰队', '进攻', '取消宣战']);
    assert.doesNotMatch(await panel.innerText(), /确认进攻|汽油/);
    if (!mobile) {
      const stage = await page.locator('#world-map-scroll').boundingBox();
      assert(bounds.x >= stage.x && bounds.x + bounds.width <= stage.x + stage.width + 1, '边缘城池的横排菜单须在地图内');
    }
    await cancelWar.click();
    assert(await page.locator('#modal').evaluate(node => node.matches(':modal')));
    await page.locator('#m-cancel').click();
    assert.equal(posts.length, 0); assert(await detail.isVisible());
    if (mobile) assert(await detail.evaluate(node => node.matches(':modal') && node.contains(document.activeElement)));
    writeGate = { started: deferred(), release: deferred() };
    await send.evaluate(button => { button.click(); button.click(); }); await waitForGate(writeGate);
    assert.deepEqual(posts, [{ confirm: true, token, cityId: 12, action: 'dispatch', buildingId: '3远征船' }]);
    await page.evaluate(() => refreshWorldMap());
    assert.equal(await panel.getByRole('button').count(), 0, '进行中的派遣不会因自动刷新重复提交');
    writeGate.release.resolve(); await cancelWar.waitFor(); writeGate = null;
    await page.waitForFunction(() => !callsInFlight);
    assert.equal(await fleet.count(), 0);
    ownFleets[1].status='空闲'; await page.evaluate(() => refreshWorldMap()); await fleet.waitFor();
    assert.equal(await fleet.inputValue(), '2远征船', '成功派遣后重新显示选队时选中实际归队的舰队');
    assert(await send.isEnabled());
    await cancelWar.click();
    const confirmText = page.locator('#m-body [data-city-confirm]');
    assert.equal(await confirmText.textContent(), '取消宣战后，将不可再向目标城派遣部队，是否确定？');
    assert.match(await page.locator('#m-body').innerText(), /当前角色消耗 200 钻石/);
    await page.locator('#m-ok').click(); await declare.waitFor();
    assert.equal(posts[1].action, 'cancelDeclare'); assert.equal(posts[1].confirmedCost,200);
    await declare.click(); assert.equal(await confirmText.textContent(), '确认向城市西港宣战');
    assert.match(await page.locator('#m-body').textContent(), /联盟 3.*1 \/ 3/s);
    await page.locator('#m-ok').click(); await cancelWar.waitFor(); assert.equal(posts[2].action, 'declare');
    if (mobile) await closeCity();
    await openCity(11); await panel.getByRole('button',{name:'前往', exact:true}).waitFor();
    await checkActionLayout(panel, mobile, ['请选择空闲舰队', '前往', '高级募兵', '集结']);
    await panel.getByRole('button',{name:'集结', exact:true}).click();
    assert.equal(await confirmText.textContent(), '确认向城市南港集结');
    await page.locator('#m-ok').click(); await panel.getByRole('button',{name:'高级募兵'}).waitFor();
    assert.equal(posts[3].action,'assemble');
    member = true; await closeCity(); expireNextQuote = true; await openCity(11);
    const recruit=panel.getByRole('button',{name:'高级募兵'}); await recruit.waitFor();
    assert.equal(await panel.getByRole('button',{name:'集结', exact:true}).count(),0);
    await recruit.click(); await panel.getByText(/已过期/).waitFor(); await recruit.waitFor();
    assert.equal(posts.length, 4, '过期选择自动更新且保持未提交');
    await recruit.click();
    assert.equal(await confirmText.textContent(), '高级募兵每次消耗1个“联盟募兵令”，为城市征召10个城防军');
    assert.match(await page.locator('#m-body').innerText(), /持有：2/);
    await page.locator('#m-ok').click(); await panel.getByRole('button',{name:'核对募兵结果'}).click();
    await panel.getByRole('button',{name:'核对募兵结果'}).waitFor();
    assert.deepEqual(posts.slice(4).map(p=>[p.action,p.confirmedCost]),[['recruit',1],['checkRecruit',undefined]]);
    assert.equal(await declare.count(), 0);
    await closeCity();
    defending = false; await openCity(11); await panel.getByRole('button', {name:'前往', exact:true}).waitFor();
    assert.doesNotMatch(await panel.innerText(), /确认前往|汽油/);
    await closeCity();
    await openCity(14);
    const go = panel.getByRole('button', { name: '前往', exact: true });
    await go.waitFor();
    await checkActionLayout(panel, mobile, ['请选择空闲舰队', '前往']);
    if (!mobile) {
      const { width, rightSpace } = await go.evaluate(button => {
        const dialog = button.closest('dialog').getBoundingClientRect();
        return { width: dialog.width, rightSpace: dialog.right - button.getBoundingClientRect().right };
      });
      assert(rightSpace >= 0 && rightSpace <= 32, '仅能前往时按钮右侧留白过多：' + rightSpace + 'px');
      assert(width <= 320, '仅能前往时弹窗整体过宽：' + width + 'px');
      console.log('通过：选队与前往弹窗宽 ' + Math.round(width) + 'px，按钮右侧留白 ' + Math.round(rightSpace) + 'px');
    }
    await closeCity();
    // 将两支舰队同步到城外同一格，直接点地图群组即可查看全部卡片。
    for (const point of nearbyFleets) Object.assign(point, { x: 350, y: 180, grid: 104 });
    await page.evaluate(() => refreshWorldMap());
    const group = page.locator('[data-world-target="fleet-2远征船"]');
    if (mobile) await group.tap(); else await group.click();
    await detail.getByRole('article', { name: '远征舰队 2 队' }).waitFor();
    await detail.getByRole('article', { name: '远征舰队 3 队' }).waitFor();
    assert.equal(await detail.getByRole('article').count(), 2);
    assert.equal(await facts.getByRole('button').count(), 0);
    assert.equal(await detail.evaluate(node => node.matches(':modal')), mobile);
    if (!mobile) {
      const anchor = await group.boundingBox(), popup = await detail.boundingBox();
      const dx = Math.max(0, anchor.x - popup.x - popup.width, popup.x - anchor.x - anchor.width);
      const dy = Math.max(0, anchor.y - popup.y - popup.height, popup.y - anchor.y - anchor.height);
      assert(Math.hypot(dx, dy) < 48, '舰队详情应紧邻地图上的舰队');
    }
    Object.assign(nearbyFleets[1], { x: 650, y: 280, grid: 105 });
    await page.evaluate(() => refreshWorldMap());
    assert.equal(await detail.getByRole('article').count(), 1, '舰队离开同一地图格后更新已打开的卡片');
    await closeCity();
    const single = page.locator('[data-world-target="fleet-3远征船"]');
    if (mobile) await single.tap(); else await single.click();
    const card = detail.getByRole('article', { name: '远征舰队 3 队' });
    await card.waitFor();
    assert.match(await card.innerText(), /维修中/);
    assert.equal(await detail.getByRole('article').count(), 1);
    await closeCity();
    member = false;
    await marker(12).focus(); await page.keyboard.press('Enter'); await cancelWar.waitFor();
    await page.keyboard.press('Escape'); await detail.waitFor({ state:'hidden' });
    assert(await marker(12).evaluate(node=>document.activeElement===node),'Esc 关闭后回到键盘触发的城池');
    if (mobile) await openCity(12); else await page.keyboard.press('Enter');
    await cancelWar.click();
    await page.evaluate(id => selectLoadedAccount(id), second);
    await page.locator('#modal').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => !callsInFlight);
    assert.equal(await detail.isVisible(), false); assert.equal(posts.length, 6);
    assert.deepEqual(defenderReads, [], '城池操作无需读取守军名单'); assert.deepEqual(errors, []); await page.close();
    console.log('通过：' + width + 'px 舰队表宽与加速、附近舰队卡片、舰队地图标记、城池操作布局、确认和切号隔离');
  }
} finally {
  await browser?.close(); session.client = null; app.server.closeAllConnections(); await app.close();
  if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('cw-city-actions-browser-')) throw Error('临时目录异常');
  fs.rmSync(directory, { recursive: true, force: true });
}
