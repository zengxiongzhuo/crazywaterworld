export const resourceFieldIds = { fuel: '汽油', seeds: '种子', tech: '公会科技点' };
export const defaultResourceFieldAmounts = { fuel: 3, seeds: 1, tech: 6 };

// 固定配额是各资源独立的目标数量。比例模式根据本次读取的个人名额重新计算。
export function resourceFieldTargets(options, maxNum) {
  const entries = Object.entries(resourceFieldIds);
  if (options.allocationMode === 'quota') {
    return Object.fromEntries(entries.map(([key, id]) => [id, options.quotas[key]]));
  }
  const targets = Object.fromEntries(entries.map(([, id]) => [id, 0]));
  const ranked = entries.filter(([key]) => options.ratios[key] > 0)
    .sort(([a], [b]) => options.ratios[b] - options.ratios[a]);
  const totalWeight = ranked.reduce((sum, [key]) => sum + options.ratios[key], 0);
  if (!totalWeight || !Number.isSafeInteger(maxNum) || maxNum < 1) return targets;
  let remaining = maxNum;
  for (const [key, id] of ranked) {
    targets[id] = Math.floor(maxNum * options.ratios[key] / totalWeight);
    remaining -= targets[id];
  }
  for (const [, id] of ranked.slice(0, remaining)) targets[id]++;
  return targets;
}
