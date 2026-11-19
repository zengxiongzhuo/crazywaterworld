// 模块启停与参数统一在游戏配置，活动详情保留各自唯一的编辑字段。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newStateFunction } from './fixtures/console-state.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-switch-ownership-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
fs.writeFileSync(process.env.CW_CONFIG_PACK, JSON.stringify([
  [1, 'FarmlandPlantCfg', { data: [{ id: '小麦', material: ['小麦种子', 1], time: 60, produceNum: 5 }] }],
]));
const { idleAutomationControls, automationControlView, setAutomationControl } = await import('../src/automation-controls.mjs');
const { defaultSettings, validateSettings, saveAutomationSettings, loadAutomationSettings, settingsUiRules,
  exportAutomationSettings, importAutomationSettings, nativeTaskValues, applyNativeTask, settingsFromNative } = await import('../src/automation-settings.mjs');
const { automationTasks, taskSettings } = await import('../src/automation.mjs');
const { nativePreferenceEnabled } = await import('../src/automation-policy.mjs');
const { activityAutomationFields } = await import('../src/activity-automation.mjs');
const script = fs.readFileSync(new URL('../src/settings-ui.js', import.meta.url), 'utf8');
const definitions = script.slice(0, script.indexOf('function configGet('));
const { staticGroups, merchantFields, guildShipFields } = newStateFunction(definitions + '\nreturn { staticGroups: configGroups, merchantFields: merchantActivityFields, guildShipFields: guildShipActivityFields };')();
const activityKeys = new Set([...merchantFields.map(field => field.key), ...guildShipFields.map(field => field.key), ...activityAutomationFields.map(field => field.key),
  'schedule.weekOrderSubmit', 'weekOrder.allowDiamonds', 'schedule.weekOrderFinal',
  'heroRaid.enabled', 'heroRaid.challenge', 'heroRaid.retryTimes', 'heroRaid.orders', 'heroRaid.lottery', 'heroRaid.rewards']);
const renderStart = script.indexOf('function configRender()');
const modelStart = script.indexOf('  const groups =', renderStart), modelEnd = script.indexOf('  const scopeSelect=', modelStart);
assert(modelStart > renderStart && modelEnd > modelStart);
const configGroups = newStateFunction('data', definitions + '\nconfigEditor.data=data;\n' + script.slice(modelStart, modelEnd) + '\nreturn groups;')({ tasks: automationTasks, rules: settingsUiRules() });
const configFields = configGroups.flatMap(group => group.fields), configKeys = new Set(configFields.map(field => field.key));
const read = (value, key) => key.split('.').reduce((object, part) => object?.[part], value);
const write = (value, key, enabled) => {
  const parts = key.split('.'), field = parts.pop();
  parts.reduce((object, part) => object[part], value)[field] = enabled;
};
let passed = 0;
const check = async (name, run) => { await run(); passed++; console.log('通过：' + name); };

try {
  await check('28个模块启停集中在所属配置，全部字段有唯一编辑位置', () => {
    const rendered = configFields.filter(field => field.moduleControl).map(field => field.key);
    const idleKeys = idleAutomationControls.map(control => control.key), movedFields = idleAutomationControls.flatMap(control => control.fields);
    assert.equal(idleKeys.length, 28, '联盟募兵统一由联盟模块管理，不保留旧订单入口');
    assert.equal(rendered.length, new Set(rendered).size, '每个入口只显示一次');
    assert.deepEqual(new Set(rendered), new Set(idleKeys));
    assert.deepEqual(new Set(settingsUiRules().controlFields), new Set(movedFields));
    assert.equal(configFields.length, configKeys.size, '配置字段不重复');
    for (const control of idleAutomationControls) {
      const categoryNames = { base: '基地', world: '世界', heroes: '英雄', antique: '藏品', equipment: '装备', daily: '日常与活动' };
      assert(configGroups.some(group => group.id === control.configTarget), control.key + ' 配置入口存在');
      const group = configGroups.find(group => group.id === control.configTarget);
      assert.equal(control.idleGroup, categoryNames[group.category], control.key + ' 与所属分类一致');
      assert(group.fields.some(field => field.key === control.key && field.moduleControl), control.key + ' 在自己的配置中启停');
    }
    const scheduledInHeader = new Set(['loop.everySeconds']);
    const fields = new Set([...staticGroups.flatMap(group => group.fields.map(field => field.key)), ...activityKeys]);
    for (const key of fields) {
      const locations = configFields.filter(field => (field.controlFields ?? [field.key]).includes(key)).length + Number(scheduledInHeader.has(key)) + Number(activityKeys.has(key));
      assert.equal(locations, 1, key + ' 应有且仅有一个编辑位置');
    }
    assert(!configGroups.some(group => group.id === 'runtime'), '运行安排已从网页配置移除');
    assert(!configGroups.some(group => group.id === 'guild-orders'), '旧联盟订单页签已移除');
    assert(!configKeys.has('schedule.guildOrders'), '动态配置不能重新生成旧联盟订单开关');
    assert(configGroups.find(group => group.id === 'alliance').fields.some(field => field.key === 'alliance.recruit'), '联盟模块保留自动募兵');
    assert(!configKeys.has('loop.rounds'), '网页挂机持续循环，不提供轮数编辑');
    assert(!configKeys.has('loop.everySeconds'));
  });

  await check('装备领取与续产只有锻造总开关，旧开关不能重新启用', () => {
    assert.deepEqual(configGroups.filter(group => group.category === 'equipment').map(group => group.id), ['forge']);
    const before = defaultSettings();
    before.forge.buildingIds = ['1装备厂']; before.forge.recipeIds = ['1001'];
    before.forge.dailyLimit = 7;
    const after = setAutomationControl(before, 'forge.enabled', true);
    const expected = structuredClone(before); expected.forge.enabled = true;
    assert.deepEqual(after, expected, '锻造总开关启用时保留工厂、配方和预算');
    assert.equal(automationControlView(after).find(control => control.key === 'forge.enabled').enabled, true);
    assert.deepEqual(setAutomationControl(after, 'forge.enabled', false), before);
    for (const key of ['schedule.equipmentCollect', 'schedule.equipmentCraft']) {
      assert(!configKeys.has(key), '动态配置不能重新生成旧开关');
      assert(!automationControlView(after).some(control => control.key === key));
      assert.throws(() => setAutomationControl(after, key, true), /无效/);
    }
  });

  await check('万吨巨轮只保留世界配置，旧派遣开关不能在导入或关闭主控后恢复', () => {
    assert(!configKeys.has('schedule.treasureLoot'), '真实分组组装不能补回旧派遣入口');
    assert(!configGroups.some(group => group.id === 'daily-other'), '旧派遣移除后不保留其他项目空组');
    const treasureGroups = configGroups.filter(group => group.id === 'treasure');
    assert.equal(treasureGroups.length, 1);
    assert.equal(treasureGroups[0].category, 'world');
    assert.equal(configFields.filter(field => field.key === 'treasure.enabled').length, 1);
    assert.equal(taskSettings({ treasureLoot: true }).treasureLoot, false, '旧任务配置不能重开派遣');
    assert.equal(nativePreferenceEnabled(null, 'treasureLoot'), false, '无详细配置时旧入口也停用');
    const nativeOnly = settingsFromNative({ treasureLoot: true });
    assert.equal(nativeOnly.schedule.treasureLoot, false);
    assert.equal(nativeOnly.treasure.enabled, false, '旧开关不擅自启用世界主控');

    for (const enabled of [false, true]) {
      const before = defaultSettings();
      Object.assign(before.treasure, { enabled, autoJoin: true, qualities: ['ORANGE', 'PURPLE'], follow: true,
        fleetIds: ['2远征船', '1远征船'], followNames: ['跟随玩家'], followPlayerIds: ['9007199254740993'],
        avoidNames: ['避战玩家'], avoidPlayerIds: ['9007199254740995'], rewardItems: ['测试奖励'],
        participationMode: 'always', repeatAttack: true, minDurabilityPercent: 73, maxProgress: 85,
        personalProgressLimit: 15, dailyDispatchLimit: 9, checkEverySeconds: 23, autoRepair: true,
        marchSpeedUp: true, marchTargetSeconds: 35, dailyDiamondLimit: 123,
        fallbackEnabled: true, fallbackAfter: '22:15', fallbackTargetRewards: 4,
        fallbackQualities: ['BLUE', 'PURPLE'], fallbackMediumRewardPriority: ['中型奖励'], fallbackSmallRewardPriority: ['小型奖励'] });
      before.schedule.treasureLoot = true;
      const frozen = structuredClone(before);
      const document = exportAutomationSettings(before);
      assert.equal(document.settings.schedule.treasureLoot, false, '导出时清除旧派遣授权');
      document.settings.schedule.treasureLoot = true; // 模拟尚未更新的备份重新导入。
      for (const result of [validateSettings(before), importAutomationSettings(document), applyNativeTask(before, 'treasureLoot', true)]) {
        assert.equal(result.schedule.treasureLoot, false, '校验、导入和旧快捷开关均不能激活派遣');
        assert.deepEqual(result.treasure, frozen.treasure, '世界主控与所有派遣参数完整保留');
      }
      assert.equal(nativeTaskValues(before, { treasureLoot: true }).treasureLoot, false);
      assert.equal(nativePreferenceEnabled(before, 'treasureLoot'), false);
      assert(!automationControlView(before).some(control => control.key === 'schedule.treasureLoot'));
      assert.throws(() => setAutomationControl(before, 'schedule.treasureLoot', true), /无效/);
      assert.deepEqual(before, frozen, '移除旧入口不能修改调用者保存的设置');
    }
  });

  await check('模块下方保留执行细项、资源权限、策略与预算', () => {
    const details = ['building.collect', 'building.upgrade', 'factory.produce', 'factory.demandFirst',
      'farm.harvest', 'farm.autoPlant', 'farm.customPlant', 'gather.fishing', 'gather.keyOpen',
      'museum.enabled', 'museum.upgrade', 'museum.revenue', 'museum.achievements', 'museum.display', 'radar.enabled', 'radar.repairIdle',
      'heroes.level', 'heroes.star', 'heroes.skill', 'heroes.universal', 'resources.allowDiamonds',
      'alliance.autoHelp', 'silicon.fleets.0.enabled', 'silicon.fleets.1.huntEnabled'];
    const idleFields = new Set(idleAutomationControls.flatMap(control => control.fields));
    for (const key of details) {
      assert(!idleFields.has(key), key + ' 不属于挂机主控');
      assert.equal(configFields.find(field => field.key === key)?.kind, 'switch', key + ' 仍能在配置中编辑');
    }
    for (const key of ['building.maxUpgrades', 'factory.keepStock', 'farm.crops', 'gather.targetLevel',
      'treasure.fleetIds', 'resources.diamondDailyLimit', 'heroes.heroIds']) {
      assert(configKeys.has(key), key + ' 参数应保留'); assert(!idleFields.has(key));
    }
  });

  await check('博物馆五项功能同组管理，自动探宝不拆分领取派遣开关', () => {
    const settings = defaultSettings(); settings.museum.runEnabled = true;
    const note = () => automationControlView(settings).find(control => control.key === 'museum.runEnabled').configurationNote;
    assert.match(note(), /尚未选择执行动作/);
    settings.museum.enabled = true;
    assert.equal(note(), '');
    settings.museum.enabled = false; settings.museum.useGuide = true;
    assert.match(note(), /尚未选择执行动作/, '指南不能独立于自动探宝执行');
    for (const key of ['upgrade', 'revenue', 'achievements', 'display']) {
      settings.museum[key] = true;
      assert.equal(note(), '', key + ' 可独立于自动探宝执行');
      const control = automationControlView(settings).find(row => row.key === 'museum.' + key);
      assert(control); assert(control.gates.includes('museum.runEnabled')); assert(!control.gates.includes('museum.enabled'));
      settings.museum[key] = false;
    }
    for (const key of ['museum.claim', 'museum.explore', 'schedule.museumRevenue', 'schedule.museumAchievements']) {
      assert(!configKeys.has(key)); assert(!automationControlView(settings).some(control => control.key === key));
      assert.throws(() => setAutomationControl(settings, key, true), /无效/);
    }
  });

  await check('商人、超凡英雄和海商王由活动页管理，全部海商王开关与参数均可编辑', () => {
    const idleFields = new Set(idleAutomationControls.flatMap(control => control.fields));
    for (const key of ['weekOrder.enabled', 'schedule.weekOrderSubmit', 'weekOrder.allowDiamonds', 'schedule.weekOrderFinal',
      'heroRaid.enabled', 'heroRaid.challenge', 'heroRaid.orders', 'heroRaid.lottery', 'heroRaid.rewards']) {
      assert(!configKeys.has(key), key);
      assert(!idleFields.has(key), key);
      assert.equal(typeof read(defaultSettings(), key), 'boolean', '原配置仍可持久保存');
    }
    assert(!configGroups.some(group => group.id === 'rich-merchant'));
    assert(!configGroups.some(group => group.id === 'hero-raid'));
    assert(!configKeys.has('heroRaid.retryTimes'));
    assert(!idleFields.has('heroRaid.retryTimes'));
    assert(!configGroups.some(group => group.id === 'merchant-week'));
    const expectedMerchantKeys = new Set([...Object.keys(defaultSettings().merchant).map(key => 'merchant.' + key),
      'schedule.merchantTrade', 'schedule.merchantRewards', 'schedule.tradeTasks']);
    assert.deepEqual(new Set(merchantFields.map(field => field.key)), expectedMerchantKeys);
    assert.equal(merchantFields.length, expectedMerchantKeys.size, '每个海商王字段只有一套定义');
    for (const field of merchantFields) {
      assert(!configKeys.has(field.key), field.key + ' 由活动页编辑');
      assert(!idleFields.has(field.key), field.key + ' 由活动页编辑');
      const value = read(defaultSettings(), field.key);
      if (typeof value === 'boolean') assert.equal(field.kind, 'switch', field.key + ' 开关可编辑');
      else if (typeof value === 'number') assert.equal(field.kind, 'number', field.key + ' 数值可编辑');
      else assert(['choice', 'time'].includes(field.kind), field.key + ' 策略或时间可编辑');
    }
  });

  await check('每个活动自动挂机总开关仅由活动配置管理，挂机面板不生成入口', () => {
    const idleKeys = new Set(idleAutomationControls.flatMap(control => control.fields));
    for (const field of activityAutomationFields) {
      assert.equal(typeof read(defaultSettings(), field.key), 'boolean', field.key + ' 有持久化布尔值');
      assert(!idleKeys.has(field.key), field.key + ' 不在挂机入口');
      assert(!configKeys.has(field.key), field.key + ' 不在通用配置重复编辑');
      assert(activityKeys.has(field.key), field.key + ' 由活动配置拥有');
    }
  });

  await check('关闭基地模块只暂停主控，混合细项和参数往返不变', () => {
    const original = defaultSettings();
    original.building.collect = false; original.building.upgrade = true; original.building.maxUpgrades = 7;
    original.factory.produce = false; original.factory.keepStock = 321;
    original.farm.harvest = false; original.farm.autoPlant = false; original.farm.customPlant = true;
    original.farm.crops = [{ id: '小麦', target: 73 }];
    original.gather.fishing = true; original.gather.diving = false; original.gather.targetLevel = 5;
    original.museum.enabled = true; original.museum.upgrade = false; original.museum.factor = 3;
    for (const key of ['building.enabled', 'factory.enabled', 'farm.enabled', 'gather.enabled', 'museum.runEnabled']) {
      const before = structuredClone(original); write(before, key, true);
      const frozen = structuredClone(before), expected = structuredClone(before); write(expected, key, false);
      const off = setAutomationControl(before, key, false);
      assert.deepEqual(off, expected, key + ' 不能改变细项或参数');
      assert.deepEqual(setAutomationControl(off, key, true), frozen, key + ' 重新开启恢复原执行选择');
      assert.deepEqual(before, frozen, '不得修改传入对象');
    }
  });

  await check('英雄自动养成只用一个入口同步两层主控，保留具体养成选择', () => {
    const hero = idleAutomationControls.find(control => control.key === 'heroes.enabled');
    assert(hero); assert.deepEqual(new Set(hero.fields), new Set(['heroes.enabled', 'loop.heroes']));
    assert(!idleAutomationControls.some(control => control.key === 'loop.heroes'));
    assert(configKeys.has('heroes.enabled') && !configKeys.has('loop.heroes'));
    assert.deepEqual(configFields.find(field => field.key === 'heroes.enabled').controlFields, ['heroes.enabled', 'loop.heroes']);
    for (const [enabled, auto] of [[false, false], [true, false], [false, true], [true, true]]) {
      const original = defaultSettings(); original.heroes.enabled = enabled; original.loop.heroes = auto;
      original.heroes.level = false; original.heroes.star = true; original.heroes.skill = false;
      original.heroes.heroIds = ['hero-fixture']; original.heroes.targetLevel = 23;
      const before = structuredClone(original);
      assert.equal(automationControlView(original).find(control => control.key === hero.key).enabled, enabled && auto);
      for (const next of [true, false]) {
        const expected = structuredClone(original); expected.heroes.enabled = expected.loop.heroes = next;
        assert.deepEqual(setAutomationControl(original, hero.key, next), expected);
      }
      assert.deepEqual(original, before);
    }
  });

  await check('真实挂机接口保存模块与英雄组合主控，配置细项保持独立且不启动游戏', async () => {
    const { saveStore } = await import('../src/accounts.mjs');
    saveStore({ version: 1, activeId: 'switch-a', accounts: ['switch-a', 'switch-b'].map(id => ({ id, label: '开关测试', url: 'ws://127.0.0.1:1', login: {}, automation: { paused: true } })) });
    const initial = defaultSettings();
    initial.farm.enabled = true; initial.farm.autoPlant = false; initial.farm.customPlant = true;
    initial.farm.crops = [{ id: '小麦', target: 73 }]; initial.building.maxUpgrades = 7;
    initial.museum.enabled = true; initial.museum.upgrade = false; initial.factory.keepStock = 123;
    initial.heroes.level = false; initial.heroes.star = true; initial.heroes.skill = false;
    initial.heroes.enabled = true; initial.loop.heroes = false;
    saveAutomationSettings('switch-a', validateSettings(initial), { revision: 0 });
    const { createConsole } = await import('../src/server.mjs');
    const app = createConsole({ port: 0, protocol: {} }); await app.listen();
    const api = async (route, body, account = 'switch-a') => {
      const response = await fetch('http://127.0.0.1:' + app.server.address().port + '/api/' + route + '?account=' + account, {
        method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, data: await response.json() };
    };
    try {
      const other = await api('settings', null, 'switch-b');
      let saved = (await api('settings')).data;
      const firstRevision = saved.revision;
      for (const [key, enabled] of [['building.enabled', false], ['farm.enabled', false], ['museum.runEnabled', false], ['heroes.enabled', true], ['heroes.enabled', false]]) {
        const control = idleAutomationControls.find(item => item.key === key), expected = structuredClone(saved.settings);
        for (const field of control.fields) write(expected, field, enabled);
        // 旧版 schedule.farm 是同一农田主控的兼容镜像，不是独立细项。
        if (key === 'farm.enabled') expected.schedule.farm = enabled;
        const result = await api('loop/control', { confirm: true, key, enabled, revision: saved.revision });
        assert.equal(result.status, 200, key + ': ' + JSON.stringify(result.data));
        assert.equal(result.data.running, false); assert.equal(result.data.controls.find(item => item.key === key).enabled, enabled);
        saved = (await api('settings')).data;
        assert.deepEqual(saved.settings, expected, key + ' 只更改本模块主控');
        assert.deepEqual(loadAutomationSettings('switch-a').settings, expected, key + ' 应持久保存');
      }
      const configured = structuredClone(saved.settings);
      configured.heroes.level = true; configured.building.speedUp = false; configured.building.maxUpgrades = 9;
      const result = await api('settings', { confirm: true, settings: configured, revision: saved.revision });
      assert.equal(result.status, 200); assert.deepEqual(result.data.settings, configured);
      for (const key of ['heroes.enabled', 'loop.heroes', 'building.enabled', 'farm.enabled', 'museum.runEnabled']) assert.equal(read(result.data.settings, key), false, '配置细项不能重开 ' + key);
      assert.deepEqual((await api('settings', null, 'switch-b')).data.settings, other.data.settings);
      assert(!app.sessions.get('switch-a').client, '编辑设置不能连接游戏或开始挂机');
      const stale = await api('loop/control', { confirm: true, key: 'heroes.enabled', enabled: true, revision: firstRevision });
      assert.equal(stale.status, 400);
      assert.deepEqual((await api('settings')).data.settings, configured, '过期主控请求不能覆盖最新配置');
    } finally { await app.close(); }
  });
  console.log(`开关归属专项 ${passed}/${passed} 通过`);
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
