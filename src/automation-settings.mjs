import { automationControlFields, automationControls, idleAutomationControls, idleControlFields } from './automation-controls.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJson, readJson, withFileLock } from './json-store.mjs';
import { accountKey, dataDirectory } from './usage-ledger.mjs';
export { beijingDay, createUsageLedger, usageFile } from './usage-ledger.mjs';
import { taskSettings, retiredAutomationTasks, migratedAutomationTasks } from './automation.mjs';
import { EXTENDED_DEFAULTS, EXTENDED_CONSTRAINTS, SILICON_FLEET_NUMBERS, validateSiliconFleets } from './extended-settings.mjs';
import { treasureRewardOptions } from './treasure-reward-filter.mjs';
import { activityAutomationDefaults, activityAutomationFields } from './activity-automation.mjs';
import { DEFAULT_APPOINTMENT_PRIORITIES, normalizeAppointmentPriorities } from './appointment-priorities.mjs';
import { validateLineupSettings, validateFleetLineupBindings } from './saved-lineups.mjs';
import { fleetSpeedDefaults, fleetSpeedEnabled, FLEET_SPEED_NUMBERS, validateFleetSpeeds } from './fleet-speed-settings.mjs';
import { cityWarFleetStrategy, cityWarUsesGlobalStrategy, validateCityWarFleetStrategies } from './city-war-settings.mjs';
import { WEEKLY_ACTIVITY_DEFAULTS, WEEKLY_ACTIVITY_CONSTRAINTS, validateWeeklyActivitySettings, migrateWeeklyActivitySettings } from './weekly-activity-settings.mjs';
import { resourceFieldIds, defaultResourceFieldAmounts } from './resource-field-allocation.mjs';

// 设置与登录凭据分开保存。导出只包含设置，不包含账号、凭据或用量账本。
export const settingsFile = () => path.join(dataDirectory(), 'automation-settings.json');
export const SETTINGS_FORMAT = 'crazywaterworld-automation';
// 文件 version / 账号 settingsVersion 是格式编号，只随结构迁移调整；
// revision 是每次保存递增的修订号，仅用于并发冲突检查，不能用作格式版本。
export const SETTINGS_SCHEMA_VERSION = 18;
const LEGACY_SETTINGS_FORMAT = 'crazywaterword-automation';
const treasureQualityLabels = { ORANGE: '万吨货轮', PURPLE: '中型货轮', BLUE: '小型货轮' };
export const DEMAND_SOURCES = [
  ['cargo', '贸易港口 / 货船'], ['guildRecruit', '联盟募兵'], ['museum', '博物馆探宝'],
  ['guildShip', '联盟商船'], ['heroRaid', '红卡订单'], ['resident', '居民订单'],
  ['merchant', '不差钱商人'], ['building', '建筑建造 / 升级'], ['refugee', '救援难民'],
  ['petAdvance', '海兽进阶'], ['petFeed', '海兽喂养'], ['factory', '工厂补料'],
];

// 新账号的功能开关和执行细项全部关闭，必须由用户逐项开启。
// ads.noPrivilege 是固定的旧格式兼容字段，不是自动执行开关。
export const DEFAULT_SETTINGS = {
  ...EXTENDED_DEFAULTS,
  // 连接被顶号后，挂机可按当前账号的策略自动恢复连接。
  // 时间使用北京时间（HH:mm）；深夜窗口支持跨午夜配置。
  login: { autoReconnect: false, intervalSeconds: 900, jitterSeconds: 0, quietHours: false, quietStart: '02:00', quietEnd: '07:00', quietIntervalSeconds: 60, maxRetries: 5 },
  schedule: taskSettings(),
  eventActions: { compassThreshold: 10, compassDrawCount: 10 },
  activityAutomation: activityAutomationDefaults,
  weeklyActivity: WEEKLY_ACTIVITY_DEFAULTS,
  weekOrder: { enabled: false, allowDiamonds: false },
  merchant: { enabled: false, autoShareIntel: false, quoteMaxAgeSeconds: 300, estimateDiscountPercent: 10, refreshWaitSeconds: 120, liquidationMinutes: 120,
    maxLossPercent: 0, minExpectedProfit: 1, autoSpeedUp: false, speedUpMinProfit: 1000, keepPointers: 0,
    speedUpMode: 'profit', speedUpMaxPerLeg: 4, monitorSeconds: 60,
    refreshWindowMinutes: 8, dailyPointerLimit: 28, autoBuyPointers: false, pointerDailyDiamondLimit: 0,
    profitLimit: 0, firstDepartureMode: 'smart', firstDepartureTime: '10:00', firstDepartureWaitMinutes: 29,
    autoUpgrade: false, upgradeCoinValuePerDiamond: 100, upgradeMinReturnPercent: 150, upgradeMaxLevel: 2, upgradeDailyDiamondLimit: 300 },
  loop: { rounds: 0, everySeconds: 60, tasks: false, dailies: false, world: false, heroes: false },
  building: { enabled: false, collect: false, build: false, upgrade: false, finish: false, supply: false, disabledTypes: [], speedUp: false, keepBlueprints: 0, maxBuilds: 5, maxUpgrades: 2 },
  factory: { enabled: false, gain: false, produce: false, cooperateNative: false, disabledTypes: [], keepStock: 50, checkEverySeconds: 30, demandFirst: false, demandPriority: DEMAND_SOURCES.map(([id]) => id), speedUpSources: [], speedUp: false, speedUpItems: [] },
  farm: { enabled: false, harvest: false, autoPlant: false, customPlant: false, crops: [], speedUp: false },
  // 总开关与细项独立保存；开启总开关不会开启任何细项。
  gather: { enabled: false, fishing: false, fishBook: false, floaters: false, antiqueFloaters: false, continueWhenFull: false, diving: false, keyOpen: false, salvage: false, upgradeFishing: false, upgradeDiving: false, upgradeSalvage: false, targetLevel: 2, fishingGoldReserve: 10000 },
  resident: { enabled: false, skipCrops: false, skipProduction: false, blockedMaterials: [], minExp: 0, minGold: 0, dailyCap: 0, rewards: false, reroll: false },
  cargo: { enabled: false, dailyLoadLimit: 0 },
  events: { enabled: false, otherOption: 1 },
  pet: { release: false, releaseQualities: [], enabled: false, claim: false, breed: false, species: [], quality: 'BLUE', universal: false, feed: false, advance: false },
  museum: { runEnabled: false, enabled: false, revenue: false, achievements: false, display: false, maxDispatches: 1, upgrade: false, factorMode: 'materials', fullRecommendedFactor: 3, partialRecommendedFactor: 2, noRecommendedFallback: false, noRecommendedFactor: 1, factor: 1, materialFactor: false, factorMaterials: [], stockThreshold: 0, matchedFactor: 1, maps: [], useGuide: false, dailyGuideLimit: 0 },
  resources: { keepAccelerators: 0, allowDiamonds: false, diamondThreshold: 0, diamondDailyLimit: 2000 },
  // noPrivilege 仅保留旧配置/导出的兼容字段；无权益账号统一走等待领取。
  ads: { noPrivilege: true, waitSeconds: 15 },
  gold: { enabled: false, times: 3 },
  heroes: { enabled: false, level: false, star: false, skill: false, heroIds: [], needsSelection: false,
    skillAdvance: false, exclusiveLevel: false, exclusiveStar: false, equipment: false, badge: false, showSkillReward: false,
    universal: false, keepExp: 0, targetLevel: 0, targetStar: 0 },
  appointments: { enabled: false, priorities: [...DEFAULT_APPOINTMENT_PRIORITIES] },
  dailies: { enabled: false, claimTasks: false, claimDailyChest: false, claimWeeklyChest: false, claimGift: false },
  tasks: { main: false, branch: false, achievements: false },
  progression: { enabled: false, mainline: false, trials: false, raidIds: ['1','2','3'], maxFailures: 3 },
  lineups: { presets: [], mainlinePresetId: '', trialPresets: [] },
  trials: { paid: false, ads: false, raidIds: ['1','2','3'], paidPerRaidLimit: 1, dailyDiamondBudget: 450, maxSingleCost: 50 },
  fleetDispatch: { priority: ['cityWar','pirateHunt','worldBoss','follow','treasure','radar','silicon','resourceFields'] },
  resourceFields: { enabled: false, refillAfterLoss: false, allocationMode: 'ratio', ratios: { ...defaultResourceFieldAmounts }, quotas: { ...defaultResourceFieldAmounts },
    fleetIds: [], minDurabilityPercent: 80, reserveFleetCount: 1, minLevel: 1, checkEverySeconds: 60 },
  fleetSpeed: { fleets: [1,2,3].map(id => fleetSpeedDefaults(id + '远征船')) },
  worldBoss: { enabled: false, fleetIds: [], fleetPresets: [], minDurabilityPercent: 80 },
  radar: { runEnabled:false, enabled:false, repairIdle:false, fleetIds:[], types:['pirate','collect','refugee','spy','fixed'], allowMaterials:false, minDurabilityPercent:80, checkEverySeconds:30 },
  pirateSweep: { type: '1' },
  pirateHunt: { enabled: false, maxFailures: 3, fleetIds: [], types: [], maxLevel: 0, minDurabilityPercent: 80, checkEverySeconds: 15 },
  treasure: { enabled: false, autoJoin: false, qualities: Object.keys(treasureQualityLabels), follow: false, followMode: 'trigger', fleetIds: [], followNames: [], followPlayerIds: [], avoidPlayerIds: [],
    rewardItems: [], avoidNames: [], allowHostile: false, minDurabilityPercent: 80,
    maxProgress: 90, personalProgressLimit: 20, dailyDispatchLimit: 0, checkEverySeconds: 15, participationMode: 'untilFull', repeatAttack: false,
    autoRepair: false,
    marchSpeedUp: false, marchTargetSeconds: 60, dailyDiamondLimit: 0,
    fallbackEnabled: false, fallbackAfter: '21:00', fallbackTargetRewards: 3,
    fallbackQualities: ['PURPLE', 'BLUE'], fallbackMediumRewardPriority: [], fallbackSmallRewardPriority: [] },
  // 攻守目标由跟随全局的舰队共用；每队还可独立保存两套策略。
  cityWar: { enabled: false, fleetIds: [], defenceFleetIds: [], targetMode: 'alliance', targetPriority: 'fewestAllied', cityRefs: [],
    defenceTargetMode: 'alliance', defenceTargetPriority: 'fewestAllied', defenceCityRefs: [], fleetStrategies: {}, autoRepair: false,
    nativeCommissionLimit: -1, repairBelowPercent: 80, reserveDuringWar: false, checkEverySeconds: 15 },
  forge: { decompose: false, decomposeQualities: [], enabled: false, nativeAuto: false, collect: true, craft: true, buildingIds: [], recipeIds: [], universal: false, materialReserve: 0,
    universalReserve: 0, goldReserve: 0, dailyLimit: 5, dailyGoldLimit: 100000, checkEverySeconds: 30 },
  antique: { enabled: false, activate: false, activateQualities: [], star: false, starQualities: [], targetStar: 0, universal: false,
    master: false, targetMasterLevel: 0, suit: false, suitQualities: [], goldReserve: 0, dailyGoldLimit: 20000,
    maxActions: 20, checkEverySeconds: 60 },
};

const int = (max = 1_000_000_000, min = 0) => ({ kind: 'number', min, max });
const strings = (max = 300) => ({ kind: 'list', max });
const constraints = {
  ...WEEKLY_ACTIVITY_CONSTRAINTS,
  'fleetSpeed.fleets': { kind: 'fleetSpeeds' },
  ...Object.fromEntries([0,1,2].flatMap(index => Object.entries(FLEET_SPEED_NUMBERS).map(([key, rule]) => ['fleetSpeed.fleets.' + index + '.' + key, rule]))),
  ...EXTENDED_CONSTRAINTS,
  ...Object.fromEntries([0, 1, 2].flatMap(index => Object.entries(SILICON_FLEET_NUMBERS).map(([key, rule]) => ['silicon.fleets.' + index + '.' + key, rule]))),
  'login.intervalSeconds': int(86400, 1), 'login.jitterSeconds': int(86400),
  'login.quietIntervalSeconds': int(86400, 1), 'login.maxRetries': int(10000, 1),
  'login.quietStart': { kind: 'time' }, 'login.quietEnd': { kind: 'time' },
  'eventActions.compassThreshold':int(999999,1), 'eventActions.compassDrawCount':int(50,1),
  'merchant.quoteMaxAgeSeconds': int(86400, 1), 'merchant.estimateDiscountPercent': int(100),
  'merchant.refreshWaitSeconds': int(3600), 'merchant.liquidationMinutes': int(1440), 'merchant.maxLossPercent': int(100),
  'merchant.minExpectedProfit': int(1000000000, 1), 'merchant.speedUpMinProfit': int(1000000000, 1), 'merchant.keepPointers': int(1000000),
  'merchant.speedUpMode': { kind: 'choice', values: ['deadline', 'profit', 'refresh', 'arrival'] }, 'merchant.speedUpMaxPerLeg': int(100, 1),
  'merchant.refreshWindowMinutes': int(30, 1), 'merchant.dailyPointerLimit': int(1000), 'merchant.pointerDailyDiamondLimit': int(100000),
  'merchant.profitLimit': int(1000000000), 'merchant.firstDepartureMode': { kind: 'choice', values: ['smart', 'time'] },
  'merchant.firstDepartureTime': { kind: 'time' }, 'merchant.firstDepartureWaitMinutes': int(120),
  'merchant.monitorSeconds': int(300, 10), 'merchant.upgradeCoinValuePerDiamond': int(1000000, 1),
  'merchant.upgradeMinReturnPercent': int(10000, 100), 'merchant.upgradeMaxLevel': int(5, 1), 'merchant.upgradeDailyDiamondLimit': int(100000),
  'ads.waitSeconds':int(120,5),
  'fleetDispatch.priority': {...strings(8),values:['cityWar','pirateHunt','worldBoss','follow','treasure','radar','silicon','resourceFields']},
  'resourceFields.allocationMode': { kind: 'choice', values: ['ratio', 'quota'] },
  'resourceFields.ratios': { kind: 'resourceAmounts' }, 'resourceFields.quotas': { kind: 'resourceAmounts' },
  ...Object.fromEntries(['ratios', 'quotas'].flatMap(group => Object.keys(resourceFieldIds).map(key => [`resourceFields.${group}.${key}`, int(1_000_000)]))),
  'resourceFields.fleetIds': strings(10), 'resourceFields.minDurabilityPercent': int(100, 1),
  'resourceFields.reserveFleetCount': int(3), 'resourceFields.minLevel': int(100, 1), 'resourceFields.checkEverySeconds': int(3600, 30),
  'worldBoss.fleetIds': strings(10), 'worldBoss.minDurabilityPercent': int(100),
  'worldBoss.fleetPresets': { kind: 'fleetLineups' },
  'events.otherOption': int(2,1), 'radar.fleetIds': strings(10), 'radar.types': {...strings(5),values:['pirate','collect','refugee','spy','fixed']},
  'radar.minDurabilityPercent':int(100), 'radar.checkEverySeconds':int(300,10),
  'loop.rounds': int(100000), 'loop.everySeconds': int(86400, 1),
  'building.keepBlueprints': int(), 'building.maxBuilds': int(100), 'building.maxUpgrades': int(100),
  'building.disabledTypes': strings(), 'factory.disabledTypes': strings(), 'factory.keepStock': int(100000), 'factory.checkEverySeconds': int(300, 1),
  'factory.demandPriority': { ...strings(12), values: DEMAND_SOURCES.map(([id]) => id) },
  'factory.speedUpSources': { ...strings(12), values: DEMAND_SOURCES.map(([id]) => id) },
  'factory.speedUpItems': strings(), 'farm.crops': { kind: 'crops' }, 'gather.targetLevel': int(1000, 1), 'gather.fishingGoldReserve': int(),
  'resident.blockedMaterials': strings(), 'resident.minExp': int(), 'resident.minGold': int(), 'resident.dailyCap': int(),
  'pet.releaseQualities': { ...strings(4), values: ['BLUE','PURPLE','ORANGE','RED'] },
  'forge.decomposeQualities': { ...strings(5), values: ['GREEN','BLUE','PURPLE','ORANGE','RED'] },
  'cargo.dailyLoadLimit': int(), 'pet.species': strings(), 'pet.quality': { kind: 'choice', values: ['BLUE', 'PURPLE', 'ORANGE', 'RED'] },
  'museum.factorMode': { kind: 'choice', values: ['materials', 'recommended'] },
  'museum.fullRecommendedFactor': int(3, 1), 'museum.partialRecommendedFactor': int(3, 1), 'museum.noRecommendedFactor': int(3, 1),
  'museum.maxDispatches': int(100), 'museum.factor': int(3, 1), 'museum.factorMaterials': strings(), 'museum.stockThreshold': int(), 'museum.matchedFactor': int(3, 1),
  'museum.maps': strings(), 'museum.dailyGuideLimit': int(), 'resources.keepAccelerators': int(), 'resources.diamondThreshold': int(),
  'resources.diamondDailyLimit': int(), 'gold.times': int(1000), 'heroes.heroIds': strings(), 'heroes.keepExp': int(),
  'heroes.targetLevel': int(10000), 'heroes.targetStar': int(1000),
  'appointments.priorities': { ...strings(7), values: DEFAULT_APPOINTMENT_PRIORITIES },
  'trials.raidIds': { ...strings(3), values: ['1','2','3'] }, 'trials.paidPerRaidLimit': int(100),
  'trials.dailyDiamondBudget': int(100000), 'trials.maxSingleCost': int(10000),
  'progression.raidIds': { ...strings(3), values: ['1','2','3'] }, 'progression.maxFailures': int(100, 1),
  'pirateHunt.maxFailures': int(100, 1),
  'pirateSweep.type': {kind:'choice',values:['1','2','3']},
  'pirateHunt.fleetIds': strings(10), 'pirateHunt.types': strings(20), 'pirateHunt.maxLevel': int(1000),
  'pirateHunt.minDurabilityPercent': int(100), 'pirateHunt.checkEverySeconds': int(60, 5),
  'treasure.fleetIds': strings(10), 'treasure.followNames': strings(30), 'treasure.followPlayerIds': strings(30),
  'treasure.qualities': { ...strings(3), values: Object.keys(treasureQualityLabels) },
  'treasure.rewardItems': strings(100), 'treasure.avoidNames': strings(30),
  'treasure.minDurabilityPercent': int(100), 'treasure.maxProgress': int(100, 1),
  'treasure.personalProgressLimit': int(100),
  'treasure.dailyDispatchLimit': int(1000), 'treasure.checkEverySeconds': int(300, 5),
  'treasure.avoidPlayerIds': strings(100), 'treasure.participationMode': { kind: 'choice', values: ['untilFull', 'always'] },
  'treasure.followMode': { kind: 'choice', values: ['trigger', 'eachTime'] },
  'treasure.marchTargetSeconds': int(3600), 'treasure.dailyDiamondLimit': int(100000000),
  'treasure.fallbackAfter': { kind: 'time' }, 'treasure.fallbackTargetRewards': int(100, 1),
  'treasure.fallbackQualities': { ...strings(2), values: ['PURPLE', 'BLUE'] },
  'treasure.fallbackMediumRewardPriority': strings(100), 'treasure.fallbackSmallRewardPriority': strings(100),
  'cityWar.fleetIds': strings(10), 'cityWar.defenceFleetIds': strings(10), 'cityWar.targetMode': { kind: 'choice', values: ['alliance', 'selected'] },
  'cityWar.targetPriority': { kind: 'choice', values: ['fewestAllied', 'original'] },
  'cityWar.cityRefs': strings(100), 'cityWar.nativeCommissionLimit': { kind: 'number', min: -1, max: 1000 },
  'cityWar.defenceTargetMode': { kind: 'choice', values: ['alliance', 'selected'] },
  'cityWar.defenceTargetPriority': { kind: 'choice', values: ['fewestAllied', 'original'] },
  'cityWar.defenceCityRefs': strings(100),
  'cityWar.fleetStrategies': { kind: 'cityWarFleetStrategies' },
  'cityWar.repairBelowPercent': int(100, 1), 'cityWar.checkEverySeconds': int(300, 5),
  'forge.buildingIds': strings(10), 'forge.recipeIds': strings(100), 'forge.materialReserve': int(),
  'forge.universalReserve': int(), 'forge.goldReserve': int(), 'forge.dailyLimit': int(1000, 1),
  'forge.dailyGoldLimit': int(1000000000, 1), 'forge.checkEverySeconds': int(300, 10), // 兼容旧配置；锻造检查已跟随每轮挂机。
  'antique.activateQualities': { ...strings(4), values: ['BLUE', 'PURPLE', 'ORANGE', 'RED'] },
  'antique.starQualities': { ...strings(4), values: ['BLUE', 'PURPLE', 'ORANGE', 'RED'] },
  'antique.suitQualities': { ...strings(4), values: ['BLUE', 'PURPLE', 'ORANGE', 'RED'] },
  'antique.targetStar': int(25), 'antique.targetMasterLevel': int(100), 'antique.goldReserve': int(),
  'antique.dailyGoldLimit': int(100000000), 'antique.maxActions': int(100, 1), 'antique.checkEverySeconds': int(3600, 10),
};

export class SettingsError extends Error {
  constructor(errors) {
    super(Object.values(errors)[0] || '设置不合法');
    this.name = 'SettingsError';
    this.fields = errors;
  }
}

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const copy = (value) => structuredClone(value);
export function defaultSettings() { return copy(DEFAULT_SETTINGS); }

// 兼容上游已有的快捷开关。未保存细化配置时，执行仍沿用上游行为。
const nativeFields = {
  heroGrowth: ['loop.heroes'],
  stageAuto: ['progression.mainline'],
  trialPaidSweep: ['trials.paid'], trialAdSweep: ['trials.ads'],
  diveEnhance: ['gather.upgradeDiving'], autoDive: ['gather.diving'], salvageEnhance: ['gather.upgradeSalvage'],
  autoSalvage: ['gather.salvage'], autoFish: ['gather.fishing'], fishEnhance: ['gather.upgradeFishing'],
  floaters: ['gather.floaters'], antiqueFloaters: ['gather.antiqueFloaters'], cargo: ['cargo.enabled'], farm: ['farm.enabled'],
  collect: ['building.collect', 'factory.gain'], finishUpgrade: ['building.finish'], build: ['building.build'],
  buildSupply: ['building.supply'],
  upgrade: ['building.upgrade'], finishOrder: ['resident.enabled'], startProduce: ['factory.produce'],
  speedUp: ['building.speedUp', 'factory.speedUp'], denyOrder: ['resident.reroll'], paidGold: ['gold.enabled'],
  dailyRewards: ['dailies.claimTasks'], chests: ['dailies.claimDailyChest', 'dailies.claimWeeklyChest'], gift: ['dailies.claimGift'],
  tasks: ['loop.tasks', 'resident.rewards'],
};
export function applyNativeTask(settings, key, enabled) {
  const result = copy(settings);
  if (migratedAutomationTasks.has(key)) { delete result.schedule[key]; return result; }
  if (retiredAutomationTasks.has(key)) enabled = false;
  if (Object.hasOwn(result.schedule, key)) result.schedule[key] = enabled;
  for (const field of nativeFields[key] ?? []) { const [group, name] = field.split('.'); result[group][name] = enabled; }
  if (key === 'speedUp' && !enabled) {
    result.factory.speedUpSources = [];
    result.farm.speedUp = false;
  }
  return result;
}
export function settingsFromNative(tasks, { rounds = 0, everySeconds = 60, fishingGoldReserve = 10000 } = {}) {
  let result = defaultSettings();
  for (const [key, value] of Object.entries(taskSettings(tasks))) result = applyNativeTask(result, key, value);
  if (tasks?.heroGrowth) result.heroes.needsSelection = true;
  result.loop.rounds = rounds;
  result.loop.everySeconds = Math.max(1, Number.isSafeInteger(everySeconds) ? everySeconds : 60);
  result.gather.fishingGoldReserve = fishingGoldReserve;
  // Native-only accounts still need their original selections before the
  // retired task registry discards them. Never reopen an existing module gate.
  for (const key of migratedAutomationTasks) if (typeof tasks?.[key] === 'boolean') result.schedule[key] = tasks[key];
  delete result.museum.revenue; delete result.museum.achievements;
  return migrateVersion9Settings(migrateVersion7Settings(migrateVersion6Settings(migrateVersion5Settings(migrateVersion4Settings(result)))));
}

// Only native-only accounts have no saved module gates. Infer these gates
// from their explicit task choices once; current settings and new accounts
// must keep the ordinary settingsFromNative defaults.
export function settingsFromLegacyNative(tasks, options) {
  const result = settingsFromNative(tasks, options);
  const selected = keys => keys.some(key => tasks?.[key] === true);
  const gates = {
    'building.enabled': ['collect', 'finishUpgrade', 'build', 'buildSupply', 'upgrade', 'speedUp', 'adSpeedUpBuilding'],
    'factory.enabled': ['collect', 'startProduce', 'buildSupply', 'speedUp', 'adSpeedUpProduce'],
    'gather.enabled': ['autoFish', 'fishEnhance', 'floaters', 'antiqueFloaters', 'autoDive', 'diveEnhance', 'autoSalvage', 'salvageEnhance'],
    'dailies.enabled': ['dailyRewards', 'chests', 'gift', 'freeGold', 'freeRecruit', 'ticketRecruit', 'arena', 'pirate', 'shop'],
    'loop.dailies': ['freeGold', 'freeRecruit', 'ticketRecruit', 'arena', 'pirate', 'paidGold', 'shop'],
    'museum.runEnabled': ['museumCollect', 'museumExplore', 'museumRevenue', 'museumAchievements'],
    'radar.runEnabled': ['radarAuto', 'radarRepair'],
    'progression.enabled': ['stageAuto'],
    'heroes.enabled': ['heroGrowth'],
  };
  for (const [field, keys] of Object.entries(gates)) if (selected(keys)) {
    const [group, name] = field.split('.'); result[group][name] = true;
  }
  for (const { key, taskKeys } of activityAutomationFields) if (selected(taskKeys)) {
    const [group, name] = key.split('.'); result[group][name] = true;
  }
  if (tasks?.weekSupplyFree === true) {
    result.activityAutomation.weekLottery = result.activityAutomation.weekChip = result.activityAutomation.weekUnique = true;
  }
  if (selected([...gates['building.enabled'], ...gates['factory.enabled'], ...gates['gather.enabled'],
    'cargo', 'farm', 'finishOrder', 'denyOrder', 'adSpeedUpMuseum', 'petCollect', 'petBreed', 'museumCollect', 'museumExplore', 'museumRevenue', 'museumAchievements'])) result.loop.world = true;
  // The native farm task explicitly included both harvesting and planting.
  if (tasks?.farm === true) result.farm.harvest = result.farm.autoPlant = true;
  return result;
}

export function nativeTaskValues(settings, current) {
  const result = { ...current, ...settings.schedule };
  delete result.weekFactory;
  for (const [key, fields] of Object.entries(nativeFields)) result[key] = fields.some(field => { const [group, name] = field.split('.'); return settings[group][name]; });
  result.heroGrowth = false; // The old mainline-only job has been retired.
  for (const key of retiredAutomationTasks) result[key] = false;
  for (const key of migratedAutomationTasks) delete result[key];
  result.startProduce = settings.factory.produce || settings.factory.cooperateNative;
  result.speedUp = settings.building.speedUp || settings.factory.speedUp || settings.farm.speedUp || settings.factory.speedUpSources.length > 0;
  return result;
}

export function hasExtraWork(settings) {
  if (settings?.radar?.runEnabled && (settings.radar.enabled || settings.radar.repairIdle)) return true;
  if (settings?.weeklyActivity?.enabled && ['farm', 'pet', 'antique', 'order', 'forge', 'hero'].some(kind => settings.weeklyActivity[kind + 'Enabled'])) return true;
  if (fleetSpeedEnabled(settings) || settings?.appointments?.enabled || settings?.alliance?.enabled || settings?.guildShip?.enabled || settings?.heroRaid?.enabled || settings?.silicon?.enabled || settings?.resourceFields?.enabled) return true;
  return !!settings && ((settings.loop.world && (settings.museum.runEnabled !== false && ['enabled', 'upgrade', 'revenue', 'achievements', 'display'].some(key => settings.museum[key]) || settings.events.enabled || settings.pet.enabled || (settings.gather.enabled !== false && settings.gather.diving && settings.gather.keyOpen))) || (settings.loop.heroes && settings.heroes.enabled)
    || (settings.progression?.enabled && (settings.progression.mainline || settings.progression.trials)) || settings.pirateHunt?.enabled);
}
export function hasBaseWork(settings) {
  return !!settings && ((settings.loop.world && (settings.museum.runEnabled !== false && ['enabled', 'upgrade', 'revenue', 'achievements', 'display'].some(key => settings.museum[key]) || settings.events.enabled ||
    settings.pet.enabled || (settings.gather.enabled !== false && settings.gather.diving && settings.gather.keyOpen))) ||
    (settings.loop.dailies && settings.gold.enabled));
}
export function settingsUiRules() {
  return { moduleControls: idleAutomationControls, controlFields: idleControlFields, controlGroups: Object.fromEntries(automationControls.flatMap(c=>c.fields.map(path=>[path,c.idleGroup??c.group]))), mappedTasks: [...Object.keys(nativeFields), ...retiredAutomationTasks], numbers: Object.fromEntries(Object.entries(constraints).filter(([, rule]) => rule.kind === 'number').map(([key, rule]) => [key, { min: rule.min, max: rule.max }])) };
}

export function validateSettings(input, options = {}) {
  // Partial callers are the legacy compatibility API. Current persisted and
  // imported documents are validated strictly after their version is checked.
  if (options.partial) input = migrateSettingsVersion(input, 1, { source: 'stored' });
  return validateCurrentSettings(input, options);
}

function validateCurrentSettings(input, { partial = false, catalog = null } = {}) {
  // An already-open settings page can still submit the retired fields.
  // Ignore only these known fields; every other setting remains strict.
  input = migrateVersion10Settings(migrateVersion9Settings(migrateVersion8Settings(migrateVersion7Settings(migrateVersion6Settings(migrateVersion5Settings(migrateVersion4Settings(migrateVersion3Settings(migrateVersion2Settings(input)))))))));
  // Additive follow preference: keep the existing behavior for older saved files and open pages.
  input = migrateVersion14Settings(migrateVersion13Settings(input));
  if (plain(input?.treasure) && Object.hasOwn(input.treasure, 'onlyTenThousand')) input = migrateVersion15Settings(input);
  input = migrateVersion17Settings(migrateVersion16Settings(input));
  if (plain(input?.resourceFields) && !Object.hasOwn(input.resourceFields, 'refillAfterLoss')) {
    input = { ...input, resourceFields: { ...input.resourceFields, refillAfterLoss: false } };
  }
  if (plain(input) && plain(input.weeklyActivity)) input = { ...input, weeklyActivity: migrateWeeklyActivitySettings(input.weeklyActivity) };
  // This additive limit was absent from saved version 2 settings. Only fill
  // the missing field; explicit values still pass through strict validation.
  if (plain(input) && plain(input.alliance) && !Object.hasOwn(input.alliance, 'askDailyLimit')) {
    input = { ...input, alliance: { ...input.alliance, askDailyLimit: DEFAULT_SETTINGS.alliance.askDailyLimit } };
  }
  const errors = Object.create(null);
  const output = defaultSettings();
  if (!plain(input)) throw new SettingsError({ settings: '配置必须是 JSON 对象' });
  for (const group of Object.keys(input)) if (!Object.hasOwn(DEFAULT_SETTINGS, group)) errors[group] = `不支持的设置分组：${group}`;
  for (const [group, defaults] of Object.entries(DEFAULT_SETTINGS)) {
    if (!Object.hasOwn(input, group)) { if (!partial) errors[group] = `缺少设置分组：${group}`; continue; }
    if (!plain(input[group])) { errors[group] = `${group} 必须是对象`; continue; }
    if (group === 'lineups') {
      try { output.lineups = validateLineupSettings(input[group]); }
      catch (error) { errors.lineups = error.message; }
      continue;
    }
    for (const key of Object.keys(input[group])) if (!Object.hasOwn(defaults, key)) errors[`${group}.${key}`] = `不支持的设置项：${group}.${key}`;
    for (const [key, initial] of Object.entries(defaults)) {
      const name = `${group}.${key}`;
      if (!Object.hasOwn(input[group], key)) { if (!partial) errors[name] = '缺少此设置项'; continue; }
      const value = input[group][key];
      const rule = constraints[name];
      if (typeof initial === 'boolean') {
        if (typeof value !== 'boolean') errors[name] = '开关值必须为 true 或 false';
        else output[group][key] = value;
      } else if (rule?.kind === 'number') {
        if (!Number.isSafeInteger(value) || value < rule.min || value > rule.max) errors[name] = `请输入 ${rule.min}–${rule.max} 之间的整数`;
        else output[group][key] = value;
      } else if (rule?.kind === 'choice') {
        if (!rule.values.includes(value)) errors[name] = '请选择有效选项';
        else output[group][key] = value;
      } else if (rule?.kind === 'resourceAmounts') {
        if (!plain(value)) { errors[name] = '请输入三种资源的数量'; continue; }
        for (const field of Object.keys(value)) {
          if (!Object.hasOwn(resourceFieldIds, field)) errors[name + '.' + field] = '不支持的资源类型';
        }
        for (const field of Object.keys(resourceFieldIds)) {
          const path = name + '.' + field, { min, max } = constraints[path];
          if (!Number.isSafeInteger(value[field]) || value[field] < min || value[field] > max) errors[path] = `请输入 ${min}–${max} 之间的整数`;
          else output[group][key][field] = value[field];
        }
      } else if (rule?.kind === 'time') {
        if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) errors[name] = '请输入有效时间（HH:mm）';
        else output[group][key] = value;
      } else if (rule?.kind === 'list') {
        if (!Array.isArray(value) || value.length > rule.max || value.some(v => typeof v !== 'string' || !v.trim() || v.length > 120) || new Set(value).size !== value.length) errors[name] = '选项必须为不重复的有效列表';
        else if (rule.values && value.some(v => !rule.values.includes(v))) errors[name] = '列表中含有不支持的选项';
        else output[group][key] = [...value];
      } else if (rule?.kind === 'fleetLineups') {
        try { output[group][key] = validateFleetLineupBindings(value, output.lineups.presets); }
        catch (error) { errors[name] = error.message; }
      } else if (rule?.kind === 'siliconFleets') {
        const fleets = validateSiliconFleets(value, errors, catalog);
        if (fleets) output[group][key] = fleets;
      } else if (rule?.kind === 'fleetSpeeds') {
        const fleets = validateFleetSpeeds(value, errors);
        if (fleets) output[group][key] = fleets;
      } else if (rule?.kind === 'cityWarFleetStrategies') {
        output[group][key] = validateCityWarFleetStrategies(value, errors, catalog);
      } else if (rule?.kind === 'crops') {
        if (!Array.isArray(value) || value.length > 100) errors[name] = '作物列表不合法';
        else {
          const ids = new Set();
          for (const row of value) {
            if (!plain(row) || Object.keys(row).some(k => !['id', 'target'].includes(k)) || typeof row.id !== 'string' || !row.id.trim() || row.id.length > 120 || ids.has(row.id) || !Number.isSafeInteger(row.target) || row.target < 0 || row.target > 100000) { errors[name] = '作物不能重复，备货数量必须是 0–100000 的整数'; break; }
            ids.add(row.id);
          }
          if (!errors[name]) output[group][key] = copy(value);
        }
      }
    }
  }
  output.appointments.priorities = normalizeAppointmentPriorities(output.appointments.priorities);
  validateWeeklyActivitySettings(output.weeklyActivity, errors);
  if (output.heroes.heroIds.length) output.heroes.needsSelection = false;
  if (output.progression.trials && !output.progression.raidIds.length) errors['progression.raidIds'] = '请选择自动推关的试炼副本';
  if (output.pirateHunt.enabled && !output.pirateHunt.fleetIds.length) errors['pirateHunt.fleetIds'] = '请选择自动讨伐海盗的舰队';
  if(!output.forge.nativeAuto && output.forge.decompose && !output.forge.decomposeQualities.length)errors['forge.decomposeQualities']='请选择可自动分解的装备品质';
  if(output.pet.release && !output.pet.releaseQualities.length)errors['pet.releaseQualities']='请选择可自动放生的海兽品质';
  if (output.antique.activate && !output.antique.activateQualities.length) errors['antique.activateQualities'] = '请选择自动激活的藏品品质';
  if (output.antique.star && !output.antique.starQualities.length) errors['antique.starQualities'] = '请选择自动升星的藏品品质';
  if (output.antique.suit && !output.antique.suitQualities.length) errors['antique.suitQualities'] = '请选择自动升级的藏品套装品质';
  if (['cityWar','pirateHunt','treasure','radar'].some(k=>!output.fleetDispatch.priority.includes(k))) errors['fleetDispatch.priority']='请保留全部任务，只调整顺序';
  for(const key of ['worldBoss','follow','silicon','resourceFields'])if(!output.fleetDispatch.priority.includes(key))output.fleetDispatch.priority.push(key);
  if (output.resourceFields.enabled && !output.resourceFields.fleetIds.length) errors['resourceFields.fleetIds'] = '请选择自动占领资源田的舰队';
  if (output.resourceFields.fleetIds.some(value => !/^[1-9]\d*远征船$/.test(value))) errors['resourceFields.fleetIds'] = '请选择有效的远征舰队';
  if (output.silicon.windows.some(value => !/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(value))) errors['silicon.windows'] = '时段格式为 HH:mm-HH:mm，每行一个；支持跨午夜';
  if (output.pirateHunt.fleetIds.some(value=>! /^[1-9]\d*远征船$/.test(value))) errors['pirateHunt.fleetIds']='请选择有效的海盗首杀舰队';
  if (output.pirateHunt.types.some(value=>! /^[1-9]\d*$/.test(value))) errors['pirateHunt.types']='请选择有效的海盗类型';
  if (![1,5,10,50].includes(output.eventActions.compassDrawCount)) errors['eventActions.compassDrawCount']='请选择1、5、10或50次';
  if (output.farm.autoPlant && output.farm.customPlant) errors['farm.customPlant'] = '自动种植和自定义种植只能开启一种';
  if (output.factory.speedUpSources.some(source => !output.factory.demandPriority.includes(source))) errors['factory.speedUpSources'] = '加速来源必须保留在需求优先级列表中';
  if (output.farm.customPlant && !output.farm.crops.length) errors['farm.crops'] = '启用自定义种植前，请至少添加一种作物';
  // An empty species selection pauses breeding, including migrated accounts
  // which must choose their spending targets in the unified configuration.
  if (output.treasure.enabled && !output.treasure.autoJoin && !output.treasure.follow) errors['treasure.autoJoin'] = '请至少开启自动参加或跟随指定玩家';
  if (output.treasure.enabled && !output.treasure.fleetIds.length) errors['treasure.fleetIds'] = '请明确选择参与巨轮的舰队，空名单不会派遣';
  if (output.treasure.fallbackEnabled && !output.treasure.fallbackQualities.length) errors['treasure.fallbackQualities'] = '开启兜底前，请至少选择一种货轮';
  if (output.treasure.follow && !output.treasure.followNames.length && !output.treasure.followPlayerIds.length && !errors['treasure.followNames'] && !errors['treasure.followPlayerIds']) errors['treasure.followNames'] = '开启跟随前，请添加玩家完整昵称或角色ID';
  for (const field of ['followNames', 'avoidNames']) if (output.treasure[field].some(value => value !== value.trim() || value.length > 40 || /[\r\n\u0000-\u001f]/.test(value))) errors['treasure.' + field] = '请输入不重复的完整昵称，每项不超过40字符，不含首尾空格或换行';
  for (const field of ['followPlayerIds', 'avoidPlayerIds']) if (output.treasure[field].some(value => !/^[1-9]\d{0,18}$/.test(value) || BigInt(value) > (1n << 63n) - 1n)) errors['treasure.' + field] = '角色ID必须为完整的正整数文本，不能使用科学计数法';
  if (output.treasure.fleetIds.some(value => !/^[1-9]\d*远征船$/.test(value))) errors['treasure.fleetIds'] = '请选择有效的远征舰队';
  if (output.cityWar.enabled && !output.cityWar.fleetIds.length) errors['cityWar.fleetIds'] = '请明确选择参与城战接续的舰队';
  if (output.cityWar.fleetIds.some(value => !/^[1-9]\d*远征船$/.test(value))) errors['cityWar.fleetIds'] = '请选择有效的远征舰队';
  if (output.cityWar.defenceFleetIds.some(value => !output.cityWar.fleetIds.includes(value))) errors['cityWar.defenceFleetIds'] = '防守舰队必须包含在城战参与舰队中';
  const legacyCityRefs = new Set();
  for (const id of output.cityWar.fleetIds) {
    const defence = output.cityWar.defenceFleetIds.includes(id);
    const mode = defence ? 'defenceTargetMode' : 'targetMode', refs = defence ? 'defenceCityRefs' : 'cityRefs';
    const independent = !cityWarUsesGlobalStrategy(output.cityWar, id);
    const prefix = independent ? 'cityWar.fleetStrategies.' + id + '.' : 'cityWar.';
    const strategy = cityWarFleetStrategy(output.cityWar, id);
    if (!independent) legacyCityRefs.add(refs);
    if (output.cityWar.enabled && strategy[mode] === 'selected' && !strategy[refs].length) errors[prefix + refs] = '请至少选择一座' + (defence ? '防守' : '进攻') + '目标城市';
  }
  for (const refs of ['cityRefs', 'defenceCityRefs']) {
    if (output.cityWar[refs].some(value => !/^[1-9]\d{0,3}:[1-9]\d{0,5}$/.test(value))) errors['cityWar.' + refs] = '城市选项必须包含有效场景和城市编号';
  }
  if (output.forge.enabled && !output.forge.buildingIds.length) errors['forge.buildingIds'] = '请选择装备锻造工厂';
  if (output.forge.enabled && !output.forge.nativeAuto && output.forge.craft && !output.forge.recipeIds.length) errors['forge.recipeIds'] = '请选择至少一种锻造配方';
  if (output.forge.recipeIds.some(value => !/^[1-9]\d{0,8}$/.test(value))) errors['forge.recipeIds'] = '请选择有效的锻造配方';
  if (catalog) {
    for (const [name, collection] of Object.entries({
      'building.disabledTypes': 'buildings', 'factory.disabledTypes': 'factories', 'factory.speedUpItems': 'materials',
      'resident.blockedMaterials': 'materials', 'museum.factorMaterials': 'materials', 'museum.maps': 'maps',
      'heroes.heroIds': 'heroes', 'pet.species': 'petSpecies',
      'treasure.fleetIds': 'expeditionFleets', 'treasure.rewardItems': 'materials',
      'treasure.fallbackMediumRewardPriority': 'materials', 'treasure.fallbackSmallRewardPriority': 'materials',
      'cityWar.fleetIds': 'expeditionFleets', ...Object.fromEntries([...legacyCityRefs].map(refs => ['cityWar.' + refs, 'cityTargets'])),
      'radar.fleetIds':'expeditionFleets','worldBoss.fleetIds':'expeditionFleets','resourceFields.fleetIds':'expeditionFleets',
      'pirateHunt.fleetIds': 'expeditionFleets', 'pirateHunt.types': 'pirateTypes',
      'forge.buildingIds': 'forgeBuildings', 'forge.recipeIds': 'forgeRecipes',
      'alliance.allowedMaterials': 'materials', 'alliance.blockedMaterials': 'materials',
      'alliance.requestMaterials': 'materials', 'alliance.techIds': 'guildTech',
      'guildShip.rewardItems': 'materials', 'guildShip.disabledMaterials': 'materials', 'guildFort.materials': 'materials',
    })) {
      const [group, key] = name.split('.');
      const allowed = new Set((catalog[collection] ?? []).map(v => String(v.value)));
      if (output[group][key].some(v => !allowed.has(v))) errors[name] = '包含当前游戏配置中不存在的选项，请重新选择';
    }
    const crops = new Set((catalog.crops ?? []).map(v => v.value));
    if (output.farm.crops.some(v => !crops.has(v.id))) errors['farm.crops'] = '包含当前游戏中不存在的作物';
  }
  if (Object.keys(errors).length) throw new SettingsError(errors);
  output.ads.noPrivilege = true;
  output.schedule = nativeTaskValues(output, output.schedule);
  return output;
}

export function settingsCatalog(config) {
  const rows = name => config?.tables?.[name]?.data ?? [];
  const option = (value, label = value) => ({ value: String(value), label: String(label) });
  const unique = list => [...new Map(list.map(x => [x.value, x])).values()];
  const buildable = new Set(rows('BuildingUnlockCfg').map(r => r.buildingType));
  const buildings = unique(rows('BuildingCfg').filter(r => !buildable.size || buildable.has(r.buildingType)).map(r => option(r.buildingType, r.name || r.buildingType)));
  const counts = new Map();
  for (const item of buildings) counts.set(item.label, (counts.get(item.label) ?? 0) + 1);
  for (const item of buildings) if (counts.get(item.label) > 1) item.label += `（${item.value}）`;
  const factoryTypes = new Set(rows('BuildingProduceCfg').map(r => r.buildType));
  const materials = unique([...rows('ItemCfg').map(r => option(r.id, r.show_name || r.showName || r.name || r.id)), ...rows('ResourceCfg').map(r => option(r.id, r.show_name || r.id))]);
  return {
    buildings, factories: buildings.filter(r => factoryTypes.has(r.value)),
    guildTech: unique(rows('GuildTechCfg').map(r => option(r.techId, r.name || '科技 ' + r.techId))),
    materials, treasureRewards: treasureRewardOptions(config, materials),
    treasureQualities: Object.entries(treasureQualityLabels).map(([value, label]) => option(value, label)),
    crops: rows('FarmlandPlantCfg').map(r => option(r.id)),
    maps: rows('MuseumExpeditionStageCfg').map(r => option(r.stageId, r.name)),
    heroes: rows('HeroCfg').filter(r => r.universalItemId || r.quality).map(r => ({
      ...option(r.id, r.showName || r.name || r.id), ...(r.type && r.type !== '英雄' ? { hidden: true } : {}),
    })),
    petSpecies: unique(rows('PetBreedCfg').map(r => option(r.spId, rows('PetSpeciesCfg').find(s => s.id === r.spId || s.spId === r.spId)?.name || `海兽种类 ${r.spId}`))),
    radarTypes: [['pirate','击退海盗'],['collect','收集资源'],['refugee','解救难民'],['spy','城战试探'],['fixed','固定情报']].map(([value,label])=>option(value,label)),
    pirateTypes: unique(rows('WorldPirateCfg').map(r=>option(r.type,r.showName))),
    trialRaids: rows('TrialRaidCfg').map(r => option(r.raidId, r.title)),
    demandSources: DEMAND_SOURCES.map(([value, label]) => option(value, label)),
    expeditionFleets: rows('BuildingUnlockCfg').filter(r => r.buildingType === '远征船' && /^[1-9]\d*远征船$/.test(r.buildingId)).map(r => option(r.buildingId, '远征舰队 ' + r.buildingId.replace('远征船', '') + ' 队')),
    cityTargets: Object.entries(config?.tables ?? {}).filter(([name]) => /^\d+_CityCfg$/.test(name)).flatMap(([name, table]) => (table.data ?? []).map(row => option(name.split('_')[0] + ':' + row.id, '场景' + name.split('_')[0] + ' · ' + row.name + '（' + row.id + '）'))),
    forgeBuildings: rows('BuildingUnlockCfg').filter(r => r.buildingType === '装备厂').map(r => option(r.buildingId, r.buildingId)),
    equipQualities: [['GREEN','绿色'],['BLUE','蓝色'],['PURPLE','紫色'],['ORANGE','橙色'],['RED','红色']].map(([v,n])=>option(v,n)),
    petQualities: [['BLUE','蓝色'],['PURPLE','紫色'],['ORANGE','橙色'],['RED','红色']].map(([v,n])=>option(v,n)),
    antiqueQualities: [['BLUE','蓝色'],['PURPLE','紫色'],['ORANGE','橙色'],['RED','红色']].map(([v,n])=>option(v,n)),
    forgeRecipes: rows('BuildingEquipMakeCfg').map(r => option(r.makeId, r.type + ' · ' + (r.costItem ?? []).map(([id, num]) => (config?.materialName?.(id) || id) + '×' + num).join('、') + ' · 赛季' + r.season + '起')),
  };
}

export function loadAutomationSettings(accountId, { file = settingsFile() } = {}) {
  const key = accountKey(accountId);
  const store = readJson(file, { version: SETTINGS_SCHEMA_VERSION, accounts: {} });
  validateSettingsStore(store);
  const entry = Object.hasOwn(store.accounts, key) ? store.accounts[key] : null;
  return loadedSettingsEntry(entry);
}

function loadedSettingsEntry(entry) {
  // The container version cannot identify an untouched account in a mixed
  // store. Entries written before version 2 did not carry their own version.
  const version = entry ? entrySettingsVersion(entry) : SETTINGS_SCHEMA_VERSION;
  const settings = entry ? validateCurrentSettings(migrateSettingsVersion(entry.settings, version, { source: 'stored' }),
    { partial: version === 1 }) : defaultSettings();
  return { settings, revision: entry?.revision ?? 0, savedAt: entry?.savedAt ?? null,
    ...(entry?.recovery ? { recovery: copy(entry.recovery) } : {}) };
}

const validRecovery = recovery => plain(recovery) && recovery.required === true
  && ['missing', 'corrupt'].includes(recovery.reason) && typeof recovery.message === 'string'
  && (recovery.backupFile === undefined || typeof recovery.backupFile === 'string');
const validStoredEntry = entry => plain(entry) && supportedSettingsVersion(entrySettingsVersion(entry));

// Read original bytes ourselves: readJson deliberately hides parse vs I/O failures,
// but only known missing/corrupt settings may be recovered. A higher version is
// checked by content first; incompatible content must never be reset to defaults.
function inspectRecoverableSettings(file, key, expected) {
  let bytes, store;
  try { bytes = fs.readFileSync(file); }
  catch (error) {
    if (error.code === 'ENOENT') return expected ? { reason: 'missing', bytes: null, store: null }
      : { loaded: loadedSettingsEntry(null) };
    throw new Error('无法读取挂机配置，已停止操作且未覆盖原文件', { cause: error });
  }
  try { store = JSON.parse(bytes.toString('utf8')); }
  catch (error) {
    if (error instanceof SyntaxError) return { reason: 'corrupt', bytes, store: null };
    throw error;
  }
  assertCompatibleFutureSettingsStore(store);
  if (!plain(store) || !supportedSettingsVersion(store.version) || !plain(store.accounts)) return { reason: 'corrupt', bytes, store };
  const damagedHeaders = Object.values(store.accounts).some(entry => !validStoredEntry(entry));
  const present = Object.hasOwn(store.accounts, key), entry = present ? store.accounts[key] : null;
  if (!present && expected && newestSettingsVersion(store) > SETTINGS_SCHEMA_VERSION) {
    throw incompatibleSettingsError(new SettingsError({ accounts: '已配置账号的设置条目缺失' }), newestSettingsVersion(store));
  }
  if (!present) return expected ? { reason: 'missing', bytes, store } : damagedHeaders
    ? { reason: 'corrupt', bytes, store, keepTarget: true } : { loaded: loadedSettingsEntry(null) };
  if (!validStoredEntry(entry)) return { reason: 'corrupt', bytes, store };
  if (!Number.isSafeInteger(entry.revision) || entry.revision < 0
    || entry.recovery !== undefined && !validRecovery(entry.recovery)) return { reason: 'corrupt', bytes, store };
  try {
    const loaded = loadedSettingsEntry(entry);
    return damagedHeaders ? { reason: 'corrupt', bytes, store, keepTarget: true } : { loaded };
  }
  catch (error) {
    if (error.fields?.version || error.code === 'SETTINGS_INCOMPATIBLE') throw error;
    return { reason: 'corrupt', bytes, store };
  }
}

// Recovery is explicit and persistent. It supplies disabled defaults to the caller;
// the console must keep automation stopped until the user saves their configuration.
export function loadRecoverableAutomationSettings(accountId, { file = settingsFile(), expected = false } = {}) {
  const key = accountKey(accountId), initial = inspectRecoverableSettings(file, key, expected);
  if (initial.loaded) return initial.loaded;
  return withFileLock(file, () => {
    const state = inspectRecoverableSettings(file, key, expected);
    if (state.loaded) return state.loaded; // Another process already repaired/saved it.
    const accounts = plain(state.store?.accounts) ? { ...state.store.accounts } : {};
    const affected = new Set(state.keepTarget ? [] : [key]);
    // Invalid sibling entry headers would make the rebuilt store unreadable. Only
    // those damaged entries also receive defaults; valid siblings remain verbatim.
    for (const [id, entry] of Object.entries(accounts)) if (!validStoredEntry(entry)) affected.add(id);
    const recovered = new Map();
    for (const id of affected) {
      const prior = accounts[id], revision = Number.isSafeInteger(prior?.revision) && prior.revision >= 0 ? prior.revision + 1 : 1;
      if (!Number.isSafeInteger(revision)) throw new Error('挂机配置版本计数超出范围，已停止恢复且未覆盖原文件');
      const reason = id === key ? state.reason : 'corrupt';
      const recovery = { required: true, id: randomUUID(), reason,
        message: reason === 'missing' ? '挂机配置缺失，已恢复默认设置并关闭自动挂机，请重新配置后保存。'
          : '挂机配置损坏，已恢复默认设置并关闭自动挂机，请重新配置后保存。' };
      recovered.set(id, { revision, savedAt: new Date().toISOString(), settingsVersion: SETTINGS_SCHEMA_VERSION,
        settings: defaultSettings(), recovery });
    }
    let backupFile;
    if (state.bytes !== null) {
      backupFile = path.resolve(file + '.corrupt-' + Date.now() + '-' + randomUUID() + '.bak');
      let descriptor;
      try {
        descriptor = fs.openSync(backupFile, 'wx', 0o600);
        fs.writeFileSync(descriptor, state.bytes); fs.fsyncSync(descriptor);
      } catch (error) {
        throw new Error('备份挂机配置失败，已停止恢复且未覆盖原文件', { cause: error });
      } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
    }
    for (const [id, entry] of recovered) {
      if (backupFile) entry.recovery.backupFile = backupFile;
      Object.defineProperty(accounts, id, { value: entry, enumerable: true, configurable: true, writable: true });
    }
    const next = { ...(plain(state.store) ? state.store : {}), version: newestSettingsVersion(state.store), accounts };
    atomicJson(file, next);
    return loadedSettingsEntry(accounts[key]);
  });
}

export function saveAutomationSettings(accountId, input, { revision, file = settingsFile(), catalog = null, expectedRecoveryId } = {}) {
  const settings = validateSettings(input, { catalog });
  const key = accountKey(accountId);
  return withFileLock(file, () => {
    const store = readJson(file, { version: SETTINGS_SCHEMA_VERSION, accounts: {} });
    validateSettingsStore(store);
    const current = Object.hasOwn(store.accounts, key) ? store.accounts[key] : null;
    if (current?.recovery?.id !== expectedRecoveryId)
      throw new SettingsError({ revision: '配置恢复状态已变化，请重新载入配置后再保存' });
    if (!Number.isSafeInteger(revision) || revision !== (current?.revision ?? 0)) throw new SettingsError({ revision: '设置已在其他页面更新，请重新载入后再保存' });
    const entry = { ...current, revision: revision + 1, savedAt: new Date().toISOString(),
      settingsVersion: Math.max(SETTINGS_SCHEMA_VERSION, current ? entrySettingsVersion(current) : 1), settings };
    delete entry.recovery;
    Object.defineProperty(store.accounts, key, { value: entry, enumerable: true, configurable: true, writable: true });
    store.version = newestSettingsVersion(store);
    atomicJson(file, store);
    return { revision: entry.revision, savedAt: entry.savedAt, settings: copy(settings) };
  });
}

export function exportAutomationSettings(settings) { return { format: SETTINGS_FORMAT, version: SETTINGS_SCHEMA_VERSION, settings: validateSettings(settings) }; }
export function importAutomationSettings(document, options) {
  if (!plain(document) || ![SETTINGS_FORMAT, LEGACY_SETTINGS_FORMAT].includes(document.format) || !supportedSettingsVersion(document.version) || Object.keys(document).some(k => !['format', 'version', 'settings'].includes(k))) throw new SettingsError({ import: '请选择本工具导出的配置文件，版本须为正整数，文件不能包含账号或凭据' });
  return validateSettings(migrateSettingsVersion(document.settings, document.version), { ...options, partial: false });
}

const settingsMigrations = new Map([[1, migrateVersion1Settings], [2, migrateVersion2Settings], [3, migrateVersion3Settings], [4, migrateVersion4Settings], [5, migrateVersion5Settings], [6, migrateVersion6Settings], [7, migrateVersion7Settings], [8, migrateVersion8Settings], [9, migrateVersion9Settings], [10, migrateVersion10Settings], [11, migrateVersion11Settings], [12, migrateVersion12Settings], [13, migrateVersion13Settings], [14, migrateVersion14Settings], [15, migrateVersion15Settings], [16, migrateVersion16Settings], [17, migrateVersion17Settings]]);
const supportedSettingsVersion = version => Number.isSafeInteger(version) && version >= 1;
const entrySettingsVersion = entry => Object.hasOwn(entry, 'settingsVersion') ? entry.settingsVersion : 1;
function newestSettingsVersion(store) {
  const versions = [store?.version, ...(plain(store?.accounts) ? Object.values(store.accounts).map(entry => entry?.settingsVersion) : [])];
  return versions.reduce((highest, version) => typeof version === 'number' && version > highest ? version : highest, SETTINGS_SCHEMA_VERSION);
}
function incompatibleSettingsError(cause, version) {
  if (cause.code === 'SETTINGS_INCOMPATIBLE') return cause;
  const fields = cause.fields ?? { settings: cause.message };
  const error = new SettingsError(fields);
  const details = Object.entries(fields).slice(0, 3).map(([field, message]) => `${field}：${message}`).join('；');
  error.message = `挂机配置自动兼容失败（文件版本 ${version}，当前格式 ${SETTINGS_SCHEMA_VERSION}）：${details}；已停止操作且未覆盖原文件`;
  return Object.assign(error, { code: 'SETTINGS_INCOMPATIBLE', settingsVersion: version, supportedVersion: SETTINGS_SCHEMA_VERSION, cause });
}
// Validation may add defaults, but a newer format must not silently lose any
// supplied field or change an explicit value through an older normalizer.
function assertSettingsPreserved(input, output, field = 'settings') {
  if (plain(input) || Array.isArray(input)) {
    if (Array.isArray(input) ? !Array.isArray(output) : !plain(output)) {
      throw new SettingsError({ [field]: '设置结构无法无损兼容' });
    }
    for (const key of Object.keys(input)) {
      const next = field === 'settings' ? key : field + '.' + key;
      if (!Object.hasOwn(output, key)) throw new SettingsError({ [next]: '当前程序无法保留此设置项' });
      assertSettingsPreserved(input[key], output[key], next);
    }
  } else if (!Object.is(input, output)) {
    throw new SettingsError({ [field]: '当前程序无法保留此设置值' });
  }
}
function compatibleFutureSettings(settings, version) {
  try {
    const normalized = validateCurrentSettings(settings);
    assertSettingsPreserved(settings, normalized);
    return normalized;
  } catch (error) { throw incompatibleSettingsError(error, version); }
}
function assertCompatibleFutureSettingsStore(store) {
  const version = newestSettingsVersion(store);
  if (version <= SETTINGS_SCHEMA_VERSION) return;
  try {
    if (!plain(store) || !supportedSettingsVersion(store.version)) throw new SettingsError({ version: '设置文件版本须为正整数' });
    if (!plain(store.accounts)) throw new SettingsError({ accounts: '账号设置必须是对象' });
    for (const entry of Object.values(store.accounts)) {
      if (!validStoredEntry(entry)) throw new SettingsError({ settingsVersion: '账号设置版本须为正整数' });
      if (!Number.isSafeInteger(entry.revision) || entry.revision < 0) throw new SettingsError({ revision: '账号设置修订号无效' });
      if (entry.recovery !== undefined && !validRecovery(entry.recovery)) throw new SettingsError({ recovery: '账号设置恢复标记无效' });
      loadedSettingsEntry(entry);
    }
  } catch (error) { throw incompatibleSettingsError(error, version); }
}
function validateSettingsStore(store) {
  assertCompatibleFutureSettingsStore(store);
  if (!plain(store) || !supportedSettingsVersion(store.version) || !plain(store.accounts)
    || Object.values(store.accounts).some(entry => !plain(entry) || !supportedSettingsVersion(entrySettingsVersion(entry)))) {
    throw new Error('设置文件格式或版本不支持，未覆盖原文件');
  }
}

// Upgrade one version at a time. New semantic changes require a new migration;
// changing defaults alone must not overwrite a user's valid saved choices.
export function migrateSettingsVersion(settings, version, { source = 'import' } = {}) {
  if (!supportedSettingsVersion(version)) throw new SettingsError({ version: '设置文件版本不支持' });
  if (!['import', 'stored'].includes(source)) throw new TypeError('未知设置迁移来源');
  if (version > SETTINGS_SCHEMA_VERSION) return compatibleFutureSettings(settings, version);
  let result = settings;
  for (let current = version; current < SETTINGS_SCHEMA_VERSION; current++) {
    const migrate = settingsMigrations.get(current);
    if (!migrate) throw new SettingsError({ version: '缺少设置版本升级规则，已停止读取' });
    result = migrate(result, { source });
  }
  return result;
}

// Version 1 grew by adding fields. Import permits only the historical additions
// listed here; stored partial settings retain their original default-fill rules.
function migrateVersion1Settings(settings, { source }) {
  if (!plain(settings)) return settings;
  const input = { ...settings };
  if (plain(input.weeklyActivity)) input.weeklyActivity = migrateWeeklyActivitySettings(input.weeklyActivity);
  if (plain(input.heroes) && !Object.hasOwn(input.heroes, 'needsSelection')) {
    input.heroes = { ...input.heroes, needsSelection: !input.heroes.heroIds?.length };
    if (input.schedule?.heroGrowth && input.heroes.needsSelection && plain(input.loop)) input.loop = { ...input.loop, heroes: true };
  }
  if (plain(input.schedule) && Object.hasOwn(input.schedule, 'weekFactory')) {
    // Factory construction now follows the existing building switches. Retiring
    // the separate priority task must not enable or disable either action.
    input.schedule = { ...input.schedule };
    delete input.schedule.weekFactory;
  }
  if (!Object.hasOwn(input, 'progression')) {
    input.progression = { ...DEFAULT_SETTINGS.progression, mainline: input.schedule?.stageAuto === true };
  }
  if (plain(input.cityWar)) {
    input.cityWar = { ...input.cityWar };
    if (!Object.hasOwn(input.cityWar, 'fleetStrategies')) input.cityWar.fleetStrategies = {};
    for (const [field, legacy] of [['defenceTargetMode', 'targetMode'], ['defenceTargetPriority', 'targetPriority'], ['defenceCityRefs', 'cityRefs']]) {
      if (!Object.hasOwn(input.cityWar, field)) {
        input.cityWar[field] = copy(Object.hasOwn(input.cityWar, legacy) ? input.cityWar[legacy] : DEFAULT_SETTINGS.cityWar[legacy]);
      }
    }
  }
  if (source === 'stored') return input;

  const addedGroups = ['fleetSpeed', 'login', 'treasure', 'cityWar', 'forge', 'antique', 'trials', 'pirateHunt',
    'radar', 'worldBoss', 'pirateSweep', 'eventActions', 'activityAutomation', 'weeklyActivity', 'merchant', 'weekOrder', 'ads', 'appointments', 'lineups', ...Object.keys(EXTENDED_DEFAULTS)];
  for (const group of addedGroups) {
    if (!Object.hasOwn(input, group)) input[group] = copy(DEFAULT_SETTINGS[group]);
  }
  for (const group of ['login', 'merchant', 'activityAutomation', 'weeklyActivity', 'antique', 'pirateHunt', 'appointments', ...Object.keys(EXTENDED_DEFAULTS)]) {
    if (plain(input[group])) input[group] = { ...copy(DEFAULT_SETTINGS[group]), ...input[group] };
  }
  const addedFields = {
    heroes: ['skillAdvance','exclusiveLevel','exclusiveStar','equipment','badge','showSkillReward'],
    treasure: ['avoidPlayerIds', 'participationMode', 'repeatAttack', 'autoRepair',
      'marchSpeedUp', 'marchTargetSeconds', 'dailyDiamondLimit',
      'personalProgressLimit', 'fallbackEnabled', 'fallbackAfter',
      'fallbackTargetRewards', 'fallbackQualities', 'fallbackMediumRewardPriority', 'fallbackSmallRewardPriority'],
    cityWar: ['targetPriority', 'nativeCommissionLimit', 'defenceFleetIds'],
    events: ['otherOption'],
    pet: ['release', 'releaseQualities'],
    forge: ['decompose', 'decomposeQualities'],
    gather: ['enabled', 'fishBook', 'antiqueFloaters'],
    museum: ['runEnabled'],
    radar: ['runEnabled'],
    factory: ['checkEverySeconds'],
    weekOrder: ['enabled'],
  };
  for (const [group, fields] of Object.entries(addedFields)) {
    if (!plain(input[group])) continue;
    input[group] = { ...input[group] };
    for (const field of fields) {
      if (!Object.hasOwn(input[group], field)) input[group][field] = copy(DEFAULT_SETTINGS[group][field]);
    }
  }
  if (plain(input.schedule)) input.schedule = { ...taskSettings(), worldOnlineRewards: false, ...input.schedule };
  return input;
}

// Version 3 retires petrol reserves and spending limits. Dispatch/repair still
// checks actual stock and keeps its pending-operation accounting at runtime.
function migrateVersion2Settings(settings) {
  if (!plain(settings)) return settings;
  const input = { ...settings };
  const retired = {
    worldBoss: ['petrolReserve'], radar: ['petrolReserve', 'dailyPetrolLimit'],
    pirateHunt: ['petrolReserve', 'fuelBudget'],
    treasure: ['petrolReserve', 'maxRepairCost', 'dailyRepairPetrolLimit'],
    cityWar: ['petrolReserve', 'maxRepairCost', 'dailyPetrolLimit'],
    silicon: ['petrolReserve', 'dailyPetrolLimit'],
  };
  for (const [group, fields] of Object.entries(retired)) {
    if (!plain(input[group])) continue;
    input[group] = { ...input[group] };
    for (const field of fields) delete input[group][field];
  }
  if (Array.isArray(input.silicon?.fleets)) {
    input.silicon.fleets = input.silicon.fleets.map(fleet => {
      if (!plain(fleet)) return fleet;
      const row = { ...fleet };
      delete row.maxRepairCost;
      return row;
    });
  }
  return input;
}

// Version 4 keeps per-fleet/per-action speed-up budgets and the global diamond
// budget, retiring only the additional shared city-war speed-up budget.
function migrateVersion3Settings(settings) {
  if (!plain(settings) || !plain(settings.fleetSpeed)) return settings;
  const input = { ...settings, fleetSpeed: { ...settings.fleetSpeed } };
  delete input.fleetSpeed.dailyDiamondLimit;
  return input;
}

// Version 5 consolidates the duplicate museum, pet and radar task switches.
// Modern settings already took precedence, so never merge dormant legacy
// actions into an active module. Native selections without an exact modern
// spending target wait for an explicit species/fleet selection.
function migrateVersion4Settings(settings) {
  if (!plain(settings)) return settings;
  const input = { ...settings };
  const schedule = plain(input.schedule) ? input.schedule : {};
  const museumLegacy = schedule.museumCollect === true || schedule.museumExplore === true;
  if (plain(input.museum) || !Object.hasOwn(input, 'museum') && museumLegacy) {
    const museum = { ...(input.museum ?? DEFAULT_SETTINGS.museum) };
    if (!Object.hasOwn(input, 'museum')) { delete museum.revenue; delete museum.achievements; }
    if (museum.enabled === false && museumLegacy) {
      Object.assign(museum, { enabled: true, claim: schedule.museumCollect === true, explore: schedule.museumExplore === true,
        maxDispatches: 1, factor: 1, materialFactor: false, maps: [], useGuide: false, dailyGuideLimit: 0 });
    } else {
      for (const key of ['claim', 'explore']) if (!Object.hasOwn(museum, key)) museum[key] = museum.enabled === true;
      if (!Object.hasOwn(museum, 'maxDispatches')) museum.maxDispatches = museum.enabled === true ? 0 : 1;
    }
    input.museum = museum;
  }
  const petLegacy = schedule.petCollect === true || schedule.petBreed === true;
  if ((plain(input.pet) && input.pet.enabled === false || !Object.hasOwn(input, 'pet')) && petLegacy) {
    input.pet = { ...(input.pet ?? DEFAULT_SETTINGS.pet), enabled: true, claim: schedule.petCollect === true,
      breed: schedule.petBreed === true, species: [], quality: 'ORANGE', universal: false, feed: false, advance: false,
      release: false, releaseQualities: [] };
  }
  const radarLegacy = schedule.radarAuto === true || schedule.radarRepair === true;
  if (plain(input.radar) || !Object.hasOwn(input, 'radar') && radarLegacy) {
    const radar = { ...(input.radar ?? DEFAULT_SETTINGS.radar) };
    if (radar.enabled === false && radarLegacy) {
      Object.assign(radar, { enabled: schedule.radarAuto === true, repairIdle: schedule.radarRepair === true,
        fleetIds: [], types: [...DEFAULT_SETTINGS.radar.types], allowMaterials: false, minDurabilityPercent: 80 });
    } else if (!Object.hasOwn(radar, 'repairIdle')) radar.repairIdle = false;
    input.radar = radar;
  }
  if (plain(input.schedule)) {
    input.schedule = { ...input.schedule };
    for (const key of ['museumCollect', 'museumExplore', 'petCollect', 'petBreed', 'radarAuto', 'radarRepair']) delete input.schedule[key];
  }
  return input;
}

// Version 6 makes exploration and reward collection one operation again.
// A previously empty or paused configuration remains off; either selected
// action under an enabled module becomes the unified exploration workflow.
function migrateVersion5Settings(settings) {
  if (!plain(settings) || !plain(settings.museum)) return settings;
  const museum = { ...settings.museum };
  if (museum.enabled === true && (Object.hasOwn(museum, 'claim') || Object.hasOwn(museum, 'explore'))) {
    museum.enabled = museum.claim === true || museum.explore === true;
  }
  delete museum.claim;
  delete museum.explore;
  return { ...settings, museum };
}

// Version 7 gives the museum its own reward and display controls. Existing
// exploration included popularity achievements; preserve that choice once,
// then let the independent achievement switch own all future collections.
function migrateVersion6Settings(settings) {
  if (!plain(settings)) return settings;
  const input = { ...settings };
  if (plain(input.museum) || !Object.hasOwn(input, 'museum') && (input.schedule?.museumRevenue === true || input.schedule?.museumAchievements === true)) {
    const museum = { ...(input.museum ?? DEFAULT_SETTINGS.museum) };
    if (!Object.hasOwn(input.museum ?? {}, 'revenue')) museum.revenue = input.schedule?.museumRevenue === true;
    if (!Object.hasOwn(input.museum ?? {}, 'achievements')) museum.achievements = museum.enabled === true || input.schedule?.museumAchievements === true;
    if (!Object.hasOwn(museum, 'display')) museum.display = false;
    if (!Object.hasOwn(museum, 'factorMode')) museum.factorMode = 'materials';
    if (!Object.hasOwn(museum, 'fullRecommendedFactor')) museum.fullRecommendedFactor = 3;
    if (!Object.hasOwn(museum, 'partialRecommendedFactor')) museum.partialRecommendedFactor = 2;
    input.museum = museum;
  }
  if (plain(input.schedule)) {
    input.schedule = { ...input.schedule };
    delete input.schedule.museumRevenue;
    delete input.schedule.museumAchievements;
  }
  return input;
}

// Version 8 separates zero recommended heroes from partially recommended
// teams. Preserve the previous fallback only for saved recommendation mode;
// new accounts keep it off and use a one-times factor when they opt in.
function migrateVersion7Settings(settings) {
  if (!plain(settings) || !plain(settings.museum)) return settings;
  const museum = { ...settings.museum };
  const legacyRecommended = museum.factorMode === 'recommended' && !Object.hasOwn(museum, 'noRecommendedFallback');
  if (!Object.hasOwn(museum, 'noRecommendedFallback')) museum.noRecommendedFallback = legacyRecommended;
  if (!Object.hasOwn(museum, 'noRecommendedFactor')) museum.noRecommendedFactor = legacyRecommended ? museum.partialRecommendedFactor ?? 2 : 1;
  return { ...settings, museum };
}

// Version 9 exposes claim/start separately without changing existing forge
// behavior. Native automation always requires an explicit opt-in.
function migrateVersion8Settings(settings) {
  if (!plain(settings) || !plain(settings.forge)) return settings;
  const forge = { ...settings.forge };
  for (const key of ['nativeAuto', 'collect', 'craft']) {
    if (!Object.hasOwn(forge, key)) forge[key] = DEFAULT_SETTINGS.forge[key];
  }
  return { ...settings, forge };
}

// Version 10 unifies the world Boss reward switches. Either old switch could
// enable claims; preserve that choice once without enabling fleet dispatch.
function migrateVersion9Settings(settings) {
  if (!plain(settings) || !plain(settings.schedule) || !Object.hasOwn(settings.schedule, 'worldBossDamage')) return settings;
  const schedule = { ...settings.schedule };
  for (const key of ['worldBossDamage', 'worldBossRewards']) {
    if (Object.hasOwn(schedule, key) && typeof schedule[key] !== 'boolean') {
      throw new SettingsError({ ['schedule.' + key]: '开关值必须为 true 或 false' });
    }
  }
  schedule.worldBossRewards = schedule.worldBossRewards === true || schedule.worldBossDamage === true;
  delete schedule.worldBossDamage;
  return { ...settings, schedule };
}

// Version 11 adds optional per-fleet boss formations. Existing accounts keep
// their fleet selection and continue using each fleet's saved formation.
function migrateVersion10Settings(settings) {
  if (!plain(settings) || !plain(settings.worldBoss) || Object.hasOwn(settings.worldBoss, 'fleetPresets')) return settings;
  return { ...settings, worldBoss: { ...settings.worldBoss, fleetPresets: [] } };
}

// Version 12 introduces opt-in resource field dispatch. Preserve task order and
// append the new task without enabling it for any existing account.
function migrateVersion11Settings(settings) {
  if (!plain(settings)) return settings;
  const next = { ...settings };
  if (!Object.hasOwn(next, 'resourceFields')) next.resourceFields = copy(DEFAULT_SETTINGS.resourceFields);
  if (Array.isArray(next.fleetDispatch?.priority) && !next.fleetDispatch.priority.includes('resourceFields')) {
    next.fleetDispatch = { ...next.fleetDispatch, priority: [...next.fleetDispatch.priority, 'resourceFields'] };
  }
  return next;
}

// Version 13 retires per-repair / per-journey diamond caps. Daily budgets,
// explicit switches and existing usage remain unchanged.
function migrateVersion12Settings(settings) {
  if (!plain(settings) || !Array.isArray(settings.fleetSpeed?.fleets)) return settings;
  return { ...settings, fleetSpeed: { ...settings.fleetSpeed, fleets: settings.fleetSpeed.fleets.map(fleet => {
    if (!plain(fleet)) return fleet;
    const row = { ...fleet };
    delete row.repairMaxDiamonds; delete row.marchMaxDiamonds;
    return row;
  }) } };
}

// Version 14 records the follow mode. Keep the historical trigger behavior when
// absent, and preserve an explicit choice from files already saved as version 14.
function migrateVersion13Settings(settings) {
  if (!plain(settings) || !plain(settings.treasure) || Object.hasOwn(settings.treasure, 'followMode')) return settings;
  return { ...settings, treasure: { ...settings.treasure, followMode: 'trigger' } };
}

// 旧配置优先一种资源，同时允许占领其他资源，因此为三类资源保留正权重。
function migrateVersion14Settings(settings) {
  if (!plain(settings?.resourceFields) || !Object.hasOwn(settings.resourceFields, 'preferredResource')) return settings;
  const { preferredResource, ...fields } = settings.resourceFields;
  if (!Object.values(resourceFieldIds).includes(preferredResource)) throw new SettingsError({ 'resourceFields.preferredResource': '请选择有效资源' });
  const ratios = Object.fromEntries(Object.entries(resourceFieldIds).map(([key, id]) => [key, id === preferredResource ? 3 : 1]));
  return { ...settings, resourceFields: { allocationMode: 'ratio', ratios, quotas: { ...defaultResourceFieldAmounts }, ...fields } };
}

// 旧开关关闭或缺失时允许全部三种货轮；保留已显式选择的新列表，包括空选。
function migrateVersion15Settings(settings) {
  if (!plain(settings?.treasure)) return settings;
  const previous = settings.treasure;
  const hasLegacy = Object.hasOwn(previous, 'onlyTenThousand');
  if (!hasLegacy && Object.hasOwn(previous, 'qualities')) return settings;
  if (hasLegacy && typeof previous.onlyTenThousand !== 'boolean') {
    throw new SettingsError({ 'treasure.onlyTenThousand': '开关值必须为 true 或 false' });
  }
  const { onlyTenThousand, ...treasure } = previous;
  if (!Object.hasOwn(treasure, 'qualities')) treasure.qualities = onlyTenThousand ? ['ORANGE'] : ['ORANGE', 'PURPLE', 'BLUE'];
  return { ...settings, treasure };
}

function migrateVersion16Settings(settings) {
  if (!plain(settings?.fleetSpeed) || !Object.hasOwn(settings.fleetSpeed, 'enabled')) return settings;
  const { enabled, ...fleetSpeed } = settings.fleetSpeed;
  return { ...settings, fleetSpeed };
}

function migrateVersion17Settings(settings) {
  if (!plain(settings?.cityWar) || !Object.hasOwn(settings.cityWar, 'dailyDispatchLimit')) return settings;
  const { dailyDispatchLimit, ...cityWar } = settings.cityWar;
  return { ...settings, cityWar };
}
