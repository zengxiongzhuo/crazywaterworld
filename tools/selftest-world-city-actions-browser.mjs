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
const points = [11, 12, 13].map((cityId, i) => ({
  cityId, key: 'city-' + cityId, name: ['南港', '西港', '堡垒C7'][i], owner: 2, detail: '', layer: 'cities',
  x: [20, 980, 400][i], y: [130, 220, 390][i],
  cityInfo: { owner: '青盟', status: '当前无宣战', declared: [], fighters: [], attack: 0, defence: 0 },
}));
const executablePath = [process.env.CW_BROWSER_TEST_EXECUTABLE, chromium.executablePath(), 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(file => file && fs.existsSync(file));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
async function waitForGate(gate) {
  let timer;
  try {
    await Promise.race([gate.started.promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('等待城池请求超时')), 8000);
    })]);
  } finally { clearTimeout(timer); }
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
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/world/overview?*', route => route.fulfill({ json: { checkedAt: Date.now() / 1000, scenario: 1,
      width: 1000, height: 500, regions: [], owners: [], points, routes: [],
      fleets: ownFleets.map(f => ({ id:f.buildingId, name:f.name, state:f.status })),
      cityWars: [], treasures: [], layers: {}, notes: [] } }));
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
      if (city === 11 && previewGate) { previewGate.started.resolve(); await previewGate.release.promise; }
      const home = city === 11, enemy = city === 12;
      const fleetChoices = ownFleets.map(f => ({ ...f, available: f.status === '空闲' && (home || (enemy && enemyWar)) }));
      const fleets = fleetChoices.filter(f => f.available).map(({ buildingId, name }) => ({ buildingId, name }));
      const token = city === 13 ? null : city + '-' + (++sequence);
      tokens.set(city, token);
      const expiresAt = Date.now() + (expireNextQuote ? -1000 : 120000);
      expireNextQuote = false;
      await route.fulfill({ json: { token, expiresAt,
        dispatch: { fleets, fleetChoices, reason: city === 13 ? '本盟尚未向该城宣战' : '', intent: home ? (defending ? 'reinforce' : 'relocate') : 'attack', cost: home ? 0 : 300 },
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
    const fleet = panel.getByRole('combobox', { name: '选择空闲舰队' });
    const declare = panel.getByRole('button', { name: '宣战', exact: true });
    const send = panel.getByRole('button', { name: '进攻', exact: true });
    const cancelWar = panel.getByRole('button', { name: '取消宣战', exact: true });
    await marker(11).waitFor();
    if (mobile) {
      await openCity(13);
      await detail.waitFor();
      assert(await detail.evaluate(node => node.matches(':modal') && node.contains(document.activeElement)));
    } else {
      await marker(13).hover(); await page.mouse.move(2,2);
      await page.waitForTimeout(350); // 超过打开延时，掠过城池不应取条件。
      assert(!tokens.has(13)); assert(!await detail.isVisible());
      await marker(13).hover();
    }
    await panel.getByText('暂无可用操作', {exact:true}).waitFor();
    assert.equal(await panel.innerText(), '暂无可用操作');
    assert.equal(await panel.getByRole('button').count(), 0);
    assert.equal(await fleet.count(), 0);
    assert.equal(await panel.getByRole('button', {name:'刷新条件'}).count(), 0);
    assert.doesNotMatch(await detail.innerText(), /本盟尚未向该城宣战|当前无宣战|优先 |所属|宣战 ·/);
    if (mobile) {
      await page.touchscreen.tap(2,2); await detail.waitFor({state:'hidden'});
    } else {
      assert(!await detail.evaluate(node => node.matches(':modal')));
      const anchor = await marker(13).boundingBox(), popover = await detail.boundingBox();
      const gapX = Math.max(anchor.x - (popover.x + popover.width), popover.x - (anchor.x + anchor.width), 0);
      const gapY = Math.max(anchor.y - (popover.y + popover.height), popover.y - (anchor.y + anchor.height), 0);
      assert(Math.hypot(gapX,gapY)<48,'悬浮面板紧邻所选城池');
      await detail.hover();
      await page.waitForTimeout(500); // 等过悬停离开延时，确认鼠标可停在浮层上操作。
      assert(await detail.isVisible());
      await page.mouse.move(2, 2);
      await detail.waitFor({ state: 'hidden' });
    }
    previewGate = { started: deferred(), release: deferred() };
    if (mobile) await openCity(11); else await marker(11).hover();
    await waitForGate(previewGate);
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
      assert(await detail.isVisible(), '点击固定后离开仍保留城池操作');
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
    await checkActionLayout(panel, mobile, ['选择空闲舰队', '进攻', '取消宣战']);
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
    await cancelWar.click(); assert.match(await page.locator('#m-body').textContent(), /西港.*当前角色.*200 钻石/s);
    await page.locator('#m-ok').click(); await declare.waitFor();
    assert.equal(posts[1].action, 'cancelDeclare'); assert.equal(posts[1].confirmedCost,200);
    await declare.click(); assert.match(await page.locator('#m-body').textContent(), /西港.*联盟 3.*1 \/ 3/s);
    await page.locator('#m-ok').click(); await cancelWar.waitFor(); assert.equal(posts[2].action, 'declare');
    if (mobile) await closeCity();
    await openCity(11); await panel.getByRole('button',{name:'增援', exact:true}).waitFor();
    await checkActionLayout(panel, mobile, ['选择空闲舰队', '增援', '高级募兵', '设为集结城']);
    await panel.getByRole('button',{name:'设为集结城'}).click();
    assert.match(await page.locator('#m-body').textContent(), /西港.*防守.*南港/s);
    await page.locator('#m-ok').click(); await panel.getByRole('button',{name:'高级募兵'}).waitFor();
    assert.equal(posts[3].action,'assemble');
    member = true; await closeCity(); expireNextQuote = true; await openCity(11);
    const recruit=panel.getByRole('button',{name:'高级募兵'}); await recruit.waitFor();
    assert.equal(await panel.getByRole('button',{name:'设为集结城'}).count(),0);
    await recruit.click(); await panel.getByText(/已过期/).waitFor(); await recruit.waitFor();
    assert.equal(posts.length, 4, '过期选择自动更新且保持未提交');
    await recruit.click(); assert.match(await page.locator('#m-body').textContent(), /1 枚联盟募兵令.*10 名守军/s);
    await page.locator('#m-ok').click(); await panel.getByRole('button',{name:'核对募兵结果'}).click();
    await panel.getByRole('button',{name:'核对募兵结果'}).waitFor();
    assert.deepEqual(posts.slice(4).map(p=>[p.action,p.confirmedCost]),[['recruit',1],['checkRecruit',undefined]]);
    assert.equal(await declare.count(), 0);
    await closeCity();
    defending = false; await openCity(11); await panel.getByRole('button', {name:'驻防', exact:true}).waitFor();
    assert.doesNotMatch(await panel.innerText(), /确认驻防|汽油/);
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
    console.log('通过：' + width + 'px 城池' + (mobile?'触屏弹窗':'悬停与固定') + '、操作布局、空态、确认和切号隔离');
  }
} finally {
  await browser?.close(); session.client = null; app.server.closeAllConnections(); await app.close();
  if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('cw-city-actions-browser-')) throw Error('临时目录异常');
  fs.rmSync(directory, { recursive: true, force: true });
}
