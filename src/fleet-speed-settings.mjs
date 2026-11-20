// 每队、每种加速只保留每日预算；0 禁止花钻，新增功能默认关闭。
export const fleetSpeedDefaults = id => ({ id, repair: false, march: false,
  repairSmartSave: false, marchSmartSave: false,
  repairSmartWaitSeconds: 5, marchSmartWaitSeconds: 5,
  repairSkipSeconds: 60, marchSkipSeconds: 60, marchMinSavedSeconds: 30,
  repairDailyDiamonds: 0, marchDailyDiamonds: 0 });

export function fleetSpeedEnabled(settings) {
  const cityWar = settings?.cityWar;
  return !!(cityWar?.enabled && settings.fleetSpeed?.fleets?.some(fleet =>
    (fleet.repair || fleet.march) && cityWar.fleetIds?.includes(fleet.id)));
}

export const FLEET_SPEED_NUMBERS = {
  repairSmartWaitSeconds: { kind: 'number', min: 1, max: 60 },
  marchSmartWaitSeconds: { kind: 'number', min: 1, max: 60 },
  repairSkipSeconds: { kind: 'number', min: 0, max: 86400 },
  marchSkipSeconds: { kind: 'number', min: 0, max: 86400 },
  marchMinSavedSeconds: { kind: 'number', min: 1, max: 86400 },
  ...Object.fromEntries(['repairDailyDiamonds','marchDailyDiamonds']
    .map(key => [key, { kind: 'number', min: 0, max: 1000000 }]))
};
export function validateFleetSpeeds(value, errors) {
  if (!Array.isArray(value) || value.length !== 3) { errors['fleetSpeed.fleets'] = '请保留三支舰队的独立加速配置'; return null; }
  return value.map((item, index) => {
    const prefix = 'fleetSpeed.fleets.' + index, defaults = fleetSpeedDefaults((index + 1) + '远征船');
    if (!item || typeof item !== 'object' || Array.isArray(item)) { errors[prefix] = '舰队加速配置必须是对象'; return defaults; }
    for (const key of Object.keys(item)) if (!Object.hasOwn(defaults, key) && !['smartSave','smartWaitSeconds','repairMaxDiamonds','marchMaxDiamonds'].includes(key)) errors[prefix + '.' + key] = '不支持的舰队加速设置';
    // 旧版共用开关/等待秒数分别迁移到两项；新字段显式值优先，不覆盖已关闭选项。
    if (Object.hasOwn(item,'smartSave') && typeof item.smartSave!=='boolean') errors[prefix+'.smartSave']='开关必须为 true 或 false';
    if (Object.hasOwn(item,'smartWaitSeconds') && (!Number.isSafeInteger(item.smartWaitSeconds)||item.smartWaitSeconds<1||item.smartWaitSeconds>60)) errors[prefix+'.smartWaitSeconds']='请输入 1–60 之间的整数';
    const row = { ...defaults, repairSmartSave:item.smartSave??defaults.repairSmartSave, marchSmartSave:item.smartSave??defaults.marchSmartSave,
      repairSmartWaitSeconds:item.smartWaitSeconds??defaults.repairSmartWaitSeconds, marchSmartWaitSeconds:item.smartWaitSeconds??defaults.marchSmartWaitSeconds, ...item };
    delete row.smartSave;delete row.smartWaitSeconds;
    // 旧版单次/整段航程上限已移除；接受旧页面和导入值，但不执行、不再保存或导出。
    delete row.repairMaxDiamonds;delete row.marchMaxDiamonds;
    if (row.id !== defaults.id) errors[prefix + '.id'] = '舰队编号与配置位置不一致';
    for (const key of ['repair','march','repairSmartSave','marchSmartSave']) if (typeof row[key] !== 'boolean') errors[prefix + '.' + key] = '开关必须为 true 或 false';
    for (const [key, rule] of Object.entries(FLEET_SPEED_NUMBERS)) if (!Number.isSafeInteger(row[key]) || row[key] < rule.min || row[key] > rule.max) errors[prefix + '.' + key] = `请输入 ${rule.min}–${rule.max} 之间的整数`;
    return row;
  });
}
