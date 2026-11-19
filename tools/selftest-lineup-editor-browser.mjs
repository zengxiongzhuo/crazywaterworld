// Run manually after build:ui. The browser uses isolated accounts and a fake game client.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { chromium } from 'playwright-core';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-lineup-browser-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_PROTO_BUNDLE = path.join(directory, 'no-game-protocol.js');
const output = path.resolve('output/playwright');
fs.mkdirSync(output, { recursive: true });

const { getConfig } = await import('../src/config.mjs');
const { saveStore } = await import('../src/accounts.mjs');
const { defaultSettings, saveAutomationSettings, loadAutomationSettings } = await import('../src/automation-settings.mjs');
const { GameClient } = await import('../src/client.mjs');
const { createConsole } = await import('./fixtures/console-server.mjs');
GameClient.prototype.connect = async () => { throw new Error('浏览器验收禁止连接真实游戏'); };
const config = getConfig();
const owned = config.tables.HeroCfg.data.filter(hero => ['BLUE', 'PURPLE', 'ORANGE', 'RED'].includes(hero.quality));
assert(owned.length >= 30, '需要至少30名英雄以验收英雄池滚动');
const seats = config.tables.FormationTypePositionCfg.data.filter(row => row.id === 1).map(row => ({ x: row.position[0], y: row.position[1] }));
const formation = { presetId: 1, heroPositions: seats.map((pos, index) => ({ heroId: owned[index].id, pos })), petUid: '0' };
const accountId = 'lineup-browser-fixture';
saveStore({ version: 1, activeId: accountId, accounts: [{
  id: accountId, label: '阵容界面隔离验收', url: 'ws://fixture.invalid', login: {},
  automation: { enabled: false, autoStart: false, paused: false },
}] });
const settings = defaultSettings();
settings.login.autoReconnect = false;
settings.progression.mainline = true;
settings.progression.trials = true;
settings.lineups = { presets: [{ id: 'qa-lineup', name: '主线突击', formation }], mainlinePresetId: '', trialPresets: [] };
saveAutomationSettings(accountId, settings, { revision: 0 });
const requests = [], gameWrites = [], challengePayloads = [], pageErrors = [], recommendationRequests = [];
let failNextBindingSave = false;
const client = new EventEmitter();
Object.assign(client, {
  connected: true, serverClockOffsetMs: 0, stopping: false,
  async request(name) {
    requests.push(name);
    if (name === 'GetFormationRequest') return { formation: structuredClone(formation) };
    if (name === 'AllHeroRequest') return { heroes: owned.map((hero, index) => ({ heroId: hero.id, level: 60 + index, power: 10000 + index * 1234 })) };
    if (name === 'MyFormationPresetRequest') return { ids: config.tables.FormationTypeUnlockCfg.data.slice(0, 10).map(row => row.id) };
    if (name === 'AllPetRequest') return { pets: config.tables.PetBreedCfg.data.slice(0, 3).map((pet, index) => ({ petId: pet.petId, uid: String(9007199254741000n + BigInt(index)), star: 2, level: 30 })) };
    throw new Error('验收未声明的游戏读取 ' + name);
  },
  async sendWatch(name) { gameWrites.push(name); throw new Error('阵容编辑验收不允许游戏写入 ' + name); },
  send(name) { gameWrites.push(name); throw new Error('阵容编辑验收不允许游戏写入 ' + name); },
  stop() { this.connected = false; this.stopping = true; },
  interleaveRead(work) { return work(); },
});
const player = { playerId: '9007199254741801', worldId: 1000001, level: 100, nickname: '界面验收船长', mainlineStage: 9999 };
const app = createConsole({ port: 0, protocol: {}, resourceUpdates: false });
let browser;
try {
  await app.listen();
  const base = 'http://127.0.0.1:' + app.server.address().port;
  await fetch(base + '/api/settings?account=' + accountId);
  const session = app.sessions.get(accountId); session.client = client; session.player = player; session.paused = false;
  const accountSnapshot = await fetch(base + '/api/accounts').then(response => response.json());
  const status = accountSnapshot.accounts[0].status;
  const executablePath = process.env.CW_BROWSER_TEST_EXECUTABLE || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find(file => fs.existsSync(file));
  assert(executablePath, '未找到浏览器，可用 CW_BROWSER_TEST_EXECUTABLE 指定');
  browser = await chromium.launch({ executablePath, headless: true });

  async function openPage(viewport, mobile = false, savedName = '主线突击') {
    const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      const respond = data => route.fulfill({ json: data });
      if (url.pathname === '/api/overview') return respond({ player, account: { title: '阵容界面隔离验收' }, status, resources: [] });
      if (url.pathname === '/api/world/overview') return respond({
        width: 1000, height: 1000, checkedAt: Math.floor(Date.now() / 1000),
        layers: {}, regions: [], routes: [], points: [], fleets: [], notes: [],
      });
      if (url.pathname === '/api/equipment') return respond({ locked: true, requiredLevel: 1 });
      if (url.pathname === '/api/equipment/crafting') return respond({ state: 'locked', buildCosts: [], recipes: [] });
      if (url.pathname === '/api/fleets/formation') return respond({ locked: true, docks: [] });
      if (url.pathname === '/api/lineups') {
        recommendationRequests.push(url.pathname);
        return respond({ targets: [] });
      }
      if (url.pathname === '/api/lineup-presets/bind' && failNextBindingSave) {
        failNextBindingSave = false;
        return route.fulfill({ status: 500, json: { error: '模拟阵容配置保存失败' } });
      }
      if (url.pathname === '/api/trials') return respond(config.tables.TrialRaidCfg.data.map(raid => ({
        raidId: raid.raidId, name: raid.title, next: { id: raid.raidId * 1000 + 1, level: 1, power: 1000 }, task: { running: false },
      })));
      if (url.pathname === '/api/trials/tasks') return respond({});
      if (['/api/trials/challenge', '/api/trials/start', '/api/stages/start'].includes(url.pathname)) {
        challengePayloads.push({ path: url.pathname, ...route.request().postDataJSON() });
        return respond({ running: false, reason: '受控挑战入口验收', wins: 0, failures: 0 });
      }
      return route.continue();
    });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.locator('#account-picker-title').filter({ hasText: '阵容界面隔离验收' }).waitFor();
    const tab = page.locator('#tabs [data-tab="lineups"]');
    if (mobile) {
      const navFits = await page.locator('#tabs > button').evaluateAll(buttons => {
        const boxes = buttons.map(button => button.getBoundingClientRect());
        return boxes.every(box => box.top === boxes[0].top && box.width > 0 && box.left >= 0 && box.right <= innerWidth);
      });
      assert(navFits, '手机底部导航所有页签均在同一行内可见');
      await tab.tap();
    } else await tab.click();
    const panel = page.locator('#tab-lineups');
    await panel.locator('#saved-lineup-view').getByRole('button', { name: '编辑阵容 ' + savedName, exact: true }).waitFor();
    assert.equal(await panel.locator('#lineup-view, #lineup-refresh, #saved-lineup-refresh').count(), 0);
    assert.equal(await panel.getByText('推荐阵容', { exact: true }).count(), 0);
    assert.equal(await tab.getAttribute('aria-current'), 'page');
    assert.equal(await page.locator('#resource-tabs').isVisible(), false);
    assert.equal(await page.locator('#tab-heroes #saved-lineup-view, #tab-heroes #lineup-view').count(), 0);
    assert.equal(await page.locator('#tab-heroes #formation-view').count(), 0);
    return { context, page };
  }

  const desktop = await openPage({ width: 1440, height: 1000 });
  const page = desktop.page;
  const modal = page.locator('#saved-lineup-dialog');
  const editorRequests = () => requests.filter(name => name === 'GetFormationRequest').length;
  const openEditor = async (targetPage, name) => {
    await targetPage.getByRole('button', { name: '编辑阵容 ' + name, exact: true }).click();
    await targetPage.locator('#saved-lineup-dialog[open][data-lineup-mode="editor"] .lineup-hero').first().waitFor();
    const bounds = await targetPage.locator('#saved-lineup-dialog').evaluate(element => {
      const box = element.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: innerWidth, height: innerHeight };
    });
    assert(bounds.top >= 0 && bounds.bottom <= bounds.height + 1);
    assert(bounds.left >= 0 && bounds.right <= bounds.width + 1);
  };
  const saveEditor = async (targetPage, touch = false) => {
    const response = targetPage.waitForResponse(result => result.url().includes('/api/lineup-presets/save') && result.request().method() === 'POST');
    const save = targetPage.getByRole('button', { name: '保存阵容', exact: true });
    if (touch) await save.tap();
    else await save.click();
    assert.equal((await response).status(), 200);
    await targetPage.locator('#saved-lineup-dialog').waitFor({ state: 'detached' });
    assert.equal(await targetPage.locator('#saved-lineup-view > [role="status"]').count(), 0, '保存成功后直接更新列表，不展示成功提示');
  };
  const assertViewer = async (targetPage, name) => {
    await targetPage.locator('#saved-lineup-dialog[open][data-lineup-mode="viewer"]').waitFor();
    assert.equal(await targetPage.locator('#saved-lineup-viewer input, #saved-lineup-viewer select, #saved-lineup-viewer [draggable="true"]').count(), 0);
    assert.equal(await targetPage.getByRole('button', { name: '保存阵容', exact: true }).count(), 0);
    assert((await targetPage.locator('#saved-lineup-viewer').textContent()).includes(name));
  };
  const assertRosterScroll = async label => {
    await modal.evaluate(dialog => Promise.all(dialog.getAnimations().map(animation => animation.finished)));
    const roster = modal.locator('.lineup-roster');
    const before = await modal.evaluate(dialog => {
      const pool = dialog.querySelector('.lineup-roster');
      const box = element => { const { top, bottom } = element.getBoundingClientRect(); return { top, bottom }; };
      return { clientHeight: pool.clientHeight, scrollHeight: pool.scrollHeight,
        contentsFit: [...pool.children].every(hero => [...hero.children].every(child => child.getBoundingClientRect().bottom <= hero.getBoundingClientRect().bottom + 1)),
        board: box(dialog.querySelector('.lineup-battlefield')),
        save: box([...dialog.querySelectorAll('button')].find(button => button.textContent === '保存阵容')) };
    });
    assert(before.scrollHeight > before.clientHeight, `${label}多英雄列表应在固定高度内产生滚动区域`);
    assert(before.contentsFit, `${label}英雄行不能被压缩至头像或名称与下一行重叠`);
    await roster.hover();
    await page.mouse.wheel(0, before.scrollHeight);
    await page.waitForFunction(() => {
      const pool = document.querySelector('.lineup-roster');
      return pool.scrollTop > 0 && pool.scrollTop + pool.clientHeight >= pool.scrollHeight - 1;
    });
    const scrolled = await roster.evaluate(pool => {
      const last = pool.lastElementChild.getBoundingClientRect(), bounds = pool.getBoundingClientRect();
      return { scrollTop: pool.scrollTop, lastVisible: last.top >= bounds.top && last.bottom <= bounds.bottom };
    });
    assert(scrolled.lastVisible, `${label}鼠标滚轮应能滚动到最后一名英雄`);
    await roster.locator('.lineup-hero').last().click();
    assert(Math.abs(await roster.evaluate(pool => pool.scrollTop) - scrolled.scrollTop) <= 1, `${label}点选英雄重绘后保留列表滚动位置`);
    const after = await modal.evaluate(dialog => {
      const box = element => { const { top, bottom } = element.getBoundingClientRect(); return { top, bottom }; };
      return { board: box(dialog.querySelector('.lineup-battlefield')),
        save: box([...dialog.querySelectorAll('button')].find(button => button.textContent === '保存阵容')),
        bodyScrollTop: dialog.querySelector('.lineup-dialog-body').scrollTop };
    });
    assert.deepEqual(after.board, before.board, `${label}滚动英雄池不能移动右侧阵位`);
    assert.deepEqual(after.save, before.save, `${label}滚动英雄池不能移动保存按钮`);
    assert.equal(after.bodyScrollTop, 0, `${label}滚轮应滚动英雄列表，而非弹窗`);
  };

  const beforeView = editorRequests();
  const revisionBeforeView = loadAutomationSettings(accountId).revision;
  await page.getByRole('button', { name: '查看阵容 主线突击', exact: true }).click();
  await assertViewer(page, '主线突击');
  assert.equal(editorRequests(), beforeView, '查看保存阵容不读取游戏阵容');
  assert.equal(loadAutomationSettings(accountId).revision, revisionBeforeView);
  await page.screenshot({ path: path.join(output, 'lineup-viewer-desktop.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('button', { name: '查看阵容 主线突击', exact: true }).evaluate(element => element === document.activeElement), true);
  assert.equal(await page.locator('#saved-lineup-view .lineup-editor, .saved-lineup-bindings').count(), 0);
  console.log('通过：保存阵容可离线只读查看，Esc关闭并返回焦点');

  await page.getByRole('button', { name: '新建阵容', exact: true }).click();
  await modal.locator('.lineup-hero').first().waitFor();
  await page.setViewportSize({ width: 1366, height: 720 });
  await assertRosterScroll('新建阵容');
  const unlockedFormations = await page.getByLabel('阵型', { exact: true }).locator('option:enabled').evaluateAll(options => options.map(option => ({ id: option.value, name: option.textContent })));
  const layoutIssues = [];
  for (const height of [768, 720]) {
    await page.setViewportSize({ width: 1366, height });
    for (const type of unlockedFormations) {
      await page.getByLabel('阵型', { exact: true }).selectOption(type.id);
      const layout = await modal.evaluate(dialog => {
        const box = element => {
          const { top, bottom, left, right, height } = element.getBoundingClientRect();
          return { top, bottom, left, right, height };
        };
        const body = dialog.querySelector('.lineup-dialog-body');
        return {
          dialog: box(dialog), roster: box(dialog.querySelector('.lineup-roster-section')),
          board: box(dialog.querySelector('.lineup-battlefield')),
          slots: [...dialog.querySelectorAll('.lineup-slot')].map(slot => ({ position: slot.dataset.lineupPosition, ...box(slot) })),
          save: box([...dialog.querySelectorAll('button')].find(button => button.textContent === '保存阵容')),
          scrollHeight: body.scrollHeight, clientHeight: body.clientHeight,
        };
      });
      const label = `${height}px ${type.name}(${type.id})`;
      assert(layout.roster.right <= layout.board.left, `${label}英雄池应在阵位左侧`);
      assert(layout.dialog.top >= 0 && layout.dialog.bottom <= height + 1);
      assert(layout.save.top >= 0 && layout.save.bottom <= height, `${label}保存按钮无需滚动即可操作`);
      if (layout.scrollHeight > layout.clientHeight + 2) layoutIssues.push(`${label}弹窗内容溢出：scrollHeight=${layout.scrollHeight}, clientHeight=${layout.clientHeight}`);
      for (let first = 0; first < layout.slots.length; first++) {
        for (let second = first + 1; second < layout.slots.length; second++) {
          const a = layout.slots[first], b = layout.slots[second];
          const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (overlapX > 0.5 && overlapY > 0.5) layoutIssues.push(`${label}站位${a.position}与${b.position}重叠 ${overlapX.toFixed(1)}×${overlapY.toFixed(1)}px`);
        }
      }
    }
  }
  await page.getByLabel('阵型', { exact: true }).selectOption('1');
  await page.screenshot({ path: path.join(output, 'lineup-create-desktop-720.png'), animations: 'disabled' });
  assert.deepEqual(layoutIssues, [], '全部解锁阵型应完整显示且站位互不重叠');
  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'detached' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  console.log('通过：全部解锁阵型在720/768px桌面左侧英雄池、右侧阵位，无站位重叠且保存操作无需滚动');

  await openEditor(page, '主线突击');
  await page.setViewportSize({ width: 1366, height: 720 });
  await assertRosterScroll('编辑阵容');
  await page.setViewportSize({ width: 1440, height: 1000 });
  console.log(`通过：${owned.length}名英雄可用滚轮滚动到底，点选保留滚动位置且阵位与保存按钮固定`);
  assert.equal(await page.getByLabel('阵型', { exact: true }).locator('option').count(), 24);
  assert(await page.getByLabel('阵型', { exact: true }).locator('option:disabled').count() > 0);
  assert.equal(await page.locator('.lineup-formation-choice').count(), 0);
  assert.equal(await page.locator('.lineup-slot').count(), seats.length);
  await page.waitForFunction(() => [...document.querySelectorAll('.lineup-portrait img')].some(image => image.complete && image.naturalWidth > 0));
  await page.getByLabel('阵容名称', { exact: true }).fill('关闭保留草稿');
  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'detached' });
  await openEditor(page, '主线突击');
  assert.equal(await page.getByLabel('阵容名称', { exact: true }).inputValue(), '关闭保留草稿');
  await page.getByLabel('阵容名称', { exact: true }).fill('桌面验证阵容');
  await page.locator('.lineup-hero').nth(6).click();
  await page.locator('.lineup-slot').first().click();
  await page.getByLabel('出战海兽', { exact: true }).selectOption({ index: 1 });
  await saveEditor(page);
  const saved = loadAutomationSettings(accountId).settings.lineups.presets[0];
  assert.equal(saved.name, '桌面验证阵容');
  assert(saved.formation.heroPositions.some(item => item.heroId === owned[6].id));
  assert.equal(saved.formation.petUid, '9007199254741000');
  console.log('通过：编辑弹窗关闭保留草稿，成功保存后关闭并更新列表');

  await openEditor(page, '桌面验证阵容');
  await page.screenshot({ path: path.join(output, 'lineup-editor-desktop.png'), animations: 'disabled' });
  const sourceSlot = page.locator('.lineup-slot').first(), targetSlot = page.locator('.lineup-slot').nth(1);
  const sourcePosition = await sourceSlot.getAttribute('data-lineup-position');
  const targetPosition = await targetSlot.getAttribute('data-lineup-position');
  const heroAt = (value, position) => value.formation.heroPositions.find(item => [item.pos.x, item.pos.y].join(',') === position)?.heroId;
  const sourceHero = heroAt(saved, sourcePosition), targetHero = heroAt(saved, targetPosition);
  await sourceSlot.click({ button: 'right' });
  assert((await sourceSlot.getAttribute('aria-label')).endsWith('，空位'));
  await saveEditor(page);
  const removed = loadAutomationSettings(accountId).settings.lineups.presets[0];
  assert.equal(heroAt(removed, sourcePosition), undefined);
  assert.equal(removed.formation.heroPositions.length, saved.formation.heroPositions.length - 1);
  await openEditor(page, '桌面验证阵容');
  const poolHero = page.locator('.lineup-hero[data-lineup-hero="' + sourceHero + '"]');
  await poolHero.scrollIntoViewIfNeeded();
  const poolFrom = await poolHero.boundingBox(), emptyTo = await sourceSlot.boundingBox();
  await page.mouse.move(poolFrom.x + poolFrom.width / 2, poolFrom.y + poolFrom.height / 2);
  await page.mouse.down();
  await page.mouse.move(emptyTo.x + emptyTo.width / 2, emptyTo.y + emptyTo.height / 2, { steps: 12 });
  await page.mouse.up();
  await saveEditor(page);
  const restored = loadAutomationSettings(accountId).settings.lineups.presets[0];
  assert.equal(heroAt(restored, sourcePosition), sourceHero);
  assert.equal(restored.formation.heroPositions.length, saved.formation.heroPositions.length);
  console.log('通过：右键下阵和英雄池拖入空位均可经HTTP保存');
  await openEditor(page, '桌面验证阵容');
  await sourceSlot.scrollIntoViewIfNeeded();
  const from = await sourceSlot.boundingBox(), to = await targetSlot.boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
  await saveEditor(page);
  const dragged = loadAutomationSettings(accountId).settings.lineups.presets[0];
  assert.equal(heroAt(dragged, sourcePosition), targetHero);
  assert.equal(heroAt(dragged, targetPosition), sourceHero);
  console.log('通过：弹窗内Pointer拖拽交换位置并经HTTP保存');

  await page.locator('#tabs [data-tab="settings"]').click();
  await page.locator('[data-config-tab="world"]').click();
  await page.locator('[data-config-group="progression"]').click();
  for (const field of ['mainline', 'trials']) {
    const disclosure = page.locator('.config-disclosure[aria-controls="config-field-progression-' + field + '-children"]');
    if (await disclosure.getAttribute('aria-expanded') === 'false') await disclosure.click();
  }
  const bindingSave = page.waitForResponse(response => new URL(response.url()).pathname === '/api/settings' && response.request().method() === 'POST');
  await page.locator('[data-lineup-binding="mainline"]').selectOption('qa-lineup');
  assert.equal((await bindingSave).status(), 200);
  const trialBindingSave = page.waitForResponse(response => new URL(response.url()).pathname === '/api/settings' && response.request().method() === 'POST');
  await page.locator('[data-lineup-binding="trial:1"]').selectOption('qa-lineup');
  assert.equal((await trialBindingSave).status(), 200);
  const bound = loadAutomationSettings(accountId).settings.lineups;
  assert.equal(bound.mainlinePresetId, 'qa-lineup');
  assert(bound.trialPresets.some(item => item.raidId === '1' && item.presetId === 'qa-lineup'));
  await page.locator('[data-lineup-view="mainline"]').click();
  await assertViewer(page, '桌面验证阵容');
  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'detached' });
  await page.screenshot({ path: path.join(output, 'lineup-settings-desktop.png'), animations: 'disabled' });
  await page.locator('#tabs [data-tab="lineups"]').click();
  await page.locator('#tab-lineups').getByRole('button', { name: '编辑阵容 桌面验证阵容', exact: true }).waitFor();
  assert.equal(await page.locator('#tabs [aria-current="page"]').getAttribute('data-tab'), 'lineups');
  console.log('通过：推关与试炼配置可选择并查看阵容，顶部导航可打开阵容页');

  await page.locator('#tabs [data-tab="stages"]').click();
  const choicesBeforeChallenge = challengePayloads.length;
  const presetsBeforeChoices = structuredClone(loadAutomationSettings(accountId).settings.lineups.presets);
  const waitForChallengeChoices = async targetPage => {
    for (const selector of ['#stage-lineup-control select', 'select[data-lineup-mode="trial:1"]', 'select[data-lineup-mode="trial:2"]']) {
      await targetPage.locator(selector).locator('option[value="qa-lineup"]').waitFor({ state: 'attached' });
    }
  };
  const waitForChoiceSave = async targetPage => {
    await targetPage.waitForFunction(() => ![...document.querySelectorAll('[data-lineup-choice-status]')]
      .some(status => !status.hidden && status.textContent));
  };
  const chooseChallengeLineup = async (key, value) => {
    const response = page.waitForResponse(result => new URL(result.url()).pathname === '/api/lineup-presets/bind' && result.request().method() === 'POST');
    await page.locator('select[data-lineup-mode="' + key + '"]').selectOption(value);
    assert.equal((await response).status(), 200);
    await waitForChoiceSave(page);
  };
  const reloadChallengePage = async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#account-picker-title').filter({ hasText: '阵容界面隔离验收' }).waitFor();
    await page.locator('#tabs [data-tab="stages"]').click();
    await waitForChallengeChoices(page);
  };
  await waitForChallengeChoices(page);
  assert.equal(await page.locator('#stage-lineup-control select').inputValue(), 'qa-lineup', '挑战页读取已保存的主线配置');
  assert.equal(await page.locator('select[data-lineup-mode="trial:1"]').inputValue(), 'qa-lineup', '挑战页读取已保存的试炼配置');
  await chooseChallengeLineup('mainline', '');
  assert.equal(loadAutomationSettings(accountId).settings.lineups.mainlinePresetId, '');
  await chooseChallengeLineup('mainline', 'qa-lineup');
  await chooseChallengeLineup('trial:1', '');
  await chooseChallengeLineup('trial:1', 'qa-lineup');
  await chooseChallengeLineup('trial:2', 'qa-lineup');
  const chosenBindings = loadAutomationSettings(accountId).settings.lineups;
  assert.equal(chosenBindings.mainlinePresetId, 'qa-lineup');
  for (const raidId of ['1', '2']) assert(chosenBindings.trialPresets.some(binding => binding.raidId === raidId && binding.presetId === 'qa-lineup'));
  assert.deepEqual(chosenBindings.presets, presetsBeforeChoices, '修改挑战绑定保留已保存阵容内容');
  assert.equal(challengePayloads.length, choicesBeforeChallenge, '选择后立即保存配置，无需开始挑战');
  const independent = await openPage({ width: 1366, height: 768 }, false, '桌面验证阵容');
  assert.equal(await independent.page.evaluate(id => localStorage.getItem('lineup-choices:' + id), accountId), null);
  await independent.page.locator('#tabs [data-tab="stages"]').click();
  await waitForChallengeChoices(independent.page);
  for (const key of ['mainline', 'trial:1', 'trial:2']) {
    assert.equal(await independent.page.locator('select[data-lineup-mode="' + key + '"]').inputValue(), 'qa-lineup', '独立浏览器从账号配置读取 ' + key);
  }
  await independent.context.close();
  await reloadChallengePage();
  assert.equal(await page.locator('#stage-lineup-control select').inputValue(), 'qa-lineup');
  assert.equal(await page.locator('select[data-lineup-mode="trial:1"]').inputValue(), 'qa-lineup');
  assert.equal(await page.locator('select[data-lineup-mode="trial:2"]').inputValue(), 'qa-lineup');
  assert.equal(challengePayloads.length, choicesBeforeChallenge, '无需开始挑战，选择后刷新即可恢复');
  assert.deepEqual(loadAutomationSettings(accountId).settings.lineups, chosenBindings);
  await page.locator('#stage-lineup-control button').click();
  await assertViewer(page, '桌面验证阵容');
  await page.keyboard.press('Escape');
  const stageStart = page.waitForResponse(response => response.url().includes('/api/stages/start'));
  await page.locator('#stage-start').click();
  await stageStart;
  const trialRow = page.locator('[data-trial-task="1"]').locator('xpath=ancestor::*[contains(@class,"progression-row")]');
  await trialRow.getByRole('button', { name: '查看所选阵容', exact: true }).click();
  await assertViewer(page, '桌面验证阵容');
  await page.keyboard.press('Escape');
  const trialChallenge = page.waitForResponse(response => response.url().includes('/api/trials/challenge'));
  await trialRow.getByRole('button', { name: /挑战一次/ }).click();
  await trialChallenge;
  assert(challengePayloads.some(item => item.path === '/api/stages/start' && item.lineupId === 'qa-lineup'));
  assert(challengePayloads.some(item => item.path === '/api/trials/challenge' && item.lineupId === 'qa-lineup'));
  await page.locator('#tab-stages').screenshot({ path: path.join(output, 'lineup-challenge-desktop.png'), animations: 'disabled' });
  await chooseChallengeLineup('mainline', '');
  await chooseChallengeLineup('trial:1', '');
  const clearedBindings = loadAutomationSettings(accountId).settings.lineups;
  assert.equal(clearedBindings.mainlinePresetId, '');
  assert(!clearedBindings.trialPresets.some(binding => binding.raidId === '1'));
  assert(clearedBindings.trialPresets.some(binding => binding.raidId === '2' && binding.presetId === 'qa-lineup'));
  await reloadChallengePage();
  assert.equal(await page.locator('#stage-lineup-control select').inputValue(), '', '改回当前阵容后刷新不能恢复旧的主线选择');
  assert.equal(await page.locator('select[data-lineup-mode="trial:1"]').inputValue(), '');
  assert.equal(await page.locator('select[data-lineup-mode="trial:2"]').inputValue(), 'qa-lineup', '清空一个试炼不影响其他试炼');
  await page.locator('#tabs [data-tab="settings"]').click();
  await page.locator('[data-config-tab="world"]').click();
  await page.locator('[data-config-group="progression"]').click();
  for (const field of ['mainline', 'trials']) {
    const disclosure = page.locator('.config-disclosure[aria-controls="config-field-progression-' + field + '-children"]');
    if (await disclosure.getAttribute('aria-expanded') === 'false') await disclosure.click();
  }
  assert.equal(await page.locator('[data-lineup-binding="mainline"]').inputValue(), '');
  assert.equal(await page.locator('[data-lineup-binding="trial:1"]').inputValue(), '');
  assert.equal(await page.locator('[data-lineup-binding="trial:2"]').inputValue(), 'qa-lineup');
  const settingsBindingSave = page.waitForResponse(response => new URL(response.url()).pathname === '/api/settings' && response.request().method() === 'POST');
  await page.locator('[data-lineup-binding="mainline"]').selectOption('qa-lineup');
  assert.equal((await settingsBindingSave).status(), 200);
  await page.locator('#tabs [data-tab="stages"]').click();
  await page.waitForFunction(() => document.querySelector('#stage-lineup-control select')?.value === 'qa-lineup');
  failNextBindingSave = true;
  const failedSave = page.waitForResponse(response => new URL(response.url()).pathname === '/api/lineup-presets/bind' && response.status() === 500);
  await page.locator('#stage-lineup-control select').selectOption('');
  await failedSave;
  await page.locator('#tab-stages [data-lineup-choice-status]').filter({ hasText: '模拟阵容配置保存失败' }).first().waitFor();
  assert.equal(await page.locator('#stage-lineup-control select').inputValue(), 'qa-lineup', '保存失败恢复服务器配置');
  assert.equal(loadAutomationSettings(accountId).settings.lineups.mainlinePresetId, 'qa-lineup');
  await chooseChallengeLineup('mainline', '');
  assert.equal(loadAutomationSettings(accountId).settings.lineups.mainlinePresetId, '');
  console.log('通过：挑战选择保存到账号配置，独立浏览器可恢复、配置页双向同步，保存失败可恢复后重试');

  const updated = loadAutomationSettings(accountId); updated.settings.lineups.presets[0].name = '主线突击';
  saveAutomationSettings(accountId, updated.settings, { revision: updated.revision });
  const mobile = await openPage({ width: 390, height: 844 }, true);
  await mobile.page.getByRole('button', { name: '编辑阵容 主线突击', exact: true }).tap();
  await mobile.page.locator('#saved-lineup-dialog[open][data-lineup-mode="editor"] .lineup-hero').first().waitFor();
  await mobile.page.getByRole('button', { name: '关闭阵容编辑器', exact: true }).tap();
  await mobile.page.locator('#saved-lineup-dialog').waitFor({ state: 'detached' });
  await mobile.page.getByRole('button', { name: '查看阵容 主线突击', exact: true }).tap();
  await assertViewer(mobile.page, '主线突击');
  await mobile.page.getByRole('button', { name: '关闭阵容查看', exact: true }).tap();
  await mobile.page.locator('#saved-lineup-dialog').waitFor({ state: 'detached' });
  console.log('通过：手机连续触摸打开、关闭编辑和查看弹窗');
  await openEditor(mobile.page, '主线突击');
  await mobile.page.getByLabel('阵容名称', { exact: true }).fill('手机验证阵容');
  await mobile.page.locator('.lineup-hero').nth(7).tap();
  await mobile.page.locator('.lineup-slot').first().tap();
  await saveEditor(mobile.page, true);
  assert.equal(loadAutomationSettings(accountId).settings.lineups.presets[0].name, '手机验证阵容');
  assert.equal(heroAt(loadAutomationSettings(accountId).settings.lineups.presets[0], sourcePosition), owned[7].id);
  await openEditor(mobile.page, '手机验证阵容');
  const metrics = await mobile.page.locator('.lineup-editor').evaluate(element => ({
    width: element.getBoundingClientRect().width, viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth,
    slots: [...element.querySelectorAll('.lineup-slot')].map(slot => ({ width: slot.getBoundingClientRect().width, height: slot.getBoundingClientRect().height })),
    rosterTouchAction: getComputedStyle(element.querySelector('.lineup-hero')).touchAction,
    portraitTouchAction: getComputedStyle(element.querySelector('.lineup-hero .lineup-portrait')).touchAction,
  }));
  assert(metrics.width <= metrics.viewport && metrics.scrollWidth <= metrics.viewport + 1);
  assert(metrics.slots.every(slot => slot.width >= 44 && slot.height >= 44));
  assert.equal(metrics.rosterTouchAction, 'pan-y'); assert.equal(metrics.portraitTouchAction, 'none');
  const mobileRoster = mobile.page.locator('.lineup-roster');
  await mobileRoster.scrollIntoViewIfNeeded();
  const swipe = await mobileRoster.evaluate(pool => {
    const bounds = pool.getBoundingClientRect();
    const footerTop = document.querySelector('.lineup-editor-footer').getBoundingClientRect().top;
    const names = [...pool.querySelectorAll('.lineup-hero-name')].map(name => name.getBoundingClientRect())
      .filter(box => box.top >= bounds.top + 70 && box.bottom <= Math.min(bounds.bottom, footerTop, innerHeight) - 5);
    const name = names.at(-1);
    return { scrollTop: pool.scrollTop, clientHeight: pool.clientHeight, scrollHeight: pool.scrollHeight,
      start: name && { x: name.x + name.width / 2, y: name.y + name.height / 2 }, endY: bounds.top + 15 };
  });
  assert(swipe.scrollHeight > swipe.clientHeight, '手机英雄池需要真实溢出才能验收触摸滚动');
  assert(swipe.start && swipe.start.y - swipe.endY > 50, '手机列表中有足够的名称区域用于触摸滑动');
  const scrollSession = await mobile.context.newCDPSession(mobile.page);
  await scrollSession.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [swipe.start] });
  for (let step = 1; step <= 10; step++) {
    await scrollSession.send('Input.dispatchTouchEvent', {
      type: 'touchMove', touchPoints: [{ x: swipe.start.x, y: swipe.start.y + (swipe.endY - swipe.start.y) * step / 10 }],
    });
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  await scrollSession.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await scrollSession.detach();
  await mobile.page.waitForFunction(previous => document.querySelector('.lineup-roster').scrollTop > previous, swipe.scrollTop);
  assert.equal(await mobileRoster.locator('[data-lineup-dragging="true"]').count(), 0);
  console.log('通过：手机可在英雄名称区域触摸滑动溢出列表');
  const touchSource = mobile.page.locator('.lineup-slot').first(), touchTarget = mobile.page.locator('.lineup-slot').nth(1);
  const beforeTouch = loadAutomationSettings(accountId).settings.lineups.presets[0];
  await touchSource.scrollIntoViewIfNeeded();
  const touchFrom = await touchSource.boundingBox(), touchTo = await touchTarget.boundingBox();
  const touchSession = await mobile.context.newCDPSession(mobile.page);
  const start = { x: touchFrom.x + touchFrom.width / 2, y: touchFrom.y + touchFrom.height / 2 };
  const end = { x: touchTo.x + touchTo.width / 2, y: touchTo.y + touchTo.height / 2 };
  await touchSession.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
  for (let step = 1; step <= 12; step++) {
    await touchSession.send('Input.dispatchTouchEvent', {
      type: 'touchMove', touchPoints: [{ x: start.x + (end.x - start.x) * step / 12, y: start.y + (end.y - start.y) * step / 12 }],
    });
    // Give the drag a human-paced duration so Chromium does not classify it as a fling.
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  await touchSession.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touchSession.detach();
  await saveEditor(mobile.page, true);
  const afterTouch = loadAutomationSettings(accountId).settings.lineups.presets[0];
  assert.equal(heroAt(afterTouch, sourcePosition), heroAt(beforeTouch, targetPosition));
  assert.equal(heroAt(afterTouch, targetPosition), heroAt(beforeTouch, sourcePosition));
  await openEditor(mobile.page, '手机验证阵容');
  await mobile.page.screenshot({ path: path.join(output, 'lineup-editor-mobile.png'), animations: 'disabled' });
  await mobile.page.getByRole('button', { name: '关闭阵容编辑器', exact: true }).tap();
  await mobile.page.locator('#saved-lineup-dialog').waitFor({ state: 'detached' });
  await mobile.page.getByRole('button', { name: '查看阵容 手机验证阵容', exact: true }).tap();
  await assertViewer(mobile.page, '手机验证阵容');
  await mobile.page.screenshot({ path: path.join(output, 'lineup-viewer-mobile.png'), animations: 'disabled' });
  console.log('通过：390px手机弹窗编辑、触摸换位、保存和只读查看，无横向溢出');
  assert.deepEqual(gameWrites, []); assert.deepEqual(pageErrors, []);
  assert.deepEqual(recommendationRequests, [], '阵容页不再请求推荐阵容');
  console.log('阵容浏览器验收通过，截图目录 ' + output);
  await desktop.context.close(); await mobile.context.close();
} finally {
  if (browser) await browser.close();
  app.server.closeAllConnections(); await app.close();
  const resolved = path.resolve(directory);
  assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(resolved, { recursive: true, force: true });
}
