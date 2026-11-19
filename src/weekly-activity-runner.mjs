import { createWeeklyActivityContext } from './weekly-activity.mjs';
import { createActionGuard, AutomationSkip } from './automation-policy.mjs';
import { surveyWorld, planWorld, runWorldRound } from './world.mjs';
import { surveyBaseAutomation, planBaseAutomation, runBaseAutomation } from './base-automation.mjs';
import { serviceGuildOrders } from './guild-orders.mjs';
import { serviceCargo } from './cargo.mjs';
import { runEquipmentForge } from './equipment-forge.mjs';
import { runAntiqueUpgrade } from './antique-upgrade.mjs';
import { readHeroGrowthPlan, runHeroPlan, heroStepLabel } from './heroes.mjs';

const requestWrites = new Set([
  'FinishGuildOrderRequest', 'FinishWorkerOrderRequest', 'FarmHarvestRequest', 'FarmPlantRequest',
  'FarmSpeedUpRequest', 'PickMadeEquipRequest', 'MakeEquipRequest', 'HeroStarUpRequest',
  'GetMaturePetRequest', 'PetBreedRequest', 'AntiqueStarUpRequest', 'AntiqueSuitLevelUpRequest', 'SetAutoFarmingRequest',
  'FillCargoShipRequest', 'DrawShipRewardRequest', 'SpeedUpFactoryProduceRequest',
]);
const scopedClients = new WeakMap();

// Keep one proxy per connection so the reused planners' push listeners and
// pending-operation WeakMaps retain their identity across idle rounds. Methods
// still run on the real client; readback is always allowed to settle sent writes.
export function weeklyActionClient(client, beforeAction) {
  let state = scopedClients.get(client);
  if (!state) {
    state = { beforeAction: null, stopped: true, proxy: null };
    state.proxy = new Proxy(client, {
      get(target, key) {
        if (key === 'request' || key === 'sendWatch') return async (...args) => {
          if (key === 'sendWatch' || requestWrites.has(args[0])) {
            try {
              if (state.stopped || !state.beforeAction) throw new AutomationSkip('周活动已停止');
              await state.beforeAction(args[0]);
              if (state.stopped) throw new AutomationSkip('周活动已停止');
            } catch (error) {
              state.stopped = true;
              error.notSent = true;
              throw error;
            }
          }
          return target[key](...args);
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    scopedClients.set(client, state);
  }
  state.beforeAction = beforeAction;
  state.stopped = false;
  return { client: state.proxy, enabled: () => !state.stopped,
    close: () => { state.stopped = true; state.beforeAction = null; } };
}

const qualityRank = { GREEN: 0, BLUE: 1, PURPLE: 2, ORANGE: 3, RED: 4 };
export function weeklyForgeRecipes(ids, config, order) {
  const rows = name => config?.tables?.[name]?.data ?? [];
  const rank = id => {
    const recipe = rows('BuildingEquipMakeCfg').find(row => row.makeId === Number(id));
    const material = recipe?.costItem?.find(row => row[0] !== 'GOLD')?.[0];
    return qualityRank[rows('ItemCfg').find(row => row.id === material)?.quality] ?? null;
  };
  return [...ids].sort((a, b) => {
    const left = rank(a), right = rank(b);
    if (left === null || right === null) return left === right ? 0 : left === null ? 1 : -1;
    return (order === 'desc' ? -1 : 1) * (left - right);
  });
}

// Only verified scoring actions are enabled by the weekly runner. Preserve
// selections and budgets; do not turn a missing selection into "everything".
export function weeklyActivityActionSettings(context, config) {
  const settings = structuredClone(context.settings);
  settings.pet.release = false;
  settings.forge.decompose = false;
  if (context.kind === 'pet') {
    settings.pet.feed = false; settings.pet.advance = false;
    settings.museum.enabled = false; settings.museum.upgrade = false; settings.museum.runEnabled = false;
    settings.gold.enabled = false; settings.events.enabled = false; settings.gather.enabled = false;
  }
  if (context.kind === 'antique') {
    settings.antique.activate = false; settings.antique.master = false;
  }
  if (context.kind === 'hero') {
    for (const key of ['level', 'skill', 'skillAdvance', 'exclusiveLevel', 'exclusiveStar', 'equipment', 'badge', 'showSkillReward']) settings.heroes[key] = false;
  }
  if (context.kind === 'forge') settings.forge.recipeIds = weeklyForgeRecipes(settings.forge.recipeIds, config, settings.weeklyActivity.forgeQualityOrder);
  return settings;
}

export async function runWeeklyActivity(client, protocol, config, player, {
  getSettings, ledger, enabled = () => true, report = () => {},
} = {}) {
  const context = await createWeeklyActivityContext(client, config, player, { getSettings, enabled, report });
  if (!context) return { kind: null, results: [], notes: [] };
  const settings = weeklyActivityActionSettings(context, config);
  const scope = weeklyActionClient(client, name => context.beforeAction(name));
  const connection = scope.client;
  const active = () => scope.enabled() && context.enabled();
  const current = () => settings;
  const results = [], notes = [];
  const emit = entry => {
    const row = { ...entry, category: '周活动', label: entry.label ?? entry.title ?? entry.step?.label ?? '周活动',
      title: entry.title ?? entry.label ?? entry.step?.label ?? '周活动' };
    results.push(row); report(row);
  };
  const note = reason => { notes.push(reason); emit({ skipped: true, reason }); };
  const guard = createActionGuard(connection, current, ledger, { enabled: active, player });
  try {
    if (!ledger) { note('缺少账号用量记录，暂不执行周活动'); return { kind: context.kind, results, notes }; }
    if (context.kind === 'farm' || context.kind === 'order') {
      const allowed = kind => active() && (context.kind === 'farm' ? kind === 'farm' : ['finishOrder', 'speedUpProduce'].includes(kind));
      const survey = await surveyWorld(connection, protocol, { config, player, includeWeekOrder: true,
        includeCargo: settings.cargo.enabled, includeProductionTiming: false });
      const plan = planWorld(survey, { config, settings, usage: ledger.snapshot(), enabled: allowed,
        allowSpeedUp: context.kind === 'farm' ? settings.weeklyActivity.farmSpeedUp : settings.factory.speedUp || settings.factory.speedUpSources.length > 0 });
      await runWorldRound(connection, protocol, plan, { config, player, settings, getSettings: current,
        getUsage: () => ledger.snapshot(), allowMutate: true, enabled: allowed,
        cargoEnabled: () => settings.cargo.enabled, finishEnabled: () => allowed('finishOrder'),
        beforeStep: guard.before, afterStep: guard.after, cancelStep: guard.cancel, onStep: emit });
      if (!plan.actions.length) note(context.kind === 'farm'
        ? '农田暂无符合种植目标的收获、种植或加速动作'
        : plan.notes.join('；') || '当前没有材料齐全且符合筛选条件的居民订单');
      if (context.kind === 'farm' && settings.weeklyActivity.farmRecruitTimes > 0 && active()) {
        await serviceGuildOrders(connection, protocol, config, { player, getSettings: current, ledger,
          enabled: active, dailyLimit: settings.weeklyActivity.farmRecruitTimes, report: emit });
      }
      if (context.kind === 'order' && settings.cargo.enabled && active()) {
        await serviceCargo(connection, config, { enabled: active, getSettings: current, ledger,
          beforeAction: guard.before, afterAction: guard.after, cancelAction: guard.cancel,
          log: (title, details = {}) => emit({ title, ok: !details.skipped, ...details }) });
      }
    } else if (context.kind === 'pet') {
      if (!settings.pet.species.length) note('请先在海兽配置选择培育物种和最高品质');
      const water = await surveyWorld(connection, protocol, { config, player, includeWeekOrder: true, includeProductionTiming: false });
      const snapshot = await surveyBaseAutomation(connection, protocol, config, player, settings, water, { ledger, enabled: active });
      const plan = planBaseAutomation(snapshot, config, settings, ledger.snapshot(), { petQualityOrder: settings.weeklyActivity.petQualityOrder });
      plan.actions = plan.actions.filter(step => ['petClaim', 'petBreed'].includes(step.kind));
      await runBaseAutomation(connection, protocol, config, plan, { player, getSettings: current, ledger, enabled: active, onStep: emit });
      if (!plan.actions.length && settings.pet.species.length) note(plan.notesBySetting?.['pet.breed']?.join('；') || '海兽队列、材料或品质条件暂不满足');
    } else if (context.kind === 'forge') {
      if (settings.forge.nativeAuto) note('已选择游戏原生自动锻造，周活动配方、品质和积分停止规则不参与；原生开关由装备挂机总开关同步');
      else if (!settings.forge.buildingIds.length || !settings.forge.recipeIds.length) note('请先在装备配置选择工厂和配方；无需开启普通自动锻造');
      else {
        const result = await runEquipmentForge(connection, protocol, config, player, { getSettings: current, ledger, enabled: active, onStep: emit });
        if (result.notes?.length) note(result.notes.join('；'));
      }
    } else if (context.kind === 'antique') {
      if (!settings.antique.starQualities.length && !settings.antique.suitQualities.length) note('请先在藏品配置选择升星或套装升级的品质；无需开启普通养成开关，周活动只执行消耗藏品碎片或藏品经验的养成');
      else {
        const result = await runAntiqueUpgrade(connection, protocol, config, player, { getSettings: current, ledger, enabled: active, onStep: emit });
        if (result.notes?.length) note(result.notes.join('；'));
      }
    } else if (context.kind === 'hero') {
      if (!settings.heroes.heroIds.length) note('请先在英雄配置选择英雄；无需开启普通养成或升星开关，周日活动仅执行已核实计分的升星');
      else {
        const { plan } = await readHeroGrowthPlan(connection, config, player, settings);
        plan.steps = plan.steps.filter(step => step.kind === 'star');
        await runHeroPlan(connection, protocol, plan, { allowMutate: true, config, player,
          enabled: active, getSettings: current, beforeAction: guard.before, afterAction: guard.after,
          cancelAction: guard.cancel, onStep: entry => emit({ ...entry, title: heroStepLabel(entry.step, entry.targetLevel) }) });
        if (!plan.steps.length) note('所选英雄暂无符合目标、碎片和保留量限制的升星动作');
      }
    }
  } finally { scope.close(); }
  return { kind: context.kind, results, notes };
}
