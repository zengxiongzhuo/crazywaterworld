// Version migration uses synthetic settings and a temporary data directory.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SETTINGS_FORMAT, SETTINGS_SCHEMA_VERSION, defaultSettings, migrateSettingsVersion,
  importAutomationSettings, exportAutomationSettings, loadAutomationSettings, saveAutomationSettings,
  nativeTaskValues, validateSettings, settingsUiRules, settingsFromNative, applyNativeTask,
} from '../src/automation-settings.mjs';
import { automationTasks, taskSettings } from '../src/automation.mjs';
import { automationControls } from '../src/automation-controls.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-settings-version-'));
const file = path.join(directory, 'settings.json');
let passed = 0;
function test(name, work) { work(); passed++; console.log('通过：' + name); }
function legacySettings() {
  const settings = defaultSettings();
  settings.schedule.stageAuto = true;
  settings.schedule.radarAuto = true;
  settings.schedule.museumExplore = true;
  settings.building.collect = false;
  settings.factory.gain = true;
  settings.radar.enabled = false;
  settings.museum.enabled = false;
  settings.gather.fishing = false;
  delete settings.progression;
  delete settings.login;
  delete settings.merchant;
  delete settings.silicon;
  delete settings.factory.checkEverySeconds;
  delete settings.cityWar.defenceFleetIds;
  delete settings.cityWar.targetPriority;
  delete settings.cityWar.nativeCommissionLimit;
  delete settings.cityWar.defenceTargetMode;
  delete settings.cityWar.defenceTargetPriority;
  delete settings.cityWar.defenceCityRefs;
  delete settings.gather.enabled;
  delete settings.museum.runEnabled;
  delete settings.radar.runEnabled;
  delete settings.heroRaid.challenge;
  delete settings.heroRaid.retryTimes;
  delete settings.heroRaid.lottery;
  return settings;
}

try {
  test('世界Boss逐队阵容兼容旧配置，绑定验证与往返保存保留选择', () => {
    const old = defaultSettings(); old.worldBoss.fleetIds = ['1远征船', '2远征船'];
    old.worldBoss.enabled = true; delete old.worldBoss.fleetPresets;
    const upgraded = importAutomationSettings({ format: SETTINGS_FORMAT, version: 10, settings: old });
    assert.deepEqual(upgraded.worldBoss, { ...old.worldBoss, fleetPresets: [] });
    assert.deepEqual(validateSettings(old).worldBoss, upgraded.worldBoss, '旧页面保存兼容新增空绑定');
    assert(!Object.hasOwn(old.worldBoss, 'fleetPresets'), '不修改输入');
    const settings = defaultSettings();
    settings.lineups.presets = [{ id: 'boss', name: '首领队', formation: { presetId: 1, heroPositions: [{ heroId: 'a', pos: { x: 4, y: 4 } }], petUid: '0' } }];
    settings.worldBoss.fleetIds = ['1远征船', '2远征船'];
    settings.worldBoss.fleetPresets = [{ buildingId: '1远征船', presetId: 'boss' }];
    assert.deepEqual(importAutomationSettings(exportAutomationSettings(settings)), validateSettings(settings));
    const paused = structuredClone(settings); paused.worldBoss.fleetIds = [];
    assert.deepEqual(validateSettings(paused).worldBoss.fleetPresets, settings.worldBoss.fleetPresets, '取消勾选保留下次使用的阵容');
    for (const bindings of [null, {}, [{ buildingId: '0远征船', presetId: 'boss' }],
      [{ buildingId: '1远征船', presetId: 'missing' }], [...settings.worldBoss.fleetPresets, ...settings.worldBoss.fleetPresets],
      [{ buildingId: '1远征船', presetId: 'boss', extra: true }]]) {
      const invalid = structuredClone(settings); invalid.worldBoss.fleetPresets = bindings;
      assert.throws(() => validateSettings(invalid), error => !!error.fields?.['worldBoss.fleetPresets']);
    }
    assert.deepEqual(settingsFromNative({}).worldBoss.fleetPresets, []);
  });

  test('世界Boss旧、新领奖开关合并后保留启用状态和独立首战配置', () => {
    for (const version of [1, 9]) for (const legacyEnabled of [false, true]) for (const rewardsEnabled of [false, true]) for (const dispatchEnabled of [false, true]) {
      const settings = defaultSettings();
      Object.assign(settings.schedule, { worldBossDamage: legacyEnabled, worldBossRewards: rewardsEnabled });
      Object.assign(settings.worldBoss, { enabled: dispatchEnabled, fleetIds: ['2远征船'], minDurabilityPercent: 63 });
      const before = structuredClone(settings);
      const expected = structuredClone(settings);
      expected.schedule.worldBossRewards = legacyEnabled || rewardsEnabled;
      delete expected.schedule.worldBossDamage;
      fs.writeFileSync(file, JSON.stringify({ version, accounts: {
        boss: { settingsVersion: version, revision: 3, settings },
        other: { settingsVersion: version, revision: 2, settings },
      } }));
      const bytes = fs.readFileSync(file), loaded = loadAutomationSettings('boss', { file });
      assert.deepEqual(loaded.settings, expected);
      assert.deepEqual(importAutomationSettings({ format: SETTINGS_FORMAT, version, settings }), expected);
      assert.deepEqual(fs.readFileSync(file), bytes, '读取只在内存合并');
      assert.deepEqual(settings, before, '迁移不修改输入');
      const saved = saveAutomationSettings('boss', loaded.settings, { file, revision: loaded.revision });
      assert.deepEqual(loadAutomationSettings('boss', { file }).settings, expected);
      assert.deepEqual(importAutomationSettings(exportAutomationSettings(saved.settings)), expected);
      assert.deepEqual(JSON.parse(fs.readFileSync(file)).accounts.other.settings, before, '不改写其他账号');
      const disabled = structuredClone(saved.settings);
      disabled.schedule.worldBossRewards = false;
      saveAutomationSettings('boss', disabled, { file, revision: saved.revision });
      const restarted = loadAutomationSettings('boss', { file }).settings;
      assert.deepEqual(restarted, disabled);
      const tasks = nativeTaskValues(restarted, { worldBossDamage: true, worldBossRewards: true });
      assert.equal(tasks.worldBossRewards, false, '关闭统一开关后旧任务值不能重新开启');
      assert(!Object.hasOwn(tasks, 'worldBossDamage'));
    }
  });

  test('世界Boss原生旧任务和旧页面保存迁移为统一领奖开关', () => {
    const defaults = defaultSettings();
    assert.equal(defaults.worldBoss.enabled, false);
    assert.equal(defaults.schedule.worldBossRewards, false);
    assert(!Object.hasOwn(defaults.schedule, 'worldBossDamage'));
    assert(!automationTasks.some(task => task.key === 'worldBossDamage'));
    assert(!automationControls.some(control => control.key === 'schedule.worldBossDamage'));
    for (const legacyEnabled of [false, true]) for (const rewardsEnabled of [false, true]) {
      const native = { worldBossDamage: legacyEnabled, worldBossRewards: rewardsEnabled };
      const expected = legacyEnabled || rewardsEnabled;
      assert.equal(taskSettings(native).worldBossRewards, expected);
      assert(!Object.hasOwn(taskSettings(native), 'worldBossDamage'));
      const migrated = settingsFromNative(native);
      assert.equal(migrated.schedule.worldBossRewards, expected);
      assert.equal(migrated.worldBoss.enabled, false, '领奖选择不自动授权首战派遣');
      assert(!Object.hasOwn(migrated.schedule, 'worldBossDamage'));
      const disabled = applyNativeTask(migrated, 'worldBossRewards', false);
      assert.deepEqual(applyNativeTask(disabled, 'worldBossDamage', true), disabled, '退役入口不能重开领奖');
      assert.equal(importAutomationSettings(exportAutomationSettings(disabled)).schedule.worldBossRewards, false);
    }
    const oldPage = defaultSettings(); oldPage.schedule.worldBossDamage = true;
    const normalized = validateSettings(oldPage);
    assert.equal(normalized.schedule.worldBossRewards, true, '已打开的旧页面仍能保存原先的领奖选择');
    assert(!Object.hasOwn(normalized.schedule, 'worldBossDamage'));
    normalized.schedule.worldBossRewards = false;
    assert.equal(importAutomationSettings(exportAutomationSettings(normalized)).schedule.worldBossRewards, false);
    for (const key of ['worldBossDamage', 'worldBossRewards']) {
      const legacy = defaultSettings(); legacy.schedule[key] = 'true';
      assert.throws(() => importAutomationSettings({ format: SETTINGS_FORMAT, version: 9, settings: legacy }),
        error => !!error.fields?.['schedule.' + key]);
    }
  });

  test('汽油限制和城战接续次数上限从旧文件、导入和旧页面保存中移除', () => {
    const expected = defaultSettings();
    Object.assign(expected.resources, { allowDiamonds: true, diamondDailyLimit: 1234, diamondThreshold: 50 });
    Object.assign(expected.cityWar, { enabled: true, fleetIds: ['1远征船'], autoRepair: true, nativeCommissionLimit: 2, repairBelowPercent: 65 });
    Object.assign(expected.treasure, { autoRepair: true, dailyDispatchLimit: 12, dailyDiamondLimit: 321 });
    Object.assign(expected.pirateHunt, { enabled: true, fleetIds: ['1远征船'], maxFailures: 4 });
    Object.assign(expected.silicon, { dailyRewardLimit: 5, dailyDiamondLimit: 200 });
    Object.assign(expected.silicon.fleets[0], { autoRepair: true, dailyAttackLimit: 11 });
    const legacy = structuredClone(expected);
    const retired = {
      worldBoss: { petrolReserve: 999999 },
      radar: { petrolReserve: 1000, dailyPetrolLimit: 1 },
      pirateHunt: { petrolReserve: 1234, fuelBudget: 1 },
      treasure: { petrolReserve: 99999, maxRepairCost: 1, dailyRepairPetrolLimit: 1 },
      cityWar: { petrolReserve: 99999, maxRepairCost: 1, dailyPetrolLimit: 1, dailyDispatchLimit: 7 },
      silicon: { petrolReserve: 99999, dailyPetrolLimit: 1 },
    };
    for (const [group, values] of Object.entries(retired)) Object.assign(legacy[group], values);
    legacy.silicon.fleets.forEach((fleet, index) => { fleet.maxRepairCost = index + 1; });
    const before = structuredClone(legacy);
    for (const version of [1, 2, 3, 17, SETTINGS_SCHEMA_VERSION]) {
      fs.writeFileSync(file, JSON.stringify({ version, accounts: {
        fuel: { settingsVersion: version, revision: 8, settings: legacy },
        other: { settingsVersion: version, revision: 3, settings: legacy },
      } }));
      const bytes = fs.readFileSync(file);
      const loaded = loadAutomationSettings('fuel', { file });
      assert.deepEqual(loaded.settings, expected);
      assert.deepEqual(importAutomationSettings({ format: SETTINGS_FORMAT, version, settings: legacy }), expected);
      assert.deepEqual(validateSettings(legacy), expected, '旧页面仍可保存，已移除的限制不再进入当前配置');
      assert.deepEqual(fs.readFileSync(file), bytes, '读取不会隐式写盘');
      assert.deepEqual(legacy, before, '迁移不修改传入对象');
      const saved = saveAutomationSettings('fuel', legacy, { file, revision: loaded.revision });
      assert.equal(saved.revision, 9);
      assert.deepEqual(loadAutomationSettings('fuel', { file }).settings, expected);
      assert.deepEqual(exportAutomationSettings(legacy).settings, expected);
      assert.deepEqual(importAutomationSettings(exportAutomationSettings(saved.settings)), expected);
      const store = JSON.parse(fs.readFileSync(file));
      assert.equal(store.accounts.fuel.settingsVersion, SETTINGS_SCHEMA_VERSION);
      assert.deepEqual(store.accounts.other.settings, before, '保存一个账号不改写其他账号');
    }
    for (const [group, fields] of Object.entries(retired)) for (const field of Object.keys(fields)) {
      assert(!Object.hasOwn(defaultSettings()[group], field));
      assert(!Object.hasOwn(settingsUiRules().numbers, group + '.' + field));
    }
    for (let index = 0; index < 3; index++) {
      assert(!Object.hasOwn(defaultSettings().silicon.fleets[index], 'maxRepairCost'));
      assert(!Object.hasOwn(settingsUiRules().numbers, 'silicon.fleets.' + index + '.maxRepairCost'));
    }
    const unknown = structuredClone(legacy); unknown.radar.unknownPetrolLimit = 1;
    assert.throws(() => validateSettings(unknown), error => !!error.fields?.['radar.unknownPetrolLimit']);
    const invalid = structuredClone(legacy); invalid.silicon.fleets[0].dailyAttackLimit = -1;
    assert.throws(() => validateSettings(invalid), error => !!error.fields?.['silicon.fleets.0.dailyAttackLimit']);
  });

  test('移除城战加速总开关、共享日限额和单次上限，旧文件及旧页面保留逐队和全局钻石设置', () => {
    const expected = defaultSettings();
    Object.assign(expected.resources, { allowDiamonds: true, diamondDailyLimit: 1234, diamondThreshold: 80 });
    Object.assign(expected.fleetSpeed.fleets[0], {
      repair: true, march: false,
      repairDailyDiamonds: 200, marchDailyDiamonds: 120, repairSmartSave: true,
    });
    Object.assign(expected.fleetSpeed.fleets[1], { march: true, marchDailyDiamonds: 300 });
    assert(!Object.hasOwn(defaultSettings().fleetSpeed, 'dailyDiamondLimit'));
    assert(!Object.hasOwn(settingsUiRules().numbers, 'fleetSpeed.dailyDiamondLimit'));
    for (const [enabled, dailyDiamondLimit] of [[false, 0], [false, 1], [true, 999999]]) for (const version of [1, 2, 3, 12, 16, SETTINGS_SCHEMA_VERSION]) {
      const legacy = structuredClone(expected);
      Object.assign(legacy.fleetSpeed, { enabled, dailyDiamondLimit });
      Object.assign(legacy.fleetSpeed.fleets[0], { repairMaxDiamonds: dailyDiamondLimit, marchMaxDiamonds: 10 });
      legacy.fleetSpeed.fleets[1].marchMaxDiamonds = 40;
      const before = structuredClone(legacy);
      fs.writeFileSync(file, JSON.stringify({ version, accounts: {
        speed: { settingsVersion: version, revision: 8, settings: legacy },
        other: { settingsVersion: version, revision: 3, settings: legacy },
      } }));
      const bytes = fs.readFileSync(file), loaded = loadAutomationSettings('speed', { file });
      assert.deepEqual(loaded.settings, expected);
      assert.deepEqual(importAutomationSettings({ format: SETTINGS_FORMAT, version, settings: legacy }), expected);
      assert.deepEqual(validateSettings(legacy), expected);
      assert.deepEqual(fs.readFileSync(file), bytes, '读取只在内存迁移');
      const saved = saveAutomationSettings('speed', legacy, { file, revision: loaded.revision });
      assert.equal(saved.revision, 9);
      assert.deepEqual(loadAutomationSettings('speed', { file }).settings, expected);
      assert.deepEqual(exportAutomationSettings(legacy).settings, expected);
      assert.deepEqual(importAutomationSettings(exportAutomationSettings(saved.settings)), expected);
      assert.deepEqual(migrateSettingsVersion(migrateSettingsVersion(legacy, 3), 3), expected);
      assert.deepEqual(legacy, before, '规范化不修改输入对象');
      const store = JSON.parse(fs.readFileSync(file));
      assert.equal(store.accounts.speed.settingsVersion, SETTINGS_SCHEMA_VERSION);
      assert.deepEqual(store.accounts.other.settings, before, '不改写其他账号');
    }
    const unknown = structuredClone(expected); unknown.fleetSpeed.unknownDiamondLimit = 1;
    assert.throws(() => validateSettings(unknown), error => !!error.fields?.['fleetSpeed.unknownDiamondLimit']);
    for (const mutate of [
      settings => { settings.fleetSpeed.fleets[0].repairDailyDiamonds = -1; },
      settings => { settings.resources.diamondDailyLimit = -1; },
      settings => { settings.fleetSpeed.fleets[0].repair = 'true'; },
    ]) {
      const invalid = structuredClone(expected); mutate(invalid);
      assert.throws(() => validateSettings(invalid));
      assert.throws(() => importAutomationSettings({ format: SETTINGS_FORMAT, version: 3, settings: invalid }));
    }
  });

  test('联盟求助次数补全旧配置，保留显式次数并校验边界', () => {
    const settings = defaultSettings();
    Object.assign(settings.alliance, { enabled: true, mutual: true, autoAsk: true, helpDailyLimit: 7 });
    delete settings.alliance.askDailyLimit;
    const before = structuredClone(settings);
    for (const version of [1, SETTINGS_SCHEMA_VERSION]) {
      fs.writeFileSync(file, JSON.stringify({ version: SETTINGS_SCHEMA_VERSION, accounts: {
        ask: { settingsVersion: version, settings, revision: 3 },
      } }));
      const bytes = fs.readFileSync(file);
      const loaded = loadAutomationSettings('ask', { file });
      const imported = importAutomationSettings({ format: SETTINGS_FORMAT, version, settings });
      assert.deepEqual(loaded.settings, imported);
      assert.deepEqual(loaded.settings.alliance, { ...before.alliance, askDailyLimit: 20 });
      assert.deepEqual(fs.readFileSync(file), bytes, '补全只在内存进行');
      assert.deepEqual(settings, before, '补全不修改输入');
      saveAutomationSettings('ask', loaded.settings, { file, revision: loaded.revision });
      assert.deepEqual(loadAutomationSettings('ask', { file }).settings, imported);
    }
    for (const askDailyLimit of [0, 7, 1000]) {
      const explicit = defaultSettings();
      explicit.alliance.askDailyLimit = askDailyLimit;
      assert.equal(importAutomationSettings(exportAutomationSettings(explicit)).alliance.askDailyLimit, askDailyLimit);
      const loaded = loadAutomationSettings('ask', { file });
      saveAutomationSettings('ask', explicit, { file, revision: loaded.revision });
      assert.equal(loadAutomationSettings('ask', { file }).settings.alliance.askDailyLimit, askDailyLimit);
    }
    for (const askDailyLimit of [-1, 1001, 1.5, '20', null, undefined]) {
      const invalid = defaultSettings();
      invalid.alliance.askDailyLimit = askDailyLimit;
      assert.throws(() => validateSettings(invalid), error => !!error.fields?.['alliance.askDailyLimit']);
      assert.throws(() => importAutomationSettings({ format: SETTINGS_FORMAT, version: SETTINGS_SCHEMA_VERSION, settings: invalid }),
        error => !!error.fields?.['alliance.askDailyLimit']);
    }
  });

  test('旧互助开关在读取、导入、保存和重启后始终停用，不改变新版联盟授权', () => {
    for (const version of [1, SETTINGS_SCHEMA_VERSION]) for (const enabled of [false, true]) for (const mutual of [false, true]) {
      const settings = defaultSettings();
      settings.schedule.guildAidCollect = settings.schedule.guildAidHelp = true;
      Object.assign(settings.alliance, { enabled, mutual, autoHelp: true, autoAsk: true, recruit: true, autoTech: true,
        allowedMaterials: ['木材'], stockReserve: 123, helpDailyLimit: 7 });
      const document = { format: SETTINGS_FORMAT, version, settings };
      fs.writeFileSync(file, JSON.stringify({ version: SETTINGS_SCHEMA_VERSION, accounts: {
        aid: { settingsVersion: version, settings, revision: 3 },
      } }));
      const loaded = loadAutomationSettings('aid', { file });
      for (const normalized of [loaded.settings, importAutomationSettings(document), validateSettings(settings)]) {
        assert.equal(normalized.schedule.guildAidCollect, false);
        assert.equal(normalized.schedule.guildAidHelp, false);
        assert.deepEqual(normalized.alliance, settings.alliance, '不自动开启联盟或互助，也不改已选分项和限制');
      }
      saveAutomationSettings('aid', loaded.settings, { file, revision: loaded.revision });
      const restarted = loadAutomationSettings('aid', { file }).settings;
      assert.deepEqual(restarted, loaded.settings);
      assert.equal(exportAutomationSettings(restarted).settings.schedule.guildAidHelp, false);
      assert.equal(settings.schedule.guildAidHelp, true, '规范化不修改输入对象');
    }
  });

  test('旧商人工厂任务迁移为普通建筑配置，保留原建造升级授权', () => {
    assert(!automationTasks.some(task => task.key === 'weekFactory'));
    assert(!automationControls.some(control => control.key === 'schedule.weekFactory'));
    assert(!Object.hasOwn(taskSettings({ weekFactory: true }), 'weekFactory'));
    for (const oldValue of [true, false]) {
      for (const upgrade of [true, false]) {
        const settings = defaultSettings();
        settings.schedule.weekFactory = oldValue;
        settings.building.build = false;
        settings.building.upgrade = upgrade;
        const original = structuredClone(settings);
        const imported = importAutomationSettings({ format: SETTINGS_FORMAT, version: 1, settings });
        fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: { factory: { settings, revision: 5 } } }));
        const stored = loadAutomationSettings('factory', { file });
        assert.deepEqual(settings, original);
        assert.deepEqual(stored.settings, imported);
        assert.equal(imported.building.build, false);
        assert.equal(imported.building.upgrade, upgrade);
        assert(!Object.hasOwn(imported.schedule, 'weekFactory'));
        assert(!Object.hasOwn(nativeTaskValues(imported, { weekFactory: oldValue }), 'weekFactory'));
        const saved = saveAutomationSettings('factory', imported, { file, revision: stored.revision });
        assert.equal(saved.revision, 6);
        assert.deepEqual(loadAutomationSettings('factory', { file }).settings, imported);
        assert.deepEqual(importAutomationSettings(exportAutomationSettings(imported)), imported);
      }
    }
  });
  test('版本1导入集中补全历史字段，显式选择和输入对象保持原值', () => {
    const settings = legacySettings();
    const before = structuredClone(settings);
    const document = { format: 'crazywaterword-automation', version: 1, settings };
    const migrated = importAutomationSettings(document);
    assert.deepEqual(settings, before);
    assert.equal(migrated.progression.mainline, true);
    assert.equal(migrated.schedule.radarAuto, undefined);
    assert.equal(migrated.schedule.museumExplore, undefined);
    assert.equal(migrated.radar.enabled, true);
    assert.deepEqual(migrated.radar.fleetIds, []);
    assert.equal(migrated.museum.enabled, true);
    assert(!Object.hasOwn(migrated.museum, 'claim'));
    assert(!Object.hasOwn(migrated.museum, 'explore'));
    assert.equal(migrated.building.collect, false);
    assert.equal(migrated.factory.gain, true);
    assert.equal(migrated.gather.fishing, false);
    assert.equal(migrated.factory.checkEverySeconds, 30);
    assert.deepEqual(migrated.heroRaid, { enabled: false, challenge: false, retryTimes: 10, orders: false, lottery: false, rewards: false });
    assert.deepEqual(migrated.cityWar.defenceFleetIds, []);
    const once = migrateSettingsVersion(settings, 1);
    assert.deepEqual(migrateSettingsVersion(once, 1), once);
    assert.deepEqual(importAutomationSettings(exportAutomationSettings(migrated)), migrated);
  });
  test('旧文件加载只在内存迁移，明确保存后使用原版本冲突检查', () => {
    const settings = legacySettings();
    fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: { old: { settings, revision: 7, savedAt: 'old-time' } } }));
    const bytes = fs.readFileSync(file);
    const loaded = loadAutomationSettings('old', { file });
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.equal(loaded.revision, 7);
    assert.equal(loaded.savedAt, 'old-time');
    const imported = importAutomationSettings({ format: SETTINGS_FORMAT, version: 1, settings });
    assert.deepEqual(loaded.settings, imported);
    const saved = saveAutomationSettings('old', loaded.settings, { file, revision: loaded.revision });
    assert.equal(saved.revision, 8);
    assert.deepEqual(loadAutomationSettings('old', { file }).settings, imported);
    assert.equal(JSON.parse(fs.readFileSync(file)).version, SETTINGS_SCHEMA_VERSION);
    assert.throws(() => saveAutomationSettings('old', imported, { file, revision: 7 }), /其他页面更新/);
  });
  test('旧城战共享目标迁移到防守侧，保存与导入保留顺序及独立副本', () => {
    const settings = legacySettings();
    Object.assign(settings.cityWar, {
      enabled: true, fleetIds: ['1远征船', '2远征船'], defenceFleetIds: ['2远征船'],
      targetMode: 'selected', targetPriority: 'original', cityRefs: ['1:3', '1:2'],
    });
    const before = structuredClone(settings);
    fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: { war: { settings, revision: 4 } } }));
    const bytes = fs.readFileSync(file);
    const stored = loadAutomationSettings('war', { file });
    const imported = importAutomationSettings({ format: SETTINGS_FORMAT, version: 1, settings });
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.deepEqual(stored.settings, imported);
    assert.deepEqual(settings, before);
    for (const migrated of [stored.settings, imported]) {
      assert.equal(migrated.cityWar.defenceTargetMode, 'selected');
      assert.equal(migrated.cityWar.defenceTargetPriority, 'original');
      assert.deepEqual(migrated.cityWar.defenceCityRefs, ['1:3', '1:2']);
      assert.notEqual(migrated.cityWar.defenceCityRefs, migrated.cityWar.cityRefs);
      assert.deepEqual(migrateSettingsVersion(migrated, 1), migrated);
    }
    imported.cityWar.defenceCityRefs = ['1:3'];
    imported.cityWar.targetMode = 'alliance';
    imported.cityWar.targetPriority = 'fewestAllied';
    saveAutomationSettings('war', imported, { file, revision: stored.revision });
    assert.deepEqual(loadAutomationSettings('war', { file }).settings.cityWar, imported.cityWar);
    assert.deepEqual(importAutomationSettings(exportAutomationSettings(imported)).cityWar, imported.cityWar);
  });
  test('城战迁移逐项保留显式防守配置，非法值继续拒绝', () => {
    const settings = legacySettings();
    Object.assign(settings.cityWar, {
      targetMode: 'selected', targetPriority: 'original', cityRefs: ['1:2'],
      defenceTargetMode: 'alliance', defenceCityRefs: [],
    });
    const document = { format: SETTINGS_FORMAT, version: 1, settings };
    const migrated = importAutomationSettings(document);
    assert.equal(migrated.cityWar.defenceTargetMode, 'alliance');
    assert.equal(migrated.cityWar.defenceTargetPriority, 'original');
    assert.deepEqual(migrated.cityWar.defenceCityRefs, []);
    for (const [field, value] of [['defenceTargetMode', null], ['defenceTargetPriority', 'unknown'], ['defenceCityRefs', undefined]]) {
      const invalid = structuredClone(document);
      invalid.settings.cityWar[field] = value;
      assert.throws(() => importAutomationSettings(invalid), error => !!error.fields?.['cityWar.' + field]);
    }
  });
  test('超凡英雄旧设置保留既有选择并补全挑战与转盘字段', () => {
    const settings = legacySettings();
    settings.heroRaid = { enabled: true, orders: true, rewards: false };
    const expected = { enabled: true, challenge: false, retryTimes: 10, orders: true, lottery: false, rewards: false };
    const document = { format: SETTINGS_FORMAT, version: 1, settings };
    assert.deepEqual(importAutomationSettings(document).heroRaid, expected);
    fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: { raid: { settings, revision: 3 } } }));
    const original = fs.readFileSync(file);
    assert.deepEqual(loadAutomationSettings('raid', { file }).settings.heroRaid, expected);
    assert.deepEqual(fs.readFileSync(file), original);
    for (const [field, value] of [['challenge', 'true'], ['lottery', 1], ['retryTimes', -1], ['retryTimes', 101], ['retryTimes', 1.5], ['retryTimes', null]]) {
      const invalid = structuredClone(document);
      invalid.settings.heroRaid[field] = value;
      assert.throws(() => importAutomationSettings(invalid), error => !!error.fields?.['heroRaid.' + field]);
    }
    for (const retryTimes of [0, 100]) {
      const valid = structuredClone(document);
      Object.assign(valid.settings.heroRaid, { challenge: true, lottery: true, retryTimes });
      assert.deepEqual(importAutomationSettings(valid).heroRaid, { ...expected, challenge: true, lottery: true, retryTimes });
    }
  });
  test('旧账号缺少详细设置时仍返回版本0且不会创建详细配置', () => {
    const bytes = fs.readFileSync(file);
    const loaded = loadAutomationSettings('legacy-native', { file });
    assert.equal(loaded.revision, 0);
    assert.deepEqual(loaded.settings, defaultSettings());
    assert.deepEqual(fs.readFileSync(file), bytes);
  });
  test('严格导入继续拒绝原有必填字段缺失、非法值和未知字段', () => {
    const document = () => ({ format: SETTINGS_FORMAT, version: 1, settings: legacySettings() });
    const missing = document(); delete missing.settings.factory.produce;
    assert.throws(() => importAutomationSettings(missing), error => !!error.fields?.['factory.produce']);
    const invalid = document(); invalid.settings.factory.checkEverySeconds = undefined;
    assert.throws(() => importAutomationSettings(invalid), error => !!error.fields?.['factory.checkEverySeconds']);
    const unknown = document(); unknown.settings.factory.removedField = true;
    assert.throws(() => importAutomationSettings(unknown), /不支持/);
  });
  test('版本1升级后重复迁移保持一致，保留有效的用户值', () => {
    assert.equal(SETTINGS_SCHEMA_VERSION, 18);
    const settings = legacySettings();
    settings.factory.checkEverySeconds = 270;
    settings.resources.diamondDailyLimit = 1234;
    const before = structuredClone(settings);
    const migrated = importAutomationSettings({ format: SETTINGS_FORMAT, version: 1, settings });
    assert.equal(migrated.factory.checkEverySeconds, 270);
    assert.equal(migrated.resources.diamondDailyLimit, 1234);
    assert.deepEqual(settings, before);
    assert.deepEqual(migrateSettingsVersion(migrated, 2), migrated);
    const exported = exportAutomationSettings(migrated);
    assert.equal(exported.version, SETTINGS_SCHEMA_VERSION);
    assert.deepEqual(importAutomationSettings(exported), migrated);
    assert.deepEqual(importAutomationSettings(exportAutomationSettings(importAutomationSettings(exported))), migrated);
  });
  test('旧货轮开关迁移为类型多选，保留兜底和显式空选', () => {
    const all = ['ORANGE', 'PURPLE', 'BLUE'];
    assert.deepEqual(defaultSettings().treasure.qualities, all);
    for (const version of [1, 15]) for (const flag of [true, false, undefined]) {
      const old = defaultSettings();
      delete old.treasure.qualities;
      if (flag !== undefined) old.treasure.onlyTenThousand = flag;
      Object.assign(old.treasure, { fallbackEnabled: true, fallbackQualities: ['BLUE'] });
      const expected = { ...old.treasure, qualities: flag ? ['ORANGE'] : all };
      delete expected.onlyTenThousand;
      fs.writeFileSync(file, JSON.stringify({ version, accounts: { test: { settingsVersion: version, revision: 7, settings: old } } }));
      const before = fs.readFileSync(file);
      const loaded = loadAutomationSettings('test', { file });
      assert.deepEqual(loaded.settings.treasure, expected);
      assert.deepEqual(importAutomationSettings({ format: SETTINGS_FORMAT, version, settings: old }).treasure, expected);
      assert.deepEqual(fs.readFileSync(file), before);
      const saved = saveAutomationSettings('test', loaded.settings, { file, revision: 7 });
      assert.deepEqual(loadAutomationSettings('test', { file }).settings.treasure, expected);
      assert.deepEqual(exportAutomationSettings(saved.settings).settings.treasure, expected);
      if (flag !== undefined) assert.deepEqual(validateSettings(old).treasure, expected, '已打开的旧版页面可以保存');
    }
    const both = defaultSettings();
    Object.assign(both.treasure, { onlyTenThousand: false, qualities: [] });
    assert.deepEqual(importAutomationSettings({ format: SETTINGS_FORMAT, version: 15, settings: both }).treasure.qualities, []);
    both.treasure.onlyTenThousand = 'false';
    assert.throws(() => validateSettings(both), error => !!error.fields?.['treasure.onlyTenThousand']);
  });
  test('保存一个账号不会将未迁移的其他账号误标为当前版本', () => {
    const old = { revision: 8, savedAt: 'legacy-time', settings: legacySettings() };
    const other = { revision: 12, savedAt: 'other-time', settings: legacySettings() };
    fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: { old, other } }));
    const otherBefore = loadAutomationSettings('other', { file });
    const loaded = loadAutomationSettings('old', { file });
    const saved = saveAutomationSettings('old', loaded.settings, { file, revision: loaded.revision });
    const store = JSON.parse(fs.readFileSync(file));
    assert.equal(store.version, SETTINGS_SCHEMA_VERSION);
    assert.equal(store.accounts.old.settingsVersion, SETTINGS_SCHEMA_VERSION);
    assert.equal(store.accounts.old.revision, 9);
    assert.deepEqual(store.accounts.other, other);
    assert.deepEqual(loadAutomationSettings('other', { file }), otherBefore);
    assert.deepEqual(loadAutomationSettings('old', { file }), saved);
    const bytes = fs.readFileSync(file);
    assert.throws(() => saveAutomationSettings('old', loaded.settings, { file, revision: 8 }), /其他页面更新/);
    assert.deepEqual(fs.readFileSync(file), bytes);
    saveAutomationSettings('other', otherBefore.settings, { file, revision: otherBefore.revision });
    assert.equal(JSON.parse(fs.readFileSync(file)).accounts.other.settingsVersion, SETTINGS_SCHEMA_VERSION);
  });
  test('旧配置升级后连续保存只递增revision，格式版本不随保存次数增长', () => {
    for (const version of [SETTINGS_SCHEMA_VERSION - 1, SETTINGS_SCHEMA_VERSION]) {
      const settings = defaultSettings();
      if (version < SETTINGS_SCHEMA_VERSION) delete settings.treasure.followMode;
      const other = { revision: 901, settingsVersion: version, settings: defaultSettings() };
      fs.writeFileSync(file, JSON.stringify({ version, accounts: {
        account: { revision: 244, settingsVersion: version, settings }, other,
      } }));
      for (let count = 1; count <= 40; count++) {
        const loaded = loadAutomationSettings('account', { file });
        assert.equal(loaded.revision, 244 + count - 1);
        const edited = structuredClone(loaded.settings); edited.loop.everySeconds = 30 + count;
        const saved = saveAutomationSettings('account', edited, { file, revision: loaded.revision });
        assert.equal(saved.revision, 244 + count);
        const bytes = fs.readFileSync(file), store = JSON.parse(bytes);
        assert.equal(store.version, SETTINGS_SCHEMA_VERSION, '文件格式编号不能随保存次数增长');
        assert.equal(store.accounts.account.settingsVersion, SETTINGS_SCHEMA_VERSION, '账号格式编号不能使用revision');
        assert.deepEqual(store.accounts.other, other, '保存不改其他账号的格式和修订号');
        assert.equal(exportAutomationSettings(saved.settings).version, SETTINGS_SCHEMA_VERSION);
        assert.deepEqual(loadAutomationSettings('account', { file }), saved, '重新读取保持保存值和修订号');
        assert.deepEqual(fs.readFileSync(file), bytes, '读取不能改变格式版本或修订号');
      }
      const bytes = fs.readFileSync(file);
      assert.throws(() => saveAutomationSettings('account', defaultSettings(), { file, revision: 244 }), /其他页面更新/);
      assert.deepEqual(fs.readFileSync(file), bytes, '过期修订号仍拒绝覆盖');
    }
  });
  test('当前版本缺项不能借历史迁移静默补全，旧版部分设置仍兼容', () => {
    for (const version of [2, 3, SETTINGS_SCHEMA_VERSION]) for (const remove of [
      settings => { delete settings.login; },
      settings => { delete settings.factory.checkEverySeconds; },
      settings => { delete settings.cityWar.fleetStrategies; },
      settings => { delete settings.cityWar.defenceTargetMode; },
    ]) {
      const settings = defaultSettings(); remove(settings);
      assert.throws(() => importAutomationSettings({ format: SETTINGS_FORMAT, version, settings }), /缺少/);
      assert.throws(() => importAutomationSettings({ format: SETTINGS_FORMAT, version, settings }, { partial: true }), /缺少/);
      fs.writeFileSync(file, JSON.stringify({ version, accounts: { current: { settingsVersion: version, revision: 2, settings } } }));
      const bytes = fs.readFileSync(file);
      assert.throws(() => loadAutomationSettings('current', { file }), /缺少/);
      assert.deepEqual(fs.readFileSync(file), bytes);
    }
    const settings = { loop: { everySeconds: 37 } };
    fs.writeFileSync(file, JSON.stringify({ version: 2, accounts: { legacy: { revision: 3, settings } } }));
    const migrated = loadAutomationSettings('legacy', { file }).settings;
    assert.equal(migrated.loop.everySeconds, 37);
    assert.deepEqual(migrated, validateSettings(settings, { partial: true }));
    assert.equal(migrated.factory.checkEverySeconds, defaultSettings().factory.checkEverySeconds);
  });
  test('更高合法版本先校验内容，完整兼容的配置可迁移导入且不修改输入', () => {
    const settings = defaultSettings();
    settings.resources.diamondDailyLimit = 4321;
    settings.treasure.followMode = 'eachTime';
    settings.loop.everySeconds = 91;
    for (const version of [SETTINGS_SCHEMA_VERSION + 1, SETTINGS_SCHEMA_VERSION + 100, Number.MAX_SAFE_INTEGER]) {
      const document = { format: SETTINGS_FORMAT, version, settings: structuredClone(settings) };
      const before = structuredClone(document);
      assert.deepEqual(migrateSettingsVersion(document.settings, version), settings);
      assert.deepEqual(importAutomationSettings(document), settings);
      assert.deepEqual(document, before, '高版本兼容验证不修改输入');
      fs.writeFileSync(file, JSON.stringify({ version, accounts: { newer: {
        settingsVersion: version, revision: 4, settings: structuredClone(settings), metadata: { writer: 'future' },
      } } }));
      const bytes = fs.readFileSync(file), loaded = loadAutomationSettings('newer', { file });
      assert.deepEqual(loaded.settings, settings); assert.deepEqual(fs.readFileSync(file), bytes);
      const saved = saveAutomationSettings('newer', loaded.settings, { file, revision: 4 });
      const store = JSON.parse(fs.readFileSync(file));
      assert.equal(store.version, version); assert.equal(store.accounts.newer.settingsVersion, version);
      assert.deepEqual(store.accounts.newer.metadata, { writer: 'future' });
      assert.deepEqual(saved.settings, settings);
    }
  });
  test('高版本导入报告不兼容字段，未知字段与有损规范化均不能静默丢弃', () => {
    const version = SETTINGS_SCHEMA_VERSION + 1;
    for (const [field, mutate] of [
      ['factory.newerRule', settings => { settings.factory.newerRule = true; }],
      ['resources.diamondDailyLimit', settings => { settings.resources.diamondDailyLimit = -1; }],
      ['treasure.petrolReserve', settings => { settings.treasure.petrolReserve = 100; }],
      ['fleetSpeed.fleets.0.repairMaxDiamonds', settings => { settings.fleetSpeed.fleets[0].repairMaxDiamonds = 7; }],
      ['lineups.presets.0.name', settings => { settings.lineups.presets = [{ id: 'one', name: ' 测试阵容 ',
        formation: { presetId: 1, heroPositions: [{ heroId: 'a', pos: { x: 4, y: 4 } }], petUid: '0' } }]; }],
    ]) {
      const document = { format: SETTINGS_FORMAT, version, settings: defaultSettings() }; mutate(document.settings);
      const before = structuredClone(document);
      assert.throws(() => importAutomationSettings(document), error => {
        assert.equal(error.code, 'SETTINGS_INCOMPATIBLE');
        assert.equal(error.settingsVersion, version); assert.equal(error.supportedVersion, SETTINGS_SCHEMA_VERSION);
        assert(error.fields?.[field], '缺少具体字段诊断：' + field);
        assert(error.message.includes(field)); assert(error.message.includes(String(version)));
        assert(error.message.includes(String(SETTINGS_SCHEMA_VERSION)));
        return true;
      });
      assert.deepEqual(document, before);
    }
  });
  test('非法版本值与损坏文件拒绝写入，保留原文件', () => {
    for (const version of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, '2', null]) {
      assert.throws(() => migrateSettingsVersion(defaultSettings(), version), /版本不支持/);
      assert.throws(() => importAutomationSettings({ format: SETTINGS_FORMAT, version, settings: defaultSettings() }), /版本/);
    }
    for (const content of ['{broken', JSON.stringify({ version: 0, accounts: {} }),
      JSON.stringify({ version: 2, accounts: { old: { settingsVersion: '15', revision: 0, settings: defaultSettings() } } }),
      JSON.stringify({ version: 2, accounts: { other: { settingsVersion: 1.5, revision: 0, settings: defaultSettings() } } }),
    ]) {
      fs.writeFileSync(file, content);
      assert.throws(() => loadAutomationSettings('old', { file }));
      assert.throws(() => saveAutomationSettings('old', defaultSettings(), { file, revision: 0 }));
      assert.equal(fs.readFileSync(file, 'utf8'), content);
    }
  });
  console.log(`设置版本迁移验证通过 ${passed} 项。`);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
