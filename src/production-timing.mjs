const table = (config, name) => config?.tables?.[name]?.data ?? [];
const finiteAmount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const effectIds = new Set([1, 2, 11]);

function readEffects(reply) {
  const rows = Array.isArray(reply) ? reply : reply?.effects;
  const result = new Map();
  if (!Array.isArray(rows)) return result;
  for (const id of effectIds) {
    const matches = rows.filter(row => row?.id === id);
    if (matches.length === 1 && finiteAmount(matches[0].value)) result.set(id, matches[0].value);
  }
  return result;
}

function observedTime(rows, productId, buildingId, kind) {
  if (typeof productId !== 'string' || !productId) return null;
  const matches = rows.filter(row => row?.productId === productId && positiveInteger(row.seconds)
    && (kind === 'farm' ? row.kind === 'farm'
      : (row.kind == null || row.kind === 'factory') && buildingId && row.buildingId === buildingId)
    && positiveInteger(row.samples ?? 1));
  if (!matches.length) return null;
  const seconds = Math.max(...matches.map(row => row.seconds));
  const samples = matches.reduce((total, row) => total + (row.samples ?? 1), 0);
  const reasons = ['采用当前会话同配方的实测耗时，共 ' + samples + ' 个样本'];
  if (new Set(matches.map(row => row.seconds)).size > 1) reasons.push('实测时长存在差异，按已观察的最长耗时安排');
  return { seconds, source: 'observed', estimated: false, samples, reasons };
}

function estimatedTime(base, reduction, speed, reasons) {
  if (!positiveInteger(base)) return { seconds: null, source: 'unavailable', estimated: true, reasons: ['生产配方耗时无效'] };
  if (!finiteAmount(reduction) || !finiteAmount(speed)) {
    return { seconds: base, source: 'config-estimate', estimated: true,
      reasons: ['当前生产加成不完整，暂按配置原始耗时估算', ...reasons] };
  }
  // The local client uses this global-effect formula. Building-specific server
  // effects are not fully exposed here, so this value remains an estimate.
  const duration = Math.ceil(Math.max(0, base - reduction) / (1 + speed));
  return { seconds: Math.max(1, duration), source: 'effects-estimate', estimated: true,
    reasons: ['按已读取的全局加成估算', ...reasons,
      ...(duration === 0 ? ['瞬时生产按至少 1 秒的调度粒度估算'] : [])] };
}

// A predicted job can use the temporary lane if it fits inside the confirmed
// entitlement window. Already-running jobs retain the server's finish time.
export function nextFactoryLane(finishes, expiresAt, seconds) {
  let index = 0;
  for (let i = 1; i < finishes.length; i++) {
    if (expiresAt !== null && finishes[i] + seconds > expiresAt) continue;
    if (finishes[i] < finishes[index]) index = i;
  }
  return { index, start: finishes[index], finish: finishes[index] + seconds };
}

export function commitFactoryLane(finishes, lane) {
  // A later entry in the same queue cannot start before its predecessor,
  // even when the shorter entry could fit in the remaining card window.
  for (let i = 0; i < finishes.length; i++) finishes[i] = Math.max(finishes[i], lane.start);
  finishes[lane.index] = lane.finish;
}

export function secondProductionLane(config, monthCards, now) {
  const cards = Array.isArray(monthCards) ? monthCards : monthCards?.cardItem;
  const types = new Set();
  let known = true, until = 0;
  if (!Array.isArray(cards) || !finiteAmount(now)) return { known: false, until };
  for (const card of cards) {
    if (![1, 2].includes(card?.type) || types.has(card.type) || !Number.isSafeInteger(card.endTime) || card.endTime < -1) {
      return { known: false, until: 0 };
    }
    types.add(card.type);
    if (card.endTime !== -1 && card.endTime <= now) continue;
    const id = card.type === 1 ? '普通月卡' : '高级月卡';
    const effects = table(config, 'MonthCardCfg').find(row => row.id === id)?.effectList;
    if (!Array.isArray(effects)) { known = false; continue; }
    if (effects.some(pair => pair?.[0] === '第二生产位' && positiveInteger(pair[1]))) {
      until = Math.max(until, card.endTime === -1 ? Infinity : card.endTime);
    }
  }
  return { known, until };
}

export function createProductionTiming({
  config, effects, monthCards, serverNow, observedDurations = [],
} = {}) {
  const values = readEffects(effects);
  const observations = Array.isArray(observedDurations) ? observedDurations : [];
  const secondLane = secondProductionLane(config, monthCards, serverNow);
  const recipes = new Map(table(config, 'BuildingProduceCfg').map(row => [row.itemId, row]));

  const timing = {
    factory(recipe, { building } = {}) {
      const measured = observedTime(observations, recipe?.itemId, building?.buildingId, 'factory');
      if (measured) return measured;
      const reasons = ['建筑专属技能、皮肤等加成尚未完整核验'];
      return estimatedTime(recipe?.produceTime, values.get(2), values.get(1), reasons);
    },

    farm(crop) {
      const measured = observedTime(observations, crop?.id, null, 'farm');
      if (measured) return measured;
      return estimatedTime(crop?.time, values.get(11), 0, []);
    },

    lanes(building) {
      const queue = building?.factory?.factoryQ;
      const clockKnown = finiteAmount(serverNow);
      const queueKnown = Array.isArray(queue) && queue.every(job => typeof job?.productId === 'string'
        && job.productId && Number.isSafeInteger(job.idx ?? 0) && (job.idx ?? 0) >= 0)
        && new Set(queue.map(job => job.idx ?? 0)).size === queue.length;
      const timers = queueKnown && clockKnown
        ? queue.filter(job => positiveInteger(job?.finishTime) && job.finishTime > serverNow) : [];
      const observed = timers.length;
      const entitled = secondLane.until > 0;
      const entitledCount = entitled ? 2 : 1;
      let expiresAt = entitled && Number.isFinite(secondLane.until) ? secondLane.until : null;
      const reasons = [];
      const count = Math.max(entitledCount, observed);
      const estimated = !queueKnown || !secondLane.known || observed > entitledCount;
      if (observed > 0) reasons.push('当前队列有 ' + observed + ' 个带完成时间的生产任务');
      if (entitled) reasons.push('有效月卡已开启第二生产位');
      if (!secondLane.known) reasons.push('月卡权益和有效期未完整读取');
      if (!queueKnown) reasons.push('当前工厂队列未完整读取');
      if (!clockKnown) reasons.push('当前服务端时间未确认');
      if (observed > entitledCount) {
        expiresAt = serverNow;
        reasons.push('已有并行任务继续计时，新增任务按普通生产位估算');
      }
      if (entitled && expiresAt !== null) reasons.push('第二位的新任务仅计入预计可在月卡到期前完成的部分');
      if (!observed && !entitled && !secondLane.known) reasons.push('暂按每厂 1 个生产位估算');
      const source = entitled || !observed && secondLane.known ? 'month-card' : observed ? 'observed' : 'default-estimate';
      return { count, source, estimated, expiresAt, afterExpiry: 1, reasons };
    },

    factoryQueue(building, queue = building?.factory?.factoryQ ?? []) {
      const lanes = timing.lanes(building);
      const now = finiteAmount(serverNow) ? serverNow : 0;
      const finishes = Array(lanes.count).fill(now);
      const jobs = [], missing = [];
      const timed = queue.filter(job => positiveInteger(job.finishTime));
      const active = timed.filter(job => job.finishTime > now);
      const server = { source: 'server', estimated: false };
      for (const job of timed) {
        if (job.finishTime <= now) jobs.push({ job, index: 0, start: now, finish: now, basis: server });
      }
      // The protocol has job IDs but no lane IDs. Conservatively assign the
      // later timer to the permanent lane when the other lane is temporary.
      if (lanes.expiresAt !== null) active.sort((a, b) => b.finishTime - a.finishTime);
      for (const [i, job] of active.entries()) {
        const index = Math.min(i, finishes.length - 1);
        finishes[index] = Math.max(finishes[index], job.finishTime);
        jobs.push({ job, index, start: now, finish: job.finishTime, basis: server });
      }
      if (queue.length && !timed.length) missing.push('在产首项完成时刻未确认');
      for (const job of queue) {
        if (positiveInteger(job.finishTime)) continue;
        const basis = timing.factory(recipes.get(job.productId), { building });
        if (!basis.seconds) { missing.push('排队产物 ' + job.productId + ' 耗时未确认'); continue; }
        const lane = nextFactoryLane(finishes, lanes.expiresAt, basis.seconds);
        commitFactoryLane(finishes, lane);
        jobs.push({ job, ...lane, basis });
      }
      return { lanes, finishes, jobs, missing };
    },
  };
  return timing;
}

const timingWatchers = new WeakMap();
export const observedProductionDurations = client => timingWatchers.get(client)?.snapshot() ?? [];
const jobKey = job => JSON.stringify([job.idx ?? 0, job.productId]);
const sampleKey = (buildingId, productId) => JSON.stringify([buildingId, productId]);

// Observe existing traffic only. No protocol requests or writes originate here.
export function watchProductionTimings(client, configGetter, {
  now = Date.now, monotonicNow = () => performance.now(),
} = {}) {
  const existing = timingWatchers.get(client);
  if (existing) return existing;
  const states = new Map(), measurements = new Map(), effectInputs = new Map();
  let disposed = false, offset = Number(client.serverClockOffsetMs) || 0;
  let effectsSignature = null, recipeSignature = null, lastWallTime = null, lastMonotonicTime = null;

  const clear = buildingId => {
    if (!buildingId) { states.clear(); measurements.clear(); return; }
    states.delete(buildingId);
    for (const [key, row] of measurements) if (row.buildingId === buildingId) measurements.delete(key);
  };
  const reset = () => {
    clear(); effectInputs.clear(); effectsSignature = null; recipeSignature = null;
    lastWallTime = null; lastMonotonicTime = null;
    offset = Number(client.serverClockOffsetMs) || 0;
  };
  const readConfig = () => typeof configGetter === 'function' ? configGetter() : configGetter;
  const observeBuilding = (building, config, timestamp) => {
    const id = building?.buildingId, queue = building?.factory?.factoryQ;
    if (typeof id !== 'string' || !id) return;
    if (!Array.isArray(queue) || queue.some(job => typeof job?.productId !== 'string' || !job.productId
      || !Number.isSafeInteger(job.idx ?? 0) || (job.idx ?? 0) < 0
      || job.finishTime != null && job.finishTime !== 0 && !positiveInteger(job.finishTime))
      || new Set(queue.map(jobKey)).size !== queue.length) { clear(id); return; }
    const timers = queue.filter(job => positiveInteger(job.finishTime));
    if (timers.length > 1) { clear(id); return; }
    const previous = states.get(id);
    if (!timers.length) {
      if (!queue.length || previous && !queue.some(job => jobKey(job) === jobKey(previous.queue[1] ?? {}))) states.delete(id);
      return;
    }
    const head = timers[0];
    const current = { head: { ...head }, queue: queue.map(job => ({ ...job })), level: building.level,
      skinId: building.skinId ?? '',
      native: building.factory.autoProductId ?? '' };
    if (head !== queue[0]) { clear(id); return; }
    if (previous) {
      const same = jobKey(previous.head) === jobKey(head);
      if (previous.level !== current.level || previous.native !== current.native || previous.skinId !== current.skinId
        || same && previous.head.finishTime !== head.finishTime) clear(id);
      else if (!same) {
        const next = previous.queue[1];
        const recipe = table(config, 'BuildingProduceCfg').find(row => row.itemId === head.productId);
        const seconds = head.finishTime - previous.head.finishTime;
        const continuous = next && jobKey(next) === jobKey(head) && !queue.some(job => jobKey(job) === jobKey(previous.head))
          && timestamp >= previous.head.finishTime - 1 && positiveInteger(seconds)
          && positiveInteger(recipe?.produceTime) && seconds <= recipe.produceTime + 2;
        if (continuous) {
          const key = sampleKey(id, head.productId), old = measurements.get(key);
          measurements.set(key, { kind: 'factory', buildingId: id, productId: head.productId,
            seconds: Math.max(seconds, old?.seconds ?? 0), samples: (old?.samples ?? 0) + 1, observedAt: timestamp });
        } else clear(id);
      }
    }
    states.set(id, current);
  };
  const onMessage = ({ name, body } = {}) => {
    if (disposed) return;
    try {
      if (name === 'GameEffectResponse') {
        const signature = JSON.stringify(Array.isArray(body?.effects) ? body.effects
          .map(row => [row?.id, row?.value]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))) : null);
        if (effectsSignature !== null && signature !== effectsSignature) clear();
        effectsSignature = signature;
        return;
      }
      if (name === 'SCGameEffectUpdate') { clear(); effectsSignature = null; return; }
      if (name === 'SCUpdateHero') { clear(); return; }
      if (['AllHeroResponse', 'AppointInfoResponse', 'MonthCardResponse', 'EnvSkinListResponse'].includes(name)) {
        const signature = JSON.stringify(body);
        if (effectInputs.has(name) && effectInputs.get(name) !== signature) clear();
        effectInputs.set(name, signature);
        return;
      }
      if (!['OnWaterResponse', 'SCUpdateWaterBuilding'].includes(name)) return;
      const wallTime = now();
      const monotonicTime = monotonicNow();
      const currentOffset = Number(client.serverClockOffsetMs ?? 0);
      if (!Number.isFinite(wallTime) || !Number.isFinite(monotonicTime) || !Number.isFinite(currentOffset)
        || Math.abs(currentOffset - offset) >= 1000
        || lastWallTime !== null && (wallTime < lastWallTime || monotonicTime < lastMonotonicTime
          || Math.abs((wallTime - lastWallTime) - (monotonicTime - lastMonotonicTime)) >= 1000)) { reset(); return; }
      lastWallTime = wallTime;
      lastMonotonicTime = monotonicTime;
      offset = currentOffset;
      const config = readConfig();
      const signature = JSON.stringify(table(config, 'BuildingProduceCfg').map(row => [row.itemId, row.buildType, row.produceTime]));
      if (recipeSignature !== null && signature !== recipeSignature) clear();
      recipeSignature = signature;
      if (!Array.isArray(body?.building)) { clear(); return; }
      const timestamp = (wallTime + currentOffset) / 1000;
      for (const building of body.building) if (building?.factory) observeBuilding(building, config, timestamp);
    } catch { reset(); }
  };
  const onFrame = ({ dir, name, body } = {}) => {
    if (disposed || dir !== 'out') return;
    if (['SpeedUpFactoryProduceRequest', 'CancelFactoryProduceRequest', 'SetFactoryAutoProduceRequest',
      'CancelFactoryAutoProduceRequest', 'UpgradeBuildingRequest', 'FinishUpgradeBuildingRequest',
      'SpeedUpUpgradeBuildingRequest', 'ApplyBuildingSkinRequest'].includes(name)) clear(body?.buildingId);
    if (['AutoAppointRequest', 'AutoUnAppointRequest', 'AppointHeroRequest', 'UnAppointHeroRequest',
      'HeroLevelUpRequest', 'HeroSkillLevelUpRequest', 'HeroSkillUpgradeRequest', 'HeroStarUpRequest',
      'BatchHeroStarUpRequest', 'HeroExclusiveLevelUpRequest', 'HeroExclusiveStarUpRequest',
      'ActivateHeroFateRequest', 'SwitchHeroSkinRequest', 'UpdateEnvSkinRequest'].includes(name)) clear();
  };
  const onPong = () => {
    const current = Number(client.serverClockOffsetMs) || 0;
    if (!Number.isFinite(current) || Math.abs(current - offset) >= 1000) clear();
    offset = current;
  };
  const listeners = [['message', onMessage], ['frame', onFrame], ['pong', onPong], ['close', reset], ['login', reset]];
  for (const [event, listener] of listeners) client.on?.(event, listener);
  const watcher = {
    snapshot() { return disposed || client.connected === false ? [] : [...measurements.values()].map(row => ({ ...row })); },
    dispose() {
      if (disposed) return;
      disposed = true;
      const remove = client.off?.bind(client) ?? client.removeListener?.bind(client);
      for (const [event, listener] of listeners) remove?.(event, listener);
      reset(); timingWatchers.delete(client);
    },
  };
  timingWatchers.set(client, watcher);
  return watcher;
}
