// Synthetic settings and a temporary ledger only; no account or game connection.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultSettings, hasExtraWork, importAutomationSettings, exportAutomationSettings,
  loadAutomationSettings, saveAutomationSettings, validateSettings, SETTINGS_FORMAT } from '../src/automation-settings.mjs';
import { automationControlView, setAutomationControl } from '../src/automation-controls.mjs';
import { validateRuntimeSettings } from '../src/settings-runtime.mjs';
import { dispatchOrder, dispatchReservationReason, reserveDispatch, fleetRecordReason, fleetDispatchView } from '../src/fleet-availability.mjs';
import { pendingPetrol } from '../src/dispatch-preview.mjs';
import { resourceFieldTargets } from '../src/resource-field-allocation.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-resource-field-settings-'));
const file = path.join(directory, 'settings.json');
let passed = 0;
function test(name, run) { run(); passed++; console.log('通过：' + name); }
try {
  test('新账号资源田关闭且没有默认派遣舰队', () => {
    const s = defaultSettings();
    assert.equal(s.resourceFields.enabled, false);
    assert.equal(s.resourceFields.refillAfterLoss, false);
    assert.deepEqual(s.resourceFields.fleetIds, []);
    assert.equal(s.resourceFields.checkEverySeconds, 60);
    assert.deepEqual(resourceFieldTargets(s.resourceFields, 10), { 汽油: 3, 种子: 1, 公会科技点: 6 });
    assert.equal(dispatchOrder(s).at(-1), 'resourceFields');
    assert.equal(automationControlView(s).find(c => c.key === 'resourceFields.enabled').configTarget, 'resourceFields');
  });
  test('版本11加载与导入关闭资源田，保留原顺序和其他账号文件', () => {
    const old = defaultSettings(); delete old.resourceFields;
    old.fleetDispatch.priority = old.fleetDispatch.priority.filter(k => k !== 'resourceFields').reverse();
    old.radar.checkEverySeconds = 42;
    fs.writeFileSync(file, JSON.stringify({ version: 11, accounts: { old: { revision: 5, settingsVersion: 11, settings: old } } }));
    const bytes = fs.readFileSync(file), loaded = loadAutomationSettings('old', { file });
    assert.equal(loaded.settings.resourceFields.enabled, false);
    assert.equal(loaded.settings.radar.checkEverySeconds, 42);
    assert.deepEqual(loaded.settings.fleetDispatch.priority, [...old.fleetDispatch.priority, 'resourceFields']);
    assert.deepEqual(importAutomationSettings({ format: SETTINGS_FORMAT, version: 11, settings: old }), loaded.settings);
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert(!Object.hasOwn(old, 'resourceFields'));
  });
  test('版本14的优先资源获得更高权重，保留其他资源、已选舰队和检查间隔', () => {
    for (const [key, preferredResource] of [['fuel','汽油'], ['seeds','种子'], ['tech','公会科技点']]) {
      const legacy = defaultSettings();
      legacy.resourceFields = { enabled: true, preferredResource, fleetIds: ['1远征船'], minDurabilityPercent: 90,
        reserveFleetCount: 0, minLevel: 2, checkEverySeconds: 300 };
      const before = structuredClone(legacy);
      fs.writeFileSync(file, JSON.stringify({ version: 14, accounts: { legacy: { settingsVersion: 14, revision: 7, settings: legacy } } }));
      const bytes = fs.readFileSync(file);
      const { settings: loaded } = loadAutomationSettings('legacy', { file });
      assert.equal(loaded.resourceFields.allocationMode, 'ratio');
      assert.deepEqual(loaded.resourceFields.ratios, { fuel: 1, seeds: 1, tech: 1, [key]: 3 });
      assert.equal(loaded.resourceFields.checkEverySeconds, 300);
      assert.deepEqual(loaded.resourceFields.fleetIds, ['1远征船']);
      assert.equal(loaded.resourceFields.enabled, true);
      assert.equal(loaded.resourceFields.refillAfterLoss, false);
      assert.deepEqual(importAutomationSettings({ format: SETTINGS_FORMAT, version: 14, settings: legacy }), loaded);
      assert.deepEqual(validateSettings(legacy), loaded);
      assert.deepEqual(fs.readFileSync(file), bytes);
      assert.deepEqual(legacy, before);
    }
  });
  test('早期版本15缺少失地补齐开关时默认关闭，保留已有配额与舰队策略', () => {
    const legacy = defaultSettings();
    Object.assign(legacy.resourceFields, { enabled: true, allocationMode: 'quota', quotas: { fuel: 0, seeds: 2, tech: 4 }, fleetIds: ['2远征船'] });
    delete legacy.resourceFields.refillAfterLoss;
    fs.writeFileSync(file, JSON.stringify({ version: 15, accounts: { legacy: { settingsVersion: 15, revision: 4, settings: legacy } } }));
    const before = fs.readFileSync(file);
    const expected = structuredClone(legacy); expected.resourceFields.refillAfterLoss = false;
    assert.deepEqual(loadAutomationSettings('legacy', { file }).settings, expected);
    assert.deepEqual(importAutomationSettings({ format: SETTINGS_FORMAT, version: 15, settings: legacy }), expected);
    assert.deepEqual(validateSettings(legacy), expected);
    assert.deepEqual(fs.readFileSync(file), before);
  });
  test('相对比例忽略零权重，余位按权重从高到低分配，同权重顺序稳定', () => {
    const r = ratios => ({ allocationMode: 'ratio', ratios });
    assert.deepEqual(resourceFieldTargets(r({ fuel: 0, seeds: 1, tech: 3 }), 6), { 汽油: 0, 种子: 1, 公会科技点: 5 });
    assert.deepEqual(resourceFieldTargets(r({ fuel: 0, seeds: 1, tech: 2 }), 10), { 汽油: 0, 种子: 3, 公会科技点: 7 });
    assert.deepEqual(resourceFieldTargets(r({ fuel: 1, seeds: 2, tech: 3 }), 5), { 汽油: 0, 种子: 2, 公会科技点: 3 });
    assert.deepEqual(resourceFieldTargets(r({ fuel: 1, seeds: 1, tech: 1 }), 2), { 汽油: 1, 种子: 1, 公会科技点: 0 });
    assert.deepEqual(resourceFieldTargets(r({ fuel: 0, seeds: 0, tech: 0 }), 10), { 汽油: 0, 种子: 0, 公会科技点: 0 });
    assert.deepEqual(resourceFieldTargets(r({ fuel: 1, seeds: 2, tech: 3 }), 0), { 汽油: 0, 种子: 0, 公会科技点: 0 });
  });
  test('固定配额按配置的块数计算，保存、导出、暂停保留两套数值和舰队选择', () => {
    const s = defaultSettings();
    Object.assign(s.resourceFields, { enabled: true, refillAfterLoss: true, allocationMode: 'quota', quotas: { fuel: 0, seeds: 5, tech: 1 }, fleetIds: ['2远征船'], reserveFleetCount: 0, minLevel: 6 });
    for (const capacity of [5, 10]) assert.deepEqual(resourceFieldTargets(s.resourceFields, capacity), { 汽油: 0, 种子: 5, 公会科技点: 1 });
    assert(hasExtraWork(s));
    const saved = saveAutomationSettings('new', s, { file, revision: 0 });
    assert.deepEqual(loadAutomationSettings('new', { file }).settings.resourceFields, s.resourceFields);
    assert.deepEqual(importAutomationSettings(exportAutomationSettings(saved.settings)), s);
    const paused = setAutomationControl(s, 'resourceFields.enabled', false);
    assert.deepEqual(paused.resourceFields, { ...s.resourceFields, enabled: false });
    assert.equal(s.resourceFields.enabled, true);
  });
  test('空舰队、非法目标和参数边界不能开启自动占领', () => {
    for (const patch of [{ enabled: true }, { refillAfterLoss: 'true' }, { allocationMode: 'absolute' }, { preferredResource: '钻石' }, { fleetIds: ['not-a-fleet'] },
      { ratios: { fuel: 3, seeds: -1, tech: 6 } }, { ratios: { fuel: 3, seeds: 1, tech: 6, diamond: 1 } },
      { quotas: { fuel: 3, seeds: 1.5, tech: 6 } }, { ratios: { fuel: 0, seeds: 1 } }, { quotas: null },
      { minDurabilityPercent: 0 }, { minDurabilityPercent: 101 }, { reserveFleetCount: -1 }, { reserveFleetCount: 4 },
      { minLevel: 0 }, { checkEverySeconds: 29 }, { checkEverySeconds: 3601 }, { fleetIds: ['1远征船', '1远征船'] }]) {
      const s = defaultSettings(); Object.assign(s.resourceFields, patch);
      assert.throws(() => validateSettings(s), error => Object.keys(error.fields ?? {}).some(k => k.startsWith('resourceFields.')));
    }
    const missing = defaultSettings(); delete missing.resourceFields;
    assert.throws(() => validateSettings(missing), error => !!error.fields?.resourceFields);
    const stale = defaultSettings(); stale.resourceFields.fleetIds = ['4远征船'];
    assert.throws(() => validateRuntimeSettings(stale, { tables: { BuildingUnlockCfg: { data: [] } } }),
      error => !!error.fields?.['resourceFields.fleetIds']);
  });
  test('资源田按任务顺序预留，已派遣和待确认舰队受到共享保护', () => {
    const s = defaultSettings(), client = {}, world = '2002001001';
    s.resourceFields.enabled = true; s.resourceFields.fleetIds = ['1远征船'];
    s.fleetDispatch.priority = ['resourceFields', ...s.fleetDispatch.priority.filter(k => k !== 'resourceFields')];
    reserveDispatch(client, 'resourceFields', ['1远征船']);
    assert.match(dispatchReservationReason(client, s, 'silicon', '1远征船'), /资源田/);
    assert.equal(dispatchReservationReason(client, s, 'resourceFields', '1远征船'), '');
    const key = 'resource-field:' + world + ':123:1';
    const records = { [key]: { confirmed: true, details: { kind: 'resourceFieldDispatch', worldId: world, buildingId: '1远征船', active: true } } };
    assert.match(fleetRecordReason(records, '1远征船', world), /资源田/);
    const ledger = { keyRecords: () => records };
    const view = fleetDispatchView(client, s, ledger, [{ buildingId: '1远征船', state: 1 }], world)[0];
    assert.deepEqual(view.intents, [{ key: 'resourceFields', label: '资源田占领' }]);
    records[key].confirmed = false;
    assert.match(fleetRecordReason(records, '1远征船', world), /待确认/);
    records[key].confirmed = true; records[key].details.active = false;
    assert.equal(fleetRecordReason(records, '1远征船', world), '');
  });
  test('占田待确认汽油与其他任务一起预留', () => {
    assert.equal(pendingPetrol({ pendingCounters: () => ({ resourceFieldPetrol: 20, siliconPetrol: 30, radarPetrol: 10 }) }), 60);
  });
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
console.log('资源田策略设置 ' + passed + '/' + passed + ' 通过');
