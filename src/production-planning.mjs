import { optimizeProductionSchedule } from './production-optimizer.mjs';
import { createProductionTiming } from './production-timing.mjs';
import { resourceReserve, worldPreferenceEnabled } from './automation-policy.mjs';
import { activityProductionEnabled } from './activity-automation.mjs';
import { createProductionEligibility } from './production-eligibility.mjs';

const rows = (config, key) => config?.tables?.[key]?.data ?? [];
const sourceNames = { resident: '居民订单', merchant: '不差钱商人', cargo: '贸易港', guildRecruit: '联盟募兵',
  heroRaid: '超凡英雄', refugee: '难民订单', building: '建筑备料', museum: '博物馆', guildShip: '联盟商船',
  petAdvance: '海兽进阶', petFeed: '海兽投喂', factory: '常规备货' };
const timingNames = { observed: '会话实测', server: '服务器完成时刻', 'effects-estimate': '加成公式估算', 'config-estimate': '配置耗时估算' };
const unique = values => [...new Set(values)];

function dependencyItems(orders, recipes) {
  const byItem = new Map(recipes.map(recipe => [recipe.productId, recipe]));
  const found = new Set();
  const visit = id => {
    if (found.has(id)) return;
    found.add(id);
    for (const input of byItem.get(id)?.costs ?? []) visit(input.id);
  };
  for (const order of orders) for (const item of order.requirements) visit(item.id);
  return found;
}

/** Convert a complete read into a fixed scheduling model without changing it. */
export function buildProductionModel(snapshot, config, settings, { pendingMaterials = [] } = {}) {
  const now = snapshot.serverNow;
  const relative = time => Math.max(0, (time ?? now) - now);
  const timing = createProductionTiming({ config, ...snapshot.timing, serverNow: now });
  const prioritySources = unique(settings.factory?.demandPriority ?? []);
  const orderRows = snapshot.orders.filter(order => activityProductionEnabled(settings, order.source)).filter(order => order.kind === 'order'
    || order.kind === 'consumption' && prioritySources.includes(order.source)
      && (order.source !== 'building' || settings.building?.supply && worldPreferenceEnabled(settings, 'buildSupply')))
    .map(order => ({ ...order, priority: prioritySources.includes(order.source)
      ? prioritySources.indexOf(order.source) : prioritySources.length }))
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const priorityLabels = new Map([...new Set(orderRows.map(order => order.priority))].map(priority => [priority,
    unique(orderRows.filter(order => order.priority === priority).map(order => sourceNames[order.source] || order.source)).join('、')]));
  const missingReads = snapshot.missingReads.map(read => read.request + ' · ' + read.reason);
  const notes = [];
  const timingByJob = new Map();
  const machines = [], incoming = [], fixedTimeline = [];
  let capacityEstimated = false;
  const stockCaps = {}, machineNames = new Map();
  const inventory = snapshot.inventory.map(item => ({ itemId: item.id,
    quantity: Math.max(0, item.num - (resourceReserve(settings, item.id) || 0)) }));
  const factoryConfigs = new Map(rows(config, 'BuildingProduceCfg').map(recipe => [recipe.itemId, recipe]));
  const cropConfigs = new Map(rows(config, 'FarmlandPlantCfg').map(recipe => [recipe.id, recipe]));
  const factoryMachines = new Map();
  const addIncoming = (id, itemId, quantity, finishTime) => {
    if (quantity > 0) incoming.push({ id, itemId, quantity, readyAt: relative(finishTime) });
  };
  const addFixed = (machine, job, start, finish, basis) => {
    addIncoming(job.id, job.productId, job.num, finish);
    fixedTimeline.push({ kind: 'existing', machineId: machine.id, itemId: job.productId, quantity: job.num,
      startAt: start, finishAt: finish, timingLabel: timingNames[basis.source] ?? basis.source, estimated: basis.estimated });
  };
  for (const factory of snapshot.factories) {
    const building = snapshot.buildings.find(row => row.id === factory.id);
    const { lanes, finishes, jobs, missing } = timing.factoryQueue(building, factory.queue);
    missingReads.push(...missing.map(reason => factory.id + reason));
    capacityEstimated ||= lanes.estimated || lanes.count > 1 && lanes.expiresAt !== null;
    const facilityMachines = Array.from({ length: lanes.count }, (_, index) => ({
      id: factory.id + ':' + (index + 1), availableAt: relative(finishes[index]),
      ...(index > 0 && lanes.expiresAt !== null ? { availableUntil: relative(lanes.expiresAt) } : {}),
    }));
    for (const [index, machine] of facilityMachines.entries()) {
      machineNames.set(machine.id, factory.id + (facilityMachines.length > 1 ? ' 第' + (index + 1) + '生产位' : ''));
    }
    factoryMachines.set(factory.id, facilityMachines);
    for (const { job, index, start, finish, basis } of jobs) addFixed(facilityMachines[index], job, start, finish, basis);
    machines.push(...facilityMachines);
    for (const item of factory.finished) addIncoming(factory.id + ':finished:' + item.id, item.id, item.num, now);
    if (factory.nativeAutoActive) missingReads.push(factory.id + '原生自动生产正在追加任务，未来占用尚未固定');
    if (lanes.estimated || lanes.expiresAt !== null) notes.push(factory.id + ' · ' + lanes.reasons.join('，'));
  }
  for (const farm of snapshot.farms) {
    const machine = { id: farm.id, availableAt: Math.max(relative(farm.upgradingUntil), relative(farm.ripeTime)) };
    machines.push(machine);
    machineNames.set(machine.id, farm.id);
    if (farm.productId && farm.ripeTime) addFixed(machine,
      { id: farm.id + ':crop', productId: farm.productId, num: farm.num }, now, Math.max(now, farm.ripeTime), { source: 'server', estimated: false });
  }
  if (snapshot.autoFarming) missingReads.push('原生自动种植正在运行，后续农田占用尚未固定');
  if (!Number.isSafeInteger(snapshot.stockCap) || snapshot.stockCap <= 0) missingReads.push('加工品存量上限未确认');
  const incomingStock = new Map();
  for (const item of incoming) incomingStock.set(item.itemId, (incomingStock.get(item.itemId) ?? 0) + item.quantity);
  const eligibility = createProductionEligibility(config, {
    buildings: snapshot.buildings.map(building => ({ ...building,
      ...snapshot.factories.find(factory => factory.id === building.id) })),
    settings, stock: new Map(inventory.map(item => [item.itemId, item.quantity])), incoming: incomingStock,
  });
  const skippedOrders = new Map();
  const activeOrderRows = orderRows.filter(order => {
    const blocked = snapshot.complete ? eligibility(order.requirements, { reserve: true }) : [];
    if (blocked.length) skippedOrders.set(order.id, blocked);
    return blocked.length === 0;
  });
  const needed = dependencyItems(activeOrderRows, snapshot.recipes);
  const recipes = snapshot.recipes.map(recipe => {
    const farm = recipe.facilityType === '农田';
    const targets = farm
      ? snapshot.farms.filter(plot => plot.enabled && (settings.farm?.customPlant
        ? settings.farm.crops.some(crop => crop.id === recipe.productId && crop.target > 0)
        : settings.farm?.autoPlant !== false)).map(plot => machines.find(machine => machine.id === plot.id))
      : snapshot.factories.filter(factory => factory.type === recipe.facilityType && factory.level >= recipe.unlockLevel
        && factory.enabled && settings.factory?.produce !== false).flatMap(factory => factoryMachines.get(factory.id));
    const durationByMachine = {};
    for (const machine of targets) {
      const building = snapshot.buildings.find(row => row.id === machine.id.replace(/:\d+$/, ''));
      const duration = farm ? timing.farm(cropConfigs.get(recipe.productId)) : timing.factory(factoryConfigs.get(recipe.productId), { building });
      durationByMachine[machine.id] = duration.seconds;
      timingByJob.set(machine.id + '\0' + recipe.productId, duration);
    }
    const durations = Object.values(durationByMachine).filter(value => value > 0);
    stockCaps[recipe.productId] = snapshot.stockCap * (farm ? 5 : 1);
    if (farm && settings.farm?.customPlant) {
      stockCaps[recipe.productId] = Math.min(stockCaps[recipe.productId],
        settings.farm.crops.find(crop => crop.id === recipe.productId)?.target ?? 0);
    }
    const original = factoryConfigs.get(recipe.productId);
    if (needed.has(recipe.productId) && (original?.limitType || original?.buildType === '活动工厂')
      && !Array.isArray(snapshot.raw?.festivals)) missingReads.push(recipe.productId + '活动配方开放状态未同步');
    const windows = original?.limitType ? (snapshot.raw?.festivals ?? []).flatMap(event => event.festivalData?.limitTimeItem ?? [])
      .filter(window => window.item === original.limitType && window.openTime <= now && window.closeTime >= now) : [];
    return { id: recipe.id, itemId: recipe.productId, outputQuantity: recipe.output,
      durationSeconds: durations.length ? Math.min(...durations) : recipe.durationSeconds, durationByMachine,
      inputs: (recipe.costs ?? []).map(item => ({ itemId: item.id, quantity: item.num })), machineIds: targets.map(machine => machine.id),
      enabled: recipe.available && targets.length > 0, blockedReason: recipe.reason || '当前设置下没有可用生产设施',
      ...(windows.length ? { availableUntil: relative(Math.max(...windows.map(window => window.closeTime))) } : {}),
    };
  });
  // The search may produce extra downstream items to free capped storage.
  // Their inputs must respect the same unresolved-spend barriers as the BOM.
  const candidateMaterials = new Set([...needed, ...recipes.filter(recipe => recipe.enabled)
    .flatMap(recipe => recipe.inputs.map(item => item.itemId))]);
  for (const pending of pendingMaterials) {
    if ([...(pending.scope ?? [])].some(id => candidateMaterials.has(id))) missingReads.push('订单或候选配方材料存在待确认扣款 · ' + pending.label);
  }
  const orders = activeOrderRows.map(order => ({ id: order.id, source: order.source, priority: order.priority,
    requirements: order.requirements.map(item => ({ itemId: item.id, quantity: item.num })),
    consumeOnCompletion: order.kind === 'order' && (order.source === 'merchant'
      ? activityProductionEnabled(settings, 'merchant') && settings.schedule?.weekOrderSubmit === true : order.metadata?.enabled === true),
    ...(order.deadline ? { deadline: order.deadline - now } : {}),
  }));
  return {
    input: { snapshotTime: now, complete: snapshot.complete && !missingReads.length, missingReads: unique(missingReads),
      inventory, orders, recipes, machines, incoming, stockCaps, stockCapMode: 'start-projected' },
    orderRows, activeOrderRows, skippedOrders, timingByJob, machineNames, fixedTimeline, notes, capacityEstimated, priorityLabels,
  };
}

/** Optimize completion by configured priority, sharing materials and capacity. */
export function planProduction(snapshot, config, settings, options = {}) {
  const model = buildProductionModel(snapshot, config, settings, options);
  const result = optimizeProductionSchedule(model.input, options.search);
  const name = id => config?.materialName?.(id) || id;
  const completions = new Map(result.orderCompletions.map(order => [order.orderId, order]));
  const refreshUncertain = new Set(model.orderRows.filter(order => order.metadata?.refreshAt
    && completions.has(order.id) && snapshot.serverNow + completions.get(order.id).completedAt >= order.metadata.refreshAt).map(order => order.id));
  const timeline = [...model.fixedTimeline, ...result.timeline.map(job => {
    const basis = model.timingByJob.get(job.machineId + '\0' + job.itemId);
    return { ...job, startAt: snapshot.serverNow + job.start, finishAt: snapshot.serverNow + job.end,
      estimated: basis?.estimated !== false, timingLabel: timingNames[basis?.source] ?? '耗时待确认' };
  })].map(job => ({ ...job, machineName: model.machineNames.get(job.machineId), productName: name(job.itemId),
    priorityLabel: job.kind === 'existing' ? '已排队' : job.priority == null ? '腾仓辅助'
      : '第' + (job.priority + 1) + '级 · ' + (model.priorityLabels.get(job.priority) || '需求备料'),
    inheritedPriority: job.kind === 'production' && job.priority != null
      && !model.activeOrderRows.some(order => order.priority === job.priority && order.requirements.some(item => item.id === job.itemId)),
    inputs: job.inputs?.map(item => ({ ...item, name: name(item.itemId) })) }))
    .sort((a, b) => a.startAt - b.startAt || a.machineId.localeCompare(b.machineId));
  const estimated = model.capacityEstimated || [...model.timingByJob.values()].some(basis => basis.estimated)
    || timeline.some(job => job.estimated);
  const priorityObjective = result.objective === 'priority-makespan';
  const hasConsumption = model.orderRows.some(order => order.kind === 'consumption');
  const scope = model.skippedOrders.size ? (hasConsumption ? 'feasible-demands' : 'feasible-orders')
    : hasConsumption ? 'configured-demands' : 'all-orders';
  const subject = model.skippedOrders.size ? '参与排产的需求' : hasConsumption ? '全部需求' : '全部订单';
  const allSkipped = model.orderRows.length > 0 && model.activeOrderRows.length === 0;
  const optimalLabel = priorityObjective ? '按配置优先级的模型内最优' : '模型内最优';
  const labels = { optimal: optimalLabel + (estimated ? '，含估算条件' : ''),
    'best-known': '已找到可行方案，最优性尚未证明',
    infeasible: estimated ? '当前估算模型下' + subject + '无法在约束内齐套' : '当前资源与设施约束下' + subject + '无法齐套',
    incomplete: '数据或搜索尚不完整，完成时间待确认' };
  const blockedOrders = model.orderRows.map(order => {
    const dependencies = dependencyItems([order], snapshot.recipes);
    return [order.id, result.blockedOrders.filter(block => block.orderId === order.id || !block.orderId && dependencies.has(block.itemId))];
  });
  const blocks = new Map(blockedOrders);
  return {
    ...result, scope, status: refreshUncertain.size ? 'incomplete' : result.status,
    statusLabel: refreshUncertain.size ? '方案越过订单刷新边界，齐套时间待确认'
      : allSkipped ? '当前需求因工厂等级或禁用限制已全部跳过排产'
        : !model.orderRows.length && result.status === 'optimal' ? '当前没有待齐套订单' : labels[result.status], estimated, config: snapshot.config,
    lowerBound: refreshUncertain.size ? null : result.lowerBound,
    upperBound: refreshUncertain.size ? null : result.upperBound,
    objectiveLowerBound: refreshUncertain.size ? null : result.objectiveLowerBound,
    objectiveUpperBound: refreshUncertain.size ? null : result.objectiveUpperBound,
    completionAt: result.upperBound === null || refreshUncertain.size || allSkipped ? null : snapshot.serverNow + result.upperBound,
    missingReads: model.input.missingReads,
    priorityPolicy: '在原料、设备和截止约束内，按用户配置逐级最小化齐套时间，同级优化共同工期，独立生产位并行安排',
    priorityBounds: (result.priorityBounds ?? []).map(bound => ({ ...bound,
      label: '第' + (bound.priority + 1) + '级 · ' + (model.priorityLabels.get(bound.priority) || '需求备料'),
      ...(refreshUncertain.size ? { lowerBound: null, upperBound: null } : {}) })),
    notes: unique([...model.notes, ...result.reasons,
      ...(model.skippedOrders.size ? ['已跳过 ' + model.skippedOrders.size + ' 项工厂等级不足或禁用的需求，材料可用于其他排产，恢复生产条件后重新计算'] : []),
      ...(refreshUncertain.size ? ['生产顺序按本次固定需求计算，联盟募兵订单刷新边界之后的实际需求需重新读取确认'] : []),
      ...(estimated ? ['候选方案比较含估算耗时或生产位条件，生产加成与容量变化后需重新读取计算'] : [])]),
    assumptions: [
      '以需求优先级列表为顺序，先优化高级需求及其上游材料，再逐级优化后续需求的齐套时间',
      '范围包括活动总开关允许的当前订单与已开启来源的消费备料，未列入优先级列表的当前订单置于最后一级',
      '建筑等消费备料齐套后独占保留，常规备货水位由库存策略处理',
      '固定当前生产加成、现有设施等级和已排队任务，新增任务按原料到齐立即开工估算',
      '生产、收获和已启用订单提交按零操作延迟计算，关闭提交的订单材料独占保留',
      '外部采集、购买、广告与道具加速、未来建筑升级收益需在新快照中确认后计算',
      '开工时检查库存、待收与在途总量，加工品上限来自当前配置，农产上限为其五倍',
      '方案按订单生产独占可用资源计算，其他消费和备货任务需让出相应材料与产能',
    ],
    orders: model.orderRows.map(order => ({ ...order, label: (sourceNames[order.source] || order.source)
      + (order.source === 'building' && order.metadata?.buildingId ? ' · ' + order.metadata.buildingId + ' ' + order.metadata.level + '级' : ''),
      priorityLabel: '第' + (order.priority + 1) + '级',
      requirements: order.requirements.map(item => ({ ...item, name: name(item.id) })),
      completionAt: completions.has(order.id) && !refreshUncertain.has(order.id) ? snapshot.serverNow + completions.get(order.id).completedAt : null,
      skipped: model.skippedOrders.has(order.id),
      statusLabel: model.skippedOrders.has(order.id) ? '已跳过排产'
        : completions.has(order.id) && !refreshUncertain.has(order.id) ? '联合方案已齐套' : '待确认',
      reason: model.skippedOrders.has(order.id)
        ? '已跳过排产，' + unique(model.skippedOrders.get(order.id).map(block => name(block.itemId) + ' · ' + block.reason)).join('，')
        : refreshUncertain.has(order.id) ? '预计完成越过订单刷新边界，需求待重新确认'
        : unique((blocks.get(order.id) ?? []).map(block => (block.itemId ? name(block.itemId) + ' · ' : '') + block.reason)).join('，'),
    })),
    timeline,
  };
}
