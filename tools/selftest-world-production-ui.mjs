import { newStateFunction } from './fixtures/console-state.mjs';
import assert from 'node:assert/strict';
import { PAGE } from '../src/page.mjs';

const script = [...PAGE.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]).find(value => value.includes('function renderWorld('));
const start = script.indexOf('function worldProductionTime(');
const end = script.indexOf('let worldVersion =', start);
assert(start >= 0 && end > start, '页面应包含工厂和农田的实际展示代码');
const refreshEnd = script.indexOf("$('inventory-refresh').onclick=", end);
assert(refreshEnd > end, '页面应包含账号切换时的海面刷新逻辑');
const durationStart = script.indexOf('function productionPlanDuration(');
const durationEnd = script.indexOf('function renderProductionPlan(', durationStart);
assert(durationStart >= 0 && durationEnd > durationStart);

function element(tag = 'div', className = '', value = '') {
  let text = String(value ?? '');
  const node = {
    tagName: tag, className, children: [], dataset: {}, attributes: {},
    get textContent() { return text + this.children.map(child => child.textContent).join(' '); },
    set textContent(value) { text = String(value ?? ''); this.children = []; },
    appendChild(child) { this.children.push(child); return child; },
    append(...children) { this.children.push(...children); },
    querySelectorAll(selector) {
      return this.children.flatMap(descendants).filter(child => matches(child, selector));
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; },
    showModal() { this.open = true; },
    close() { this.open = false; this.onclose?.(); },
    focus() { this.focused = true; },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
      if (name.startsWith('data-')) {
        const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
        this.dataset[key] = String(value);
      }
    },
  };
  node.classList = {
    add(name) { node.className = [node.className, name].filter(Boolean).join(' '); },
    contains(name) { return (node.className || '').split(' ').includes(name); },
  };
  return node;
}

function matches(node, selector) {
  const match = selector.match(/^(?:([a-z]+))?\[([^=\]]+)(?:="([^"]*)")?\]$/);
  assert(match, '测试夹具未支持选择器 ' + selector);
  const [, tag, attribute, expected] = match;
  if (tag && node.tagName !== tag) return false;
  const key = attribute.replace(/^data-/, '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  const value = attribute.startsWith('data-') ? node.dataset[key] : attribute === 'open' ? node.open : node.attributes[attribute];
  return expected === undefined ? value !== undefined && value !== false : String(value) === expected;
}

function descendants(root) {
  return [root, ...root.children.flatMap(descendants)];
}

function cellText(value) {
  return value?.textContent ?? value?.text ?? String(value);
}

function currentProductText(cell) {
  if (!cell?.children?.length) return cellText(cell);
  return cell.children.filter(child => child.tagName !== 'button').map(cellText).join(' ');
}

function fixture() {
  const nodes = new Map();
  const env = { now: 1767225600000, tables: [], element };
  env.node = id => {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id);
  };
  env.clear = node => { node.textContent = ''; return node; };
  env.table = (headers, rows) => {
    const result = element('table');
    env.tables.push({ headers, rows, node: result });
    result.append(element('thead', '', headers.join(' ')));
    for (const row of rows) {
      const tr = element('tr');
      for (const value of row) {
        tr.append(value?.tagName ? value : element('td', '', value?.text ?? value));
      }
      result.append(tr);
    }
    return result;
  };
  env.document = {
    hidden: false,
    querySelectorAll(selector) {
      return [...nodes.values()].flatMap(descendants).filter(node => matches(node, selector));
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; },
  };
  newStateFunction('env', `
    const $ = env.node, el = env.element, clear = env.clear, table = env.table;
    const document = env.document, Date = { now: () => env.now };
    const chip = (state, label) => el('span', state, label);
    const smallButton = label => el('button', '', label);
    const renderInventory = () => {}, fmt = value => String(value);
    const resetInventory = () => {};
    const call = () => new Promise(() => {});
    const snapshot = { paused: false }, disconnected = new Set();
    let current = 'account-a';
    let orderClockOffset = 0;
    ${script.slice(durationStart, durationEnd)}
    ${script.slice(start, end)}
    ${script.slice(end, refreshEnd)}
    env.render = renderWorld;
    env.updateTimers = updateWorldProductionTimers;
    env.refreshUnavailable = mode => {
      if (mode === 'account') current = 'account-b';
      if (mode === 'paused') snapshot.paused = true;
      if (mode === 'disconnected') disconnected.add(current);
      refreshManualWorld(true);
    };
  `)(env);
  return env;
}

function productionButton(env, buildingId = '1食品厂') {
  const button = env.document.querySelectorAll('[data-factory-production]')
    .find(node => node.dataset.factoryProduction === buildingId);
  assert(button, buildingId + ' 应提供查看排产按钮');
  return button;
}

function worldData(env, extra = {}) {
  return { serverNow: env.now / 1000 + 5, factories: [], farms: [], buildings: [], orders: [], stock: [],
    resFields: { fields: [], rows: [], totals: [] }, ...extra };
}

function factory(jobs = [], extra = {}) {
  return { buildingId: '1食品厂', type: '食品厂', typeName: '食品厂', level: 3,
    queue: jobs.length, capacity: 6, queueKnown: true, jobs, auto: '面包', autoEnabled: false, ...extra };
}

let passed = 0;
function test(name, work) {
  work();
  passed++;
  console.log('通过：' + name);
}

test('海面依次展示工厂、农田、空位，活动工坊并入工厂表格', () => {
  const env = fixture();
  const data = worldData(env, {
    factories: [factory(), factory([], { buildingId: '1活动工厂', type: '活动工厂', typeName: '活动工坊' })],
    farms: [10, 2, 1].map(index => ({ plot: index + '农田', level: 1, productId: null, productName: null, state: 'idle' })),
    buildings: [{ buildingId: '1材料厂', type: '材料厂', level: 0 }],
  });
  const original = JSON.stringify(data);
  env.render(data);
  const headings = descendants(env.node('world-factories')).filter(node => node.tagName === 'h2');
  assert.deepEqual(headings.map(node => node.textContent), ['工厂', '农田', '空位']);
  assert.equal(env.tables.length, 3);
  assert.deepEqual(env.tables[0].headers, ['建筑', '类型', '等级', '当前产物', '自动生产', '下一产物']);
  assert.equal(env.tables[0].rows.length, 2);
  assert.match(env.tables[0].node.textContent, /活动工坊/);
  assert.deepEqual(env.tables[1].headers, ['农田', '等级', '当前作物', '状态与计时']);
  assert.deepEqual(env.tables[1].rows.map(row => row[0]?.text ?? row[0]), ['1农田', '2农田', '10农田']);
  assert.equal(JSON.stringify(data), original, '展示排序不能修改服务器快照');
});

test('查看排产打开独立弹窗，完整格子不占用工厂表格', () => {
  const env = fixture();
  const now = env.now / 1000 + 5;
  env.render(worldData(env, { factories: [factory([
    { index: 20, productId: '面包', name: '面包', finishTime: now + 65 },
    { index: 21, productId: '饼干', name: '饼干', finishTime: null },
  ])] }));
  const factoryTable = env.tables[0].node;
  const text = factoryTable.textContent;
  assert.match(text, /面包/);
  assert.match(text, /饼干/);
  assert.match(text, /1分5秒/);
  assert.equal(descendants(factoryTable).filter(node => node.className === 'factory-slot' || node.tagName === 'details').length, 0);
  const row = env.tables[0].rows[0];
  assert.match(currentProductText(row[3]), /面包.*1分5秒/);
  assert.doesNotMatch(currentProductText(row[3]), /饼干/);
  assert.equal(cellText(row[5]), '饼干');
  const button = productionButton(env);
  assert.equal(button.attributes['aria-haspopup'], 'dialog');
  assert.equal(button.attributes['aria-controls'], 'factory-production-dialog');
  assert(!env.node('factory-production-dialog').open);
  button.onclick();
  assert.equal(env.node('factory-production-dialog').open, true);
  assert.equal(env.node('factory-production-dialog').dataset.factoryId, '1食品厂');
  assert.equal(env.node('factory-production-close').focused, true);
  assert.match(env.node('factory-production-title').textContent, /1食品厂/);
  const body = env.node('factory-production-body');
  assert.match(body.textContent, /面包.*饼干/);
  assert.match(body.textContent, /等待生产/);
  assert.equal((body.textContent.match(/空闲/g) ?? []).length, 4);
  assert.equal(descendants(body).filter(node => node.className === 'factory-slot').length, 6);
  assert.equal(factoryTable.textContent, text, '打开弹窗应保持原表格内容');
  assert.equal(descendants(factoryTable).filter(node => node.className === 'factory-slot' || node.tagName === 'details').length, 0);
  for (const id of ['factory-production-dialog', 'factory-production-title', 'factory-production-body', 'factory-production-close']) {
    assert.equal((PAGE.match(new RegExp('id="' + id + '"', 'g')) ?? []).length, 1, id);
  }
});

test('多个在产位均展示剩余时间，下一产物取首个等待项目', () => {
  const env = fixture();
  const now = env.now / 1000 + 5;
  env.render(worldData(env, { factories: [factory([
    { index: 10, productId: '面包', name: '面包', finishTime: now + 65 },
    { index: 11, productId: '面条', name: '面条', finishTime: now + 120 },
    { index: 12, productId: '饼干', name: '饼干', finishTime: null },
    { index: 13, productId: '蛋糕', name: '蛋糕', finishTime: 0 },
  ])] }));
  const row = env.tables[0].rows[0];
  const current = currentProductText(row[3]);
  assert.match(current, /面包.*1分5秒/);
  assert.match(current, /面条.*2分0秒/);
  assert.doesNotMatch(current, /饼干|蛋糕/);
  assert.equal(cellText(row[5]), '饼干');
});

test('刷新同步弹窗排产，关闭清理内容并把焦点返回当前工厂按钮', () => {
  const env = fixture();
  const jobs = [{ index: 5, productId: '饼干', name: '饼干', finishTime: null }];
  const data = worldData(env, { factories: [factory(jobs), factory(jobs, { buildingId: '2食品厂' })] });
  env.render(data);
  const first = productionButton(env);
  first.onclick();
  assert.match(env.node('factory-production-body').textContent, /饼干/);
  data.factories[0].jobs = [{ index: 6, productId: '蛋糕', name: '蛋糕', finishTime: null }];
  env.render(data);
  assert.equal(env.node('factory-production-dialog').open, true);
  assert.match(env.node('factory-production-body').textContent, /蛋糕/);
  assert.doesNotMatch(env.node('factory-production-body').textContent, /饼干/);
  const currentButton = productionButton(env);
  assert.notEqual(currentButton, first);
  env.node('factory-production-close').onclick();
  assert.equal(env.node('factory-production-dialog').open, false);
  assert.equal(env.node('factory-production-body').textContent, '');
  assert.equal(currentButton.focused, true, '关闭应聚焦刷新后的按钮');
  env.render(data);
  assert.equal(env.node('factory-production-dialog').open, false, '关闭后刷新不能重新打开');
});

test('原生弹窗关闭事件清理排产内容并返回打开按钮', () => {
  const env = fixture();
  const jobs = [{ index: 5, productId: '饼干', name: '饼干', finishTime: null }];
  env.render(worldData(env, { factories: [factory(jobs)] }));
  const button = productionButton(env);
  button.onclick();
  env.node('factory-production-dialog').close();
  assert.equal(env.node('factory-production-body').textContent, '');
  assert.equal(env.node('factory-production-dialog').dataset.factoryId, undefined);
  assert.equal(button.focused, true);
});

test('切换账号、暂停或断开时关闭弹窗并清理旧账号排产', () => {
  for (const mode of ['account', 'paused', 'disconnected']) {
    const env = fixture();
    const jobs = [{ index: 5, productId: '饼干', name: '饼干', finishTime: null }];
    env.render(worldData(env, { factories: [factory(jobs)] }));
    productionButton(env).onclick();
    env.refreshUnavailable(mode);
    assert.equal(env.node('factory-production-dialog').open, false, mode);
    assert.equal(env.node('factory-production-body').textContent, '', mode);
    assert.equal(env.node('world-factories').textContent, '', mode);
  }
});

test('刷新后工厂消失会关闭排产弹窗并聚焦建筑一览', () => {
  const env = fixture();
  const jobs = [{ index: 5, productId: '饼干', name: '饼干', finishTime: null }];
  env.render(worldData(env, { factories: [factory(jobs)] }));
  productionButton(env).onclick();
  env.render(worldData(env));
  assert.equal(env.node('factory-production-dialog').open, false);
  assert.equal(env.node('factory-production-body').textContent, '');
  assert.equal(env.node('tab-manual').focused, true);
});

test('当前产物区分等待开工、已完成和空闲，缺少队列显示未同步', () => {
  const env = fixture();
  const now = env.now / 1000 + 5;
  const cases = [
    { value: factory([{ index: 5, productId: '饼干', name: '饼干', finishTime: null }]), current: /待开工/, next: '饼干' },
    { value: factory([{ index: 5, productId: '面包', name: '面包', finishTime: now - 1 }]), current: /面包.*已完成.*待收取/, next: '—' },
    { value: factory(), current: /空闲/, next: '—' },
    { value: factory([], { queueKnown: false }), current: /未同步/, next: '未同步' },
  ];
  for (const entry of cases) {
    env.render(worldData(env, { factories: [entry.value] }));
    const row = env.tables.at(-1).rows[0];
    assert.match(currentProductText(row[3]), entry.current);
    assert.equal(cellText(row[5]), entry.next);
  }
});

test('自动生产按实际开关显示，缺少状态时显示未同步', () => {
  for (const [autoEnabled, expected] of [[true, '已开启'], [false, '未开启'], [undefined, '未同步']]) {
    const env = fixture();
    env.render(worldData(env, { factories: [factory([], { autoEnabled })] }));
    assert.equal(cellText(env.tables[0].rows[0][4]), expected);
  }
});

test('生产格容量变化或缺失时仍完整显示全部已排产项目', () => {
  const jobs = Array.from({ length: 7 }, (_, index) => ({ index: 100 + index, productId: '物品' + index, name: '物品' + index, finishTime: null }));
  for (const capacity of [6, null]) {
    const env = fixture();
    env.render(worldData(env, { factories: [factory(jobs, { capacity })] }));
    productionButton(env).onclick();
    const text = env.node('factory-production-body').textContent;
    for (const job of jobs) assert(text.includes(job.name), job.name);
    assert.equal((text.match(/等待生产/g) ?? []).length, 7);
  }
});

test('倒计时使用服务器时间偏移，时间推进后更新工厂和农田状态', () => {
  const env = fixture();
  const now = env.now / 1000 + 5;
  env.render(worldData(env, {
    factories: [factory([{ index: 2, productId: '面包', name: '面包', finishTime: now + 65 }])],
    farms: [{ plot: '1农田', level: 2, productId: '小麦', productName: '小麦', state: 'growing', ripeTime: now + 65 }],
  }));
  productionButton(env).onclick();
  const timers = env.document.querySelectorAll('[data-production-finish-at]');
  assert(timers.length >= 3, '表格、弹窗和农田均应展示对应倒计时');
  for (const timer of timers) assert.match(timer.textContent, /^（.*剩余 1分5秒）$/);
  env.now += 60000;
  env.updateTimers();
  for (const timer of timers) assert.match(timer.textContent, /^（.*剩余 5秒）$/);
  env.now += 6000;
  env.updateTimers();
  for (const timer of timers) assert.equal(timer.textContent, timer.dataset.productionReadyText);
  assert.match(env.tables[1].node.textContent, /已成熟/);
});

test('未同步队列和缺少成熟时间明确显示未知状态', () => {
  const env = fixture();
  env.render(worldData(env, {
    factories: [factory([], { queueKnown: false })],
    farms: [{ plot: '1农田', level: 1, productId: '小麦', productName: '小麦', state: 'growing', ripeTime: null }],
  }));
  assert.match(env.tables[0].node.textContent, /未同步/);
  assert.doesNotMatch(env.tables[0].node.textContent, /空闲/);
  assert.match(env.tables[1].node.textContent, /时间未同步/);
  assert.doesNotMatch(env.tables[1].node.textContent, /已成熟/);
  assert.equal(env.document.querySelectorAll('[data-production-finish-at]').length, 0);
});

test('农田施工使用建造倒计时，重新读取后清理旧倒计时', () => {
  const env = fixture();
  const now = env.now / 1000 + 5;
  env.render(worldData(env, { farms: [{ plot: '1农田', level: 0, state: 'building', finishTime: now + 10 }] }));
  assert.match(env.tables[0].node.textContent, /建造中.*10秒/);
  env.now += 11000;
  env.updateTimers();
  assert.match(env.tables[0].node.textContent, /待竣工/);
  env.render(worldData(env, { farms: [{ plot: '1农田', level: 1, state: 'idle', status: '空闲' }] }));
  assert.equal(env.document.querySelectorAll('[data-production-finish-at]').length, 0);
  assert.match(env.node('world-factories').textContent, /空闲/);
  assert.doesNotMatch(env.node('world-factories').textContent, /待竣工/);
});

console.log('海面生产界面测试 ' + passed + '/' + passed + ' 通过');
