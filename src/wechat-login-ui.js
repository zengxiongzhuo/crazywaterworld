// 微信原生协议扫码，复用控制台的角色选择、版本保护和账号保存。
let wechatState = null;
let wechatBusy = false;
let wechatGeneration = 0;
let wechatTimer = null;
let wechatPollFailures = 0;
let wechatChoiceId = '';
let wechatSelectedRole = null;
const wechatLoginPath = '/api/accounts/wechat-login';

function selectedWechatRole() {
  return wechatState?.choices?.find(choice => choice.id === wechatChoiceId);
}

function wechatRoleWorld(role) {
  return role.roleWorldName || role.worldName || '区服 ' + role.worldId;
}

function receiveWechatState(state) {
  if (state.id !== wechatState?.id) wechatSelectedRole = null;
  wechatState = state;
  if (state.phase !== 'captured') return;
  const choices = state.choices || [];
  if (!choices.length && state.roleError) {
    wechatChoiceId = '';
    return;
  }
  const previous = wechatSelectedRole;
  const selected = choices.find(choice => choice.accountId === previous?.accountId && choice.worldId === previous?.worldId)
    || (choices.length === 1 ? choices[0] : null);
  wechatSelectedRole = selected;
  wechatChoiceId = selected?.id || '';
}

function renderWechatRoles() {
  const box = clear($('wechat-roles'));
  const captured = wechatState?.phase === 'captured';
  box.hidden = !captured;
  if (!captured) return;
  const choices = wechatState.choices || [];
  if (!choices.length) {
    if (!wechatState.roleError) box.appendChild(el('p', 'dim', '当前微信账号暂无可选择的游戏角色，请核对账号和游戏渠道后重试。'));
    return;
  }
  const list = el('fieldset', 'phone-roles');
  list.appendChild(el('legend', null, '选择区服和游戏角色'));
  for (const choice of choices) {
    const row = el('label', 'phone-role');
    const input = el('input');
    input.type = 'radio';
    input.name = 'wechat-role';
    input.value = choice.id;
    input.checked = choice.id === wechatChoiceId;
    input.disabled = wechatBusy || Boolean(wechatState.roleError) || wechatState.expiresAt <= Date.now();
    input.onchange = () => {
      if (!input.checked || input.disabled || wechatBusy || wechatState?.phase !== 'captured'
        || wechatState.roleError || wechatState.expiresAt <= Date.now()) return;
      const selected = wechatState.choices.find(role => role.id === input.value);
      if (!selected) return;
      wechatChoiceId = selected.id;
      wechatSelectedRole = selected;
      $('wechat-save').disabled = false;
      $('wechat-result').textContent = '已选择 ' + (selected.nickname || '未命名角色') + ' · ' + wechatRoleWorld(selected);
    };
    const info = el('div', 'phone-role-info');
    const heading = el('div', 'phone-role-heading');
    heading.append(el('strong', null, choice.nickname || '未命名角色'), el('span', null, wechatRoleWorld(choice)));
    info.appendChild(heading);
    const stats = [];
    if (choice.level != null) stats.push('等级 ' + choice.level);
    if (choice.power != null) stats.push('战力 ' + Number(choice.power).toLocaleString('zh-CN'));
    if (stats.length) info.appendChild(el('p', 'dim', stats.join(' · ')));
    if (choice.roleWorldId && String(choice.roleWorldId) !== String(choice.worldId)) {
      info.appendChild(el('p', 'dim', '原区服 ' + (choice.worldName || choice.worldId) + '，合服后位于 ' + wechatRoleWorld(choice)));
    }
    if (choice.matched) info.appendChild(el('p', 'dim', '此账号已有保存记录，再次保存会更新所选角色和区服。'));
    row.append(input, info);
    list.appendChild(row);
  }
  box.appendChild(list);
}

function renderWechatLogin() {
  const state = wechatState || { phase: 'idle' };
  const captured = state.phase === 'captured';
  const messages = {
    idle: '点击「生成二维码」，然后使用微信扫一扫。',
    starting: '正在获取微信授权二维码，请稍候…',
    waiting: '请使用微信扫码，并核对手机上的应用宝授权提示。',
    scanned: '已扫码，请在手机微信确认授权。',
    authorizing: '扫码已确认，正在进入游戏并读取登录信息…',
    'reading-roles': '正在读取该账号的区服和游戏角色…',
    captured: '已读取游戏角色，请确认区服和角色后保存。',
    expired: '本次登录已过期，请刷新二维码重新扫码。',
    error: '登录失败，请刷新二维码重试。',
    cancelled: '已取消本次登录。',
    saved: '账号已保存并切换，尚未开始挂机。可先在「挂机配置」设置任务，再点击账号卡片或页头的「开始挂机」。',
  };
  if (state.account?.status?.paused || state.account?.status?.loginBlocked) {
    messages.saved = '账号已保存并切换。点击页面顶部的「恢复托管」，连接后核对角色和区服。';
  } else if (state.account?.status?.looping) {
    messages.saved = '账号已保存并切换，已按保存配置启动自动挂机。可前往「挂机配置」调整任务。';
  } else if (state.account?.status?.connected) {
    messages.saved = '账号已保存并切换，游戏已连接，尚未开始挂机。可先在「挂机配置」设置任务，再点击账号卡片或页头的「开始挂机」。';
  }
  const hint = $('wechat-hint');
  hint.textContent = state.error || state.roleError || messages[state.phase] || '正在读取登录状态…';
  hint.className = 'phone-feedback ' + (state.error || state.roleError || ['expired', 'error'].includes(state.phase) ? 'bad' : 'dim');
  const image = $('wechat-qr');
  const showQr = ['waiting', 'scanned'].includes(state.phase) && /^data:image\/(?:png|jpeg|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(state.qrImage || '');
  image.hidden = !showQr;
  if (showQr) image.src = state.qrImage;
  else image.removeAttribute('src');
  $('wechat-start').textContent = state.id || ['expired', 'error'].includes(state.phase) ? '刷新二维码' : '生成二维码';
  $('wechat-start').disabled = wechatBusy;
  $('wechat-cancel').hidden = !state.id || ['cancelled', 'saved'].includes(state.phase);
  $('wechat-cancel').disabled = wechatBusy;
  $('wechat-save').hidden = !captured;
  const selected = selectedWechatRole();
  $('wechat-save').disabled = wechatBusy || !captured || !selected?.accountId || Boolean(state.roleError) || state.expiresAt <= Date.now();
  $('wechat-roles-retry').hidden = !captured || (!state.roleError && Boolean(state.choices?.length));
  $('wechat-roles-retry').disabled = wechatBusy || state.expiresAt <= Date.now();
  $('wechat-result').hidden = !captured && state.phase !== 'saved';
  $('wechat-result').textContent = selected
    ? '已选择 ' + (selected.nickname || '未命名角色') + ' · ' + wechatRoleWorld(selected)
    : captured && state.choices?.length ? '请选择要保存的角色。' : '';
  if (state.phase === 'saved' && state.selectedRole) {
    $('wechat-result').textContent = (state.selectedRole.nickname || '未命名角色') + ' · ' + wechatRoleWorld(state.selectedRole);
  }
  $('wechat-expiry').textContent = captured ? '请在本次登录结果过期前保存。' : '';
  $('wechat-flow').setAttribute('aria-busy', String(wechatBusy || ['starting', 'authorizing', 'reading-roles'].includes(state.phase)));
  renderWechatRoles();
  if (typeof accountAddChanged === 'function') {
    accountAddChanged('wechat-qr', state.phase, { busy: wechatBusy, account: state.account });
  }
}

async function resetWechatLogin() {
  if (wechatBusy) return false;
  const previous = wechatState;
  ++wechatGeneration;
  clearTimeout(wechatTimer);
  wechatBusy = true;
  wechatState = { ...previous, phase: 'cancelled', qrImage: null, error: null };
  renderWechatLogin();
  try {
    let id = previous?.id;
    // 生成响应丢失时仍可能已经打开浏览器，先找回本次临时会话再结束。
    if (!id && previous && !['idle', 'cancelled', 'saved'].includes(previous.phase)) {
      const state = await call(wechatLoginPath + '/status');
      id = state.id;
    }
    if (id) await call(wechatLoginPath + '/cancel', { method: 'POST', body: JSON.stringify({ id }) });
    wechatState = null;
    wechatChoiceId = '';
    wechatSelectedRole = null;
    wechatPollFailures = 0;
    return true;
  } catch {
    wechatState = { ...previous, phase: 'error', qrImage: null, error: '临时扫码会话尚未结束，请重试关闭或返回。' };
    throw new Error(wechatState.error);
  } finally {
    wechatBusy = false;
    renderWechatLogin();
  }
}

function scheduleWechatPoll(generation) {
  clearTimeout(wechatTimer);
  if (generation !== wechatGeneration || !wechatState?.id) return;
  if (wechatState.phase === 'captured') {
    wechatTimer = setTimeout(() => {
      if (generation !== wechatGeneration || wechatState?.phase !== 'captured') return;
      wechatState = { ...wechatState, phase: 'expired', qrImage: null, error: null };
      renderWechatLogin();
    }, Math.max(0, wechatState.expiresAt - Date.now()));
  } else if (['starting', 'waiting', 'scanned', 'authorizing', 'reading-roles'].includes(wechatState.phase)) {
    wechatTimer = setTimeout(() => pollWechatLogin(generation), 1500);
  }
}

async function pollWechatLogin(generation) {
  if (generation !== wechatGeneration || !wechatState?.id) return;
  const id = wechatState.id;
  try {
    const state = await call(wechatLoginPath + '/status?id=' + encodeURIComponent(id));
    if (generation !== wechatGeneration || wechatState?.id !== id) return;
    wechatPollFailures = 0;
    receiveWechatState(state);
  } catch (error) {
    if (generation !== wechatGeneration || wechatState?.id !== id) return;
    wechatPollFailures++;
    wechatState = { ...wechatState, error: wechatPollFailures < 3
      ? '登录状态读取失败，正在重试…'
      : '登录状态连续读取失败，请刷新二维码重试。' };
    if (wechatPollFailures >= 3) wechatState.phase = 'error';
  }
  renderWechatLogin();
  scheduleWechatPoll(generation);
}

$('wechat-start').onclick = async () => {
  if (wechatBusy) return;
  const previous = wechatState;
  let retryId = previous?.id;
  const generation = ++wechatGeneration;
  clearTimeout(wechatTimer);
  wechatBusy = true;
  wechatPollFailures = 0;
  wechatChoiceId = '';
  wechatSelectedRole = null;
  wechatState = { phase: 'starting' };
  renderWechatLogin();
  try {
    if (previous?.id) {
      await call(wechatLoginPath + '/cancel', { method: 'POST', body: JSON.stringify({ id: previous.id }) });
      retryId = null;
    }
    const state = await call(wechatLoginPath + '/start', { method: 'POST', body: JSON.stringify({ confirm: true }) });
    if (generation !== wechatGeneration) return;
    receiveWechatState(state);
    scheduleWechatPoll(generation);
  } catch (error) {
    if (generation !== wechatGeneration) return;
    wechatState = { id: retryId, phase: 'error', error: error.message || '二维码读取失败，请重试。' };
  } finally {
    if (generation === wechatGeneration) {
      wechatBusy = false;
      renderWechatLogin();
    }
  }
};

$('wechat-cancel').onclick = async () => {
  if (wechatBusy || !wechatState?.id) return;
  const previous = wechatState;
  const generation = ++wechatGeneration;
  clearTimeout(wechatTimer);
  wechatBusy = true;
  wechatState = { ...previous, phase: 'cancelled', qrImage: null, error: null };
  renderWechatLogin();
  try {
    await call(wechatLoginPath + '/cancel', { method: 'POST', body: JSON.stringify({ id: previous.id }) });
    if (generation === wechatGeneration) wechatState = { phase: 'cancelled' };
  } catch (error) {
    if (generation === wechatGeneration) {
      wechatState = { id: previous.id, phase: 'error', error: '取消登录失败，请重试取消。' };
    }
  } finally {
    if (generation === wechatGeneration) {
      wechatBusy = false;
      renderWechatLogin();
    }
  }
};

$('wechat-roles-retry').onclick = async () => {
  if (wechatBusy || wechatState?.phase !== 'captured' || wechatState.expiresAt <= Date.now()) return;
  const pending = wechatState;
  const generation = ++wechatGeneration;
  clearTimeout(wechatTimer);
  wechatState = { ...pending, phase: 'reading-roles', error: null, roleError: null };
  renderWechatLogin();
  try {
    const state = await call(wechatLoginPath + '/roles', { method: 'POST', body: JSON.stringify({ confirm: true, id: pending.id }) });
    if (generation !== wechatGeneration || wechatState?.id !== pending.id) return;
    receiveWechatState(state);
  } catch (error) {
    if (generation !== wechatGeneration || wechatState?.id !== pending.id) return;
    wechatState = { ...pending, roleError: error.message || '角色读取失败，请重试。', error: null };
    if (pending.expiresAt <= Date.now()) wechatState.phase = 'expired';
  }
  renderWechatLogin();
  scheduleWechatPoll(generation);
};

$('wechat-save').onclick = async () => {
  if (wechatBusy || wechatState?.phase !== 'captured' || wechatState.roleError) return;
  const choice = selectedWechatRole();
  if (!choice?.accountId) return;
  if (wechatState.expiresAt <= Date.now()) {
    wechatState = { ...wechatState, phase: 'expired', error: null };
    renderWechatLogin();
    return;
  }
  const pending = wechatState;
  wechatBusy = true;
  renderWechatLogin();
  $('wechat-save').textContent = '正在保存…';
  try {
    if (!await configMayChangeAccount(choice.accountId)) {
      wechatState = { ...pending, error: '当前账号的配置尚未保存，请处理配置后再次保存此账号。' };
      return;
    }
    if (pending.expiresAt <= Date.now()) {
      wechatState = { ...pending, phase: 'expired', error: null };
      return;
    }
    const data = await call(wechatLoginPath + '/save', { method: 'POST', body: JSON.stringify({ confirm: true, id: pending.id, choiceId: choice.id }) });
    ++wechatGeneration;
    clearTimeout(wechatTimer);
    wechatState = { phase: 'saved', account: data.account, selectedRole: data.selectedRole || choice };
    stateActions.upsertAccount({ ...accounts.find(account => account.id === data.account.id), ...data.account });
    if (!data.account.status?.connected) stateActions.setFlag('disconnected', data.account.id, true);
    accountDetailsOwner = null;
    selectLoadedAccount(data.account.id);
    renderAccounts();
    try {
      await loadAccounts(false);
    } catch {
      wechatState.error = '账号已保存并切换，账号列表刷新失败，请刷新页面查看。';
    }
  } catch (error) {
    wechatState = { ...pending, error: error.message || '保存失败，请重试。' };
  } finally {
    wechatBusy = false;
    $('wechat-save').textContent = '保存所选角色';
    renderWechatLogin();
  }
};

renderWechatLogin();
