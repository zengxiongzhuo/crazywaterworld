let resourceFieldsOwner = null, resourceFieldsData = null, resourceFieldsLoading = false, resourceFieldsSerial = 0;
let resourceFieldsReceivedAt = 0, resourceFieldsLastAttempt = 0, resourceFieldsAction = null;
const resourceFieldsNumber = value => Number.isFinite(value) && value >= 0 ? fmt(value) : '未同步';
const resourceFieldsConnected = () => !!current && snapshot.connected && !snapshot.paused && !disconnected.has(current);
const resourceFieldsVisible = () => !document.hidden && !$('tab-overview').classList.contains('hidden');
const resourceFieldsStale = () => !resourceFieldsReceivedAt || Date.now() - resourceFieldsReceivedAt > 120000;
const resourceFieldName = id => id === '公会科技点' ? '科技点' : id;
const resourceFieldTypes = ['汽油', '种子', '公会科技点'];

function resetResourceFieldsOverview() {
  resourceFieldsSerial++; resourceFieldsOwner = null; resourceFieldsData = null; resourceFieldsLoading = false;
  resourceFieldsReceivedAt = 0; resourceFieldsLastAttempt = 0; resourceFieldsAction = null;
  $('resource-fields-action-dialog').close(); $('resource-fields-feedback').hidden = true;
  for (const id of ['summary', 'pending', 'owned-table', 'candidates', 'candidate-count', 'notes', 'automatic', 'action-body']) clear($('resource-fields-' + id));
  $('resource-fields-capacity').textContent = '连接账号后读取资源田';
  $('resource-fields-resource').value = ''; $('resource-fields-level').value = '1';
  $('resource-fields-level').setCustomValidity('');
  $('resource-fields-overview').setAttribute('aria-busy', 'false');
  document.querySelector('#resource-fields-overview .resource-fields-help').open = false;
}
function resourceFieldsAccountChanged() {
  if (resourceFieldsOwner !== null && (resourceFieldsOwner !== current || !resourceFieldsConnected())) resetResourceFieldsOverview();
  updateResourceFieldsControls();
  if (!resourceFieldsConnected()) {
    const message = !current ? '请选择账号查看资源田' : snapshot.paused ? '账号已暂停，连接后可读取资源田' : '连接账号后读取资源田';
    $('resource-fields-status').textContent = message; $('resource-fields-capacity').textContent = message;
  } else if (!resourceFieldsData && !resourceFieldsLoading) $('resource-fields-status').textContent = '等待读取资源田';
}
function updateResourceFieldsControls() {
  const busy = resourceFieldsLoading || resourceFieldsAction !== null;
  $('resource-fields-refresh').disabled = busy || !resourceFieldsConnected();
  for (const button of document.querySelectorAll('[data-resource-manage]')) {
    button.disabled = busy || !resourceFieldsConnected() || resourceFieldsStale();
    button.title = resourceFieldsStale() ? '信息已过期，请先刷新资源田' : '选择新增占领或替换已有田';
  }
  for (const button of document.querySelectorAll('[data-resource-field]')) {
    button.disabled = resourceFieldsAction?.phase !== 'selecting' || !resourceFieldsConnected() || !!button.dataset.unavailable;
    button.title = button.dataset.unavailable || '核对目标、费用和舰队';
  }
  for (const button of document.querySelectorAll('[data-resource-replace], [data-resource-give-up]')) {
    button.disabled = resourceFieldsAction?.phase !== 'selecting' || !resourceFieldsConnected() || !!button.dataset.unavailable;
    button.title = button.dataset.unavailable || '';
  }
}
function resourceFieldRow(field) {
  const row = el('article', 'resource-fields-row'), body = el('div');
  body.append(el('strong', '', (field.name || '资源田') + ' · ' + (field.level == null ? '等级未同步' : 'Lv.' + field.level)));
  body.append(el('span', 'dim', (field.cityName || '城市未同步') + ' · 格 ' + field.grid));
  body.append(el('span', 'resource-fields-yield', field.product || '产出未同步'));
  if (field.productionStatus) body.append(el('small', field.active === false ? 'warn' : 'dim', field.productionStatus));
  row.append(body);
  return row;
}
function paintResourceFieldsOverview(data) {
  const opened = new Set([...document.querySelectorAll('[data-resource-details][open]')].map(node => node.dataset.resourceDetails));
  const summary = clear($('resource-fields-summary'));
  $('resource-fields-capacity').textContent = '已占 ' + resourceFieldsNumber(data.count) + ' / ' + resourceFieldsNumber(data.maxNum)
    + ' · 可新增 ' + resourceFieldsNumber(data.remaining) + ' · 在途 ' + (data.pending?.length || 0)
    + ((data.owned || []).some(row => !resourceFieldTypes.includes(row.resourceId)) ? ' · 类型待同步 ' + data.owned.filter(row => !resourceFieldTypes.includes(row.resourceId)).length : '');
  for (const id of resourceFieldTypes) {
    const owned = (data.owned || []).filter(row => row.resourceId === id), item = (data.totals || []).find(row => row.id === id);
    const card = el('article', 'resource-fields-type'); card.dataset.resourceType = id;
    const details = el('details'); details.dataset.resourceDetails = id; details.open = opened.has(id);
    const heading = el('summary'), text = el('span', 'resource-fields-type-summary');
    text.append(el('strong', '', resourceFieldName(id)), el('span', 'resource-fields-rate', resourceFieldsNumber(item?.perHour) + (item?.perHour == null ? '' : ' /小时')),
      el('small', 'dim', '已占 ' + (data.count == null ? '未同步' : owned.length) + ' · 失效 ' + (data.count == null ? '未同步' : owned.filter(row => row.active === false).length)
        + (owned.some(row => row.active == null) ? ' · 归属待同步 ' + owned.filter(row => row.active == null).length : '')));
    heading.append(text); details.append(heading);
    const list = el('div', 'resource-fields-owned');
    for (const field of owned) list.append(resourceFieldRow(field));
    if (!owned.length) list.append(el('p', 'dim', data.count == null ? '已占信息未同步' : '暂无此类资源田'));
    details.append(list); card.append(details);
    const button = smallButton('管理'); button.type = 'button'; button.dataset.resourceManage = id;
    button.setAttribute('aria-label', '管理' + resourceFieldName(id) + '资源田'); button.onclick = () => openResourceFieldManager(id);
    card.append(button); summary.append(card);
  }
  const pending = clear($('resource-fields-pending'));
  for (const entry of data.pending || []) {
    pending.append(el('p', entry.confirmed ? 'dim' : 'warn', (entry.fleetId || '舰队') + ' → 格 ' + entry.grid + ' · ' + (entry.reason || (entry.confirmed ? '已派遣，等待战斗结果' : '操作结果待确认')) + '，已预留名额'));
  }
  $('resource-fields-automatic').textContent = data.automatic ? '自动占领已开启' : '自动占领未开启';
  $('resource-fields-notes').textContent = (data.notes || []).join(' ');
  updateResourceFieldsControls();
}
function resourceFieldsFeedback(text, warning = false) {
  const node = $('resource-fields-feedback'); node.hidden = false; node.textContent = text; node.classList.toggle('warn', warning);
}
function closeResourceFieldAction() {
  if (resourceFieldsAction?.phase !== 'sending') resourceFieldsAction = null;
  $('resource-fields-action-dialog').close(); updateResourceFieldsControls();
}
function openResourceFieldManager(resource) {
  if (!resourceFieldsConnected() || resourceFieldsLoading || resourceFieldsAction || resourceFieldsStale()) return;
  resourceFieldsAction = { account: current, phase: 'selecting', page: 0, ownedPage: 0, replaceGridIdx: null, quote: null, fleetId: null };
  $('resource-fields-resource').value = resource; $('resource-fields-level').value = '1'; $('resource-fields-level').setCustomValidity('');
  showResourceFieldSelection(); $('resource-fields-action-dialog').showModal();
  document.querySelector('#resource-fields-manager .resource-fields-table-scroll').focus(); $('resource-fields-action-dialog').scrollTop = 0;
}
function showResourceFieldSelection() {
  const action = resourceFieldsAction; if (!action || action.phase === 'sending') return;
  action.phase = 'selecting'; action.kind = null; action.quote = null; action.fleetId = null;
  $('resource-fields-action-title').textContent = '管理资源田';
  $('resource-fields-manager').hidden = false; $('resource-fields-action-body').hidden = true;
  $('resource-fields-action-confirm').hidden = true; $('resource-fields-action-back').hidden = true;
  $('resource-fields-action-cancel').textContent = '关闭';
  paintOwnedResourceFieldTable(); paintResourceFieldCandidates(); updateResourceFieldsControls();
}
function resourceFieldTableEmpty(root, message) {
  const row = el('tr'), cell = el('td', 'dim', message); cell.colSpan = 6; row.append(cell); root.append(row);
}
function resourceFieldCandidateReason(field) {
  const data = resourceFieldsData, action = resourceFieldsAction;
  if (!data || !action) return '资源田信息未同步';
  if (data.reason || field?.reason) return data.reason || field.reason;
  const valid = value => Number.isSafeInteger(value) && value >= 0;
  const replacing = action.replaceGridIdx !== null;
  if (replacing) {
    const old = (data.owned || []).find(row => row.grid === action.replaceGridIdx);
    if (!old || field?.grid === old.grid) return '请选择仍由本人占领的另一块旧田';
    if (old.replacementReason) return old.replacementReason;
    if (!old.resourceId || !(old.active === false || old.active === true && valid(old.perHour))) return '旧田产出或归属未同步';
    if (!valid(data.maxNum) || !valid(data.count) || !Array.isArray(data.pending)) return '资源田名额未同步';
    if (data.maxNum - data.count - data.pending.length + 1 <= 0) return '名额已被在途任务预留';
  } else if (!valid(data.remaining)) return '资源田名额未同步';
  else if (data.remaining === 0) return '名额已满，请在上方选择要替换的旧田';
  if (!(data.fleets || []).some(fleet => fleet.available === true)) return '暂无可用舰队';
  if (!valid(data.cost) || !valid(data.fuel) || !valid(data.pendingFuel ?? 0)) return '占田费用或汽油库存未同步';
  if (data.fuel - (data.pendingFuel ?? 0) < data.cost) return '可用汽油不足（含其他任务待确认消耗）';
  return '';
}
function resourceFieldTableRow(field, owned) {
  const row = el('tr'); if (owned) row.dataset.ownedField = String(field.grid);
  if (owned && resourceFieldsAction.replaceGridIdx === field.grid) row.classList.add('is-selected');
  const type = el('td', '', resourceFieldName(field.resourceId || '未同步'));
  const name = el('td'); name.append(el('strong', '', field.name || '资源田'), el('small', 'dim', 'Lv.' + (field.level ?? '?')));
  const location = el('td'); location.append(el('span', '', field.cityName || '城市未同步'), el('small', 'dim', '格 ' + field.grid));
  const rate = el('td', 'resource-fields-yield', resourceFieldsNumber(owned ? fieldEffectiveYield(field) : field.perHour) + '/小时');
  const state = el('td', owned && field.active === false ? 'warn' : '');
  state.append(el('span', '', owned ? field.productionStatus || (field.active === true ? '产出中' : field.active === false ? '暂停产出' : '归属未同步') : resourceFieldsNumber(field.recommendedPower)));
  const actions = el('td'), controls = el('div', 'resource-fields-row-actions');
  if (owned) {
    for (const [kind, label, reason] of [['replace', '替换', field.replacementReason], ['giveUp', '放弃', field.giveUpReason]]) {
      const button = smallButton(label); button.type = 'button'; button.dataset[kind === 'replace' ? 'resourceReplace' : 'resourceGiveUp'] = String(field.grid);
      button.dataset.unavailable = reason || ''; button.setAttribute('aria-label', label + ' ' + (field.name || '资源田') + ' 格 ' + field.grid);
      button.onclick = () => {
        if (kind === 'giveUp') void openResourceFieldGiveUp(field.grid);
        else { resourceFieldsAction.replaceGridIdx = field.grid; paintOwnedResourceFieldTable(); paintResourceFieldCandidates(); }
      };
      controls.append(button);
    }
    const reason = field.giveUpReason || field.replacementReason; if (reason) state.append(el('small', 'warn', reason));
  } else {
    const replace = resourceFieldsAction.replaceGridIdx !== null, button = smallButton(replace ? '选为替换' : '占领');
    button.type = 'button'; button.dataset.resourceField = String(field.grid); button.setAttribute('aria-label', (replace ? '选为替换 ' : '占领 ') + (field.name || '资源田') + ' 格 ' + field.grid);
    button.dataset.unavailable = resourceFieldCandidateReason(field);
    button.onclick = () => openResourceFieldAction(field.grid); controls.append(button);
    if (field.reason) state.append(el('small', 'warn', field.reason));
  }
  actions.append(controls); row.append(type, name, location, rate, state, actions); return row;
}
function paintOwnedResourceFieldTable() {
  const action = resourceFieldsAction; if (!action || action.phase !== 'selecting') return;
  const root = clear($('resource-fields-owned-table')), owned = resourceFieldsData.owned || [], pages = Math.max(1, Math.ceil(owned.length / 6));
  action.ownedPage = Math.min(action.ownedPage || 0, pages - 1);
  for (const field of owned.slice(action.ownedPage * 6, (action.ownedPage + 1) * 6)) root.append(resourceFieldTableRow(field, true));
  if (!owned.length) resourceFieldTableEmpty(root, resourceFieldsData.count === null ? '已占资源田未同步' : '暂无已占资源田');
  $('resource-fields-owned-page').textContent = '共 ' + owned.length + ' 块 · ' + (action.ownedPage + 1) + ' / ' + pages + ' 页';
  $('resource-fields-owned-prev').disabled = action.ownedPage === 0; $('resource-fields-owned-next').disabled = action.ownedPage + 1 >= pages;
  updateResourceFieldsControls();
}
function paintResourceFieldCandidates() {
  const action = resourceFieldsAction, data = resourceFieldsData;
  if (!action || action.phase !== 'selecting' || !data) return;
  const root = clear($('resource-fields-candidates')), resource = $('resource-fields-resource').value;
  const minimum = Number($('resource-fields-level').value) || 1, replace = action.replaceGridIdx !== null;
  const rows = (data.candidates || []).filter(field => !resourceFieldCandidateReason(field) && (!resource || field.resourceId === resource) && field.level >= minimum);
  if (resource) rows.sort((a, b) => b.level - a.level || (b.perHour ?? -1) - (a.perHour ?? -1) || a.grid - b.grid);
  const pages = Math.max(1, Math.ceil(rows.length / 6)); action.page = Math.min(action.page || 0, pages - 1);
  for (const field of rows.slice(action.page * 6, (action.page + 1) * 6)) root.append(resourceFieldTableRow(field, false));
  const availability = resourceFieldCandidateReason(null);
  const sampled = data.candidateCount > (data.candidates?.length || 0) ? '（各资源优先目标）' : '';
  $('resource-fields-candidate-count').textContent = rows.length + ' 块当前可占' + sampled + ' · 每队 ' + resourceFieldsNumber(data.cost) + ' 汽油 · 库存 ' + resourceFieldsNumber(data.fuel) + (availability ? ' · ' + availability : '');
  const old = (data.owned || []).find(row => row.grid === action.replaceGridIdx);
  $('resource-fields-replace-bar').hidden = !replace;
  $('resource-fields-replace-note').textContent = old ? resourceFieldName(old.resourceId || '未知资源') + ' · ' + (old.name || '资源田') + ' Lv.' + (old.level ?? '?') + ' · 格 ' + old.grid + ' · 当前 ' + resourceFieldsNumber(fieldEffectiveYield(old)) + '/小时。请在下表选择新田。' : '';
  if (!rows.length) resourceFieldTableEmpty(root, availability || '当前没有符合筛选条件的可占资源田');
  $('resource-fields-page-state').textContent = (action.page + 1) + ' / ' + pages + ' 页';
  $('resource-fields-page-prev').disabled = action.page === 0; $('resource-fields-page-next').disabled = action.page + 1 >= pages;
  updateResourceFieldsControls();
}
function fieldEffectiveYield(field) {
  if (field?.active === false) return 0;
  return field?.active === null || !Number.isFinite(field?.perHour) ? null : field.perHour;
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
async function openResourceFieldAction(gridIdx) {
  const action = resourceFieldsAction;
  if (!action || action.phase !== 'selecting' || !resourceFieldsConnected() || action.account !== current) return;
  const replace = action.replaceGridIdx !== null;
  action.phase = 'preview'; action.kind = 'dispatch'; action.gridIdx = gridIdx;
  $('resource-fields-manager').hidden = true; $('resource-fields-action-body').hidden = false;
  $('resource-fields-action-title').textContent = replace ? '确认替换资源田' : '确认占领资源田';
  clear($('resource-fields-action-body')).append(el('p', 'dim', '正在核对目标、收益、汽油和可用舰队…'));
  $('resource-fields-action-confirm').hidden = false; $('resource-fields-action-confirm').disabled = true;
  $('resource-fields-action-back').hidden = true; $('resource-fields-action-cancel').textContent = '取消';
  updateResourceFieldsControls();
  try {
    const intent = { gridIdx, ...(action.replaceGridIdx !== null ? { replaceGridIdx: action.replaceGridIdx } : {}) };
    const quote = await call('/api/resource-fields/preview?account=' + encodeURIComponent(action.account), { method: 'POST', body: JSON.stringify(intent) });
    if (resourceFieldsAction !== action || action.phase !== 'preview' || current !== action.account || !resourceFieldsConnected()) return;
    if (action.replaceGridIdx !== null && quote.replacement?.grid !== action.replaceGridIdx) throw Error('旧田确认信息不完整，请返回重新选择');
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
  if (!action || action.phase !== 'selecting' || !resourceFieldsConnected() || action.account !== current) return;
  action.phase = 'preview'; action.kind = 'giveUp'; action.gridIdx = gridIdx; action.fleetId = null;
  $('resource-fields-manager').hidden = true; $('resource-fields-action-body').hidden = false;
  $('resource-fields-action-title').textContent = '确认放弃资源田';
  clear($('resource-fields-action-body')).append(el('p', 'dim', '正在核对这块已占资源田…'));
  $('resource-fields-action-confirm').hidden = false; $('resource-fields-action-confirm').disabled = true;
  $('resource-fields-action-back').hidden = true; $('resource-fields-action-cancel').textContent = '取消';
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
    const message = partial ? '旧田已放弃，新田派遣尚未完成，旧田不会自动恢复。' + (result.reason || '')
      : result.reason || (result.ok ? giveUp ? '资源田已放弃，名额已释放。' : '派遣已确认，最终占领结果请刷新查看。' : result.status === 'unknown' ? '操作结果待确认，已保留任务记录，不会自动重发。' : '操作未完成：' + (result.error || '请刷新后重试'));
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
  updateResourceFieldsControls(); $('resource-fields-status').textContent = '正在同步资源田…'; $('resource-fields-overview').setAttribute('aria-busy', 'true');
  try {
    const data = await call('/api/resource-fields/overview?account=' + encodeURIComponent(account));
    if (account !== current || serial !== resourceFieldsSerial || !resourceFieldsConnected()) return;
    resourceFieldsData = data; resourceFieldsReceivedAt = Date.now(); paintResourceFieldsOverview(data);
    $('resource-fields-status').textContent = data.reason || (((data.notes || []).some(note => note.includes('未同步')) ? '部分信息未同步 · ' : '更新 ') + new Date(data.checkedAt * 1000).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }));
  } catch (error) {
    if (account === current && serial === resourceFieldsSerial) {
      $('resource-fields-status').textContent = '同步失败：' + error.message + (resourceFieldsData ? '；下方为上次同步结果' : '');
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
$('resource-fields-resource').onchange = () => { if (resourceFieldsAction) resourceFieldsAction.page = 0; paintResourceFieldCandidates(); };
$('resource-fields-replace-cancel').onclick = () => { if (resourceFieldsAction?.phase === 'selecting') { resourceFieldsAction.replaceGridIdx = null; paintOwnedResourceFieldTable(); paintResourceFieldCandidates(); } };
$('resource-fields-level').oninput = event => {
  const input = event.target, value = Number(input.value);
  input.setCustomValidity(input.value && Number.isInteger(value) && value >= 1 && value <= 100 ? '' : '请输入 1–100 之间的整数等级');
  if (input.validity.valid) { if (resourceFieldsAction) resourceFieldsAction.page = 0; paintResourceFieldCandidates(); }
};
$('resource-fields-page-prev').onclick = () => { if (resourceFieldsAction?.page > 0) { resourceFieldsAction.page--; paintResourceFieldCandidates(); } };
$('resource-fields-page-next').onclick = () => { if (resourceFieldsAction) { resourceFieldsAction.page++; paintResourceFieldCandidates(); } };
$('resource-fields-owned-prev').onclick = () => { if (resourceFieldsAction?.ownedPage > 0) { resourceFieldsAction.ownedPage--; paintOwnedResourceFieldTable(); } };
$('resource-fields-owned-next').onclick = () => { if (resourceFieldsAction) { resourceFieldsAction.ownedPage++; paintOwnedResourceFieldTable(); } };
$('resource-fields-action-cancel').onclick = closeResourceFieldAction;
$('resource-fields-dialog-close').onclick = closeResourceFieldAction;
$('resource-fields-action-back').onclick = showResourceFieldSelection;
$('resource-fields-action-dialog').oncancel = event => { event.preventDefault(); closeResourceFieldAction(); };
$('resource-fields-action-confirm').onclick = submitResourceFieldAction;
