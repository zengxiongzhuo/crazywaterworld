// 隐藏的 select 继续承载账号值，页面内的列表负责展示和键盘操作。
var accountPickerReady = false;

function accountPickerPresentation(account, activeStatus) {
  const status = (account.id === current ? snapshot : account.status) ?? {};
  const connecting = connectingAccounts.has(account.id);
  const detail = account.id === current && activeStatus ? activeStatus
    : connecting ? '连接中…' : connectionStatus(status);
  let label = detail;
  if (status.switching) label = '切换中';
  else if (status.syncingProduction) label = '同步中';
  else if (status.paused) label = '已暂停';
  else if (detail === '连接中…') label = '连接中';
  else if (status.reconnecting) label = '重连中';
  else if (status.loginBlocked && !status.paused) label = '待恢复';
  const kind = connectionStatusKind(status, connecting || detail === '连接中…');
  return { label, detail, kind };
}

function paintAccountPickerTag(tag, text, kind) {
  if (tag.textContent !== text) tag.textContent = text;
  tag.classList.remove('done', 'waiting', 'blocked');
  tag.classList.add(kind);
}

function renderAccountPicker(activeStatus) {
  if (!accountPickerReady) return;
  const trigger = $('account-picker-trigger');
  const list = $('account-picker-list');
  const selected = accounts.find(account => account.id === current);
  const title = $('account-picker-title');
  const tag = $('account-picker-status');
  trigger.disabled = !accounts.length || (typeof accountSwitchPending !== 'undefined' && Boolean(accountSwitchPending));
  title.textContent = selected?.title || (accounts.length ? '选择账号' : '没有账号');
  tag.hidden = !selected;
  if (selected) {
    const status = accountPickerPresentation(selected, activeStatus);
    paintAccountPickerTag(tag, status.label, status.kind);
    trigger.title = selected.title + ' · ' + status.detail;
    trigger.setAttribute('aria-label', '当前账号 ' + trigger.title);
  } else {
    trigger.title = title.textContent;
    trigger.setAttribute('aria-label', title.textContent);
  }
  if (!accounts.length) {
    closeAccountPicker(!list.hidden);
    clear(list);
    return;
  }
  if (list.hidden) return;
  const buttons = new Map(Array.from(list.children).map(button => [button.accountId, button]));
  const focused = document.activeElement;
  const hadFocus = list.contains(focused);
  for (const button of Array.from(list.children)) {
    if (!accounts.some(account => account.id === button.accountId)) button.remove();
  }
  accounts.forEach((account, index) => {
    let button = buttons.get(account.id);
    if (!button) {
      button = component('ui-account-option');
      button.accountId = account.id;
      button.onclick = () => chooseAccountPicker(account.id);
    }
    const status = accountPickerPresentation(account, activeStatus);
    const name = button.querySelector('[data-picker-field="title"]');
    if (name.textContent !== account.title) name.textContent = account.title;
    paintAccountPickerTag(button.querySelector('[data-picker-field="status"]'), status.detail, status.kind);
    button.querySelector('[data-picker-field="check"]').hidden = account.id !== current;
    button.setAttribute('aria-selected', String(account.id === current));
    button.setAttribute('aria-label', account.title + ' · ' + status.detail);
    if (list.children[index] !== button) list.insertBefore(button, list.children[index] || null);
  });
  if (hadFocus && !list.contains(focused)) focusAccountPicker(current);
}

function focusAccountPicker(id) {
  const list = $('account-picker-list');
  const button = Array.from(list.children).find(option => option.accountId === id) || list.children[0];
  button?.focus();
  button?.scrollIntoView({ block: 'nearest' });
}

function openAccountPicker(edge) {
  if ($('account-picker-trigger').disabled) return;
  $('account-picker-list').hidden = false;
  $('account-picker-trigger').setAttribute('aria-expanded', 'true');
  renderAccountPicker();
  const id = edge === 'first' ? accounts[0]?.id : edge === 'last' ? accounts.at(-1)?.id : current;
  focusAccountPicker(id);
  void refreshAccountStatuses();
}

function closeAccountPicker(restoreFocus = false) {
  $('account-picker-list').hidden = true;
  $('account-picker-trigger').setAttribute('aria-expanded', 'false');
  if (restoreFocus) $('account-picker-trigger').focus();
}

async function chooseAccountPicker(id) {
  if (typeof accountSwitchPending !== 'undefined' && accountSwitchPending) return;
  closeAccountPicker(true);
  accountSelectionVersion++;
  const source = $('account');
  if (id === current || !accounts.some(account => account.id === id)) {
    source.value = current || '';
    return;
  }
  source.value = id;
  try {
    await source.onchange();
  } catch (error) {
    reportError(error);
  } finally {
    source.value = current || '';
    renderAccountPicker();
  }
}

accountPickerReady = true;
$('account-picker-trigger').onclick = () => {
  if ($('account-picker-list').hidden) openAccountPicker();
  else closeAccountPicker();
};
$('account-picker-trigger').onkeydown = event => {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  openAccountPicker(event.key === 'Home' ? 'first' : event.key === 'End' || event.key === 'ArrowUp' ? 'last' : undefined);
};
$('account-picker-trigger').addEventListener('focus', () => { void refreshAccountStatuses(); });
$('account-picker-list').onkeydown = event => {
  if (event.key === 'Escape' || event.key === 'Tab') {
    if (event.key === 'Escape') event.preventDefault();
    closeAccountPicker(true);
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const options = Array.from($('account-picker-list').children);
  const index = options.indexOf(document.activeElement);
  let next = index;
  if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = options.length - 1;
  else next = Math.max(0, Math.min(options.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
  focusAccountPicker(options[next]?.accountId);
};
document.addEventListener('pointerdown', event => {
  if (!$('account-picker-list').hidden && !$('account-picker').contains(event.target)) closeAccountPicker();
});
renderAccountPicker();
