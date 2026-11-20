import { cleanupAfterClaim } from './claim-cleanup.mjs';
import { collectAntiqueFloaters } from './antique-floaters.mjs';
import { normalize } from './worlds.mjs';
import { displayMaterial, RESOURCE } from './config.mjs';
import { budgetPreview, createActionGuard, resourceReserve, exactAutomationId, automationWireId, nativePreferenceEnabled, AutomationSkip } from './automation-policy.mjs';
import { serviceBoats } from './boats.mjs';
import { serviceCargo } from './cargo.mjs';
import { collectFloaters } from './collections.mjs';
import { fishOnce } from './fishing.mjs';
import { upgradeFishingOnce } from './fishing-upgrade.mjs';
import { readOrderReservedStock } from './order-reservations.mjs';
import { petSpendSnapshot, confirmPetSpend, petAdvanceFeedCount } from './spend-evidence.mjs';
import { goldAccountKey } from './gold-reservations.mjs';
import { readAllianceRecruitDemand } from './alliance-automation.mjs';
import { readGuildShips, guildShipDemands } from './guild-ships.mjs';
import { watchHeroRaidPushes, heroRaidDemands } from './hero-raid-automation.mjs';
import { museumExploreFactor, selectMuseumHeroes } from './museum-exploration.mjs';

const rows = (config, name) => config?.tables?.[name]?.data ?? [];
const quantities = list => (list ?? []).map(item => Array.isArray(item) ? { id: item[0], num: Number(item[1]) } : { id: item.id, num: Number(item.num) });
const validCosts = list => Array.isArray(list) && list.length > 0 && list.every(item => typeof item.id === 'string' && Number.isSafeInteger(item.num) && item.num > 0);
const resourceIds = new Set(Object.values(RESOURCE));
const stateByClient = new WeakMap();
function addBaseNote(notes, notesBySetting, setting, text) {
  notes.push(text);
  (notesBySetting[setting] ??= []).push(text);
}
function petRooms(buildings, config) {
  return (buildings ?? []).filter(b => b.level > 0 && b.petBreed &&
    (b.type ?? rows(config, 'BuildingUnlockCfg').find(row => row.buildingId === b.buildingId)?.buildingType) === '宠物培育室');
}
function petQueue(room, config) {
  const data = room.petBreed;
  const configured = rows(config, 'BuildingUpgradeCfg').find(row => row.buildingType === '宠物培育室' && row.level === room.level)?.effect?.find(row => row[0] === '培育队列')?.[1];
  if (!Number.isSafeInteger(room.level) || !Number.isSafeInteger(data.maxQLength) || data.maxQLength < 1 ||
      !Array.isArray(data.breedQ) || !Array.isArray(data.maturePets) || (configured != null && (!Number.isSafeInteger(configured) || configured < 1))) return null;
  // 客户端按建筑等级解锁队列；协议的最大长度不能越过已解锁数量。
  return { jobs: data.breedQ.length, mature: data.maturePets.length, capacity: Math.min(room.level, data.maxQLength, configured ?? room.level) };
}
function normalizeBaseReply(request, raw) {
  const value = normalize(raw);
  if (request === 'AllPetRequest') for (const [index, pet] of (value.pets ?? []).entries()) pet.uid = exactAutomationId(raw.pets[index].uid);
  if (request === 'GuildShipRequest') for (const list of ['ship', 'ownRun']) for (const [index, ship] of (value[list] ?? []).entries()) {
    for (const [cabinIndex, cabin] of (ship.cabin ?? []).entries()) if (cabin.player) cabin.player.playerId = exactAutomationId(raw[list][index].cabin[cabinIndex].player?.playerId);
  }
  return value;
}
// 客户端 WorldIdRule：百万位以上的后三位为赛季。
export function gameSeason(player) {
  const id = Number(player?.worldId?.toString?.() ?? player?.worldId);
  return Number.isSafeInteger(id) && id > 0 ? Math.floor(id / 1_000_000 % 1000) : null;
}

// 这些状态由登录后的服务器推送提供，不能根据本地配置表伪造一个“正在进行”的活动或事件。
export function watchBasePushes(client) {
  if (stateByClient.has(client)) return stateByClient.get(client);
  const state = { choices: new Map(), raids: watchHeroRaidPushes(client).raids, choiceObserved: false, invalidChoice: false };
  stateByClient.set(client, state);
  const reset=()=>{state.choices.clear();state.raids.clear();state.choiceObserved=false;state.invalidChoice=false;};
  client.on?.('login',reset);client.on?.('close',reset);
  client.on?.('message', ({ name, body }) => {
    if (name === 'SCChoiceEventUpdate') {
      state.choiceObserved = true;
      for (const raw of body?.events ?? []) {
        const uid = exactAutomationId(raw.uid);
        if (uid) state.choices.set(uid, { ...normalize(raw), uid });
        else state.invalidChoice = true;
      }
    }
  });
  return state;
}

export async function surveyBaseAutomation(client, protocol, config, player, settings, waterSurvey, { ledger, enabled = () => true } = {}) {
  const notes = [], notesBySetting = {};
  const note = (setting, text) => addBaseNote(notes, notesBySetting, setting, text);
  const state = watchBasePushes(client);
  if (state.invalidChoice) note('events.enabled', '部分随机事件的标识无法精确确认，已跳过');
  const needs = new Set(settings?.factory.demandFirst || settings?.factory.speedUpSources.length ? settings.factory.demandPriority : []);
  const get = async (request, setting, response = request.replace(/Request$/, 'Response')) => {
    if (!protocol[request] || !protocol[response]) { note(setting, `${request} 的状态接口不可用`); return null; }
    try { return normalizeBaseReply(request, await client.request(request, {}, response, 8000)); }
    catch { note(setting, `${request} 本轮未取得状态`); return null; }
  };
  const member = !!exactAutomationId(player?.guildId);
  const [museum, heroes, pets, gold, guildOrder, guildShip, radar] = await Promise.all([
    settings.museum.runEnabled !== false && (['enabled', 'upgrade', 'revenue', 'achievements', 'display'].some(key => settings.museum[key]) || needs.has('museum')) ? get('MuseumInfoRequest', 'museum') : null,
    settings.museum.runEnabled !== false && settings.museum.enabled ? get('AllHeroRequest', 'museum.enabled') : null,
    settings.pet.enabled && settings.pet.advance ? get('AllPetRequest', 'pet.advance') : null,
    settings.gold.enabled ? get('ClickGoldInfoRequest', 'gold.enabled') : null,
    member && needs.has('guildRecruit') && !settings.alliance?.enabled ? get('GuildOrderRequest', 'factory') : null,
    member && needs.has('guildShip') && !settings.guildShip?.enabled ? get('GuildShipRequest', 'factory') : null,
    needs.has('refugee') ? get('RadarInfoRequest', 'factory') : null,
  ]);
  let guildRecruitDemand = [];
  if (member && settings.alliance?.enabled && settings.alliance.recruit && settings.alliance.recruitProduction) {
    try { guildRecruitDemand = await readAllianceRecruitDemand(client, protocol, config, player, settings, { ledger, enabled }); }
    catch (error) { notes.push('联盟募兵补产：' + error.message); }
  }
  let guildShipDemand = [];
  // 红船补料有独立开关，不依赖工厂“优先需求”或需求来源排序；仍由工厂总开关决定是否生产。
  if (member && settings.guildShip?.enabled && settings.guildShip.produceMissing) {
    try { guildShipDemand = guildShipDemands(await readGuildShips(client, protocol, config, { player, getSettings: () => settings, enabled }), settings, ledger); }
    catch (error) { notes.push('联盟商船补产：' + error.message); }
  }
  return { now: waterSurvey.serverNow ?? waterSurvey.now, player, world: waterSurvey, museum, heroes: heroes?.heroes ?? [], pets: pets?.pets ?? [], gold,
    guildOrder, guildRecruitDemand, guildShip, guildShipDemand, heroRaidDemand: heroRaidDemands(client, config, player, settings, { ledger }),
    radar, choices: [...state.choices.values()], raids: [...state.raids.values()], choiceObserved: state.choiceObserved, notes, notesBySetting };
}

function museumFactor(stage, snapshot, config, settings) {
  return museumExploreFactor(stage, snapshot, config, settings);
}

function museumDispatchPreference(settings) {
  return JSON.stringify(['factorMode', 'fullRecommendedFactor', 'partialRecommendedFactor', 'noRecommendedFallback',
    'noRecommendedFactor', 'factor', 'materialFactor', 'factorMaterials', 'stockThreshold', 'matchedFactor', 'maps', 'maxDispatches']
    .map(key => settings.museum[key]));
}

function stageAvailable(stage, snapshot, config, settings) {
  const row = rows(config, 'MuseumExpeditionStageCfg').find(r => r.stageId === stage.stageId);
  if (!row || (settings.museum.maps.length && !settings.museum.maps.includes(String(stage.stageId)))) return false;
  const requirement = row.areaLevelReq ?? [];
  return !requirement.length || (snapshot.museum?.exhibitions ?? []).some(ex => ex.exhibitionId === requirement[0] && ex.level >= requirement[1]);
}

export function baseDemands(snapshot, config, settings) {
  const demands = [];
  const add = (source, requirements) => { const items = quantities(requirements); if (validCosts(items)) demands.push({ source, requirements: items }); };
  for (const stage of snapshot.museum?.exploreStages ?? []) {
    if (settings.museum.runEnabled === false || !settings.museum.enabled || stage.expedition?.endTime > 0 || !stageAvailable(stage, snapshot, config, settings)) continue;
    const { factor, costs } = museumFactor(stage, snapshot, config, settings);
    add('museum', costs.map(item => ({ ...item, num: item.num * factor })));
  }
  if (settings.museum.runEnabled !== false && settings.museum.upgrade) for (const ex of snapshot.museum?.exhibitions ?? []) {
    const next = rows(config, 'MuseumAreaCfg').find(r => r.areaId === ex.exhibitionId && r.level === ex.level + 1);
    if (next && next.playerLevelReq <= (snapshot.player?.level ?? 0)) add('museum', next.costArr);
  }
  if (settings.alliance?.enabled) demands.push(...(snapshot.guildRecruitDemand ?? []));
  else add('guildRecruit', snapshot.guildOrder?.order?.requirements);
  if (settings.guildShip?.enabled) demands.push(...(snapshot.guildShipDemand ?? []));
  else {
    const self = exactAutomationId(snapshot.player?.playerId ?? snapshot.player?.id);
    const guildShips = new Map([...(snapshot.guildShip?.ship ?? []), ...(snapshot.guildShip?.ownRun ?? [])].map(ship => [ship.shipId, ship]));
    for (const ship of guildShips.values()) if (ship.state === 1) {
      for (const cabin of ship.cabin ?? []) if (self && String(cabin.player?.playerId ?? '') === self) add('guildShip', cabin.order);
    }
  }
  for (const event of snapshot.radar?.radarInfo?.events ?? []) if (!(event.startTime > 0)) add('refugee', event.refugee?.requirements);
  if (settings.heroRaid?.enabled && settings.heroRaid.orders) demands.push(...(snapshot.heroRaidDemand ?? []));
  for (const b of snapshot.world.buildings) {
    add('petAdvance', b.petServe?.upgradeRequirements);
    if (petRooms([b], config).length) for (const job of b.petBreed.breedQ ?? []) if (job.finishTime > snapshot.now) add('petFeed', job.feedRequirements);
  }
  if (settings.factory.keepStock > 0) {
    const recipes = rows(config, 'BuildingProduceCfg').filter(r => snapshot.world.factories.some(b => b.type === r.buildType && b.level >= r.unlockLevel && !settings.factory.disabledTypes.includes(b.type)));
    add('factory', recipes.map(r => ({ id: r.itemId, num: Math.min(settings.factory.keepStock, snapshot.world.stockCap) })));
  }
  return demands;
}

export async function previewNativeAutomation(client, config, player, settings, flags, world, usage) {
  const actions = [], notes = [];
  const enabled = key => flags[key] === true && nativePreferenceEnabled(settings, key);
  const reads = new Set(['FishEncyclopediaRequest','OnWaterRequest', 'AllItemRequest', 'AllResourceRequest', 'GameEffectRequest', 'CargoShipsRequest', 'WeekInfoRequest', 'WeekOrderInfoRequest']);
  // 除 dryRun 分支外再限定请求白名单，预览路径始终不能发送游戏写入。
  const readonly = new Proxy(client, { get(target, key) {
    if (key === 'request') return (name, ...args) => {
      if (!reads.has(name)) throw new Error('只读预览不允许此游戏动作');
      return target.request(name, ...args);
    };
    if (key === 'sendWatch' || key === 'send') return () => { throw new Error('只读预览禁止发送游戏写入'); };
    const value = target[key];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const record = entry => {
    if (entry?.action) actions.push(entry.action);
    else if (entry?.reason || entry?.error) notes.push((entry.label || '采集') + '：' + (entry.reason || entry.error));
  };
  const group = async (label, action) => { try { await action(); } catch (error) { notes.push(label + '：' + error.message); } };
  if (enabled('autoFish')) await group('钓鱼', async () => record(await fishOnce(readonly, config, () => enabled('autoFish'), { dryRun: true, fishBook: settings.gather.fishBook })));
  if (enabled('fishEnhance')) await group('钓具养成', async () => record(await upgradeFishingOnce(readonly, config, { playerLevel: player?.level,
    reserveGold: settings.gather.fishingGoldReserve, targetLevel: settings.gather.targetLevel, enabled: () => enabled('fishEnhance'), dryRun: true })));
  if (['autoDive', 'autoSalvage', 'diveEnhance', 'salvageEnhance'].some(enabled)) await group('船只', () => serviceBoats(readonly, config, enabled, record, { settings, dryRun: true }));
  if (enabled('antiqueFloaters')) await group('藏品宝箱',()=>collectAntiqueFloaters(readonly,config,{enabled:()=>enabled('antiqueFloaters'),report:record,dryRun:true}));
  if (enabled('floaters')) await group('漂浮物', () => collectFloaters(readonly, config, world.floaters, enabled, record, { settings, dryRun: true }));
  if (enabled('cargo') && player?.level >= (rows(config, 'CargoUnlockCfg')[0]?.playerLevel ?? 9)) await group('贸易港', () => serviceCargo(readonly, config, {
    enabled: () => enabled('cargo'), getSettings: () => settings, ledger: { snapshot: () => usage }, dryRun: true,
    log(label, details) { if (details?.action) actions.push(details.action); else if (details?.skipped) notes.push(label); },
  }));
  if (settings.gather.keyOpen && actions.some(action => action.kind === 'autoDive') && world.have('保险箱钥匙') >= 1) {
    actions.push({ kind: 'diveKey', label: '潜水成功后使用 1 把现有保险箱钥匙', costs: [{ id: '保险箱钥匙', num: 1 }] });
  }
  return { actions, notes };
}

export function planBaseAutomation(snapshot, config, settings, usage = {}, { diveCompleted = false, petQualityOrder = 'asc' } = {}) {
  const actions = [], notes = [...snapshot.notes];
  const notesBySetting = Object.fromEntries(Object.entries(snapshot.notesBySetting ?? {}).map(([key, values]) => [key, [...values]]));
  const note = (setting, text) => addBaseNote(notes, notesBySetting, setting, text);
  const { world, now, player } = snapshot;
  const working = new Map(world.stock);
  const free = id => (working.get(id) ?? 0) - resourceReserve(settings, id);
  const add = step => {
    if ((step.costs ?? []).some(item => !Number.isSafeInteger(item.num) || item.num < 0 || free(item.id) < item.num)) { note(step.setting, `${step.label}：现有材料不足或需保留`); return false; }
    for (const item of step.costs ?? []) working.set(item.id, (working.get(item.id) ?? 0) - item.num);
    actions.push({ scope: 'base', ...step });
    return true;
  };
  if (settings.loop.world) {
    const priorities = settings.factory.demandPriority;
    if (settings.pet.enabled && settings.pet.advance && settings.factory.enabled && settings.factory.demandFirst && priorities.includes('petAdvance')) {
      const priority = source => priorities.includes(source) ? priorities.indexOf(source) : priorities.length;
      const plans = [['museum', planMuseum], ['petFeed', planQueuedPetFeeds], ['petAdvance', planPetAdvance]];
      plans.sort(([a], [b]) => priority(a) - priority(b));
      for (const [, plan] of plans) plan();
      planPets(false);
    } else {
      planMuseum();
      planPets();
      planPetAdvance();
    }
    if (settings.events.enabled) {
      if (!snapshot.choiceObserved) note('events.enabled', '随机事件：尚未收到本次连接的事件状态');
      for (const event of snapshot.choices) {
        const row = rows(config, 'EventChoiceCfg').find(r => r.eventId === event.eventId);
        const option = row?.title === '发现海上资源补给' && row.option2 === '建造居民房' ? 2 : row?.title === '居民想要离开' && row.option2 === '让他离开' ? 2 : settings.events.otherOption ?? 1;
        if (option == null) { note('events.enabled', `随机事件“${row?.title ?? event.eventId}”留待手动选择`); continue; }
        add({ kind: 'choiceEvent', setting: 'events.enabled', request: 'SelectChoiceRequest', response: 'GotRewardResponse', body: { uid: String(event.uid), optionIndex: option }, label: `${row?.title ?? '随机事件 '+event.eventId}：${row?.['option'+option] ?? '自动选择第'+option+'项'}` });
      }
    }
    if (settings.gather.enabled !== false && settings.gather.diving && settings.gather.keyOpen && diveCompleted && free('保险箱钥匙') >= 1) {
      add({ kind: 'diveKey', setting: 'gather.keyOpen', request: 'AntiqueRecruitRequest', response: 'AntiqueRecruitResponse', body: { type: 2, way: 2 },
        costs: [{ id: '保险箱钥匙', num: 1 }], label: '潜水后使用 1 把保险箱钥匙开箱' });
    }
  }
  if (settings.loop.dailies && settings.gold.enabled) planPaidGold();
  const checked = budgetPreview(actions, world.stock, settings, usage);
  for (const [setting, values] of Object.entries(checked.notesBySetting)) {
    (notesBySetting[setting] ??= []).push(...values);
  }
  return { actions: checked.actions, notes: [...notes, ...checked.notes], notesBySetting, demands: baseDemands(snapshot, config, settings),
    goldInfo: settings.loop.dailies && settings.gold.enabled ? snapshot.gold?.info : null, pendingPaidGold: usage.pendingPaidGold === true };

  function planPaidGold() {
    const target = settings.gold.times;
    if (target === 0) {
      note('gold.enabled', '付费点金：每日目标为 0 次');
      return;
    }
    const { paidTimes: paidBefore = 0, freeTimes: freeBefore = 0, maxPaidTimes, resetTime } = snapshot.gold?.info ?? {};
    const params = rows(config, 'OfflineParamCfg');
    const price = params.find(row => row.paramName === '点金价格')?.paramValue;
    const freeLimit = params.find(row => row.paramName === '免费点金次数')?.paramValue;
    if (!Number.isSafeInteger(price) || price < 1 ||
        ![freeLimit, freeBefore, paidBefore, maxPaidTimes].every(n => Number.isSafeInteger(n) && n >= 0) ||
        paidBefore > maxPaidTimes || (resetTime != null && (!Number.isSafeInteger(resetTime) || resetTime < 0))) {
      note('gold.enabled', '付费点金：未能确认当天次数和单价');
      return;
    }
    const recorded = Math.max(paidBefore, usage.counters?.goldPaidTimes ?? 0);
    if (usage.pendingPaidGold || recorded > paidBefore) {
      note('gold.enabled', `付费点金：游戏已完成 ${paidBefore} 次，已计入或预留 ${recorded} 次，等待未确认结果，不再追加`);
      return;
    }
    const remaining = Math.min(target, maxPaidTimes) - paidBefore;
    if (remaining <= 0) {
      note('gold.enabled', `付费点金：今日已付费 ${paidBefore} 次，${paidBefore >= target ? '已达到设置目标' : '已达到游戏当日上限'}`);
      return;
    }
    if (freeBefore < freeLimit) {
      note('gold.enabled', `付费点金：今日还剩 ${freeLimit - freeBefore} 次免费点金，等免费次数用完后再付费`);
      return;
    }
    const budget = settings.resources.allowDiamonds ? settings.resources.diamondDailyLimit - (usage.counters?.diamonds ?? 0) : 0;
    const affordable = Math.min(remaining, Math.floor(free('RUBY') / price), Math.floor(budget / price));
    if (!Number.isSafeInteger(affordable) || affordable < 1) {
      note('gold.enabled', '付费点金：钻石开关、保留余额或每日额度限制了本次操作');
      return;
    }
    // 客户端只提供单点和按游戏剩余次数计算的连点按钮。
    const batch = Math.min(10, maxPaidTimes - paidBefore);
    const count = affordable >= batch ? batch : 1;
    add({ kind: 'paidGold', setting: 'gold.enabled', scope: 'daily', request: 'ClickGoldRequest', response: 'ClickGoldResponse', body: { times: count, free: false },
      costs: [{ id: 'RUBY', num: count * price }], counters: { goldPaidTimes: count }, counterMinimums: { goldPaidTimes: paidBefore },
      verify: { paidBefore, freeBefore, freeLimit, maxPaidTimes, ...(resetTime != null ? { resetTime } : {}) },
      label: `付费点金 ${count} 次（今日目标 ${target}，已完成 ${paidBefore}）` });
  }

  function planMuseum() {
    const pref = settings.museum, data = snapshot.museum;
    if (pref.runEnabled === false || !['enabled', 'upgrade', 'revenue', 'achievements', 'display'].some(key => pref[key])) return;
    if (!data) { note('museum', '博物馆：本轮未取得状态，待开放或连接恢复后再检查'); return; }
    if (!data.exhibitions?.length && !data.exploreStages?.length) {
      const unlockLevels = rows(config, 'BuildingUnlockCfg').filter(row => row.buildingType === '博物馆').map(row => row.playerLevel);
      const unlockLevel = Math.min(...unlockLevels);
      if (Number.isSafeInteger(unlockLevel) && player?.level < unlockLevel) note('museum', `博物馆：角色达到 ${unlockLevel} 级后解锁`);
    }
    if (pref.revenue) {
      if (Number.isSafeInteger(data.uncollectedRevenue) && data.uncollectedRevenue > 0) {
        add({ kind: 'museumRevenue', setting: 'museum.revenue', request: 'MuseumCollectRevenueRequest', response: 'MuseumCollectRevenueResponse', body: {}, label: '领取博物馆人气币' });
      } else if (data.uncollectedRevenue !== 0) note('museum.revenue', '博物馆：未能确认待领取的人气币数量');
    }
    if (pref.achievements) {
      const claimed = new Set((data.claimedAchievements ?? []).map(Number));
      for (const row of rows(config, 'MuseumAchievementCfg')) if (!claimed.has(row.score) && Number(data.topPopularity ?? data.popularity ?? 0) >= row.score) {
        add({ kind: 'museumAchievement', setting: 'museum.achievements', request: 'MuseumClaimAchievementRequest', response: null, body: { popularityThreshold: row.score }, label: `领取博物馆人气 ${row.score} 奖励` });
      }
    }
    if (pref.enabled) {
      let guides = Math.max(0, Math.min(free('博物馆加速'), pref.dailyGuideLimit - (usage.counters?.museumGuides ?? 0)));
      for (const stage of data.exploreStages ?? []) {
        if (!(stage.expedition?.endTime > 0)) continue;
        if (stage.expedition.endTime <= now) add({ kind: 'museumComplete', setting: 'museum.enabled', request: 'MuseumCompleteExploreRequest', response: 'MuseumCompleteExploreResponse', body: { stageId: stage.stageId }, label: `领取地图 ${stage.stageId} 的探宝结果` });
        else if (pref.useGuide && guides > 0 && (!pref.maps.length || pref.maps.includes(String(stage.stageId)))) {
          const useNum = Math.min(guides, Math.ceil((stage.expedition.endTime - now) / 1800));
          guides -= useNum;
          add({ kind: 'museumGuide', setting: 'museum.useGuide', request: 'MuseumSpeedUpExploreRequest', response: 'MuseumSpeedUpExploreResponse', body: { stageId: stage.stageId, useNum },
            costs: [{ id: '博物馆加速', num: useNum }], counters: { museumGuides: useNum }, verify: { endTime: stage.expedition.endTime }, label: `地图 ${stage.stageId} 使用 ${useNum} 本探险指南` });
        }
      }
      const occupied = (data.exploreStages ?? []).filter(stage => stage.expedition?.endTime > 0);
      const maxTeams = Math.max(0, ...rows(config, 'MuseumExpeditionTeamCfg').filter(row => row.playerLevel <= (player?.level ?? 0)).map(row => row.teamCount));
      let freeTeams = Math.max(0, maxTeams - occupied.length);
      if (pref.maxDispatches > 0) freeTeams = Math.min(freeTeams, pref.maxDispatches);
      const busy = new Set(occupied.flatMap(stage => stage.expedition.heroIds ?? []));
      const candidates = (data.exploreStages ?? []).filter(stage => !(stage.expedition?.endTime > 0) && stageAvailable(stage, snapshot, config, settings))
        .map(stage => ({ stage, ...museumFactor(stage, snapshot, config, settings) })).sort((a, b) => Number(a.matched) - Number(b.matched) || a.stage.stageId - b.stage.stageId);
      for (const { stage } of candidates) {
        if (!freeTeams) break;
        const team = selectMuseumHeroes(stage, snapshot.heroes, config, busy);
        if (!team.ready) { note('museum.enabled', `地图 ${stage.stageId}：${team.reason}`); continue; }
        const { factor, costs, reason } = museumExploreFactor(stage, snapshot, config, settings, team);
        if (!(factor > 0)) { note('museum.enabled', `地图 ${stage.stageId}：${reason || '探宝倍数未解锁'}`); continue; }
        if (!validCosts(costs)) { note('museum.enabled', `地图 ${stage.stageId}：服务器尚未下发派遣材料，本轮不派遣`); continue; }
        const requirements = costs.map(item => ({ ...item, num: item.num * factor }));
        if (add({ kind: 'museumStart', setting: 'museum.enabled', request: 'MuseumStartExploreRequest', response: 'MuseumStartExploreResponse',
          body: { stageId: stage.stageId, heroIds: team.heroIds, factor }, costs: requirements,
          verify: { dispatchPreference: museumDispatchPreference(settings) }, label: `派遣地图 ${stage.stageId}，${factor} 倍探宝` })) {
          freeTeams--; for (const heroId of team.heroIds) busy.add(heroId);
        }
      }
    }
    if (pref.upgrade) for (const ex of data.exhibitions ?? []) {
      const levels = Array.from({ length: 3 }, (_, index) => Number(ex.keywordLevels?.[index] ?? 0));
      const stageRows = rows(config, 'MuseumAreaIndicatorCfg').filter(row => row.areaId === ex.exhibitionId && row.areaLevel === ex.level);
      const cap = Math.max(0, ...stageRows.map(row => row.level));
      if (!cap) { note('museum.upgrade', `展区 ${ex.exhibitionId}：缺少当前等级的技能配置`); continue; }
      if (levels.every(level => level >= cap)) {
        const next = rows(config, 'MuseumAreaCfg').find(row => row.areaId === ex.exhibitionId && row.level === ex.level + 1);
        if (!next || next.playerLevelReq > (player?.level ?? 0)) continue;
        const costs = quantities(next.costArr);
        if (!validCosts(costs)) { note('museum.upgrade', `展区 ${ex.exhibitionId}：升级消耗不明`); continue; }
        add({ kind: 'museumExhibition', setting: 'museum.upgrade', request: 'MuseumUpgradeExhibitionRequest', response: 'MuseumCaseUpdateResponse', body: { exhibitionId: ex.exhibitionId },
          costs, verify: { level: ex.level + 1 }, label: `博物馆展区 ${ex.exhibitionId} 升至 ${ex.level + 1} 级` });
      } else {
        const index = levels.indexOf(Math.min(...levels));
        const next = rows(config, 'MuseumAreaIndicatorCfg').find(row => row.areaId === ex.exhibitionId && row.level === levels[index] + 1 && row.areaLevel <= ex.level);
        if (!next?.upgradeCost) continue;
        add({ kind: 'museumKeyword', setting: 'museum.upgrade', request: 'MuseumUpgradeKeywordRequest', response: 'MuseumCaseUpdateResponse', body: { exhibitionId: ex.exhibitionId, keywordType: index + 1 },
          costs: quantities([next.upgradeCost]), verify: { index, level: levels[index] + 1 }, label: `博物馆展区 ${ex.exhibitionId} 技能 ${index + 1} 升至 ${levels[index] + 1} 级` });
      }
    }
  }

  function planRoomFeeds(room) {
    for (const job of room.petBreed.breedQ) {
      const costs = quantities(job.feedRequirements);
      if (job.finishTime > now && validCosts(costs)) add({ kind: 'petFeed', setting: 'pet.feed', request: 'PetFeedRequest', response: null, body: { jobIdx: job.idx }, costs, verify: { finishTime: job.finishTime }, label: `喂养培育队列 ${job.idx}` });
    }
  }

  function planQueuedPetFeeds() {
    if (!settings.pet.feed) return;
    for (const room of petRooms(world.buildings, config)) if (petQueue(room, config)) planRoomFeeds(room);
  }

  function planPets(includeFeed = true) {
    const pref = settings.pet;
    if (!pref.enabled) return;
    const rooms = petRooms(world.buildings, config);
    const season = gameSeason(player);
    const matureBefore = rooms.reduce((sum, room) => sum + (room.petBreed.maturePets?.length ?? 0), 0);
    let claimPlanned = false, breedPlanned = false;
    if (!rooms.length) note('pet', '海兽培育：未找到已建成的真实培育室');
    if (pref.breed && !pref.species.length) note('pet.breed', '海兽培育：请先选择培育品种，未选择时不会开始培育');
    if (matureBefore > 0 && pref.breed) note('pet.breed', pref.claim ? '海兽培育：先领取已完成海兽，确认领取后下次检查再培育' : '海兽培育：有已完成海兽待领取，自动领取已关闭，暂不继续培育');
    for (const room of rooms) {
      const data = room.petBreed;
      const queue = petQueue(room, config);
      if (!queue) { note('pet', '海兽培育：队列状态或容量未确认，等待下次检查'); continue; }
      if (pref.breed && queue.jobs >= queue.capacity) note('pet.breed', `海兽培育队列已满（${queue.jobs}/${queue.capacity}），等待完成并领取后再培育`);
      if (pref.claim && data.maturePets?.length && !claimPlanned) claimPlanned = add({ kind: 'petClaim', setting: 'pet.claim', request: 'GetMaturePetRequest', response: null, body: {}, verify: { matureBefore }, label: '领取已培育完成的海兽' });
      if (pref.feed && includeFeed) planRoomFeeds(room);
      if (pref.breed && pref.species.length && !breedPlanned && matureBefore === 0 && queue.jobs < queue.capacity) {
        if (!(season > 0)) { note('pet.breed', '海兽培育：无法确认当前赛季，本轮不开始培育'); continue; }
        const quality = ['BLUE', 'PURPLE', 'ORANGE', 'RED'];
        const candidates = rows(config, 'PetBreedCfg').filter(row => pref.species.includes(String(row.spId)) && row.season <= season && quality.includes(row.quality) && quality.indexOf(row.quality) <= quality.indexOf(pref.quality))
          .sort((a, b) => (petQualityOrder === 'desc' ? -1 : 1) * (quality.indexOf(a.quality) - quality.indexOf(b.quality)) || pref.species.indexOf(String(a.spId)) - pref.species.indexOf(String(b.spId)));
        for (const row of candidates) {
          const original = quantities(row.cost);
          if (!validCosts(original)) continue;
          const costs = original.map(item => ({ ...item }));
          let universal = false;
          const own = costs[0];
          const missing = Math.max(0, own.num - Math.max(0, free(own.id)));
          if (missing > 0 && pref.universal) {
            const name = ({ BLUE: '蓝', PURPLE: '紫', ORANGE: '橙', RED: '红' })[row.quality];
            const item = row.spId <= 3 ? `${name}宠基因自选包` : ['ORANGE', 'RED'].includes(row.quality) ? `${name}宠基因自选包2` : null;
            if (item && free(item) >= missing) { own.num -= missing; costs.push({ id: item, num: missing }); universal = true; }
          }
          if (costs.some(item => free(item.id) < item.num)) continue;
          breedPlanned = add({ kind: 'petBreed', setting: 'pet.breed', request: 'PetBreedRequest', response: null, body: { petId: row.petId, universal }, costs: costs.filter(item => item.num > 0),
            verify: { queueBefore: rooms.reduce((sum, room) => sum + (room.petBreed.breedQ?.length ?? 0), 0) },
            label: `培育${rows(config, 'PetSpeciesCfg').find(s => s.spId === row.spId)?.name ?? row.petId}（${({ BLUE: '蓝', PURPLE: '紫', ORANGE: '橙', RED: '红' })[row.quality]}）` });
          break;
        }
      }
    }
  }

  function planPetAdvance() {
    if (!settings.pet.enabled || !settings.pet.advance) return;
    const grades = rows(config, 'PetAdvancedCfg');
    const maxGrade = Math.max(...grades.map(row => row.grade));
    for (const b of world.buildings.filter(b => b.petServe?.petUid)) {
      const pet = snapshot.pets.find(p => String(p.uid) === String(b.petServe.petUid));
      if (!pet) continue;
      const required = rows(config, 'PetFeedAttrCfg').filter(row => row.level === (pet.grade ?? 0)).reduce((sum, row) => sum + (row.attrCounts ?? []).reduce((n, count) => n + count, 0), 0);
      const fed = petAdvanceFeedCount(pet);
      const grade = pet.grade ?? 0;
      const next = grades.find(row => row.grade === grade + 1);
      if ((!next && grade !== maxGrade) || !(required > 0) || fed === null) continue;
      if (fed >= required) {
        if (!next) continue;
        if (pet.level >= next.level) add({ kind: 'petAdvance', setting: 'pet.advance', request: 'PetUpgradeRequest', response: null, body: { buildingId: b.buildingId }, verify: { petUid: String(pet.uid), grade: next.grade }, label: `海兽 ${pet.petId} 进阶至 ${next.grade} 阶` });
        else note('pet.advance', `海兽 ${pet.petId} 进阶需要等级 ${next.level}`);
        continue;
      }
      const items = quantities(b.petServe.upgradeRequirements);
      if (!validCosts(items)) continue;
      const label = `海兽 ${pet.petId} 投喂进阶材料`;
      if (items.some(({ id }) => (resourceIds.has(id) ? world.resourceStockKnown : world.stockKnown) === false)) {
        note('pet.advance', `${label}：未能读取完整库存，等待重新检查`);
        continue;
      }
      const totals = new Map();
      for (const { id, num } of items) totals.set(id, (totals.get(id) ?? 0) + num);
      const costs = [...totals].map(([id, num]) => ({ id, num }));
      const missing = costs.filter(item => free(item.id) < item.num);
      if (missing.length) {
        const details = missing.map(({ id, num }) => {
          const stock = world.stock.get(id) ?? 0, used = stock - (working.get(id) ?? 0);
          const keep = resourceReserve(settings, id);
          const name = displayMaterial(config, id);
          return `${name === '未知材料' ? id : name}需要 ${num}，库存 ${stock}` +
            (used ? `，本轮已安排 ${used}` : '') + (keep ? `，设置保留 ${keep}` : '') + `，可用 ${Math.max(0, free(id))}`;
        });
        note('pet.advance', `${label}：${details.join('；')}`);
        continue;
      }
      add({ kind: 'petAdvanceFeed', setting: 'pet.advance', request: 'PetUpgradeFeedRequest', response: null, body: { buildingId: b.buildingId }, costs,
        verify: { petUid: String(pet.uid), fed, grade }, label });
    }
  }
}

export function observeBaseAutomationPlan(rewards, plan, settings, everyMs) {
  if (!rewards) return;
  const groups = {
    museum: ['runEnabled', 'enabled', 'upgrade', 'revenue', 'achievements', 'display', 'useGuide'],
    pet: ['enabled', 'claim', 'breed', 'feed', 'advance'],
    events: ['enabled'],
    gold: ['enabled'],
  };
  for (const [group, fields] of Object.entries(groups)) {
    const preferences = settings[group];
    const active = group === 'museum'
      ? preferences.runEnabled !== false && ['enabled', 'upgrade', 'revenue', 'achievements', 'display'].some(key => preferences[key])
      : preferences.enabled;
    if (!active || !(group === 'gold' ? settings.loop.dailies : settings.loop.world)) continue;
    const activeFields = fields.filter(field => (field === 'runEnabled' ? preferences[field] !== false : preferences[field] === true)
      && (field !== 'useGuide' || preferences.enabled));
    const activeKeys = activeFields.map(field => group + '.' + field);
    for (const field of activeFields) {
      const key = group + '.' + field;
      const aggregate = key === 'museum.runEnabled' || key === 'pet.enabled';
      const keys = aggregate ? activeKeys : key === 'museum.enabled' ? ['museum.enabled', 'museum.useGuide'] : [key];
      const actions = plan.actions.filter(action => keys.includes(action.setting));
      const notes = [...new Set([
        ...(plan.notesBySetting?.[group] ?? []),
        ...keys.flatMap(setting => plan.notesBySetting?.[setting] ?? []),
      ])];
      const text = actions.length ? `本次计划 ${actions.length} 项`
        : '已核对，当前无符合条件的动作' + (notes.length ? '：' + notes.join('；') : '');
      if (key === 'gold.enabled' && plan.pendingPaidGold) rewards.observe(key, text, 'pending');
      else rewards.observe(key, text);
      rewards.expect(key, rewards.now() + Math.ceil(everyMs / 1000));
    }
  }
}

async function checkPaidGoldBeforeSend(client, protocol, step, settings) {
  if (!settings.loop.dailies || !settings.gold.enabled) throw new AutomationSkip('付费点金已关闭');
  if (!protocol.ClickGoldResponse || !protocol.ClickGoldInfoRequest || !protocol.ClickGoldInfoResponse) {
    throw new AutomationSkip('当前协议无法核实点金回执和次数');
  }
  const { info } = normalize(await client.request('ClickGoldInfoRequest', {}, 'ClickGoldInfoResponse', 8000));
  const { freeLimit, paidBefore, maxPaidTimes, resetTime } = step.verify;
  const paid = info?.paidTimes ?? 0, free = info?.freeTimes ?? 0;
  if (!info || !Number.isSafeInteger(free) || free < freeLimit || paid !== paidBefore || info.maxPaidTimes !== maxPaidTimes ||
      info.resetTime !== resetTime || paid + step.body.times > settings.gold.times) {
    throw new AutomationSkip('点金次数、当日上限或重置时间已变化，等待重新规划');
  }
}

async function checkPaidGoldReceipt(client, step, body, ledger, ticket) {
  if (!Array.isArray(body?.result) || body.result.length !== step.body.times ||
      !body.result.every(row => Number.isSafeInteger(row?.gold) && row.gold > 0)) {
    return '点金奖励明细不完整，已保留本次次数与钻石额度';
  }
  ledger.markPaidGoldReward(ticket);
  const { info } = normalize(await client.request('ClickGoldInfoRequest', {}, 'ClickGoldInfoResponse', 8000));
  if (info?.resetTime !== step.verify.resetTime || !Number.isSafeInteger(info?.paidTimes) ||
      info.paidTimes < step.verify.paidBefore + step.body.times) {
    return '已收到点金奖励，付费次数尚待确认，下一轮继续核对';
  }
  return null;
}

export async function runBaseAutomation(client, protocol, config, plan, { player = null, getSettings, ledger, enabled = () => true, onStep } = {}) {
  const guard = createActionGuard(client, getSettings, ledger, { enabled, player });
  const results = [];
  if (plan.pendingPaidGold && plan.goldInfo && enabled() && ledger.reconcilePaidGold(plan.goldInfo, player ? goldAccountKey(player) : null)) {
    const row = { step: { kind: 'paidGold', setting: 'gold.enabled', label: '核对上次付费点金' }, ok: true, status: 'confirmed',
      note: `上次点金奖励及次数已确认，今日已付费 ${plan.goldInfo.paidTimes} 次` };
    results.push(row); onStep?.(row);
  }
  for (const step of plan.actions) {
    if (!enabled()) break;
    let ticket = null, choiceTicket = null, prepared = false, sent = false, writePending = false, entry, petBefore, waterSnapshot;
    try {
      const current = getSettings();
      const [group, key] = step.setting.split('.');
      if (!current[group]?.[key] || (group === 'pet' && !current.pet.enabled) || (group === 'museum' && (current.museum.runEnabled === false || key === 'useGuide' && !current.museum.enabled))) continue;
      const dispatchChanged = () => step.kind === 'museumStart' && step.verify?.dispatchPreference
        && step.verify.dispatchPreference !== museumDispatchPreference(getSettings());
      if (dispatchChanged()) throw new AutomationSkip('探宝派遣设置已变化，等待重新规划');
      if (!protocol[step.request]) throw new Error('当前协议不支持此动作');
      if (step.kind === 'museumRevenue' && !protocol.MuseumCollectRevenueResponse) throw new AutomationSkip('当前协议不能确认人气币领取');
      if (step.kind === 'museumComplete' && (!protocol.MuseumCompleteExploreResponse || !protocol.MuseumRewardRequest || !protocol.MuseumRewardResponse)) throw new Error('当前协议不能完整确认探宝结算与领奖');
      if(step.kind==='choiceEvent') {
        if(!protocol.GotRewardResponse||!ledger)throw new AutomationSkip('随机事件回执或记录不可用');
        const choiceKey='choice-event:'+step.body.uid;
        if(ledger.hasKey(choiceKey))throw new AutomationSkip('此随机事件已处理或结果待确认，不重复选择');
        choiceTicket=ledger.reserve({},{},{},{uniqueKey:choiceKey,details:{kind:'choiceEvent',eventUid:step.body.uid}});
      }
      if (step.kind === 'museumStart' && player) {
        const reserved = await readOrderReservedStock(client, protocol, config, { player, settings: current, enabled: () => enabled() && current === getSettings(), itemIds: (step.costs ?? []).map(row => row.id) });
        const costs = new Map();
        for (const cost of step.costs ?? []) {
          if (typeof cost.id !== 'string' || !Number.isSafeInteger(cost.num) || cost.num <= 0) throw new AutomationSkip('博物馆派遣消耗未确认');
          const total = (costs.get(cost.id) ?? 0) + cost.num;
          if (!Number.isSafeInteger(total)) throw new AutomationSkip('博物馆派遣消耗无法精确确认');
          costs.set(cost.id, total);
        }
        if (!costs.size || [...costs].some(([id, need]) => (reserved.available.get(id) ?? 0) < need)) throw new AutomationSkip('博物馆派遣材料不足，或已为商人订单、贸易港和居民订单预留');
      }
      if (['petBreed', 'petClaim', 'petFeed'].includes(step.kind)) {
        const fresh = normalize(await client.request('OnWaterRequest', {}, 'OnWaterResponse', 8000));
        if (!Array.isArray(fresh.building)) throw new AutomationSkip('海兽培育：未取得最新队列状态，等待下次检查');
        const rooms = petRooms(fresh.building, config), queues = rooms.map(room => petQueue(room, config));
        if (!rooms.length || queues.some(q => !q)) throw new AutomationSkip('海兽培育：真实培育室或队列容量未确认，暂不操作');
        if (step.kind !== 'petClaim') {
          petBefore = petSpendSnapshot(rooms);
          if (!petBefore) throw new AutomationSkip('海兽培育：队列身份或时间数据不完整，暂不操作');
          waterSnapshot = fresh;
        }
        const mature = queues.reduce((n, q) => n + q.mature, 0);
        if (step.kind === 'petBreed') {
          if (mature) throw new AutomationSkip('海兽培育：有已完成海兽待领取，领取确认后再培育');
          if (!queues.some(q => q.jobs < q.capacity)) throw new AutomationSkip('海兽培育队列已满，等待完成并领取后再培育');
          step.verify.queueBefore = queues.reduce((n, q) => n + q.jobs, 0);
        } else if (step.kind === 'petClaim') {
          if (!mature) throw new AutomationSkip('当前没有可领取的已完成海兽');
          step.verify.matureBefore = mature;
        } else if (!rooms.some(room => room.petBreed.breedQ.some(job => job.idx === step.body.jobIdx && job.finishTime > Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000)))) {
          throw new AutomationSkip('海兽喂养队列已变化，等待下次检查');
        }
        if (!enabled() || current !== getSettings() || !getSettings().pet.enabled || !getSettings().pet[key]) throw new AutomationSkip('海兽操作设置已变化或已暂停');
      }
      if (step.kind === 'paidGold') await checkPaidGoldBeforeSend(client, protocol, step, current);
      ticket = await guard.before(step, { waterSnapshot }); prepared = true;
      if (!enabled() || current !== getSettings()) { await guard.cancel(step, ticket, { notSent: true }); if(choiceTicket)ledger.cancel(choiceTicket); break; }
      if (dispatchChanged()) throw new AutomationSkip('探宝派遣设置已变化，等待重新规划');
      const wireBody = step.kind === 'choiceEvent' ? { ...step.body, uid: automationWireId(step.body.uid) } : step.body;
      sent = writePending = true;
      if (step.response && protocol[step.response]) {
        const reply = await client.request(step.request, wireBody, step.response, 15000);
        writePending = false;
        let body = normalize(reply);
        if (step.kind === 'museumRevenue' && (!Number.isSafeInteger(body.collected) || body.collected < 0)) throw new Error('服务器尚未确认人气币领取结果');
        if(step.kind==='choiceEvent' && !body.reward?.asset?.length)throw new Error('随机事件奖励回执尚未确认');
        if (step.kind === 'museumStart' && !(body.expedition?.endTime > 0)) throw new Error('服务器尚未确认探宝队伍出发');
        if (step.kind === 'museumComplete') {
          if (!Number.isSafeInteger(body.grade) || body.grade < 1 || body.grade > 5) throw new Error('服务器尚未确认探宝结算');
          if (!enabled() || !getSettings()?.loop.world || getSettings()?.museum.runEnabled === false || !getSettings()?.museum.enabled) throw new AutomationSkip('探宝已结算，操作已暂停，奖励留待下次领取');
          const reward = normalize(await client.request('MuseumRewardRequest', { stageId: step.body.stageId }, 'MuseumRewardResponse', 15000));
          if (reward.exploreStage?.stageId !== step.body.stageId || reward.exploreStage.expedition?.endTime > 0) throw new Error('服务器尚未确认探宝奖励领取完成');
          body = { settlement: body, ...reward };
        }
        if (step.kind === 'museumGuide' && (!Number.isSafeInteger(body.expedition?.endTime) || body.expedition.endTime >= step.verify.endTime)) throw new Error('服务器尚未确认探险指南缩短了时间，额度暂时保留');
        if (step.kind === 'museumKeyword' || step.kind === 'museumExhibition') {
          const after = normalize(await client.request('MuseumInfoRequest', {}, 'MuseumInfoResponse'));
          const ex = after.exhibitions?.find(row => row.exhibitionId === step.body.exhibitionId);
          const actual = step.kind === 'museumKeyword' ? ex?.keywordLevels?.[step.verify.index] : ex?.level;
          if (!Number.isSafeInteger(actual) || actual < step.verify.level) throw new Error('服务器尚未确认博物馆升级');
        }
        entry = { step, ok: true, body };
        if (step.kind === 'paidGold') {
          const reason = await checkPaidGoldReceipt(client, step, body, ledger, ticket);
          if (reason) entry = { step, ok: false, status: 'pending', reason, body };
        }
      } else {
        const watched = await client.sendWatch(step.request, wireBody, { window: 500 });
        writePending = false;
        entry = { step, ok: true, sent: watched };
        if (step.kind === 'museumAchievement') {
          const after = normalize(await client.request('MuseumInfoRequest', {}, 'MuseumInfoResponse'));
          if (!after.claimedAchievements?.some(score => Number(score) === step.body.popularityThreshold)) throw new Error('服务器尚未确认博物馆成就已领取');
          entry = { step, ok: true, body: { claimed: step.body.popularityThreshold } };
        } else if (['petClaim', 'petBreed', 'petFeed'].includes(step.kind)) {
          const after = normalize(await client.request('OnWaterRequest', {}, 'OnWaterResponse'));
          if (!Array.isArray(after.building)) throw new Error('无法核对海兽培育状态');
          const rooms = petRooms(after.building, config);
          if (!rooms.length || rooms.some(room => !petQueue(room, config))) throw new Error('无法完整确认真实培育室队列，等待下次检查');
          const mature = rooms.reduce((sum, b) => sum + (b.petBreed.maturePets?.length ?? 0), 0);
          const confirmed = step.kind === 'petClaim' ? mature < step.verify.matureBefore
            : confirmPetSpend(petBefore, petSpendSnapshot(rooms), step.request, step.body);
          if (!confirmed) throw new Error('服务器尚未确认海兽操作结果');
          entry = { step, ok: true, body: { confirmed: true } };
        } else if (step.kind === 'petAdvance' || step.kind === 'petAdvanceFeed') {
          const after = normalizeBaseReply('AllPetRequest', await client.request('AllPetRequest', {}, 'AllPetResponse'));
          const pet = after.pets?.find(p => String(p.uid) === step.verify.petUid);
          const fed = pet && petAdvanceFeedCount(pet);
          const confirmed = pet && (step.kind === 'petAdvance' ? pet.grade >= step.verify.grade : fed > step.verify.fed || pet.grade > step.verify.grade);
          if (!confirmed) throw new Error('服务器尚未确认海兽进阶进度');
          entry = { step, ok: true, body: { confirmed: true } };
        }
      }
      if (step.kind === 'choiceEvent') {ledger.confirm(choiceTicket);watchBasePushes(client).choices.delete(String(step.body.uid));}
      await guard.after(step, ticket, entry);
    } catch (error) {
      const notSent = !sent || (writePending && error.notSent === true);
      if(choiceTicket && (notSent || error.prompt&&error.request==='SelectChoiceRequest'))ledger.cancel(choiceTicket);
      const pendingGold = step.kind === 'paidGold' && !notSent && !(writePending && error.prompt && error.request === step.request);
      if (pendingGold) {
        entry = { step, ok: false, status: 'pending', reason: `点金结果待核对，已保留次数与钻石额度（${error.message}）` };
        await guard.after(step, ticket, entry);
      } else {
        if (prepared) await guard.cancel(step, ticket, { notSent, error });
        entry = { step, ok: false, ...(error.code === 'AUTOMATION_SKIP' ? { skipped: true } : {}), error: error.message };
      }
    }
    results.push(entry); onStep?.(entry);
  }
  const pref = getSettings();
  const cleanup = await cleanupAfterClaim(client, config, pref, ledger, 'pet',
    () => enabled() && client.connected && getSettings() === pref && pref.loop.world && pref.pet.enabled);
  if (cleanup) {
    const row = { ...cleanup, step: { kind: 'petRelease', label: cleanup.label } };
    results.push(row);
    onStep?.(row);
  }
  return results;
}
