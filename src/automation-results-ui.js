const resultsState = bindConsoleObject('results', { period: 'current', scope: 'role', page: 1, data: null, serial: 0, loading: false }, ['period', 'scope', 'page', 'data', 'serial', 'loading']);
const resultsVisible = () => consoleStore.getState().view.page === 'results' && !document.hidden;
const resultsAccount = () => consoleStore.getState().currentAccountId;
function resultsDuration(ms) {
  const seconds = Math.floor(Math.max(0, ms || 0) / 1000), hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return hours ? hours + '小时' + minutes + '分' : minutes ? minutes + '分' + seconds % 60 + '秒' : seconds + '秒';
}
function resultsTime(at) { return new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }); }
function resultsMaterial(data, id) { return data.materials?.[id]?.name || id; }
function resultsBlank(node, text) { node.replaceChildren(el('p', 'dim results-empty', text)); }
function renderResults() {
  const data = resultsState.data;
  $('results-current').setAttribute('aria-pressed', String(resultsState.period === 'current'));
  $('results-today').setAttribute('aria-pressed', String(resultsState.period === 'today'));
  $('results-scope').value = resultsState.scope;
  if (!data) {
    $('results-run').textContent = '';
    $('results-metrics').replaceChildren();
    for (const id of ['gains', 'costs', 'actions', 'roles', 'events']) resultsBlank($('results-' + id), resultsAccount() ? '等待读取成果' : '请先选择一个区服');
    $('results-previous').disabled = $('results-next').disabled = true;
    $('results-page-number').textContent = '';
    $('results-empty').hidden = true;
    $('results-pending-list').replaceChildren();
    return;
  }
  const total = data.totals;
  $('results-run').textContent = data.period === 'today' ? data.day + ' · 北京时间今日累计'
    : data.run ? (data.run.kind === 'rotation' ? '区服轮换' : '普通挂机') + ' · ' + resultsTime(data.run.startedAt) + ' 开始 · ' + (data.run.endedAt ? '已结束：' + (data.run.reason || '挂机停止') : '本次持续累计') : '尚无本次挂机记录';
  const metrics = [
    ['挂机时长', resultsDuration(total.elapsedMs)], ['实际在线', resultsDuration(total.onlineMs)],
    ['成功操作', fmt(total.completed) + ' 次'], ['参与区服', data.roles.filter(role => role.elapsedMs > 0 || role.completed > 0).length + ' 个'],
  ];
  $('results-metrics').replaceChildren(...metrics.map(([label, value]) => { const box = el('dl', 'results-metric'); box.append(el('dt', '', label), el('dd', '', value)); return box; }));
  $('results-empty').hidden = Boolean(total.completed || Object.keys(total.gains).length || Object.keys(total.costs).length);
  $('results-empty').textContent = data.run?.endedAt ? '本次挂机没有确认的成果，可在明细和待确认操作中查看情况。' : total.elapsedMs ? '挂机正在记录，当前还没有确认的成果。' : '尚无挂机成果，开始挂机后会自动记录。';
  for (const [field, sign] of [['gains', '+'], ['costs', '−']]) {
    const entries = Object.entries(total[field]).sort((a, b) => b[1] - a[1]), root = $('results-' + field);
    if (!entries.length) { resultsBlank(root, field === 'gains' ? '当前没有已确认的收获' : '当前没有已确认的消耗'); continue; }
    root.replaceChildren(...entries.map(([id, quantity]) => {
      const name = resultsMaterial(data, id), node = el('details', 'results-asset'), summary = el('summary');
      summary.append(iconEl(data.materials?.[id]?.icon, 30, name), el('span', 'results-asset-name', name), el('strong', field === 'gains' ? 'results-gain' : '', sign + fmt(quantity)));
      summary.title = '展开查看' + name + (field === 'gains' ? '的收获来源' : '的消耗用途');
      const sources = el('div', 'results-asset-sources');
      for (const [label, amount] of Object.entries(total[field === 'gains' ? 'gainSources' : 'costSources']?.[id] ?? {})) sources.append(el('p', '', label + ' · ' + sign + fmt(amount)));
      node.append(summary, sources);
      return node;
    }));
  }
  const actions = Object.entries(total.actions).sort((a, b) => b[1] - a[1]), actionRoot = $('results-actions');
  if (!actions.length) resultsBlank(actionRoot, '完成操作后在这里按玩法汇总');
  else actionRoot.replaceChildren(...actions.map(([label, quantity]) => {
    const node = el('div', 'results-action'), bar = el('div', 'results-action-bar'), fill = el('div', 'results-action-fill');
    fill.style.width = Math.max(2, quantity / Math.max(1, total.completed) * 100) + '%'; bar.append(fill);
    node.append(el('span', '', label), el('strong', '', fmt(quantity) + ' 次'), bar); return node;
  }));
  const roleRoot = $('results-roles');
  if (!data.roles.length) resultsBlank(roleRoot, '区服参与挂机后显示成果');
  else roleRoot.replaceChildren(...data.roles.map(role => {
    const node = el('div', 'results-role'); node.append(el('strong', '', role.label), el('p', '', '在线 ' + resultsDuration(role.onlineMs) + ' · 成功 ' + fmt(role.completed) + ' 次 · 收获 ' + Object.keys(role.gains).length + ' 类物品'));
    return node;
  }));
  const eventRoot = $('results-events'), roleNames = new Map(data.roles.map(role => [role.id, role.label]));
  if (!data.events.length) resultsBlank(eventRoot, '当前范围还没有成果明细');
  else eventRoot.replaceChildren(...data.events.map(event => {
    const node = el('article', 'results-event'), meta = el('div', 'results-event-meta'), time = el('time', '', resultsTime(event.at)); time.dateTime = new Date(event.at).toISOString();
    meta.append(time, el('div', 'results-event-role', roleNames.get(event.roleId) || '区服角色'));
    const content = el('div'), title = el('div', 'results-event-title'), status = el('span', 'results-event-state', event.status === 'failed' ? '失败' : event.kind === 'assets' ? '已确认收支' : '已完成');
    status.dataset.state = event.status; title.append(el('span', '', event.label), status); content.append(title);
    const items = el('div', 'results-event-assets');
    for (const [field, sign] of [['gains', '+'], ['costs', '−']]) for (const [id, quantity] of Object.entries(event[field])) items.append(el('span', field === 'gains' ? 'results-gain' : '', resultsMaterial(data, id) + ' ' + sign + fmt(quantity)));
    if (items.childNodes.length) content.append(items);
    if (event.detail) content.append(el('div', 'results-event-detail', event.detail));
    node.append(meta, content); return node;
  }));
  $('results-page-number').textContent = data.page + ' / ' + data.pages + ' 页';
  $('results-previous').disabled = data.page <= 1;
  $('results-next').disabled = data.page >= data.pages;
  $('results-pending-label').textContent = '待确认 ' + total.pending + ' 项 · 失败 ' + total.failed + ' 次';
  $('results-pending-list').replaceChildren(...data.pending.map(entry => el('p', '', (roleNames.get(entry.roleId) || '区服角色') + ' · ' + entry.label + (entry.detail ? ' · ' + entry.detail : ' · 等待服务器核对'))));
  if (!data.pending.length) resultsBlank($('results-pending-list'), '当前没有已记录的待确认操作');
  $('results-note').textContent = '从 ' + resultsTime(data.trackingStartedAt) + ' 开始记录。收获与消耗分别累计，未知数量不推测；每次挂机展示最近 2000 条明细，累计成果保留。';
}
async function refreshResults() {
  const account = resultsAccount();
  if (!resultsVisible() || !account || resultsState.loading) return;
  const serial = ++resultsState.serial;
  resultsState.loading = true;
  if (!resultsState.data) $('results-status').textContent = '正在读取成果…';
  try {
    const data = await call('/api/automation-results?account=' + encodeURIComponent(account) + '&period=' + resultsState.period + '&scope=' + resultsState.scope + '&page=' + resultsState.page);
    if (serial !== resultsState.serial || account !== resultsAccount()) return;
    resultsState.data = data;
    renderResults();
    $('results-status').textContent = data.warning ? '记录保存失败：' + data.warning : '已更新 · ' + new Date(data.now).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  } catch (error) { if (serial === resultsState.serial) $('results-status').textContent = '读取失败：' + error.message; }
  finally { if (serial === resultsState.serial) resultsState.loading = false; }
}
function resultsChange(patch) {
  Object.assign(resultsState, patch); resultsState.serial++; resultsState.loading = false; resultsState.data = null;
  renderResults(); void refreshResults();
}
$('results-current').onclick = () => resultsChange({ period: 'current', page: 1 });
$('results-today').onclick = () => resultsChange({ period: 'today', page: 1 });
$('results-scope').onchange = event => resultsChange({ scope: event.target.value, page: 1 });
$('results-refresh').onclick = () => void refreshResults();
for (const [id, delta] of [['previous', -1], ['next', 1]]) $('results-' + id).onclick = () => resultsChange({ page: Math.max(1, resultsState.page + delta) });
consoleStore.subscribe((state, previous) => {
  if (state.currentAccountId !== previous.currentAccountId) resultsChange({ page: 1 });
  else if (state.view.page !== previous.view.page && state.view.page === 'results') { renderResults(); void refreshResults(); }
});
document.addEventListener('visibilitychange', () => { if (resultsVisible()) void refreshResults(); });
setInterval(() => { if (resultsVisible()) void refreshResults(); }, 3000);
