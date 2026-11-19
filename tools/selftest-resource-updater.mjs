// 所有远端响应为虚构 CDN 数据；临时目录、可控时钟，不使用账号或游戏网关。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createResourceUpdater } from '../src/resource-updater.mjs';
import { activeResources, resourceUpdatePolicy, resourceReadiness, assertResourcesReady } from '../src/resource-store.mjs';
import { getConfig, findConfigPack } from '../src/config.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-resource-updater-'));
const envKeys = ['CW_RESOURCE_DIR', 'CW_CONFIG_PACK', 'CW_DATA_DIR', 'CW_RESOURCE_AUTO_UPDATE', 'CW_RESOURCE_MAX_AGE_MINUTES', 'CW_RESOURCE_APP_VERSION', 'APPDATA'];
const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
process.env.CW_DATA_DIR = path.join(directory, 'accounts');
process.env.APPDATA = path.join(directory, 'client');
process.env.CW_RESOURCE_DIR = path.join(directory, 'policy-resources');
fs.mkdirSync(process.env.CW_DATA_DIR);
delete process.env.CW_CONFIG_PACK;
delete process.env.CW_RESOURCE_AUTO_UPDATE;
delete process.env.CW_RESOURCE_MAX_AGE_MINUTES;
delete process.env.CW_RESOURCE_APP_VERSION;
let sequence = 0, passed = 0;
const check = async (name, work) => { await work(); passed++; console.log('通过：' + name); };
const policy = { enabled: true, intervalMinutes: 30, appVersion: '1.14.5', disabledReason: '' };

function fixture() {
  const root = path.join(directory, 'case-' + ++sequence), calls = [], events = [];
  const f = { root, calls, events, revision: 1, release: 1, appVersion: '1.14.5', hook: null };
  const pack = () => {
    const data = { ResourceCfg: [{ id: 'GOLD', show_name: '金币' }], ItemCfg: [{ id: '汽油' }],
      ModuleOpenCfg: [{ moduleId: '世界', playerLevel: 16 }], WorldParamCfg: [{ paramName: '攻城战消耗耐久', paramValue: 100 }],
      WorldScenarioCfg: [{ id: 1 }, { id: 2 }], MarkerCfg: [{ revision: f.revision }],
      BuildingProduceCfg: [{ buildType: '工厂', itemId: '产品', unlockLevel: 1, produceTime: 60, costItem: [['木材', 1]] }],
      FarmlandPlantCfg: [{ id: '小麦', time: 60, produceNum: 5, material: ['种子', 1] }],
      MuseumExpeditionStageCfg: [{ stageId: 1, exploreTime: 60 }],
      MuseumExploreTimeFactorCfg: [{ factor: 1, playerLevel: 1 }],
      MuseumExpeditionTeamCfg: [{ teamCount: 1, playerLevel: 1 }] };
    for (const id of [1, 2]) {
      data[id + '_CityCfg'] = [{ id: 1, guildIndex: 7 }, { id: 2, guildIndex: 8 }];
      data[id + '_AttackCityConsumeCfg'] = [{ dist: 1, cost: f.revision * 0.4 }];
    }
    for (let i = 0; i < 100; i++) data['Extra' + i] = [];
    return Object.entries(data).map(([name, rows], index) => [index, name, { data: rows }]);
  };
  const map = () => [null, null, null, null, null, [[0, 'map', {
    mapInfo: { width: 2, height: 2, tileWidth: 100 * f.revision, tileHeight: 75 },
    mapData: [1, 2, 1, 2], cityInfo: { 1: { gridIdx: 0 }, 2: { gridIdx: 1 } },
  }]]];
  f.fetchImpl = async (url, options) => {
    calls.push(url); const p = new URL(url).pathname; let value;
    if (p.endsWith('version.manifest')) value = { version: f.appVersion + '.' + f.release,
      bundleVers: { config_cn: 'cfg' + f.revision, world_map: 'map' + f.revision } };
    else if (/config_cn\/config\./.test(p)) value = { packs: { abconfig: [0] }, uuids: ['abconfig'], versions: { import: [0, 'p' + f.revision] } };
    else if (/config_cn\/import\//.test(p)) value = pack();
    else if (/world_map\/config\./.test(p)) value = { paths: { 0: ['world_map1', 0], 1: ['world_map2', 0] },
      types: ['cc.JsonAsset'], uuids: ['abmap1', 'abmap2'], versions: { import: [0, 'm' + f.revision, 1, 'm' + f.revision] } };
    else if (/world_map\/import\//.test(p)) value = map();
    else throw new Error('未声明的网络请求：' + p);
    const custom = await f.hook?.(p, value, options);
    return custom ?? new Response(JSON.stringify(value));
  };
  f.updater = createResourceUpdater({ root, policy, fetchImpl: f.fetchImpl, onEvent: event => events.push(event) });
  return f;
}

try {
  await check('默认每30分钟检查，支持间隔、关闭及显式配置覆盖', () => {
    const policyFor = values => resourceUpdatePolicy({ APPDATA: process.env.APPDATA, CW_RESOURCE_DIR: process.env.CW_RESOURCE_DIR, ...values });
    assert.equal(policyFor({}).intervalMinutes, 30);
    assert.equal(policyFor({}).maxAgeMinutes, 1440);
    assert.equal(policyFor({}).versionSource, 'fallback');
    assert.equal(policyFor({ CW_RESOURCE_APP_VERSION: '1.15.0' }).versionSource, 'explicit');
    assert.equal(policyFor({ CW_RESOURCE_UPDATE_MINUTES: '60' }).intervalMinutes, 60);
    assert.equal(policyFor({ CW_RESOURCE_AUTO_UPDATE: '0' }).enabled, false);
    assert.equal(policyFor({ CW_CONFIG_PACK: 'fixed.json' }).enabled, false);
    for (const value of ['0', '-1', '1.5', 'NaN', '1441']) assert.throws(() => policyFor({ CW_RESOURCE_UPDATE_MINUTES: value }));
    assert.throws(() => policyFor({ CW_RESOURCE_APP_VERSION: '../other' }));
    for (const value of ['0', '-1', '1.5', 'NaN', '10081']) assert.throws(() => policyFor({ CW_RESOURCE_MAX_AGE_MINUTES: value }));
  });
  await check('默认更新器每次发现客户端分支，切换后保存来源且无客户端时沿用已知分支', async () => {
    const f = fixture(); process.env.CW_RESOURCE_DIR = f.root;
    let discovered = { appVersion: '1.14.5', source: 'wechat-package-cdn', packageVersion: 76 }, discoveries = 0;
    const updater = createResourceUpdater({ root: f.root, fetchImpl: f.fetchImpl,
      resolveVersion: async () => { discoveries++; return discovered; } });
    assert.equal((await updater.check()).status, 'updated');
    f.appVersion = '1.15.0'; f.release = f.revision = 2;
    discovered = { appVersion: f.appVersion, source: 'wechat-cache', packageVersion: 77 };
    assert.equal((await updater.check()).status, 'updated');
    assert.equal(discoveries, 2);
    assert(f.calls.some(url => url.endsWith('/1.15.0/version.manifest')));
    assert.equal(updater.view().appVersion, '1.15.0');
    assert.equal(updater.view().versionSource, 'wechat-cache');
    assert.equal(updater.view().sourcePackageVersion, 77);
    assert.equal(updater.view().protocolDownload, false);
    assert.deepEqual(updater.view().updates, ['config_cn', 'world_map']);
    const record = JSON.parse(fs.readFileSync(path.join(f.root, 'check.json')));
    assert.equal(record.appVersion, '1.15.0'); assert.equal(record.sourcePackageVersion, 77);
    discovered = null;
    assert.equal((await updater.check()).status, 'current');
    assert.equal(updater.view().versionSource, 'last-known');
    assert.equal(discoveries, 3);
    await updater.stop(); await f.updater.stop();
  });
  await check('新包版本发现失败不会请求旧分支并冒称 current，重启仍阻止旧资源', async () => {
    const f = fixture(); process.env.CW_RESOURCE_DIR = f.root; await f.updater.check();
    const old = activeResources({ root: f.root }), calls = f.calls.length;
    const updater = createResourceUpdater({ root: f.root, fetchImpl: f.fetchImpl,
      resolveVersion: async () => { throw new Error('new appConfig unavailable'); } });
    assert.equal((await updater.check()).status, 'error');
    assert.equal(f.calls.length, calls);
    assert.equal(activeResources({ root: f.root }).generation, old.generation);
    assert.equal(resourceReadiness({ root: f.root }).ready, false);
    assert.match(resourceReadiness({ root: f.root }).reason, /无法确认最新客户端/);
    await updater.stop();
    const restarted = createResourceUpdater({ root: f.root, fetchImpl: f.fetchImpl,
      resolveVersion: async () => { throw new Error('still unavailable'); } });
    assert.equal(restarted.view().ready, false);
    await restarted.stop(); await f.updater.stop();
  });
  await check('自动发现的旧客户端缓存不能降低已经保存的新分支', async () => {
    const f = fixture(); process.env.CW_RESOURCE_DIR = f.root;
    f.appVersion = '1.15.10';
    let discovered = { appVersion: f.appVersion, source: 'wechat-cache', packageVersion: 78 };
    const updater = createResourceUpdater({ root: f.root, fetchImpl: f.fetchImpl,
      resolveVersion: async () => discovered });
    try {
      assert.equal((await updater.check()).status, 'updated');
      const active = fs.readFileSync(path.join(f.root, 'active.json')), calls = f.calls.length;
      discovered = { appVersion: '1.15.9', source: 'wechat-cache', packageVersion: 77 };
      assert.equal((await updater.check()).status, 'current');
      assert.equal(f.calls.length, calls + 1);
      assert(f.calls.at(-1).endsWith('/1.15.10/version.manifest'));
      assert.equal(updater.view().appVersion, '1.15.10');
      assert.equal(updater.view().versionSource, 'last-known');
      assert.equal(updater.view().sourcePackageVersion, 78);
      assert.equal(resourceUpdatePolicy().appVersion, '1.15.10');
      assert.deepEqual(fs.readFileSync(path.join(f.root, 'active.json')), active);
    } finally { await updater.stop(); await f.updater.stop(); }
  });
  await check('新分支已经发现但清单失败时先持久化待更新目标，执行侧不能回落旧分支', async () => {
    const f = fixture(); process.env.CW_RESOURCE_DIR = f.root; await f.updater.check();
    f.hook = () => { throw new Error('manifest unavailable'); };
    const updater = createResourceUpdater({ root: f.root, fetchImpl: f.fetchImpl,
      resolveVersion: async () => ({ appVersion: '1.15.0', source: 'wechat-package-cdn', packageVersion: 77 }) });
    assert.equal((await updater.check()).status, 'error');
    assert.equal(resourceUpdatePolicy().appVersion, '1.15.0');
    assert.equal(resourceReadiness({ root: f.root }).ready, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'check.json'))).sourcePackageVersion, 77);
    await updater.stop(); await f.updater.stop();
  });
  await check('显式客户端版本跳过自动发现并使用指定清单', async () => {
    const f = fixture(); process.env.CW_RESOURCE_DIR = f.root;
    process.env.CW_RESOURCE_APP_VERSION = f.appVersion = '1.16.0';
    const updater = createResourceUpdater({ root: f.root, fetchImpl: f.fetchImpl,
      resolveVersion: async () => assert.fail('explicit version must not discover') });
    try {
      assert.equal((await updater.check()).status, 'updated');
      assert.equal(updater.view().versionSource, 'explicit');
      assert(f.calls[0].endsWith('/1.16.0/version.manifest'));
    } finally { delete process.env.CW_RESOURCE_APP_VERSION; await updater.stop(); await f.updater.stop(); }
  });
  await check('用户显式指定较旧分支时仍按手动选择下载，不被自动防降级覆盖', async () => {
    const f = fixture(); process.env.CW_RESOURCE_DIR = f.root;
    f.appVersion = '1.16.0';
    const automatic = createResourceUpdater({ root: f.root, fetchImpl: f.fetchImpl,
      resolveVersion: async () => ({ appVersion: '1.16.0', source: 'wechat-cache', packageVersion: 80 }) });
    let explicit;
    try {
      assert.equal((await automatic.check()).status, 'updated');
      process.env.CW_RESOURCE_APP_VERSION = f.appVersion = '1.15.0';
      explicit = createResourceUpdater({ root: f.root, fetchImpl: f.fetchImpl,
        resolveVersion: async () => assert.fail('explicit version must not discover') });
      assert.equal((await explicit.check()).status, 'updated');
      assert.equal(activeResources({ root: f.root }).appVersion, '1.15.0');
      assert.equal(explicit.view().versionSource, 'explicit');
      assert.equal(resourceUpdatePolicy().appVersion, '1.15.0');
    } finally { delete process.env.CW_RESOURCE_APP_VERSION; await explicit?.stop(); await automatic.stop(); await f.updater.stop(); }
  });
  await check('自定义资源目录的已知版本独立于进程默认目录', async () => {
    const f = fixture();
    process.env.CW_RESOURCE_DIR = path.join(directory, 'unused-global-root');
    f.appVersion = '1.17.0';
    fs.mkdirSync(f.root, { recursive: true });
    fs.writeFileSync(path.join(f.root, 'check.json'), JSON.stringify({ version: 1, appVersion: f.appVersion }));
    const updater = createResourceUpdater({ root: f.root, fetchImpl: f.fetchImpl, resolveVersion: async () => null });
    assert.equal(updater.view().appVersion, '1.17.0');
    assert.equal(updater.view().versionSource, 'last-known');
    assert.equal((await updater.check()).status, 'updated');
    assert(f.calls[0].endsWith('/1.17.0/version.manifest'));
    assert.equal(resourceReadiness({ root: f.root }).ready, true);
    assert.doesNotThrow(() => assertResourcesReady({ root: f.root }));
    await updater.stop(); await f.updater.stop();
  });
  await check('无微信缓存可首次下载配置和两张地图，版本不变只取清单', async () => {
    const f = fixture(); process.env.CW_RESOURCE_DIR = f.root;
    assert.equal((await f.updater.check()).status, 'updated');
    assert.equal(f.calls.length, 6);
    const active = activeResources(), config = getConfig();
    assert.equal(findConfigPack(), active.configFile); assert.equal(config.tables.MarkerCfg.data[0].revision, 1);
    assert.equal(config.resources.generation, active.generation);
    assert.equal((await f.updater.check()).status, 'current'); assert.equal(f.calls.length, 7);
    assert.equal(f.events.filter(event => event.level === 'info').length, 1);
    await f.updater.stop();
  });
  await check('仅发布清单变化时不重复下载，更新发布版本记录', async () => {
    const f = fixture(); process.env.CW_RESOURCE_DIR = f.root;
    await f.updater.check(); const before = activeResources({ root: f.root }), beforeConfig = getConfig();
    f.release = 2; assert.equal((await f.updater.check()).version, '1.14.5.2');
    const after = activeResources({ root: f.root }); assert.equal(after.generation, before.generation);
    assert.equal(after.version, '1.14.5.2'); assert.equal(f.calls.length, 7);
    assert.equal(getConfig().resources.version, '1.14.5.2');
    assert.notEqual(getConfig(), beforeConfig);
    await f.updater.stop();
  });
  await check('旧CDN清单不能降低已启用发布版本，也不能延长旧清单验证时间', async () => {
    const f = fixture(); let time = Date.now(); f.release = 10;
    const updater = createResourceUpdater({ root: f.root, policy, fetchImpl: f.fetchImpl, now: () => time });
    try {
      assert.equal((await updater.check()).status, 'updated');
      const active = fs.readFileSync(path.join(f.root, 'active.json'));
      const checked = fs.readFileSync(path.join(f.root, 'check.json'));
      for (const revision of [1, 2]) {
        f.release = 9; f.revision = revision; time += 60000;
        const calls = f.calls.length;
        assert.equal((await updater.check()).status, 'error');
        assert.equal(f.calls.length, calls + 1, '旧发布的相同或不同资源哈希都不能触发下载');
        assert.deepEqual(fs.readFileSync(path.join(f.root, 'active.json')), active);
        assert.deepEqual(fs.readFileSync(path.join(f.root, 'check.json')), checked);
      }
    } finally { await updater.stop(); await f.updater.stop(); }
  });
  await check('已发现但尚未下载的较新发布不能被旧清单遗忘或重新验证', async () => {
    const f = fixture(); let time = Date.now(); f.release = 10;
    const updater = createResourceUpdater({ root: f.root, policy, fetchImpl: f.fetchImpl, now: () => time });
    try {
      await updater.check();
      f.release = 12; f.revision = 2; time += 60000;
      f.hook = p => p.includes('/abmap2.') ? new Response('unavailable', { status: 503 }) : undefined;
      assert.equal((await updater.check()).status, 'error');
      const active = fs.readFileSync(path.join(f.root, 'active.json'));
      const checked = fs.readFileSync(path.join(f.root, 'check.json'));
      assert.equal(JSON.parse(checked).required.version, '1.14.5.12');
      f.hook = null; f.release = 11; f.revision = 1; time += 60000;
      const calls = f.calls.length;
      assert.equal((await updater.check()).status, 'error');
      assert.equal(f.calls.length, calls + 1);
      assert.deepEqual(fs.readFileSync(path.join(f.root, 'active.json')), active);
      assert.deepEqual(fs.readFileSync(path.join(f.root, 'check.json')), checked);
      assert.equal(updater.view().requiredVersion, '1.14.5.12');
      assert.equal(updater.view().ready, false);
    } finally { await updater.stop(); await f.updater.stop(); }
  });
  await check('更新只发布完整配置地图，新旧任务的配置与地图快照各自一致', async () => {
    const f = fixture(); process.env.CW_RESOURCE_DIR = f.root;
    await f.updater.check(); const old = getConfig();
    const { loadMapAsset } = await import('../src/world.mjs');
    const oldMap = await loadMapAsset(1, old.resources); assert.equal(oldMap.tileWidth, 100);
    f.revision = f.release = 2; await f.updater.check(); const current = getConfig();
    assert.notStrictEqual(current, old); assert.equal(old.tables.MarkerCfg.data[0].revision, 1);
    assert.equal(current.tables.MarkerCfg.data[0].revision, 2);
    assert.equal((await loadMapAsset(1, current.resources)).tileWidth, 200);
    assert.equal((await loadMapAsset(1, old.resources)).tileWidth, 100);
    assert.throws(() => assertResourcesReady({ root: f.root, policy, resources: old.resources }), /重新规划/);
    assert.equal(assertResourcesReady({ root: f.root, policy, resources: current.resources }).ready, true);
    assert(fs.existsSync(old.resources.configFile)); await f.updater.stop();
  });
  await check('第二张地图下载失败不启用半套版本，下次检查可恢复', async () => {
    const f = fixture(); process.env.CW_RESOURCE_DIR = f.root;
    await f.updater.check(); const before = fs.readFileSync(path.join(f.root, 'active.json'));
    const old = getConfig();
    f.revision = f.release = 2;
    f.hook = p => p.includes('/abmap2.') ? new Response('unavailable', { status: 503 }) : undefined;
    assert.equal((await f.updater.check()).status, 'error');
    assert.deepEqual(fs.readFileSync(path.join(f.root, 'active.json')), before);
    assert.equal(f.updater.view().ready, false);
    assert.equal(f.updater.view().requiredVersion, '1.14.5.2');
    assert.throws(() => getConfig(), error => error.code === 'RESOURCE_STALE');
    assert.equal(getConfig({ allowStale: true }), old);
    // A new updater with no network still remembers the failed upgrade.
    const restarted = createResourceUpdater({ root: f.root, policy,
      fetchImpl: async () => { throw new Error('offline after restart'); } });
    try {
      await restarted.check();
      assert.equal(restarted.view().ready, false);
      assert.throws(() => assertResourcesReady({ root: f.root, policy }), /1\.14\.5\.2/);
    } finally { await restarted.stop(); }
    f.hook = null; assert.equal((await f.updater.check()).status, 'updated');
    assert.equal(activeResources({ root: f.root }).version, '1.14.5.2');
    assert.equal(f.updater.view().ready, true); assert.equal(getConfig().tables.MarkerCfg.data[0].revision, 2);
    await f.updater.stop();
  });
  await check('短暂清单失败允许已验证资源，超过有效期暂停，恢复检查自动解除', async () => {
    const f = fixture(); let time = Date.now();
    const updater = createResourceUpdater({ root: f.root, policy, fetchImpl: f.fetchImpl, now: () => time });
    try {
      await updater.check(); assert.equal(updater.view().ready, true);
      const verifiedAt = updater.view().lastVerifiedAt;
      f.hook = () => { throw new Error('offline'); };
      time += 30 * 60000;
      await updater.check(); assert.equal(updater.view().ready, true);
      assert.equal(updater.view().lastVerifiedAt, verifiedAt);
      time += 24 * 60 * 60000;
      await updater.check(); assert.equal(updater.view().ready, false);
      assert.throws(() => assertResourcesReady({ root: f.root, policy, now: time }), /超过 1440 分钟/);
      f.hook = null; await updater.check();
      assert.equal(updater.view().ready, true); assert.notEqual(updater.view().lastVerifiedAt, verifiedAt);
    } finally { await updater.stop(); await f.updater.stop(); }
  });
  await check('首次验证失败、客户端改变或检查记录损坏均不能静默使用旧配置', async () => {
    const f = fixture();
    f.hook = () => { throw new Error('offline'); };
    await f.updater.check();
    assert.equal(f.updater.view().ready, false);
    f.hook = null; await f.updater.check();
    assert.equal(resourceReadiness({ root: f.root, policy: { ...policy, appVersion: '1.15.0' } }).ready, false);
    fs.writeFileSync(path.join(f.root, 'check.json'), '{broken');
    assert.throws(() => assertResourcesReady({ root: f.root, policy }), /记录损坏/);
    await f.updater.check(); assert.equal(f.updater.view().ready, true);
    await f.updater.stop();
  });
  await check('畸形清单、路径、配置、费用及地图不被启用', async () => {
    const corruptions = [
      (p, v) => { if (p.endsWith('manifest')) v.version = '2.0.0.1'; },
      (p, v) => { if (p.endsWith('manifest')) v.bundleVers.config_cn = '../../other'; },
      (p, v) => { if (p.includes('config_cn/config.')) v.versions.import = []; },
      (p, v) => { if (p.includes('config_cn/import/')) v.length = 0; },
      (p, v) => { if (p.includes('config_cn/import/')) v.find(row => row[1] === '2_AttackCityConsumeCfg')[2].data[0].cost = -1; },
      (p, v) => { if (p.includes('world_map/config.')) delete v.paths[1]; },
      (p, v) => { if (p.includes('world_map/import/')) v[5][0][2].mapData.pop(); },
      (p, v) => { if (p.includes('world_map/import/')) delete v[5][0][2].cityInfo[2]; },
    ];
    for (const corrupt of corruptions) {
      const f = fixture(); f.hook = corrupt;
      assert.equal((await f.updater.check()).status, 'error');
      assert.equal(activeResources({ root: f.root }), null); await f.updater.stop();
    }
  });
  await check('超大响应、坏JSON及网络失败均保留原有效版本', async () => {
    for (const response of [() => new Response('{}', { headers: { 'content-length': '999999999' } }),
      () => new Response('invalid json'), () => { throw new Error('network offline'); }]) {
      const f = fixture(); await f.updater.check(); const before = activeResources({ root: f.root }).generation;
      f.hook = response; assert.equal((await f.updater.check()).status, 'error');
      assert.equal(activeResources({ root: f.root }).generation, before); await f.updater.stop();
    }
  });
  await check('关键消费字段缺失、类型错误或负数时阻止切换，修复后重试启用', async () => {
    for (const corrupt of [
      rows => { delete rows.find(row => row[1] === 'BuildingProduceCfg')[2].data[0].produceTime; },
      rows => { rows.find(row => row[1] === 'FarmlandPlantCfg')[2].data[0].material[1] = -1; },
      rows => { rows.find(row => row[1] === 'MuseumExploreTimeFactorCfg')[2].data[0].factor = '3'; },
      rows => { rows.splice(rows.findIndex(row => row[1] === 'MuseumExpeditionStageCfg'), 1); },
    ]) {
      const f = fixture(); await f.updater.check();
      const before = activeResources({ root: f.root }).generation;
      f.revision = f.release = 2;
      f.hook = (url, value) => { if (url.includes('config_cn/import/')) corrupt(value); };
      assert.equal((await f.updater.check()).status, 'error');
      assert.equal(activeResources({ root: f.root }).generation, before);
      f.hook = null;
      assert.equal((await f.updater.check()).status, 'updated');
      await f.updater.stop();
    }
  });
  await check('同一检查合并并发请求，停止后不发布迟到的下载', async () => {
    const f = fixture(); let release;
    const gate = new Promise(resolve => { release = resolve; });
    f.hook = async p => { if (p.endsWith('manifest')) await gate; };
    const one = f.updater.check(), two = f.updater.check(); assert.strictEqual(one, two);
    const stopping = f.updater.stop(); release(); await stopping;
    assert.equal((await one).status, 'stopped'); assert.equal(f.calls.length, 1);
    assert.equal(activeResources({ root: f.root }), null);
    assert.equal((await f.updater.check()).status, 'disabled');
  });
  await check('文件损坏时即使版本号未变也重新下载修复', async () => {
    const f = fixture(); await f.updater.check(); const before = activeResources({ root: f.root });
    fs.writeFileSync(before.configFile, '{}');
    assert.equal((await f.updater.check()).status, 'updated');
    assert.notEqual(activeResources({ root: f.root }).generation, before.generation); await f.updater.stop();
  });
  await check('定时器按30分钟触发，失败仍安排重试，关闭后取消定时器', async () => {
    const f = fixture(); let time = Date.UTC(2026, 10, 13), timer, canceled = 0;
    const updater = createResourceUpdater({ root: f.root, policy, fetchImpl: f.fetchImpl, now: () => time,
      setTimer: (fn, ms) => (timer = { fn, ms, unref() {} }), clearTimer: () => { canceled++; } });
    await updater.start(); assert.equal(timer.ms, 30 * 60000);
    assert.equal(updater.view().nextCheckAt, new Date(time + 30 * 60000).toISOString());
    f.revision = f.release = 2; time += timer.ms; await timer.fn();
    assert.equal(updater.view().version, '1.14.5.2');
    f.hook = () => { throw new Error('offline'); }; time += timer.ms; await timer.fn();
    assert.equal(updater.view().status, 'error'); assert(updater.view().nextCheckAt);
    await updater.stop(); assert.equal(canceled, 1); assert.equal(updater.view().nextCheckAt, null);
    await timer.fn(); assert.equal(canceled, 1); await f.updater.stop();
  });
  await check('关闭或显式指定配置时不发起任何远程请求', async () => {
    const f = fixture(); process.env.CW_RESOURCE_DIR = f.root; await f.updater.check();
    const file = path.join(directory, 'override.json'); fs.writeFileSync(file, '[]'); process.env.CW_CONFIG_PACK = file;
    try {
      assert.equal(activeResources(), null); assert.equal(findConfigPack(), file);
      const updater = createResourceUpdater({ root: f.root, policy: resourceUpdatePolicy(process.env), fetchImpl: () => { throw new Error('不应下载'); } });
      await updater.start(); assert.equal((await updater.check()).status, 'disabled'); await updater.stop();
    } finally { delete process.env.CW_CONFIG_PACK; await f.updater.stop(); }
  });
  await check('控制台启动、状态接口和关闭接入更新器，无需游戏账号', async () => {
    const f = fixture(); process.env.CW_RESOURCE_DIR = f.root;
    const { createConsole } = await import('./fixtures/console-server.mjs');
    const app = createConsole({ port: 0, resourceUpdater: f.updater, protocol: {} });
    try {
      const url = await app.listen(); const response = await fetch(url + '/api/resources'); const view = await response.json();
      assert.equal(response.status, 200); assert.equal(view.enabled, true); assert.equal(view.intervalMinutes, 30);
      assert.equal(view.version, '1.14.5.1'); assert(view.lastCheckedAt); assert(view.nextCheckAt);
      assert.equal(view.protocol.automaticDownload, false);
      f.revision = 2; f.release = 2;
      const checked = await fetch(url + '/api/resources/check', { method: 'POST' });
      const refreshed = await checked.json();
      assert.equal(checked.status, 200);
      assert.equal(refreshed.result.status, 'updated');
      assert.equal(refreshed.version, '1.14.5.2');
      assert.equal(app.sessions.size, 0);
    } finally { app.server.closeAllConnections(); await app.close(); }
    assert.equal(f.updater.view().status, 'stopped'); assert.equal(f.updater.view().nextCheckAt, null);
  });
} finally {
  for (const key of envKeys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  fs.rmSync(directory, { recursive: true, force: true });
}
console.log('远程资源更新专项 ' + passed + '/' + passed + ' 通过');
