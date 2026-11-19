import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-hero-growth-http-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
process.env.CW_RESOURCE_DIR = path.join(directory, 'resources');
const ids = ['甲', '乙', '丙', '丁', '戊'];
const tables = {
  ModuleOpenCfg: [{ moduleId: '英雄装备', playerLevel: 16 }],
  EquipCfg: [{ id: '刀' }], EquipAttrCfg: [{ id: '刀', star: 0, maxLv: 3 }],
  EquipUpDecomposeCfg: [{ level: 2, upgradeCost: 50 }],
  HeroCfg: ids.map(id => ({ id, name: id, quality: 'BLUE' })),
  HeroAbilityShowCfg: ids.map(id => ({ id, reward: ['RUBY', 20] })),
};
fs.writeFileSync(process.env.CW_CONFIG_PACK, JSON.stringify(Object.entries(tables).map(([name, data], i) => [i, name, { data }])));
const { defaultSettings } = await import('../src/automation-settings.mjs');
const { saveStore } = await import('../src/accounts.mjs');
const { createConsole } = await import('./fixtures/console-server.mjs');
const accountId = 'hero-growth-http';
saveStore({ version: 1, activeId: accountId, accounts: [{
  id: accountId, label: '养成回归', url: 'ws://fixture.invalid', login: {}, automation: { enabled: false, autoStart: false },
}] });
const app = createConsole({ port: 0, protocol: {}, resourceUpdates: false });
const root = await app.listen();
async function api(route, body) {
  const response = await fetch(root + '/api/' + route + '?account=' + accountId, {
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000),
  });
  const data = await response.json();
  assert.equal(response.status, 200, route + ' ' + JSON.stringify(data));
  return data;
}
function disableSwitches(object) {
  for (const [key, value] of Object.entries(object)) {
    if (typeof value === 'boolean') object[key] = false;
    else if (value && typeof value === 'object') disableSwitches(value);
  }
}

let session;
try {
  let view = await api('settings');
  const settings = defaultSettings();
  disableSwitches(settings);
  settings.heroes.enabled = true;
  settings.heroes.showSkillReward = true;
  settings.loop.everySeconds = 1;
  const owned = ['甲', '乙'], claimed = new Set(), writes = [], unexpected = [];
  session = app.sessions.get(accountId);
  const client = new EventEmitter();
  client.setMaxListeners(30);
  Object.assign(client, {
    connected: true, serverClockOffsetMs: 0,
    stop() { this.connected = false; },
    async request(name, body) {
      if (name === 'AllHeroRequest') return { heroes: owned.map((heroId, index) => ({ heroId, level: 1, equips: [{ uid: index + 1, equipId: '刀' }] })), showSkillHeroes: [...claimed] };
      if (name === 'AllItemRequest') return { items: [{ itemId: '精铁', num: 100 }] };
      if (name === 'EquipsRequest') return { equip: ids.map((_, i) => ({ uid: i + 1, equipId: '刀', level: 1 })) };
      if (name === 'GotHeroShowSkillRequest') {
        writes.push(body.heroId);
        assert(owned.includes(body.heroId), '未拥有英雄不能领取展示奖励');
        assert(!claimed.has(body.heroId), '重复领取英雄展示奖励');
        claimed.add(body.heroId);
        return { reward: { asset: [{ id: 'RUBY', num: 20 }] } };
      }
      unexpected.push(name);
      throw new Error('意外游戏请求 ' + name);
    },
    async sendWatch(name) { unexpected.push(name); throw new Error('意外游戏写入 ' + name); },
  });
  session.client = client;
  session.player = { playerId: 86721, worldId: 12001, nickname: '养成回归', level: 40 };
  const save = async heroIds => {
    settings.heroes.heroIds = heroIds;
    view = await api('settings', { settings, revision: view.revision, baseRevision: view.baseRevision });
    assert.deepEqual(view.settings.heroes.heroIds, heroIds);
  };
  const run = () => api('heroes/run', { confirm: true });
  const preview = heroIds => api('settings/preview', {
    category: 'heroes', settings: { ...settings, heroes: { ...settings.heroes, heroIds } },
  });

  await save([]);
  assert.deepEqual((await api('heroes')).steps.map(step => step.heroId), owned, '空名单仍计划全部已拥有英雄奖励');
  const unselected = await preview([]);
  assert.deepEqual(unselected.actions.map(step => step.kind), ['showSkillReward', 'showSkillReward']);
  assert(unselected.actions.every((step, i) => step.label.includes(owned[i])));
  assert.deepEqual(writes, [], '空名单预览不能执行写入');

  await save(['甲']);
  const mixed = { ...settings, heroes: { ...settings.heroes, heroIds: ['乙'], equipment: true } };
  const gear = await api('settings/preview', { category: 'equipmentGrowth', settings: mixed });
  assert.equal(gear.scopeLabel, '装备强化');
  assert.deepEqual(gear.actions.map(step => step.kind), ['equipment']);
  assert.match(gear.actions[0].label, /乙/);
  const draft = await api('settings/preview', { category: 'heroes', settings: mixed });
  assert.deepEqual(draft.actions.map(step => step.kind), ['showSkillReward', 'showSkillReward']);
  assert(draft.actions.every((step, i) => step.label.includes(owned[i])), '英雄预览中的奖励不受草稿培养名单限制');
  assert.deepEqual((await api('settings')).settings.heroes.heroIds, ['甲']);
  assert.deepEqual((await api('heroes')).steps.map(step => step.heroId), owned);
  assert.deepEqual(writes, [], '读取计划和预览草稿不能执行写入');
  const result = await run();
  assert.equal(result.failed, 0);
  assert.equal(result.sent, 2);
  assert(result.steps.every(step => step.ok));
  assert.deepEqual(writes, ['甲', '乙'], '手动领取包含未选中的已拥有英雄');
  assert.deepEqual((await api('heroes')).steps, [], '已领名单回读后不再计划');
  assert.equal((await run()).sent, 0);

  owned.push('丙');
  await save([]);
  const emptyResult = await run();
  assert.equal(emptyResult.failed, 0);
  assert.equal(emptyResult.sent, 1);
  assert.deepEqual(writes, ['甲', '乙', '丙'], '手动空名单仍领取新英雄奖励并跳过已领取英雄');

  owned.push('丁', '戊');
  settings.loop.heroes = true;
  await save([]);
  await api('loop/start', { confirm: true, everySeconds: 1, rounds: 1 });
  await session.loop.job;
  assert.equal(session.loop.error, null);
  assert.equal(session.loop.completed, 1);
  assert.deepEqual(writes, ids, '挂机空名单仍领取所有新英雄奖励并跳过已领取英雄');
  assert.deepEqual(unexpected, []);
  view = await api('settings');
  await save([]);
  assert.equal((await run()).sent, 0);
  assert.deepEqual(writes, ids);
  console.log('英雄养成 HTTP 通过：持久化培养名单、草稿只读预览、手动与挂机空名单全英雄领奖、回读去重');
} finally {
  session?.loop.controller?.abort();
  await session?.loop.job;
  app.server.closeAllConnections();
  await app.close();
  assert.equal(path.dirname(directory), fs.realpathSync(os.tmpdir()));
  fs.rmSync(directory, { recursive: true, force: true });
}
