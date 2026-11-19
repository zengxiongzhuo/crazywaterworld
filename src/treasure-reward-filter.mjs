// 此 ID 只供客户端展示；货轮实际发放的是各品质的补给材料。
const supplyDisplayId = '展示补给材料';
const rows = (config, name) => config?.tables?.[name]?.data ?? [];

function configuredRewardIds(config) {
  const libraries = new Set(rows(config, 'TreasureLootCfg').flatMap(row => row.rewardLib ?? []));
  return new Set(rows(config, 'TreasureLootRewardCfg')
    .filter(row => libraries.has(row.libId) && Array.isArray(row.reward) && typeof row.reward[0] === 'string' && row.reward[1] > 0)
    .map(row => row.reward[0]));
}

function supplyRewardIds(config, rewardIds = configuredRewardIds(config)) {
  const items = rows(config, 'ItemCfg');
  if (!items.some(row => row.id === supplyDisplayId)) return new Set();
  return new Set(items.filter(row => row.type === '补给材料' && row.id !== supplyDisplayId && rewardIds.has(row.id)).map(row => row.id));
}

// 返回第一个命中的勾选项。空选时所有货轮同级，勾选后没有交集才跳过。
export function treasureRewardPriority(config, selected, rewards) {
  if (!selected?.length) return 0;
  const ids = new Set((rewards ?? []).map(asset => asset.id));
  return selected.findIndex(id => {
    if (id !== supplyDisplayId) return ids.has(id);
    const supplies = supplyRewardIds(config);
    return (rewards ?? []).some(asset => supplies.has(asset.id));
  });
}

export function matchesTreasureRewards(config, selected, rewards) {
  return treasureRewardPriority(config, selected, rewards) >= 0;
}

// 仅货轮使用此目录：先列实际奖励，完整材料和旧选择仍可搜索；其他模块不改名称或顺序。
export function treasureRewardOptions(config, materials) {
  const rewardIds = configuredRewardIds(config), supplies = supplyRewardIds(config, rewardIds);
  const priority = id => id === supplyDisplayId ? 0 : supplies.has(id) ? 1 : rewardIds.has(id) ? 2 : 3;
  return materials.map(option => option.value === supplyDisplayId ? { ...option, label: option.label + '（任意品质）' } : { ...option })
    .sort((a, b) => priority(a.value) - priority(b.value));
}
