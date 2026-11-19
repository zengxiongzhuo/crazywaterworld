// APP 登录界面，与控制台共用请求、账号切换及确认弹窗。
let phoneMode = 'password';
let phoneBusy = false;
let phonePending = null;
let phoneSavedAccount = null;
let phoneGeneration = 0;
let phoneChoiceId = '';
let phoneRoleInputs = [];
let phoneExpiryTimer = null;
let smsTimer = null;
const smsCooldowns = new Map();
const phoneControls = [
  'phone-account', 'phone-password', 'phone-password-toggle', 'phone-number', 'phone-code',
  'phone-password-tab', 'phone-sms-tab', 'phone-login', 'phone-sms-login',
  'phone-back', 'phone-device-file', 'phone-device-refresh', 'phone-add-another',
];

function phoneHint(text, bad = false) {
  const hint = $('phone-hint');
  hint.textContent = text;
  hint.className = 'phone-feedback ' + (bad ? 'bad' : 'dim');
}

function updateSmsButton() {
  const left = Math.max(0, Math.ceil(((smsCooldowns.get($('phone-number').value.trim()) || 0) - Date.now()) / 1000));
  $('phone-send-code').disabled = phoneBusy || left > 0;
  $('phone-send-code').textContent = left > 0 ? left + ' 秒后重新获取' : '获取验证码';
}

function setPhoneBusy(busy) {
  phoneBusy = busy;
  $('phone-flow').setAttribute('aria-busy', String(busy));
  for (const id of phoneControls) $(id).disabled = busy;
  const expired = !phonePending || phonePending.expiresAt <= Date.now();
  for (const input of phoneRoleInputs) input.disabled = busy || expired;
  $('phone-roles-retry').disabled = busy || expired;
  $('phone-save').disabled = busy || expired || !selectedPhoneRole();
  updateSmsButton();
  if (typeof accountAddChanged === 'function') {
    accountAddChanged('phone', phoneSavedAccount ? 'saved' : phonePending ? 'selecting' : 'entry', { busy, account: phoneSavedAccount });
  }
}

function phoneAccountName(value) {
  return String(value || '').replace(/\b(1[3-9][0-9])[0-9]{4}([0-9]{4})\b/g, '$1****$2');
}

function selectedPhoneRole() {
  return phonePending?.choices?.find(choice => choice.id === phoneChoiceId);
}

function phoneRoleWorld(role) {
  return role.roleWorldName || role.worldName || '区服 ' + role.worldId;
}

function phoneInvalid(id, message) {
  $(id).setAttribute('aria-invalid', 'true');
  phoneHint(message, true);
  $(id).focus();
}

function concealPhonePassword() {
  $('phone-password').type = 'password';
  $('phone-password-toggle').textContent = '显示';
  $('phone-password-toggle').setAttribute('aria-label', '显示密码');
  $('phone-password-toggle').setAttribute('aria-pressed', 'false');
}

function switchPhoneMode(mode) {
  if (phoneBusy) return;
  const password = mode === 'password';
  if (!password && !$('phone-number').value && /^1[3-9][0-9]{9}$/.test($('phone-account').value.trim())) {
    $('phone-number').value = $('phone-account').value.trim();
  }
  if (password && !$('phone-account').value) $('phone-account').value = $('phone-number').value.trim();
  phoneMode = mode;
  for (const name of ['password', 'sms']) {
    const selected = name === mode;
    $('phone-' + name + '-tab').setAttribute('aria-selected', String(selected));
    $('phone-' + name + '-tab').tabIndex = selected ? 0 : -1;
    $('phone-' + name + '-panel').hidden = !selected;
  }
  concealPhonePassword();
  phoneHint('');
  updateSmsButton();
}

for (const mode of ['password', 'sms']) {
  const tab = $('phone-' + mode + '-tab');
  tab.onclick = () => switchPhoneMode(mode);
  tab.onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || phoneBusy) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'password' : event.key === 'End' ? 'sms' : phoneMode === 'password' ? 'sms' : 'password';
    switchPhoneMode(next);
    $('phone-' + next + '-tab').focus();
  };
}

$('phone-password-toggle').onclick = () => {
  const reveal = $('phone-password').type === 'password';
  $('phone-password').type = reveal ? 'text' : 'password';
  $('phone-password-toggle').textContent = reveal ? '隐藏' : '显示';
  $('phone-password-toggle').setAttribute('aria-label', reveal ? '隐藏密码' : '显示密码');
  $('phone-password-toggle').setAttribute('aria-pressed', String(reveal));
};

for (const id of ['phone-account', 'phone-password', 'phone-number', 'phone-code']) {
  $(id).oninput = () => {
    $(id).removeAttribute('aria-invalid');
    phoneHint('');
    if (id === 'phone-number') {
      $('phone-code').value = '';
      updateSmsButton();
    }
  };
}

async function refreshPhoneDevice() {
  try {
    const data = await call('/api/accounts/phone-login/status');
    renderPhoneDevice(data);
  } catch (error) {
    $('phone-device-status').textContent = '设备状态读取失败，请点击「重新检查」。';
    $('phone-device-status').className = 'bad';
    $('phone-device-details').open = true;
  }
}

function renderPhoneDevice(data) {
  let status = '首次登录或获取验证码时，将自动生成并保存设备档案。';
  if (data.deviceReady) {
    status = data.deviceSource === 'generated' ? '设备档案已自动生成并保存' : '已载入导入的设备档案';
    if (data.deviceModel) status += ' · ' + data.deviceModel;
  } else if (data.deviceError) {
    status = '设备档案读取失败。' + data.deviceError;
  }
  $('phone-device-status').textContent = status;
  $('phone-device-status').className = data.deviceError ? 'bad' : data.deviceReady ? 'ok' : 'dim';
  $('phone-device-path').textContent = data.devicePath ? '本机档案位置 ' + data.devicePath : '';
  $('phone-device-details').open = Boolean(data.deviceError);
}

$('phone-device-refresh').onclick = refreshPhoneDevice;
$('phone-device-file').onchange = async () => {
  const file = $('phone-device-file').files?.[0];
  if (!file || phoneBusy) return;
  setPhoneBusy(true);
  const hint = $('phone-device-hint');
  hint.textContent = '正在导入设备档案…';
  hint.className = 'phone-feedback dim';
  try {
    let profile;
    try {
      profile = JSON.parse(await file.text());
    } catch {
      throw new Error('文件内容无法读取为 JSON，请选择有效的设备档案文件。');
    }
    const data = await call('/api/accounts/phone-login/device', { method: 'POST', body: JSON.stringify({ confirm: true, profile }) });
    renderPhoneDevice(data);
    hint.textContent = '设备档案已导入，可以继续登录。';
    hint.className = 'phone-feedback ok';
  } catch (error) {
    hint.textContent = error.message;
    hint.className = 'phone-feedback bad';
  } finally {
    $('phone-device-file').value = '';
    setPhoneBusy(false);
  }
};

function expirePhonePending() {
  clearTimeout(phoneExpiryTimer);
  if (!phonePending) return;
  $('phone-save').disabled = true;
  $('phone-roles-retry').disabled = true;
  for (const input of phoneRoleInputs) input.disabled = true;
  $('phone-expiry').textContent = '本次登录结果已过期，请返回重新登录。';
  $('phone-expiry').className = 'bad';
}

function renderPhonePending(data) {
  const previous = selectedPhoneRole();
  phonePending = { ...data, expiresAt: data.expiresAt || Date.now() + 10 * 60 * 1000 };
  const choices = phonePending.choices || [];
  phoneChoiceId = choices.find(choice => choice.accountId === previous?.accountId && choice.worldId === previous?.worldId)?.id || '';
  phoneRoleInputs = [];
  $('phone-entry').hidden = true;
  $('phone-success').hidden = true;
  $('phone-preview').hidden = false;
  $('phone-step').textContent = '登录验证已完成 → 选择区服和角色';
  const box = clear($('phone-result'));
  box.appendChild(el('p', null, '本次查询 ' + (data.linkedAccountCount || 1) + ' 个 APP 账号，已找到 ' + choices.length + ' 个角色。'));
  if (choices.length) {
    const list = el('fieldset', 'phone-roles');
    list.appendChild(el('legend', null, '选择要使用的角色'));
    for (const choice of choices) {
      const row = el('label', 'phone-role');
      const input = el('input');
      input.type = 'radio';
      input.name = 'phone-role';
      input.value = choice.id;
      input.checked = choice.id === phoneChoiceId;
      input.onchange = () => {
        if (!input.checked || phoneBusy || phonePending.expiresAt <= Date.now()) return;
        phoneChoiceId = choice.id;
        updatePhoneSelection();
        setPhoneBusy(false);
      };
      phoneRoleInputs.push(input);
      const info = el('div', 'phone-role-info');
      const heading = el('div', 'phone-role-heading');
      heading.append(el('strong', null, choice.nickname || '未命名角色'), el('span', null, phoneRoleWorld(choice)));
      info.appendChild(heading);
      const stats = [];
      if (choice.level != null) stats.push('等级 ' + choice.level);
      if (choice.power != null) stats.push('战力 ' + Number(choice.power).toLocaleString('zh-CN'));
      if (stats.length) info.appendChild(el('p', 'dim', stats.join(' · ')));
      info.appendChild(el('p', 'dim', 'APP 账号 ' + phoneAccountName(choice.userName || data.phone || '益世界账号')));
      if (choice.roleWorldId && String(choice.roleWorldId) !== String(choice.worldId)) {
        info.appendChild(el('p', 'dim', '原区服 ' + (choice.worldName || choice.worldId) + '，合服后位于 ' + phoneRoleWorld(choice)));
      }
      if (choice.matched) info.appendChild(el('p', 'dim', '已有记录 ' + (choice.existingTitle || choice.nickname) + '，保存会更新此区服的登录凭证。同一账号的其他区服分别保留，切换时结束旧区服的任务和连接。'));
      row.append(input, info);
      list.appendChild(row);
    }
    box.appendChild(list);
  }
  for (const account of data.emptyAccounts || []) {
    box.appendChild(el('p', 'dim', phoneAccountName(account.userName || '此 APP 账号') + ' 暂无已有角色，请核对游戏渠道或先在 APP 中确认角色。'));
  }
  const failures = data.failures || [];
  if (failures.length) {
    const errors = el('div', 'phone-role-failures');
    for (const failure of failures) {
      errors.appendChild(el('p', 'bad', phoneAccountName(failure.userName || 'APP 账号') + ' 读取失败。' + failure.error));
    }
    if (failures.some(failure => !failure.retryable)) errors.appendChild(el('p', 'dim', '认证失败的账号需要返回重新登录。'));
    box.appendChild(errors);
  }
  $('phone-roles-retry').hidden = !failures.some(failure => failure.retryable);
  updatePhoneSelection();
  $('phone-expiry').className = 'dim';
  $('phone-expiry').textContent = '请在 10 分钟内保存，超时需重新登录。';
  clearTimeout(phoneExpiryTimer);
  phoneExpiryTimer = setTimeout(expirePhonePending, Math.max(0, phonePending.expiresAt - Date.now()));
  $('phone-preview-title').focus();
}

function updatePhoneSelection() {
  const role = selectedPhoneRole();
  $('phone-selection').textContent = role
    ? '已选择 ' + (role.nickname || '未命名角色') + ' · ' + phoneRoleWorld(role)
    : phonePending?.choices?.length ? '请选择要使用的角色，再点击「保存所选角色」。' : '当前没有可选择的角色，可重试读取或返回检查登录账号。';
}

$('phone-roles-retry').onclick = async () => {
  if (phoneBusy || !phonePending) return;
  if (phonePending.expiresAt <= Date.now()) return expirePhonePending();
  setPhoneBusy(true);
  phoneHint('正在重新读取失败账号的角色列表…');
  try {
    const data = await call('/api/accounts/phone-login/roles', { method: 'POST', body: JSON.stringify({ confirm: true, id: phonePending.id }) });
    renderPhonePending(data);
    phoneHint('');
  } catch (error) {
    phoneHint(error.message || '读取失败，请稍后重试。', true);
  } finally {
    setPhoneBusy(false);
  }
};

async function phoneLogin(payload) {
  if (phoneBusy) return;
  setPhoneBusy(true);
  phoneHint('正在验证 APP 账号并读取全部区服角色，多账号可能需要稍等片刻…');
  const button = $(phoneMode === 'password' ? 'phone-login' : 'phone-sms-login');
  const label = button.textContent;
  button.textContent = '正在读取角色…';
  try {
    const data = await call('/api/accounts/phone-login', { method: 'POST', body: JSON.stringify({ confirm: true, ...payload }) });
    $('phone-password').value = '';
    $('phone-code').value = '';
    concealPhonePassword();
    phoneHint('');
    renderPhonePending(data);
  } catch (error) {
    phoneHint(error.message || '登录失败，请稍后重试。', true);
  } finally {
    button.textContent = label;
    setPhoneBusy(false);
    void refreshPhoneDevice();
  }
}

$('phone-password-panel').onsubmit = event => {
  event.preventDefault();
  if (phoneBusy) return;
  const phone = $('phone-account').value.trim();
  const password = $('phone-password').value;
  if (!phone) return phoneInvalid('phone-account', '请输入 APP 账号或绑定手机号。');
  if (!password) return phoneInvalid('phone-password', '请输入 APP 登录密码，也可以切换到短信验证码登录。');
  return phoneLogin({ phone, password });
};

$('phone-sms-panel').onsubmit = event => {
  event.preventDefault();
  if (phoneBusy) return;
  const phone = $('phone-number').value.trim();
  const code = $('phone-code').value.trim();
  if (!/^1[3-9][0-9]{9}$/.test(phone)) return phoneInvalid('phone-number', '请输入 APP 绑定的 11 位大陆手机号。');
  if (!code) return phoneInvalid('phone-code', '请输入短信验证码，可先点击「获取验证码」。');
  return phoneLogin({ phone, code });
};

$('phone-send-code').onclick = () => {
  if (phoneBusy || $('phone-send-code').disabled) return;
  const phone = $('phone-number').value.trim();
  if (!/^1[3-9][0-9]{9}$/.test(phone)) return phoneInvalid('phone-number', '请输入 APP 绑定的 11 位大陆手机号。');
  const generation = phoneGeneration;
  openConfirm('发送短信验证码', [el('p', null, '将向 ' + phone + ' 发送 APP 登录验证码。')], async () => {
    if (phoneBusy || generation !== phoneGeneration) return;
    setPhoneBusy(true);
    $('phone-send-code').textContent = '正在发送…';
    phoneHint('正在发送验证码…');
    try {
      const data = await call('/api/accounts/phone-login/send-code', { method: 'POST', body: JSON.stringify({ confirm: true, phone }) });
      smsCooldowns.set(phone, Date.now() + (Number(data.cooldown) || 60) * 1000);
      clearInterval(smsTimer);
      smsTimer = setInterval(() => {
        updateSmsButton();
        if ([...smsCooldowns.values()].every(deadline => deadline <= Date.now())) clearInterval(smsTimer);
      }, 1000);
      phoneHint('验证码已发送至 ' + phone.slice(0, 3) + '****' + phone.slice(-4) + '，请输入后点击「验证并读取角色」。');
    } catch (error) {
      phoneHint(error.message || '发送失败，请稍后重试。', true);
    } finally {
      setPhoneBusy(false);
      void refreshPhoneDevice();
    }
    $('phone-code').focus();
  });
};

async function resetPhoneEntry() {
  if (phoneBusy) return false;
  phoneGeneration++;
  const pending = phonePending;
  if (pending) {
    setPhoneBusy(true);
    try {
      await call('/api/accounts/phone-login/cancel', { method: 'POST', body: JSON.stringify({ id: pending.id }) });
    } catch {
      phoneHint('临时登录结果尚未清理，请重试返回。', true);
      return false;
    } finally {
      setPhoneBusy(false);
    }
  }
  phonePending = null;
  phoneSavedAccount = null;
  phoneChoiceId = '';
  phoneRoleInputs = [];
  clearTimeout(phoneExpiryTimer);
  $('phone-preview').hidden = true;
  $('phone-success').hidden = true;
  $('phone-entry').hidden = false;
  $('phone-step').textContent = '登录验证 → 选择区服和角色 → 保存并切换';
  clear($('phone-result'));
  phoneHint('');
  setPhoneBusy(false);
  $(phoneMode === 'password' ? 'phone-account' : 'phone-number').focus();
  return true;
}

async function resetPhoneLogin() {
  if (phoneBusy) return false;
  phoneGeneration++;
  for (const id of ['phone-account', 'phone-password', 'phone-number', 'phone-code']) {
    $(id).value = '';
    $(id).removeAttribute('aria-invalid');
  }
  concealPhonePassword();
  clearInterval(smsTimer);
  const pending = phonePending;
  setPhoneBusy(true);
  try {
    if (pending) await call('/api/accounts/phone-login/cancel', { method: 'POST', body: JSON.stringify({ id: pending.id }) });
    phonePending = null;
  } catch {
    throw new Error('APP 临时登录结果尚未清理，请重试关闭或返回。');
  } finally {
    setPhoneBusy(false);
  }
  await resetPhoneEntry();
  $('phone-device-file').value = '';
  $('phone-device-details').open = false;
  $('phone-device-hint').textContent = '';
  return true;
}
$('phone-back').onclick = resetPhoneEntry;
$('phone-add-another').onclick = resetPhoneEntry;

$('phone-save').onclick = async () => {
  if (phoneBusy || !phonePending) return;
  const pending = phonePending;
  if (pending.expiresAt <= Date.now()) return expirePhonePending();
  const role = selectedPhoneRole();
  if (!role) {
    phoneHint('请先选择要使用的区服和角色。', true);
    phoneRoleInputs[0]?.focus();
    return;
  }
  setPhoneBusy(true);
  $('phone-save').textContent = '正在保存…';
  try {
    if (!await configMayChangeAccount(role.accountId)) {
      phoneHint('当前账号的配置尚未保存，请处理配置后再次保存此账号。', true);
      return;
    }
    const data = await call('/api/accounts/phone-login/save', { method: 'POST', body: JSON.stringify({ confirm: true, id: pending.id, choiceId: role.id }) });
    phonePending = null;
    phoneSavedAccount = data.account;
    clearTimeout(phoneExpiryTimer);
    // 保存接口已切换服务端账号，客户端同步使用同一账号。
    stateActions.upsertAccount({ ...accounts.find(account => account.id === data.account.id), ...data.account });
    if (!accounts.find(account => account.id === data.account.id)?.status?.connected) stateActions.setFlag('disconnected', data.account.id, true);
    accountDetailsOwner = null;
    selectLoadedAccount(data.account.id);
    renderAccounts();
    $('phone-preview').hidden = true;
    $('phone-success').hidden = false;
    $('phone-saved-account').textContent = (role.nickname || '未命名角色') + ' · ' + phoneRoleWorld(role);
    let nextStep = '手动开始挂机';
    let nextHint = '账号已保存，尚未开始挂机。可先在「挂机配置」设置任务，再点击账号卡片或页头的「开始挂机」。';
    if (snapshot.paused || snapshot.loginBlocked) {
      nextStep = '恢复托管';
      nextHint = '请点击页面顶部的「恢复托管」，连接后核对角色和区服。';
    } else if (snapshot.looping) {
      nextStep = '自动挂机';
      nextHint = '已按保存配置启动自动挂机，可前往「挂机配置」调整任务。';
    } else if (snapshot.connected) {
      nextHint = '所选角色已连接，尚未开始挂机。可先在「挂机配置」设置任务，再点击账号卡片或页头的「开始挂机」。';
    }
    $('phone-step').textContent = '所选角色已保存 → ' + nextStep;
    $('phone-success-next').textContent = nextHint;
    phoneHint('');
    $('phone-success-title').focus();
    try {
      await loadAccounts(false);
    } catch {
      phoneHint('账号已保存并切换，账号列表刷新失败，请刷新页面查看。', true);
    }
  } catch (error) {
    phoneHint(error.message || '保存失败，请重试。', true);
  } finally {
    $('phone-save').textContent = '保存所选角色';
    setPhoneBusy(false);
  }
};
