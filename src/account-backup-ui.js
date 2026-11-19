let accountTransferBusy = false;
let accountExportChoices = [];

function accountTransferNotice(message, failed = false) {
  const notice = $('account-transfer-notice');
  notice.textContent = message;
  notice.hidden = !message;
  notice.classList.toggle('warn', failed);
}

function updateAccountExportSelection() {
  const count = accountExportChoices.filter(input => input.checked).length;
  const total = accountExportChoices.length;
  $('account-export-scope').textContent = total
    ? '已选择 ' + count + ' / ' + total + ' 个账号' : '暂无可导出的账号，请先添加账号。';
  $('account-export-all').checked = total > 0 && count === total;
  $('account-export-all').indeterminate = count > 0 && count < total;
  $('account-export-all').disabled = accountTransferBusy || !total;
  for (const input of accountExportChoices) input.disabled = accountTransferBusy;
  for (const name of ['account-export-only', 'account-export-settings']) $(name).disabled = accountTransferBusy || !count;
  $('account-export-close').disabled = accountTransferBusy;
}

function exportAccounts(id) {
  if (accountTransferBusy) return;
  const list = $('account-export-list');
  list.replaceChildren();
  accountExportChoices = accounts.map(account => {
    const row = document.createElement('label');
    row.className = 'account-export-option';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = account.id;
    input.checked = account.id === id;
    input.onchange = () => { $('account-export-error').hidden = true; updateAccountExportSelection(); };
    const info = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = account.title;
    const detail = document.createElement('span');
    detail.className = 'dim';
    detail.textContent = [accountChannel(account.source), account.lastSeen?.worldName
      || (account.lastSeen?.worldId ? '区服 ' + account.lastSeen.worldId : '')].filter(Boolean).join(' · ');
    info.append(title, detail);
    row.append(input, info);
    list.appendChild(row);
    return input;
  });
  list.hidden = !accountExportChoices.length;
  updateAccountExportSelection();
  $('account-export-error').hidden = true;
  $('account-export-dialog').showModal();
  (accountExportChoices.find(input => input.checked) || (accounts.length ? $('account-export-all') : $('account-export-close'))).focus();
}

async function downloadAccounts(includeSettings) {
  if (accountTransferBusy) return;
  const ids = accountExportChoices.filter(input => input.checked).map(input => input.value);
  if (!ids.length) {
    $('account-export-error').textContent = '请至少勾选一个账号';
    $('account-export-error').hidden = false;
    return;
  }
  accountTransferBusy = true;
  updateAccountExportSelection();
  $('account-export-error').hidden = true;
  try {
    const path = '/api/accounts/export', body = { ids, includeSettings };
    const versionGuard = typeof window === 'undefined' ? null : window.cwConsoleVersion;
    const pageVersion = versionGuard?.version;
    const assertCurrent = response => {
      if (response && versionGuard?.check(response) === false) throw new Error('控制台已更新，请刷新页面后重新导出账号。');
      versionGuard?.assertWritable(path, 'POST', body);
    };
    assertCurrent();
    if (includeSettings && !await configFlush()) throw new Error('配置尚未保存，请先处理配置页的提示后再导出');
    assertCurrent();
    const headers = { 'content-type': 'application/json', ...(pageVersion ? { 'X-CW-Console-Version': pageVersion } : {}) };
    const response = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
    globalThis.cwConsoleAuth?.check(response);
    assertCurrent(response);
    if (!response.ok) {
      const data = await response.json();
      if (versionGuard?.check(response, data) === false) throw new Error('控制台已更新，请刷新页面后重新导出账号。');
      assertCurrent();
      throw new Error(data.error || '账号导出失败');
    }
    const blob = await response.blob();
    // The version may change while the body is being read. Never initiate an
    // account download after the global page guard has rejected this page.
    assertCurrent(response);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = (ids.length === 1 ? 'account-' : 'accounts-') + (includeSettings ? 'with-settings-' : '')
      + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
    document.body.appendChild(link);
    try { link.click(); }
    finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
    $('account-export-dialog').close();
    accountTransferNotice('已导出所选 ' + ids.length + ' 个账号' + (includeSettings ? '及配置' : '（仅账号）') + '。');
  } catch (error) {
    $('account-export-error').textContent = error.message;
    $('account-export-error').hidden = false;
  } finally {
    accountTransferBusy = false;
    updateAccountExportSelection();
  }
}

async function importAccounts(file) {
  if (!file || accountTransferBusy) return;
  accountTransferBusy = true;
  $('import-accounts').disabled = true;
  let imported = false;
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error('账号文件不能超过 10 MB');
    let backup;
    try { backup = JSON.parse((await file.text()).replace(/^\uFEFF/, '')); }
    catch { throw new Error('文件不是有效 JSON，请选择本工具导出的账号文件'); }
    if (!await configFlush()) throw new Error('配置尚未保存，请先处理配置页的提示后再导入');
    accountTransferNotice('正在检查账号文件…');
    const preview = await call('/api/accounts/import/preview', { method: 'POST', body: JSON.stringify({ document: backup }) });
    const message = '将新增 ' + preview.created + ' 个账号、更新 ' + preview.updated + ' 个已有账号的凭据。'
      + (preview.settingsCount ? '文件中的 ' + preview.settingsCount + ' 份配置将替换对应账号的本机配置。' : '本机游戏配置保持不变。')
      + '新账号不会自动开始挂机，已有账号保持当前运行状态。';
    if (await accountDialog('确认导入账号', message) === null) { accountTransferNotice('已取消导入。'); return; }
    if (!await configFlush()) throw new Error('配置尚未保存，请先处理配置页的提示后再导入');
    accountTransferNotice('正在导入账号…');
    const result = await call('/api/accounts/import', { method: 'POST', body: JSON.stringify({ document: backup, token: preview.token, confirm: true }) });
    imported = true;
    await loadAccounts(false);
    renderAccounts();
    if (result.settingsCount) {
      await configLoad();
      await refreshSavedLineups();
    }
    accountTransferNotice('导入完成：新增 ' + result.created + ' 个账号，更新 ' + result.updated + ' 个账号，恢复 ' + result.settingsCount + ' 份配置。');
  } catch (error) {
    accountTransferNotice((imported ? '账号已导入，但页面刷新失败，请刷新页面：' : '导入失败：') + error.message, true);
  } finally {
    accountTransferBusy = false;
    $('import-accounts').disabled = false;
    $('import-accounts-file').value = '';
  }
}

$('export-accounts').onclick = () => exportAccounts();
$('account-export-all').onchange = () => {
  if (accountTransferBusy) return;
  for (const input of accountExportChoices) input.checked = $('account-export-all').checked;
  $('account-export-error').hidden = true;
  updateAccountExportSelection();
};
$('account-export-only').onclick = () => downloadAccounts(false);
$('account-export-settings').onclick = () => downloadAccounts(true);
$('account-export-close').onclick = () => { if (!accountTransferBusy) $('account-export-dialog').close(); };
$('account-export-dialog').oncancel = event => { if (accountTransferBusy) event.preventDefault(); };
$('import-accounts').onclick = () => { if (!accountTransferBusy) $('import-accounts-file').click(); };
$('import-accounts-file').onchange = event => importAccounts(event.target.files?.[0]);
