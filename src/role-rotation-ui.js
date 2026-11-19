var rotationGroups = [];
var rotationDrafts = new Map();
var rotationLoginId = null;
var rotationLoading = false;
var rotationSaving = false;
var rotationReloadPending = false;
var rotationClockOffset = 0;

function rotationTimeLabel(at) {
  return new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function renderRoleRotationStatus() {
  const group = rotationGroups.find(group => group.loginId === rotationLoginId);
  const node = $('rotation-status');
  if (!group) { node.textContent = '点击「刷新区服」读取角色后可配置轮换。'; return; }
  const state = group.runtime;
  if (!group.settings.enabled) node.textContent = '轮换未启用';
  else if (state.paused) node.textContent = '轮换已暂停，可点击「继续轮换」恢复';
  else if (state.phase === 'running') {
    const role = group.roles.find(role => role.id === state.currentId);
    const left = Math.max(0, Math.ceil((state.endsAt - Date.now() - rotationClockOffset) / 60000));
    node.textContent = '正在挂机：' + (role?.title || '当前区服') + ' · 剩余 ' + left + ' 分钟 · ' + rotationTimeLabel(state.endsAt) + ' 交接';
  } else if (state.phase === 'retrying') {
    const left = Math.max(0, Math.ceil((state.retryAt - Date.now() - rotationClockOffset) / 1000));
    node.textContent = (group.roles.find(role => role.id === state.currentId)?.title || '当前区服') + ' 意外断线：' + state.error
      + '；' + left + ' 秒后重连（第 ' + ((state.reconnectAttempts || 0) + 1) + '/' + group.settings.reconnect.maxRetries + ' 次）';
  } else if (state.phase === 'connecting') node.textContent = '正在' + (state.reconnectAttempts ? '重连（第 ' + state.reconnectAttempts + '/' + group.settings.reconnect.maxRetries + ' 次）' : '登录 ')
    + (group.roles.find(role => role.id === state.currentId)?.title || '下一个区服') + '…';
  else if (state.phase === 'error') node.textContent = '轮换暂未成功：' + state.error + (state.retryAt ? '；稍后尝试下一区服' : '');
  else node.textContent = group.window.active ? '正在等待区服交接' : '等待每日运行时段 · ' + rotationTimeLabel(group.window.nextStart) + ' 开始';
  const draft = rotationDrafts.get(rotationLoginId);
  $('rotation-pause').hidden = !group.settings.enabled;
  $('rotation-pause').disabled = rotationSaving || Boolean(draft?.dirty);
  $('rotation-pause').textContent = state.paused ? '继续轮换' : '暂停轮换';
}
function captureRotationDraft() {
  const draft = rotationDrafts.get(rotationLoginId);
  if (!draft || $('rotation-fields').dataset.login !== rotationLoginId) return;
  draft.settings.enabled = $('rotation-enabled').checked;
  draft.settings.allDay = $('rotation-all-day').checked;
  draft.settings.start = $('rotation-start').value;
  draft.settings.end = $('rotation-end').value;
  draft.settings.reconnect = { enabled: $('rotation-reconnect-enabled').checked,
    maxRetries: Number($('rotation-reconnect-retries').value), intervalSeconds: Number($('rotation-reconnect-interval').value) };
  for (const node of $('rotation-roles').querySelectorAll('[data-rotation-role]')) {
    const row = draft.settings.roles.find(row => row.id === node.dataset.rotationRole);
    if (!row) continue;
    row.enabled = node.querySelector('[data-rotation-enabled]').checked;
    row.minutes = Number(node.querySelector('[data-rotation-minutes]').value);
  }
  draft.dirty = true;
  $('rotation-notice').textContent = '有未保存修改；保存后按新配置运行。';
  $('rotation-start').disabled = draft.settings.allDay;
  $('rotation-end').disabled = draft.settings.allDay;
  $('rotation-reconnect-retries').disabled = !draft.settings.reconnect.enabled;
  $('rotation-reconnect-interval').disabled = !draft.settings.reconnect.enabled;
  renderRoleRotationStatus();
}
function renderRoleRotationForm() {
  const group = rotationGroups.find(group => group.loginId === rotationLoginId);
  const select = clear($('rotation-login'));
  for (const entry of rotationGroups) {
    const option = el('option', '', (entry.roles[0]?.label || entry.roles[0]?.lastSeen?.nickname || '登录账号') + ' · ' + entry.roles.map(role => role.bornWorldName || role.lastSeen?.worldName).join(' / '));
    option.value = entry.loginId;
    select.appendChild(option);
  }
  select.value = rotationLoginId || '';
  select.disabled = rotationSaving || !rotationGroups.length;
  $('rotation-fields').disabled = rotationSaving || !group;
  $('rotation-fields').dataset.login = rotationLoginId || '';
  if (!group) { clear($('rotation-roles')); renderRoleRotationStatus(); return; }
  if (!rotationDrafts.has(group.loginId)) rotationDrafts.set(group.loginId, { revision: group.revision, settings: structuredClone(group.settings), dirty: false });
  const draft = rotationDrafts.get(group.loginId);
  const settings = draft.settings;
  $('rotation-enabled').checked = settings.enabled;
  $('rotation-all-day').checked = settings.allDay;
  $('rotation-start').value = settings.start;
  $('rotation-end').value = settings.end;
  $('rotation-start').disabled = settings.allDay;
  $('rotation-end').disabled = settings.allDay;
  $('rotation-reconnect-enabled').checked = settings.reconnect.enabled;
  $('rotation-reconnect-retries').value = settings.reconnect.maxRetries;
  $('rotation-reconnect-interval').value = settings.reconnect.intervalSeconds;
  $('rotation-reconnect-retries').disabled = !settings.reconnect.enabled;
  $('rotation-reconnect-interval').disabled = !settings.reconnect.enabled;
  const box = clear($('rotation-roles'));
  settings.roles.forEach((row, index) => {
    const role = group.roles.find(role => role.id === row.id);
    if (!role) return;
    const node = el('div', 'rotation-role');
    node.dataset.rotationRole = row.id;
    const label = el('label', 'rotation-role-title');
    const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.checked = row.enabled; checkbox.dataset.rotationEnabled = '';
    label.append(checkbox, el('span', '', (index + 1) + '. ' + role.title));
    const duration = el('label', 'rotation-duration');
    const input = el('input'); input.type = 'number'; input.min = '1'; input.max = '1440'; input.step = '1'; input.value = String(row.minutes);
    input.dataset.rotationMinutes = ''; input.setAttribute('aria-label', role.title + ' 挂机分钟数');
    duration.append(input, el('span', '', '分钟'));
    const ordering = el('div', 'rotation-order');
    for (const [offset, text] of [[-1, '上移'], [1, '下移']]) {
      const button = el('button', '', text); button.type = 'button'; button.disabled = index + offset < 0 || index + offset >= settings.roles.length;
      button.setAttribute('aria-label', role.title + ' ' + text);
      button.onclick = () => {
        captureRotationDraft();
        [settings.roles[index], settings.roles[index + offset]] = [settings.roles[index + offset], settings.roles[index]];
        renderRoleRotationForm();
      };
      ordering.appendChild(button);
    }
    node.append(label, duration, ordering); box.appendChild(node);
  });
  $('rotation-notice').textContent = draft.dirty ? '此账号有未保存修改；切换登录账号会保留草稿。' : '';
  renderRoleRotationStatus();
}
async function refreshRoleRotations(force = false) {
  if (rotationLoading || rotationSaving) { if (force) rotationReloadPending = true; return; }
  rotationLoading = true;
  try {
    const data = await call('/api/role-rotations');
    rotationClockOffset = data.now - Date.now();
    rotationGroups = data.groups;
    if (!rotationGroups.some(group => group.loginId === rotationLoginId)) rotationLoginId = rotationGroups[0]?.loginId || null;
    const group = rotationGroups.find(group => group.loginId === rotationLoginId);
    const draft = rotationDrafts.get(rotationLoginId);
    if (force || !draft || !draft.dirty) {
      if (group) rotationDrafts.delete(group.loginId);
      renderRoleRotationForm();
    } else renderRoleRotationStatus();
  } catch (error) { $('rotation-notice').textContent = '读取失败：' + error.message; }
  finally {
    rotationLoading = false;
    if (rotationReloadPending && !rotationSaving) { rotationReloadPending = false; void refreshRoleRotations(true); }
  }
}
$('rotation-login').onchange = () => { rotationLoginId = $('rotation-login').value; renderRoleRotationForm(); };
$('rotation-fields').oninput = event => { if (event.target.matches('input')) captureRotationDraft(); };
$('rotation-fields').onchange = event => { if (event.target.matches('input')) captureRotationDraft(); };
$('role-rotation-form').onsubmit = async event => {
  event.preventDefault();
  if (rotationSaving || !rotationLoginId) return;
  captureRotationDraft();
  const draft = rotationDrafts.get(rotationLoginId);
  if (draft.settings.roles.some(row => !Number.isSafeInteger(row.minutes) || row.minutes < 1 || row.minutes > 1440)) { $('rotation-notice').textContent = '挂机时长请填写 1–1440 的整数分钟。'; return; }
  const reconnect = draft.settings.reconnect;
  if (!Number.isSafeInteger(reconnect.maxRetries) || reconnect.maxRetries < 1 || reconnect.maxRetries > 1000
    || !Number.isSafeInteger(reconnect.intervalSeconds) || reconnect.intervalSeconds < 1 || reconnect.intervalSeconds > 86400) {
    $('rotation-notice').textContent = '断线重连次数请填写 1–1000 的整数，间隔请填写 1–86400 的整数秒。'; return;
  }
  rotationSaving = true;
  $('rotation-fields').disabled = true;
  $('rotation-login').disabled = true;
  $('rotation-notice').textContent = '正在保存并交接原有任务…';
  try {
    const data = await call('/api/role-rotations/save', { method: 'POST', body: JSON.stringify({ confirm: true, loginId: rotationLoginId, revision: draft.revision, settings: draft.settings }) });
    rotationGroups = rotationGroups.map(group => group.loginId === rotationLoginId ? data.group : group);
    rotationDrafts.delete(rotationLoginId);
    rotationSaving = false;
    renderRoleRotationForm();
    $('rotation-notice').textContent = data.group.settings.enabled ? '轮换配置已保存，按每日时段自动运行。' : '配置已保存，轮换已关闭。';
  } catch (error) { $('rotation-notice').textContent = '保存失败：' + error.message; }
  finally { rotationSaving = false; $('rotation-fields').disabled = false; $('rotation-login').disabled = false; renderRoleRotationStatus(); void refreshAccountStatuses(); }
};
$('rotation-pause').onclick = async () => {
  const group = rotationGroups.find(group => group.loginId === rotationLoginId);
  if (rotationSaving || !group || rotationDrafts.get(rotationLoginId)?.dirty) return;
  rotationSaving = true; $('rotation-fields').disabled = true; $('rotation-login').disabled = true;
  try {
    const data = await call('/api/role-rotations/pause', { method: 'POST', body: JSON.stringify({ confirm: true, loginId: rotationLoginId, paused: !group.runtime.paused }) });
    rotationGroups = rotationGroups.map(group => group.loginId === rotationLoginId ? data.group : group);
    renderRoleRotationStatus();
  } catch (error) { $('rotation-notice').textContent = error.message; }
  finally { rotationSaving = false; $('rotation-fields').disabled = false; $('rotation-login').disabled = false; renderRoleRotationStatus(); void refreshAccountStatuses(); }
};
$('rotation-reload').onclick = () => refreshRoleRotations(true);
setInterval(() => { if (!document.hidden && !$('tab-account').classList.contains('hidden')) void refreshRoleRotations(); }, 3000);
setInterval(() => { if (!document.hidden && !$('tab-account').classList.contains('hidden')) renderRoleRotationStatus(); }, 1000);
