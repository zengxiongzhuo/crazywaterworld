let resourceFieldsOwner = null, resourceFieldsData = null, resourceFieldsLoading = false, resourceFieldsSerial = 0;
let resourceFieldsReceivedAt = 0, resourceFieldsLastAttempt = 0, resourceFieldsAction = null;
const resourceFieldsNumber = value => Number.isFinite(value) && value >= 0 ? fmt(value) : '未同步';
const resourceFieldsConnected = () => !!current && snapshot.connected && !snapshot.paused && !disconnected.has(current);
const resourceFieldsVisible = () => !document.hidden && !$('tab-overview').classList.contains('hidden');
const resourceFieldsStale = () => !resourceFieldsReceivedAt || Date.now() - resourceFieldsReceivedAt > 120000;
const resourceFieldName = id => id === '公会科技点' ? '科技点' : id;
const resourceFieldBuildings = new Map([['公会科技点', '工厂'], ['种子', '绿洲'], ['汽油', '油罐']]);
const resourceFieldRate = value => Number.isFinite(value) && value >= 0 ? fmt(value) + '/小时' : '未同步';

function resetResourceFieldsOverview() {
  resourceFieldsSerial++; resourceFieldsOwner = null; resourceFieldsData = null; resourceFieldsLoading = false;
  resourceFieldsReceivedAt = 0; resourceFieldsLastAttempt = 0; resourceFieldsAction = null;
  $('resource-fields-action-dialog').close(); $('resource-fields-feedback').hidden = true;
  for (const id of ['summary', 'owned-table', 'candidates', 'candidate-count', 'automatic', 'action-body']) clear($('resource-fields-' + id));
  $('resource-fields-capacity').textContent = '连接账号后读取资源田';
  $('resource-fields-overview').setAttribute('aria-busy', 'false');
}
function resourceFieldsAccountChanged() {
  if (resourceFieldsOwner !== null && (resourceFieldsOwner !== current || !resourceFieldsConnected())) resetResourceFieldsOverview();
  updateResourceFieldsControls();
  if (!resourceFieldsConnected()) {
    $('resource-fields-capacity').textContent = !current ? '请选择账号查看资源田' : snapshot.paused ? '账号已暂停，连接后可读取资源田' : '连接账号后读取资源田';
  } else if (!resourceFieldsData && !resourceFieldsLoading) $('resource-fields-capacity').textContent = '等待读取资源田';
}
function updateResourceFieldsControls() {
  const busy = resourceFieldsLoading || resourceFieldsAction !== null || !resourceFieldsConnected();
  const stale = resourceFieldsStale(), readOnlyDetails = !!resourceFieldsAction?.detailResource && stale;
  $('resource-fields-refresh').disabled = busy;
  for (const button of document.querySelectorAll('[data-resource-manage], [data-resource-view]')) {
    button.disabled = busy || (button.hasAttribute('data-resource-manage') && stale);
    button.title = stale && button.hasAttribute('data-resource-manage') ? '信息已过期，请先刷新资源田' : button.getAttribute('aria-label');
  }
  for (const button of document.querySelectorAll('[data-resource-select-old], [data-resource-give-up]')) {
    button.disabled = resourceFieldsAction?.phase !== 'selecting' || !resourceFieldsConnected() || readOnlyDetails || !!button.dataset.unavailable;
    button.title = readOnlyDetails ? '信息已过期，请关闭并刷新资源田' : button.dataset.unavailable || '';
  }
  const selecting = resourceFieldsAction?.phase === 'selecting';
  const showOwned = selecting && !!(resourceFieldsAction.target || resourceFieldsAction.detailResource);
  const hint = $('resource-fields-owned-hint');
  hint.hidden = !showOwned;
  $('resource-fields-candidate-count').hidden = $('resource-fields-candidate-fuel').hidden = !selecting || showOwned;
  if (showOwned) {
    const count = resourceFieldsData.count == null ? '数量未同步' : '共 ' + hint.dataset.count + ' 块';
    const target = resourceFieldsAction.target;
    hint.textContent = target ? '换入 ' + (target.cityName || '城市未同步') + ' · 格 ' + target.grid + ' · Lv.' + (target.level ?? '?')
      : readOnlyDetails ? count + ' · 上次同步结果，请关闭并刷新后操作' : count;
  }
}
function resourceFieldRow(field) {
  const row = el('article', 'resource-fields-row'), body = el('div', 'resource-fields-field-data');
  body.append(el('strong', '', (field.name || '资源田') + ' · ' + (field.level == null ? '等级未同步' : 'Lv.' + field.level)));
  body.append(el('span', 'dim', (field.cityName || '城市未同步') + ' · 格 ' + field.grid));
  body.append(el('span', 'resource-fields-yield', '有效基础时产 ' + resourceFieldRate(fieldEffectiveYield(field))));
  body.append(el('small', field.active === true ? 'dim' : 'warn', field.productionStatus || (field.active === true ? '产出中' : field.active === false ? '暂停产出' : '归属未同步')));
  row.append(body);
  return row;
}
function paintResourceFieldsOverview(data) {
  const summary = clear($('resource-fields-summary'));
  $('resource-fields-capacity').textContent = '已占 ' + resourceFieldsNumber(data.count) + ' / ' + resourceFieldsNumber(data.maxNum)
    + ' · 可新增 ' + resourceFieldsNumber(data.remaining) + ' · 在途 ' + (data.pending?.length || 0)
    + ((data.owned || []).some(row => !resourceFieldBuildings.has(row.resourceId)) ? ' · 类型待同步 ' + data.owned.filter(row => !resourceFieldBuildings.has(row.resourceId)).length : '');
  for (const [id, building] of resourceFieldBuildings) {
    const owned = (data.owned || []).filter(row => row.resourceId === id), item = (data.totals || []).find(row => row.id === id);
    const card = el('article', 'resource-fields-type'); card.dataset.resourceType = id;
    const view = el('button', 'resource-fields-view'), text = el('span', 'resource-fields-type-summary');
    view.type = 'button'; view.dataset.resourceView = id; view.setAttribute('aria-haspopup', 'dialog');
    const name = el('span', 'resource-fields-type-name'), rate = el('span', 'resource-fields-rate');
    name.append(el('strong', '', building), el('span', 'dim', resourceFieldName(id)));
    rate.append(el('small', 'dim', '有效基础时产'), el('strong', '', resourceFieldRate(item?.perHour)));
    text.append(name, rate,
      el('small', 'dim resource-fields-count', '已占 ' + (data.count == null ? '未同步' : owned.length) + ' · 失效 ' + (data.count == null ? '未同步' : owned.filter(row => row.active === false).length)
        + (owned.some(row => row.active == null) ? ' · 归属待同步 ' + owned.filter(row => row.active == null).length : '')));
    view.setAttribute('aria-label', '查看' + building + '明细');
    view.setAttribute('aria-description', resourceFieldName(id) + '，有效基础时产 ' + resourceFieldRate(item?.perHour) + '，' + text.lastChild.textContent);
    text.append(el('span', 'resource-fields-view-label', '查看明细')); view.append(text);
    view.onclick = () => openResourceFieldManager(id, true); card.append(view);
    const label = data.remaining == null ? '管理' : data.remaining === 0 ? '换田' : '占领';
    const button = smallButton(label); button.type = 'button'; button.dataset.resourceManage = id; button.classList.add('resource-fields-manage');
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-label', label === '换田' ? '换田，选择要换入的' + building : label + building);
    button.onclick = () => openResourceFieldManager(id);
    card.append(button); summary.append(card);
  }
  $('resource-fields-automatic').textContent = data.automatic ? '自动占领已开启' : '自动占领未开启';
  updateResourceFieldsControls();
}
function resourceFieldsFeedback(text, warning = false) {
  const node = $('resource-fields-feedback'); node.textContent = text; node.hidden = !text; node.classList.toggle('warn', warning);
}
function closeResourceFieldAction() {
  const opener = resourceFieldsAction?.opener;
  if (resourceFieldsAction?.phase !== 'sending') resourceFieldsAction = null;
  $('resource-fields-action-dialog').close(); updateResourceFieldsControls();
  if (opener?.isConnected && !opener.disabled) opener.focus({ preventScroll: true });
}
function openResourceFieldManager(resource, details = false) {
  if (resourceFieldsOwner !== current || !resourceFieldsConnected() || !resourceFieldsData || resourceFieldsLoading || resourceFieldsAction || (!details && resourceFieldsStale())) return;
  resourceFieldsAction = { account: current, resource, detailResource: details ? resource : null, phase: 'selecting',
    target: null, replaceGridIdx: null, quote: null, fleetId: null, opener: document.activeElement };
  showResourceFieldSelection(); $('resource-fields-action-dialog').showModal();
  $('resource-fields-' + (details ? 'owned-table' : 'candidates')).closest('.resource-fields-table-scroll').focus();
}
function showResourceFieldSelection() {
  const action = resourceFieldsAction; if (!action || action.phase === 'sending') return;
  const chooseOld = !!action.target, showOwned = !!action.detailResource || chooseOld;
  action.phase = 'selecting'; action.kind = null; action.quote = null; action.fleetId = null; action.replaceGridIdx = null;
  $('resource-fields-manager').dataset.view = action.detailResource ? 'details' : chooseOld ? 'choose-old' : 'manage';
  $('resource-fields-action-title').textContent = action.detailResource ? '已占资源田' : chooseOld ? '选择要替换的旧田' : '占领资源田';
  $('resource-fields-manager').hidden = false; $('resource-fields-action-body').hidden = true;
  $('resource-fields-action-confirm').hidden = true;
  $('resource-fields-action-back').hidden = !chooseOld; $('resource-fields-action-back').textContent = action.detailResource ? '返回明细' : '返回候选';
  $('resource-fields-owned').hidden = !showOwned; $('resource-fields-targets').hidden = showOwned;
  if (showOwned) { clear($('resource-fields-candidates')); paintOwnedResourceFieldTable(); }
  else { clear($('resource-fields-owned-table')); paintResourceFieldCandidates(); }
  updateResourceFieldsControls();
}
function resourceFieldTableEmpty(root, message, columns) {
  const row = el('tr'), cell = el('td', 'dim', message); cell.colSpan = columns; row.append(cell); root.append(row);
}
function resourceFieldReplacementReason(field) {
  return field.replacementReason || (!field.resourceId || fieldEffectiveYield(field) === null ? '旧田产出或归属未同步' : '');
}
function resourceFieldCapacityReason(replacing) {
  const data = resourceFieldsData, valid = value => Number.isSafeInteger(value) && value >= 0;
  if (replacing) {
    if (!valid(data.maxNum) || !valid(data.count) || !Array.isArray(data.pending)) return '资源田名额未同步';
    if (data.maxNum - data.count - data.pending.length + 1 <= 0) return '名额已被在途任务预留';
    if (!(data.owned || []).some(field => !resourceFieldReplacementReason(field))) return '暂无可替换的旧田';
  } else if (!valid(data.remaining)) return '资源田名额未同步';
  else if (data.remaining === 0) return '名额已满';
  return '';
}
function resourceFieldDispatchReason() {
  const data = resourceFieldsData, valid = value => Number.isSafeInteger(value) && value >= 0;
  if (data.reason) return data.reason;
  if (!(data.fleets || []).some(fleet => fleet.available === true)) return '暂无可用舰队';
  if (!valid(data.cost) || !valid(data.fuel) || !valid(data.pendingFuel ?? 0)) return '占田费用或汽油库存未同步';
  if (data.fuel - (data.pendingFuel ?? 0) < data.cost) return '可用汽油不足（含其他任务待确认消耗）';
  return '';
}
function compareResourceFieldsByLevel(a, b) {
  return (b.level ?? -1) - (a.level ?? -1) || a.grid - b.grid;
}
function resourceFieldOwnedRow(field) {
  const action = resourceFieldsAction, target = action.target;
  const row = el('tr'), plot = el('td'), controls = el('td');
  const city = field.cityName || '城市未同步', name = field.name || '资源田', grid = '格 ' + field.grid;
  row.dataset.ownedField = String(field.grid);
  plot.append(el('strong', '', city));
  if (target) plot.append(el('small', 'dim', resourceFieldName(field.resourceId || '未知资源')));
  const button = smallButton(target ? '选为旧田' : '放弃'); button.type = 'button';
  if (target) {
    button.dataset.resourceSelectOld = String(field.grid);
    button.dataset.unavailable = resourceFieldReplacementReason(field) || (target.grid === field.grid ? '与目标地块相同' : '');
    button.onclick = () => openResourceFieldAction(target.grid, field.grid);
  } else {
    button.dataset.resourceGiveUp = String(field.grid); button.dataset.unavailable = field.giveUpReason || '';
    button.onclick = () => openResourceFieldGiveUp(field.grid);
  }
  button.setAttribute('aria-label', button.textContent + ' ' + city + ' · ' + name + ' · ' + grid);
  controls.append(button);
  row.append(plot, el('td', '', field.level ?? '未同步'),
    el('td', 'resource-fields-yield', resourceFieldRate(fieldEffectiveYield(field))), controls);
  return row;
}
function paintOwnedResourceFieldTable() {
  const action = resourceFieldsAction, data = resourceFieldsData;
  const root = clear($('resource-fields-owned-table')), all = data.owned || [];
  const owned = all.filter(field => !action.detailResource || field.resourceId === action.resource).sort(compareResourceFieldsByLevel);
  $('resource-fields-owned-hint').dataset.count = String(owned.length);
  for (const field of owned) root.append(resourceFieldOwnedRow(field));
  if (!owned.length) resourceFieldTableEmpty(root, data.count == null ? '已占资源田未同步' : '暂无已占' + (action.detailResource ? resourceFieldBuildings.get(action.resource) : '资源田'), 4);
}
function resourceFieldCandidateRow(field, canOccupy, canReplace) {
  const row = el('tr'), plot = el('td'), actions = el('td'), controls = el('div', 'resource-fields-row-actions');
  const name = field.name || '资源田', city = field.cityName || '城市未同步', location = city + ' · 格 ' + field.grid;
  const level = field.level == null ? '等级未同步' : 'Lv.' + field.level;
  row.dataset.candidateField = String(field.grid);
  plot.append(el('strong', '', city), el('small', 'dim', level + ' ' + name));
  plot.title = name + ' · ' + location;
  if (canOccupy) {
    const button = smallButton('占领'); button.type = 'button'; button.dataset.resourceField = String(field.grid);
    button.setAttribute('aria-label', '占领 ' + name + ' ' + location); button.onclick = () => openResourceFieldAction(field.grid);
    controls.append(button);
  }
  if (canReplace) {
    const button = smallButton('替换'); button.type = 'button'; button.dataset.resourceReplace = String(field.grid);
    button.setAttribute('aria-label', '替换为 ' + name + ' ' + location);
    button.onclick = () => {
      resourceFieldsAction.target = field; showResourceFieldSelection();
      $('resource-fields-owned-table').closest('.resource-fields-table-scroll').focus();
    };
    controls.append(button);
  }
  actions.append(controls);
  row.append(plot, el('td', 'resource-fields-yield', resourceFieldRate(field.perHour)), el('td', '', resourceFieldsNumber(field.recommendedPower)), actions);
  return row;
}
function paintResourceFieldCandidates() {
  const action = resourceFieldsAction, data = resourceFieldsData;
  const root = clear($('resource-fields-candidates')), common = resourceFieldDispatchReason();
  const occupyReason = resourceFieldCapacityReason(false), replaceReason = resourceFieldCapacityReason(true);
  const reason = common || (occupyReason && replaceReason);
  const rows = reason ? [] : (data.candidates || []).filter(field => field.resourceId === action.resource && !field.reason)
    .sort(compareResourceFieldsByLevel);
  const fragment = document.createDocumentFragment();
  for (const field of rows) fragment.append(resourceFieldCandidateRow(field, !occupyReason, !replaceReason));
  root.append(fragment);
  $('resource-fields-candidate-count').textContent = rows.length + ' 块可选';
  $('resource-fields-candidate-fuel').textContent = '每队 ' + resourceFieldsNumber(data.cost) + ' 汽油 · 库存 ' + resourceFieldsNumber(data.fuel);
  if (!rows.length) resourceFieldTableEmpty(root, reason || '当前没有可占的' + resourceFieldBuildings.get(action.resource), 4);
}
function fieldEffectiveYield(field) {
  if (field?.active === false) return 0;
  return field?.active === true && Number.isSafeInteger(field.perHour) && field.perHour >= 0 ? field.perHour : null;
}
function appendResourceFieldComparison(root, quote, action) {
  const old = quote.replacement, target = quote.resourceId ? quote : resourceFieldsData.candidates.find(row => row.grid === action.gridIdx) || quote;
  const comparison = el('div', 'resource-fields-comparison');
  const add = (label, field, oldField = false) => {
    const item = el('div'); item.append(el('small', 'dim', label), el('strong', '', (field.name || '资源田') + ' · Lv.' + (field.level ?? '?')),
      el('span', 'dim', (field.cityName || '城市未同步') + ' · 格 ' + (field.grid ?? field.gridIdx)),
      el('span', 'resource-fields-yield', resourceFieldName(field.resourceId || '') + ' ' + resourceFieldsNumber(oldField ? fieldEffectiveYield(field) : field.perHour) + '/小时'));
    if (oldField && field.active === false) item.append(el('small', 'warn', '当前失效，实际产量为 0'));
    comparison.append(item);
  };
  if (old) add('先放弃旧田', old, true);
  add(old ? '再出征新田' : '新增占领目标', { ...target, gridIdx: quote.gridIdx ?? action.gridIdx }); root.append(comparison);
  if (old && old.resourceId === target.resourceId) {
    const before = fieldEffectiveYield(old), after = target.perHour;
    if (before !== null && Number.isFinite(after)) {
      const difference = after - before;
      root.append(el('p', difference < 0 ? 'warn' : 'resource-fields-yield', '占领成功后预计 ' + resourceFieldName(target.resourceId) + (difference >= 0 ? ' +' : ' −') + fmt(Math.abs(difference)) + '/小时（基础产量）'));
    } else root.append(el('p', 'dim', '收益变化待同步，当前无法计算准确差额'));
  } else if (old) root.append(el('p', 'dim', '跨资源替换会减少旧田对应产出并增加新田对应产出，两种资源不合并计算。'));
}
async function openResourceFieldAction(gridIdx, replaceGridIdx = null) {
  const action = resourceFieldsAction;
  if (!action || action.phase !== 'selecting' || action.detailResource || !resourceFieldsConnected() || action.account !== current || resourceFieldDispatchReason()) return;
  const replace = replaceGridIdx !== null;
  if (resourceFieldCapacityReason(replace) || (replace && (action.target?.grid !== gridIdx || gridIdx === replaceGridIdx))) return;
  if (replace) {
    const old = (resourceFieldsData.owned || []).find(field => field.grid === replaceGridIdx);
    if (!old || resourceFieldReplacementReason(old)) return;
  }
  action.replaceGridIdx = replaceGridIdx;
  $('resource-fields-action-back').textContent = replace ? '返回选旧田' : '返回候选';
  action.phase = 'preview'; action.kind = 'dispatch'; action.gridIdx = gridIdx;
  $('resource-fields-manager').hidden = true; $('resource-fields-action-body').hidden = false;
  $('resource-fields-action-title').textContent = replace ? '确认替换资源田' : '确认占领资源田';
  clear($('resource-fields-action-body')).append(el('p', 'dim', '正在核对目标、收益、汽油和可用舰队…'));
  $('resource-fields-action-confirm').hidden = false; $('resource-fields-action-confirm').disabled = true;
  $('resource-fields-action-back').hidden = true;
  updateResourceFieldsControls();
  try {
    const intent = { gridIdx, ...(action.replaceGridIdx !== null ? { replaceGridIdx: action.replaceGridIdx } : {}) };
    const quote = await call('/api/resource-fields/preview?account=' + encodeURIComponent(action.account), { method: 'POST', body: JSON.stringify(intent) });
    if (resourceFieldsAction !== action || action.phase !== 'preview' || current !== action.account || !resourceFieldsConnected()) return;
    if (quote.gridIdx !== gridIdx || (quote.replacement?.grid ?? null) !== replaceGridIdx) throw Error('地块确认信息不一致，请返回重新选择');
    action.phase = 'ready'; action.quote = quote;
    const root = clear($('resource-fields-action-body')); appendResourceFieldComparison(root, quote, action);
    root.append(el('p', 'resource-fields-cost', '本次消耗 ' + resourceFieldsNumber(quote.cost) + ' 汽油 · 库存 ' + resourceFieldsNumber(quote.fuel)));
    root.append(el('p', 'dim', '新田推荐战力 ' + resourceFieldsNumber(quote.recommendedPower) + '，战斗结果以游戏结算为准'));
    if (quote.reason) root.append(el('p', 'warn', quote.reason));
    const choices = el('fieldset', 'resource-fields-action-fleets'); choices.append(el('legend', '', '选择派遣舰队'));
    for (const fleet of quote.fleets || []) {
      const label = el('label', 'resource-fields-action-fleet'), input = el('input'); input.type = 'radio'; input.name = 'resource-field-fleet'; input.value = fleet.id;
      input.disabled = !fleet.available; label.classList.toggle('is-unavailable', !fleet.available);
      const body = el('span'); body.append(el('strong', '', fleet.name || fleet.id), el('span', 'dim', '战力 ' + resourceFieldsNumber(fleet.power) + ' · 耐久 ' + resourceFieldsNumber(fleet.durability)));
      if (fleet.reason) body.append(el('small', 'warn', fleet.reason));
      input.onchange = () => { action.fleetId = fleet.id; $('resource-fields-action-confirm').disabled = !quote.token || Date.now() >= quote.expiresAt; };
      if (fleet.available && !action.fleetId) { input.checked = true; action.fleetId = fleet.id; }
      label.append(input, body); choices.append(label);
    }
    root.append(choices, el('p', quote.replacement ? 'warn resource-fields-replacement-warning' : 'dim', quote.replacement
      ? '确认后先放弃旧田，再派舰队出征新田。新田战败或中途失败不会自动恢复旧田；出征期间旧田停止产出。'
      : '派遣后需要行军与战斗，占领结果以服务器为准。'));
    const expiry = el('p', 'warn'); expiry.id = 'resource-fields-action-expiry'; expiry.hidden = true; root.append(expiry);
    $('resource-fields-action-confirm').textContent = quote.replacement ? '放弃旧田并派遣' : '确认派遣';
    $('resource-fields-action-confirm').disabled = !quote.token || !action.fleetId || Date.now() >= quote.expiresAt;
    $('resource-fields-action-back').hidden = false;
  } catch (error) {
    if (resourceFieldsAction !== action || current !== action.account) return;
    action.phase = 'error'; clear($('resource-fields-action-body')).append(el('p', 'warn', '无法准备操作：' + error.message)); $('resource-fields-action-back').hidden = false;
  }
}
async function openResourceFieldGiveUp(gridIdx) {
  const action = resourceFieldsAction;
  if (!action || action.phase !== 'selecting' || !resourceFieldsConnected() || action.account !== current || (action.detailResource && resourceFieldsStale())) return;
  action.phase = 'preview'; action.kind = 'giveUp'; action.gridIdx = gridIdx; action.fleetId = null;
  $('resource-fields-manager').hidden = true; $('resource-fields-action-body').hidden = false;
  $('resource-fields-action-title').textContent = '确认放弃资源田';
  clear($('resource-fields-action-body')).append(el('p', 'dim', '正在核对这块已占资源田…'));
  $('resource-fields-action-confirm').hidden = false; $('resource-fields-action-confirm').disabled = true;
  $('resource-fields-action-back').hidden = true;
  updateResourceFieldsControls();
  try {
    const quote = await call('/api/resource-fields/preview?account=' + encodeURIComponent(action.account), { method: 'POST', body: JSON.stringify({ kind: 'giveUp', gridIdx }) });
    if (resourceFieldsAction !== action || action.phase !== 'preview' || current !== action.account || !resourceFieldsConnected()) return;
    if (quote.kind !== 'giveUp' || quote.gridIdx !== gridIdx || quote.field?.grid !== gridIdx) throw Error('资源田确认信息不完整，请返回重新选择');
    action.phase = 'ready'; action.quote = quote;
    const root = clear($('resource-fields-action-body')), field = quote.field, rate = fieldEffectiveYield(field);
    root.append(resourceFieldRow(field), el('p', 'resource-fields-cost', rate === null ? '该田当前产量未同步，放弃后会失去其产出。' : '放弃后减少 ' + resourceFieldName(field.resourceId || '对应资源') + ' ' + resourceFieldsNumber(rate) + '/小时（当前有效基础产量）'),
      el('p', 'dim', '不需要舰队，不消耗汽油。放弃后释放这块田的占领名额。'),
      el('p', 'warn resource-fields-replacement-warning', '确认后停止持有这块资源田；需要重新出征才能再次占领。'));
    if (quote.automatic) root.append(el('p', 'warn', '自动占领仍开启，后续可能再次占领资源田。可到资源田配置中关闭自动占领。'));
    if (quote.reason) root.append(el('p', 'warn', quote.reason));
    const expiry = el('p', 'warn'); expiry.id = 'resource-fields-action-expiry'; expiry.hidden = true; root.append(expiry);
    $('resource-fields-action-confirm').textContent = '确认放弃';
    $('resource-fields-action-confirm').disabled = !quote.available || !quote.token || Date.now() >= quote.expiresAt;
    $('resource-fields-action-back').hidden = false;
  } catch (error) {
    if (resourceFieldsAction !== action || current !== action.account) return;
    action.phase = 'error'; clear($('resource-fields-action-body')).append(el('p', 'warn', '无法准备操作：' + error.message)); $('resource-fields-action-back').hidden = false;
  }
}
async function submitResourceFieldAction() {
  const action = resourceFieldsAction;
  if (!action || action.phase !== 'ready' || !action.quote?.token || action.account !== current || !resourceFieldsConnected()) return;
  const giveUp = action.kind === 'giveUp';
  if (giveUp ? !action.quote.available : !action.fleetId) return;
  if (Date.now() >= action.quote.expiresAt) { $('resource-fields-action-confirm').disabled = true; return; }
  action.phase = 'sending'; $('resource-fields-action-confirm').disabled = true; $('resource-fields-action-dialog').close(); updateResourceFieldsControls();
  resourceFieldsFeedback(giveUp ? '正在放弃所选资源田，等待服务器确认…' : action.quote.replacement ? '正在放弃旧田并派遣舰队，等待服务器确认…' : '正在派遣舰队，等待服务器确认…');
  try {
    const result = await call('/api/resource-fields/action?account=' + encodeURIComponent(action.account), { method: 'POST', body: JSON.stringify({ confirm: true, token: action.quote.token, ...(!giveUp ? { fleetId: action.fleetId } : {}) }) });
    if (resourceFieldsAction !== action || current !== action.account || !resourceFieldsConnected()) return;
    const partial = !giveUp && (result.partial || result.released && !result.ok);
    if (!giveUp && result.ok && result.status === 'confirmed' && !partial) {
      resourceFieldsFeedback('');
      return;
    }
    const message = partial ? '旧田已放弃，新田派遣尚未完成，旧田不会自动恢复。' + (result.reason || '')
      : result.reason || (giveUp && result.ok ? '资源田已放弃，名额已释放。' : result.status === 'unknown' ? '操作结果待确认，已保留任务记录，不会自动重发。' : '操作未完成：' + (result.error || '请刷新后重试'));
    resourceFieldsFeedback(message, !result.ok || !!partial);
  } catch (error) {
    if (resourceFieldsAction === action && current === action.account) resourceFieldsFeedback('未取得操作结果：' + error.message + (giveUp ? '。放弃结果待确认，请刷新资源田核对；不会自动重发。' : action.quote.replacement ? '。旧田可能已放弃，请刷新核对资源田和舰队；不会自动重发。' : '。请刷新核对舰队，不会自动重发。'), true);
  } finally {
    if (resourceFieldsAction === action) { resourceFieldsAction = null; updateResourceFieldsControls(); if (current === action.account && resourceFieldsConnected()) await refreshResourceFieldsOverview(); }
  }
}
async function refreshResourceFieldsOverview() {
  if (!resourceFieldsConnected() || resourceFieldsLoading || resourceFieldsAction) return;
  const account = current, serial = ++resourceFieldsSerial;
  resourceFieldsOwner = account; resourceFieldsLoading = true; resourceFieldsLastAttempt = Date.now();
  updateResourceFieldsControls(); $('resource-fields-overview').setAttribute('aria-busy', 'true');
  try {
    const data = await call('/api/resource-fields/overview?account=' + encodeURIComponent(account));
    if (account !== current || serial !== resourceFieldsSerial || !resourceFieldsConnected()) return;
    resourceFieldsData = data; resourceFieldsReceivedAt = Date.now(); paintResourceFieldsOverview(data);
  } catch (error) {
    if (account === current && serial === resourceFieldsSerial) {
      resourceFieldsFeedback('资源田同步失败：' + error.message + '。请刷新后再操作。', true); resourceFieldsReceivedAt = 0;
    }
  } finally {
    if (serial === resourceFieldsSerial) { resourceFieldsLoading = false; resourceFieldsLastAttempt = Date.now(); updateResourceFieldsControls(); $('resource-fields-overview').setAttribute('aria-busy', 'false'); }
  }
}
function maybeRefreshResourceFields() {
  resourceFieldsAccountChanged();
  if (resourceFieldsVisible() && resourceFieldsConnected() && !resourceFieldsLoading && !resourceFieldsAction && Date.now() - resourceFieldsLastAttempt >= 60000) void refreshResourceFieldsOverview();
}
setInterval(() => {
  maybeRefreshResourceFields();
  if (resourceFieldsAction?.phase === 'ready' && Date.now() >= resourceFieldsAction.quote.expiresAt) {
    $('resource-fields-action-confirm').disabled = true;
    const expiry = $('resource-fields-action-expiry'); expiry.hidden = false; expiry.textContent = '本次确认已过期，请返回选田后重新确认。';
  }
}, 1000);
$('resource-fields-refresh').onclick = refreshResourceFieldsOverview;
$('resource-fields-dialog-close').onclick = closeResourceFieldAction;
$('resource-fields-action-back').onclick = () => {
  const action = resourceFieldsAction; if (!action || action.phase === 'sending') return;
  let selector, grid;
  if (action.phase === 'selecting' && action.target) {
    selector = 'data-resource-replace'; grid = action.target.grid; action.target = null;
  } else if (action.target) {
    selector = 'data-resource-select-old'; grid = action.replaceGridIdx;
  } else {
    selector = action.detailResource ? 'data-resource-give-up' : 'data-resource-field'; grid = action.gridIdx;
  }
  showResourceFieldSelection();
  const button = document.querySelector('[' + selector + '="' + grid + '"]');
  const table = $('resource-fields-' + (action.detailResource || action.target ? 'owned-table' : 'candidates'));
  (button && !button.disabled ? button : table.closest('.resource-fields-table-scroll')).focus();
};
$('resource-fields-action-dialog').oncancel = event => { event.preventDefault(); closeResourceFieldAction(); };
$('resource-fields-action-confirm').onclick = submitResourceFieldAction;
