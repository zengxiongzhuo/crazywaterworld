import { readFileSync } from 'node:fs';
import { SETTINGS_FORMAT, SETTINGS_SCHEMA_VERSION } from './automation-settings.mjs';
import { operationLabels } from './operation-labels.mjs';
import { LOG_CATEGORIES, LOG_GROUPS, LOG_GROUP_TONES } from './log-categories.mjs';
import { createLogAccountLabels } from './log-accounts.mjs';
import { chrome, journal, dialogs, templates, giftCodesPage, overviewPage, manualPage, inventoryPage, heroesPage, lineupsPage, guildPage, activitiesPage, accountPage, stagePanel, settingsPage, resultsPage } from './ui/dist/console.mjs';
const componentCss = readFileSync(new URL('./ui/dist/theme.css', import.meta.url), 'utf8');
const consoleCss = readFileSync(new URL('./console.css', import.meta.url), 'utf8');
const progressionScript = readFileSync(new URL('./ui/progression.js', import.meta.url), 'utf8');
const lineupScript = readFileSync(new URL('./lineup-editor.js', import.meta.url), 'utf8');
const lineupCss = readFileSync(new URL('./lineup-editor.css', import.meta.url), 'utf8');
const settingsScript = readFileSync(new URL('./settings-ui.js', import.meta.url), 'utf8');
const activitiesScript = readFileSync(new URL('./ui/activities.js', import.meta.url), 'utf8');
const settingsCss = readFileSync(new URL('./settings.css', import.meta.url), 'utf8');
const giftCodeScript=readFileSync(new URL('./gift-codes-ui.js',import.meta.url),'utf8');
const inventoryScript=readFileSync(new URL('./inventory-ui.js',import.meta.url),'utf8');
const productionPlanningScript = readFileSync(new URL('./production-planning-ui.js', import.meta.url), 'utf8');
const worldMapScript=readFileSync(new URL('./world-map-ui.js',import.meta.url),'utf8');
const siliconOverviewScript = readFileSync(new URL('./silicon-overview-ui.js', import.meta.url), 'utf8');
const siliconOverviewCss = readFileSync(new URL('./silicon-overview.css', import.meta.url), 'utf8');
const resourceFieldsScript = readFileSync(new URL('./resource-fields-ui.js', import.meta.url), 'utf8');
const resourceFieldsCss = readFileSync(new URL('./resource-fields.css', import.meta.url), 'utf8');
import {mapMotionPosition} from './world-map-geometry.mjs';
const phoneLoginScript = readFileSync(new URL('./phone-login-ui.js', import.meta.url), 'utf8');
const alipayLoginScript = readFileSync(new URL('./alipay-login-ui.js', import.meta.url), 'utf8');
const accountAddScript = readFileSync(new URL('./account-add-ui.js', import.meta.url), 'utf8');
const accountBackupScript = readFileSync(new URL('./account-backup-ui.js', import.meta.url), 'utf8');
const accountPickerScript = readFileSync(new URL('./account-picker-ui.js', import.meta.url), 'utf8');
const roleRotationScript = readFileSync(new URL('./role-rotation-ui.js', import.meta.url), 'utf8');
const resultsScript = readFileSync(new URL('./automation-results-ui.js', import.meta.url), 'utf8');
const resultsCss = readFileSync(new URL('./automation-results.css', import.meta.url), 'utf8');
const helpTipsScript = readFileSync(new URL('./help-tips.js', import.meta.url), 'utf8');
const appointmentsScript = readFileSync(new URL('./appointments-ui.js', import.meta.url), 'utf8');
const appointmentsCss = readFileSync(new URL('./appointments.css', import.meta.url), 'utf8');
const themeScript = readFileSync(new URL('./theme-ui.js', import.meta.url), 'utf8');
const consoleStoreScript = readFileSync(new URL('./ui/dist/console-store.js', import.meta.url), 'utf8');

export const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3E%3Crect fill='%23102d39' width='40' height='40' rx='8'/%3E%3Cpath fill='%23ffbd77' d='m20 3 4 13 13 4-13 4-4 13-4-13-13-4 13-4z'/%3E%3C/svg%3E">
<title>疯狂水世界</title>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#ffffff">
<meta name="format-detection" content="telephone=no">
<script id="theme-init">${themeScript}</script>
<style>@layer properties, theme, base, components, page, utilities; @layer page { ${consoleCss} ${settingsCss} ${appointmentsCss} ${lineupCss} ${siliconOverviewCss} ${resourceFieldsCss} ${resultsCss} } ${componentCss}</style>
</head>
<body>
${chrome()}
<div class="deck"><main>
  <nav id="resource-tabs" class="resource-tabs" aria-label="杂项分类" hidden>
    <button type="button" data-resource-tab="guild">联盟</button><button type="button" data-resource-tab="inventory">仓库</button><button type="button" data-resource-tab="heroes">英雄与装备</button><button type="button" data-resource-tab="giftcodes">礼包兑换</button>
  </nav>
  <section id="tab-overview">
    ${overviewPage()}
  </section>

  <section id="tab-results" class="hidden">${resultsPage()}</section>

  <section id="tab-settings" class="hidden">
    ${settingsPage()}
  </section>

  <section id="tab-manual" class="hidden">
    ${manualPage()}
  </section>

  <section id="tab-stages" class="hidden">
    ${stagePanel()}
  </section>

  <section id="tab-lineups" class="hidden" aria-label="阵容">
    ${lineupsPage()}
  </section>

  <section id="tab-inventory" class="hidden">
    ${inventoryPage()}
  </section>

  <section id="tab-heroes" class="hidden">
    ${heroesPage()}
  </section>

  <section id="tab-activities" class="hidden">
    ${activitiesPage()}
  </section>

  <section id="tab-guild" class="hidden">${guildPage()}</section>

  <section id="tab-giftcodes" class="hidden">
    ${giftCodesPage()}
  </section>
  <section id="tab-account" class="hidden">
    ${accountPage()}
  </section>
</main></div>
${journal()}
${dialogs()}
${templates()}

<script>
${consoleStoreScript}
const { consoleStore, stateActions, bindConsoleSlice, patchConsoleSlice, setConsoleValue, mutateConsoleValue, bindConsoleObject } = CWConsoleState.createConsoleRuntime();
window.cwConsoleStore = consoleStore;
const $ = (id) => document.getElementById(id);
const logEl = $('log');
const operationNames = ${JSON.stringify(operationLabels)};

// 游戏操作按顶部账号执行；运行日志独立订阅所有账号并筛选。
let current = null;
let accounts = [];
let stream = null;
const consoleDraftFormat = ${JSON.stringify({ format: SETTINGS_FORMAT, version: SETTINGS_SCHEMA_VERSION })};

function createConsoleVersionGuard() {
  const version = document.querySelector('meta[name="cw-console-version"]')?.content || '';
  const message = '控制台已更新或重启，当前页面已过期。未保存的草稿已保留；请先下载或复制未保存的修改，再刷新页面。';
  const stops = new Set(['/api/loop/stop','/api/disconnect','/api/stages/stop','/api/pirates/advance/stop',
    '/api/guild/mutual/stop','/api/trials/stop','/api/capture/stop','/api/accounts/alipay-login/cancel','/api/accounts/phone-login/cancel']);
  let stale = false;
  const failure = () => Object.assign(new Error(message), { code: 'CLIENT_VERSION_MISMATCH', fields: { revision: message } });
  const allowed = (path, method = 'POST') => ['GET','HEAD','OPTIONS'].includes(String(method).toUpperCase())
    || String(method).toUpperCase() === 'POST' && stops.has(new URL(path || '/', location.href).pathname);
  const reject = () => {
    if (stale) return;
    stale = true;
    const banner = document.createElement('section'); banner.id = 'console-version-warning'; banner.className = 'config-message';
    banner.dataset.kind = 'error'; banner.setAttribute('role', 'alert');
    const text = document.createElement('p'); text.textContent = message; banner.append(text);
    const actions = document.createElement('div'); Object.assign(actions.style, { display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '8px' });
    const action = (label, run) => { const button = document.createElement('button'); button.type = 'button'; button.className = 'config-small-button'; button.textContent = label; button.onclick = run; actions.append(button); return button; };
    const download = action('下载游戏配置草稿', () => configDownloadDraft()); download.disabled = !configHasDraft();
    action('刷新页面', () => {
      if (!window.confirm('刷新会丢弃本页未保存的修改。请先下载游戏配置草稿或复制需要保留的内容，确认已保留后再刷新。')) return;
      location.reload();
    });
    for (const [label, route] of [['停止当前账号挂机', '/api/loop/stop'], ['断开当前账号', '/api/disconnect']]) {
      const button = action(label, async () => {
        if (!current) return; button.disabled = true;
        try { await call(route, { method: 'POST', body: JSON.stringify({ confirm: true }) }); await refreshLoop(); }
        catch (error) { reportError(error); }
        finally { button.disabled = !current; }
      }); button.disabled = !current;
    }
    banner.append(actions); (document.querySelector('header') || document.body).prepend(banner);
    window.dispatchEvent(new Event('cw-console-version-stale'));
  };
  const observe = value => { if (value && value !== version) reject(); };
  return Object.freeze({ version, message, isStale: () => stale, observe, reject,
    check(response, data) { observe(response?.headers?.get('X-CW-Console-Version')); if (data?.code === 'CLIENT_VERSION_MISMATCH') reject(); return !stale; },
    assertWritable(path, method = 'POST') { if (stale && !allowed(path, method)) throw failure(); },
  });
}
window.cwConsoleVersion = createConsoleVersionGuard();

function num(v) {
  if (v == null || typeof v !== 'object') return v;
  return (v.low >>> 0) + (v.high >>> 0) * 4294967296;
}

function fmt(v) {
  const n = num(v);
  if (typeof n !== 'number') return String(n == null ? '-' : n);
  return n.toLocaleString('zh-CN');
}

function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('zh-CN', { hour12: false });
}

let callsInFlight = 0, callProgressTimer = 0;
function trackCall(delta) {
  callsInFlight += delta;
  if (callsInFlight > 0) {
    if (!callProgressTimer) callProgressTimer = setTimeout(() => { callProgressTimer = 0; if (callsInFlight > 0) document.body.setAttribute('data-loading', ''); }, 400);
    return;
  }
  clearTimeout(callProgressTimer);
  callProgressTimer = 0;
  document.body.removeAttribute('data-loading');
}

async function call(path, options) {
  const opts = { ...options }, method = String(opts.method || 'GET').toUpperCase();
  const versionGuard = window.cwConsoleVersion;
  versionGuard.assertWritable(path, method);
  const headers = new Headers(opts.headers); headers.set('X-CW-Console-Version', versionGuard.version); opts.headers = headers;
  let url = path;
  if (current && url.indexOf('/api/') === 0 && url.indexOf('account=') < 0) {
    url += (url.indexOf('?') < 0 ? '?' : '&') + 'account=' + encodeURIComponent(current);
  }
  const account = new URL(url, location.href).searchParams.get('account');
  trackCall(1);
  try {
    const res = await fetch(url, opts);
    versionGuard.check(res);
    versionGuard.assertWritable(path, method);
    const data = await res.json();
    versionGuard.check(res, data);
    versionGuard.assertWritable(path, method);
    if (!res.ok) {
      const error = new Error(data.error || res.statusText);
      if (data.code) error.code = data.code;
      if (data.fields) error.fields = data.fields;
      if (data.log) appendLog(data.log);
      error.logged = true;
      if (!data.log) reportError(new Error(data.error || ('控制台返回 HTTP ' + res.status)), path, account);
      throw error;
    }
    return data;
  } catch (error) {
    if (!error.logged) reportError(error, path, account);
    error.logged = true;
    throw error;
  } finally {
    trackCall(-1);
  }
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function clear(node) {
  node.textContent = '';
  return node;
}

// ---- 图标 ------------------------------------------------------------------
// 每个图标单独下载缩略图；屏幕外的不加载，取不到时退回名字首字。

function iconEl(entry, size, name) {
  if (!entry?.thumb) {
    const box = el('span', 'ico');
    box.style.width = size + 'px';
    box.style.height = size + 'px';
    box.appendChild(el('span', 'fallback', (name || '?').slice(0, 1)));
    box.title = name || '';
    return box;
  }
  const k = size / Math.max(entry.w, entry.h);
  const img = el('img', 'ico');
  img.width = Math.max(1, Math.round(entry.w * k));
  img.height = Math.max(1, Math.round(entry.h * k));
  img.alt = '';
  img.title = name || '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.onerror = () => img.replaceWith(iconEl(null, size, name));
  img.src = entry.thumb;
  return img;
}

// 一项东西：图标 + 名字 + 数量
function cell(entry, size, name, qty, showPlaceholder = true) {
  const node = el('div', 'cell');
  if (entry || showPlaceholder) node.appendChild(iconEl(entry, size || 34, name));
  const txt = el('div', 'txt');
  txt.appendChild(el('span', 'nm', name || '?'));
  if (qty != null) txt.appendChild(el('span', 'qty', qty));
  node.appendChild(txt);
  return node;
}

function component(id) {
  return $(id).content.firstElementChild.cloneNode(true);
}
function smallButton(label, danger = false) {
  const button = component(danger ? 'ui-delete' : 'ui-button');
  button.textContent = label;
  return button;
}
function chip(status, text) {
  const badge = component('ui-badge');
  badge.classList.add('chip', status);
  badge.textContent = text;
  return badge;
}

// ---- 弹窗 ------------------------------------------------------------------
function closeModal() {
  $('modal').close();
  $('m-ok').onclick = null;
}
function openConfirm(title, bodyNodes, onOk) {
  $('m-title').textContent = title;
  const body = clear($('m-body'));
  for (const node of bodyNodes) body.appendChild(node);
  $('m-ok').onclick = async () => {
    const run = onOk;
    closeModal();
    try {
      await run();
    } catch (error) {
      $('hint').textContent = '';
      reportError(error);
    }
  };
  $('modal').showModal();
  $('m-cancel').focus();
}
$('m-cancel').onclick = closeModal;
$('modal').oncancel = event => { event.preventDefault(); closeModal(); };
function isChecked(control) {
  return control.getAttribute('aria-checked') === 'true';
}
for (const control of document.querySelectorAll('[data-local-switch]')) {
  control.onclick = () => setTaskSwitch(control, !isChecked(control));
}

function accountDialog(title, message, value) {
  const dialog = $('account-dialog'), input = $('account-label-input');
  $('account-title').textContent = title;
  $('account-message').textContent = message;
  input.hidden = value === undefined;
  input.value = value ?? '';
  dialog.returnValue = '';
  dialog.showModal();
  if (!input.hidden) input.select();
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok' ? input.value : null), { once: true });
  });
}

function bindGameAction(id, action) {
  const button = $(id);
  button.onclick = async () => {
    if (!current || button.disabled) return;
    button.disabled = true;
    try { await action(); }
    catch (error) { reportError(error); }
    finally { button.disabled = false; }
  };
}

// ---- 运行记录 --------------------------------------------------------------
const seen = new Set();
const logTime = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const logCategories = ${JSON.stringify(LOG_CATEGORIES)};
const logGroups = ${JSON.stringify(LOG_GROUPS)};
const logGroupTones = ${JSON.stringify(LOG_GROUP_TONES)};
const createLogAccountLabels = ${createLogAccountLabels.toString()};
let logAccount = 'all';
let logGroup = 'all';
let onlyIssues = false;
consoleStore.subscribe((state, previous) => {
  if (state.view === previous.view) return;
  logAccount = state.view.logAccount;
  logGroup = state.view.logGroup;
  onlyIssues = state.view.onlyIssues;
});
let logReturnFocus;
function openJournal() {
  if ($('journal-dialog').open) return;
  closeHelpTip(false); logReturnFocus = document.activeElement;
  updateLogSummary();
  document.body.classList.add('has-log-dialog'); $('journal-dialog').showModal();
  const selectedAccount = $('log-account-tabs').querySelector('[aria-pressed=true]');
  selectedAccount.focus({ preventScroll: true });
  revealLogFilter(selectedAccount); revealLogFilter($('log-tabs').querySelector('[aria-selected=true]'));
}
$('logs-open').onclick = openJournal;
$('logs-close').onclick = () => $('journal-dialog').close();
$('journal-dialog').addEventListener('close', () => { document.body.classList.remove('has-log-dialog'); (logReturnFocus?.isConnected ? logReturnFocus : $('logs-open')).focus(); });
const logTabs = [...$('log-tabs').querySelectorAll('[role=tab]')];
function revealLogFilter(button) {
  // 使用布局坐标，避免弹窗开场缩放影响横向定位。
  const container = button.parentElement, left = button.offsetLeft - 3, right = button.offsetLeft + button.offsetWidth + 3;
  if (left < container.scrollLeft) container.scrollLeft = left;
  else if (right > container.scrollLeft + container.clientWidth) container.scrollLeft = right - container.clientWidth;
}
function selectLogGroup(tab) {
  stateActions.setView({ logGroup: tab.dataset.logGroup });
  updateLogSummary();
  revealLogFilter(tab);
}
function selectLogAccount(id) {
  stateActions.setView({ logAccount: id });
  updateLogSummary();
  revealLogFilter($('log-account-tabs').querySelector('[aria-pressed=true]'));
}
$('log-account-tabs').onkeydown = event => {
  const buttons = [...$('log-account-tabs').querySelectorAll('[data-log-account]')];
  const index = buttons.indexOf(event.target.closest('[data-log-account]'));
  if (index < 0) return;
  const next = { ArrowRight: (index + 1) % buttons.length, ArrowLeft: (index + buttons.length - 1) % buttons.length, Home: 0, End: buttons.length - 1 }[event.key];
  if (next === undefined) return;
  event.preventDefault(); selectLogAccount(buttons[next].dataset.logAccount); buttons[next].focus({ preventScroll: true });
};
for (const [index, tab] of logTabs.entries()) {
  tab.onclick = () => selectLogGroup(tab);
  tab.onkeydown = event => {
    const next = { ArrowRight: (index + 1) % logTabs.length, ArrowLeft: (index + logTabs.length - 1) % logTabs.length, Home: 0, End: logTabs.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault(); selectLogGroup(logTabs[next]); logTabs[next].focus({ preventScroll: true });
  };
}
const logClearWatermarks = new Map();
const logAccountNames = new Map();
let logClearing = false;
function logAccountLabel(id) {
  if (!id) return '系统';
  for (const [key, name] of createLogAccountLabels(accounts)) logAccountNames.set(key, name);
  return logAccountNames.get(id) || '已移除账号';
}
function paintLogAccount(badge, id) {
  const label = logAccountLabel(id);
  badge.querySelector('.log-account-name').textContent = label;
  badge.title = id ? label + ' · ' + id : '控制台系统日志';
  badge.setAttribute('aria-label', '筛选账号：' + label);
  badge.dataset.tone = 'neutral';
}
function updateLogAccounts() {
  const ids = new Set(accounts.map(account => account.id));
  for (const row of logEl.children) if (row.dataset.account) ids.add(row.dataset.account);
  if (logAccount !== 'all') ids.add(logAccount);
  const options = [['all', '全部'], ...[...ids].map(id => [id, logAccountLabel(id)])];
  const signature = JSON.stringify(options);
  const container = $('log-account-tabs');
  if (container.dataset.options === signature) return;
  const existing = new Map([...container.children].map(button => [button.dataset.logAccount, button]));
  for (const [index, [id, label]] of options.entries()) {
    const button = existing.get(id) || component('ui-log-account-filter');
    existing.delete(id);
    button.dataset.logAccount = id;
    button.querySelector('[data-log-account-name]').textContent = label;
    button.title = id === 'all' ? '查看全部账号与系统记录' : label;
    button.onclick = () => selectLogAccount(id);
    if (container.children[index] !== button) container.insertBefore(button, container.children[index] || null);
  }
  for (const button of existing.values()) button.remove();
  container.dataset.options = signature;
  for (const row of logEl.children) {
    const badge = row.querySelector('.log-account');
    if (badge) paintLogAccount(badge, row.dataset.account);
  }
}
function clearedLog(entry) {
  const watermark = logClearWatermarks.get(entry.account || '');
  return watermark && (entry.id ? entry.id <= watermark.before : entry.t <= watermark.at);
}
let guildRefreshTimer;
function updateLogSummary() {
  updateLogAccounts();
  let count = 0;
  const groupCounts = { all: 0 };
  const accountCounts = new Map([['all', 0]]);
  for (const row of logEl.children) {
    const accountMatches = logAccount === 'all' || row.dataset.account === logAccount;
    const levelMatches = !onlyIssues || row.classList.contains('error') || row.classList.contains('warn');
    const group = Object.keys(logGroups).find(key => logGroups[key].includes(row.dataset.category));
    const groupMatches = logGroup === 'all' || group === logGroup;
    if (accountMatches && levelMatches) { groupCounts.all++; if (group) groupCounts[group] = (groupCounts[group] || 0) + 1; }
    if (groupMatches && levelMatches) {
      accountCounts.set('all', accountCounts.get('all') + 1);
      if (row.dataset.account) accountCounts.set(row.dataset.account, (accountCounts.get(row.dataset.account) || 0) + 1);
    }
    row.hidden = !accountMatches || !levelMatches || !groupMatches;
    if (!row.hidden) count++;
  }
  for (const button of $('log-account-tabs').children) {
    const selected = button.dataset.logAccount === logAccount;
    button.setAttribute('aria-pressed', String(selected)); button.tabIndex = selected ? 0 : -1;
    const counter = button.querySelector('[data-log-account-count]');
    const value = String(accountCounts.get(button.dataset.logAccount) || 0);
    if (counter.textContent !== value) counter.textContent = value;
  }
  for (const tab of logTabs) {
    const selected = tab.dataset.logGroup === logGroup;
    tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
    tab.querySelector('[data-log-group-count]').textContent = groupCounts[tab.dataset.logGroup] || 0;
    if (selected) $('log-panel').setAttribute('aria-labelledby', tab.id);
  }
  const account = accounts.find(item => item.id === logAccount);
  $('log-clear').disabled = logClearing || !account;
  $('log-clear').title = account ? '清空“' + logAccountLabel(logAccount) + '”的全部运行日志（不限当前分类）' : '选择一个账号后可清空该账号的全部运行日志';
  $('log-top-count').textContent = logEl.children.length;
  $('log-count').textContent = String(count);
  $('log-empty').hidden = count > 0;
  $('log-empty').textContent = logGroup !== 'all' || logAccount !== 'all' || onlyIssues ? '没有符合当前账号、分类和等级筛选的记录' : '还没有运行记录';
}
function appendLog(entry) {
  if (clearedLog(entry)) return;
  if (entry.id && seen.has(entry.id)) return;
  if (entry.id) seen.add(entry.id);
  if (entry.account && entry.accountName) logAccountNames.set(entry.account, entry.accountName);
  const atTop = logEl.scrollTop < 30;
  const anchor = [...logEl.children].find(row => !row.hidden && row.getBoundingClientRect().bottom > logEl.getBoundingClientRect().top);
  const anchorTop = anchor?.getBoundingClientRect().top;
  const waitKey=entry.extra?.waitKey;
  const sameScope = row => row?.dataset.account === (entry.account || '') && row.dataset.category === (entry.category || 'system') && row.classList.contains(entry.level);
  const newer = (a, b) => a.t > b.t || (a.t === b.t && (a.id || Infinity) > (b.id || 0));
  const repeated=waitKey && [...logEl.children].find(row=>sameScope(row) && row.dataset.waitKey===waitKey);
  if(repeated){
    repeated.logEntries.push(entry); repeated.logEntries.sort((a,b) => newer(a,b) ? -1 : 1);
    if(repeated.logEntries.length>400){const dropped=repeated.logEntries.pop();seen.delete(dropped.id);}
    repeated.dataset.waitCount=String(Number(repeated.dataset.waitCount||1)+1);updateLogRow(repeated);
    const next=[...logEl.children].find(row=>row!==repeated && newer(repeated.logEntries[0],row.logEntries[0]));
    logEl.insertBefore(repeated,next||null);updateLogSummary();
    if(atTop)logEl.scrollTop=0;else if(anchor?.isConnected)logEl.scrollTop+=anchor.getBoundingClientRect().top-anchorTop;
    return;
  }
  const batch = entry.extra?.batch;
  const first = logEl.firstElementChild;
  if (batch && sameScope(first) && first.dataset.batch === batch && first.logEntries.length < 32 && newer(entry, first.logEntries[0])) {
    first.logEntries.unshift(entry);
    updateLogRow(first);
  } else {
    const row = el('div', 'row ' + entry.level);
    row.dataset.category = entry.category || 'system';
    row.dataset.account = entry.account || '';
    if(waitKey){row.dataset.waitKey=waitKey;row.dataset.waitCount='1';}
    row.logEntries = [entry];
    if (batch) row.dataset.batch = batch;
    const timestamp = logTime.format(entry.t);
    const body = el('div', 'log-body');
    const meta = el('div', 'log-meta');
    const accountBadge = component(entry.account ? 'ui-log-account' : 'ui-log-badge');
    if (entry.account) {
      paintLogAccount(accountBadge, entry.account);
      accountBadge.onclick = () => selectLogAccount(entry.account);
    } else {
      accountBadge.textContent = '系统'; accountBadge.dataset.tone = 'neutral'; accountBadge.classList.add('log-system-tag');
      accountBadge.title = '控制台系统日志';
    }
    const categoryBadge = component('ui-log-badge'); categoryBadge.classList.add('log-category-tag');
    categoryBadge.textContent = logCategories[row.dataset.category] || logCategories.system;
    const group = Object.keys(logGroups).find(key => logGroups[key].includes(row.dataset.category));
    categoryBadge.dataset.tone = logGroupTones[group] || 'neutral';
    meta.append(el('time', 'ts', timestamp), accountBadge, categoryBadge);
    const levelName = { error: '错误', warn: '警告' }[entry.level];
    if (levelName) {
      const levelBadge = component('ui-log-badge'); levelBadge.classList.add('log-level-tag');
      levelBadge.dataset.tone = entry.level === 'error' ? 'error' : 'warning'; levelBadge.textContent = levelName;
      meta.appendChild(levelBadge);
    }
    body.appendChild(meta);
    body.appendChild(el('span', 'log-message', entry.message));
    if (entry.detail || batch) {
      const details = el('details', 'log-details');
      details.hidden = !entry.detail;
      details.append(el('summary', null, batch ? '查看逐次排产' : '查看详情'),
        el('div', 'log-detail-text', entry.detail || timestamp + ' ' + entry.message));
      body.appendChild(details);
    }
    row.appendChild(body);
    const next = [...logEl.children].find(item => newer(entry, item.logEntries[0]));
    logEl.insertBefore(row, next || null);
  }
  while (logEl.childElementCount > 400) {
    for (const item of logEl.lastChild.logEntries) seen.delete(item.id);
    logEl.lastChild.remove();
  }
  updateLogSummary();
  if (atTop) logEl.scrollTop = 0;
  else if (anchor?.isConnected) logEl.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
}
function updateLogRow(row) {
  const entry = row.logEntries[0];
  row.querySelector('time').textContent = logTime.format(entry.t);
  row.querySelector('.log-message').textContent = row.dataset.waitKey ? entry.message+'（累计 '+row.dataset.waitCount+' 次，时间为最后检查）' : row.logEntries.length > 1
    ? entry.extra.factory + '：连续安排生产' + entry.extra.product + '，共 ' + row.logEntries.length + ' 次' : entry.message;
  const details = row.querySelector('.log-details');
  if (details) {
    details.hidden = row.logEntries.length < 2 && !entry.detail;
    row.querySelector('.log-detail-text').textContent = entry.detail || row.logEntries.map(item => logTime.format(item.t) + ' ' + item.message).join(String.fromCharCode(10));
  }
}
function clearLogBefore(data) {
  if (!data.account) return;
  const previous = logClearWatermarks.get(data.account);
  logClearWatermarks.set(data.account, { before: Math.max(previous?.before || 0, data.before || 0), at: Math.max(previous?.at || 0, data.at || 0) });
  for (const row of [...logEl.children]) {
    if (row.dataset.account !== data.account) continue;
    row.logEntries = row.logEntries.filter(entry => !clearedLog(entry));
    if (row.dataset.waitKey) row.dataset.waitCount = String(row.logEntries.length);
    if (row.logEntries.length) updateLogRow(row); else row.remove();
  }
  seen.clear();
  for (const row of logEl.children) for (const entry of row.logEntries) if (entry.id) seen.add(entry.id);
  updateLogSummary();
}
$('log-clear').onclick = async () => {
  if (logClearing || !accounts.some(account => account.id === logAccount)) return;
  const account = logAccount;
  logClearing = true; updateLogSummary();
  try {
    const data = await call('/api/logs/clear?account=' + encodeURIComponent(account), { method: 'POST', body: JSON.stringify({ confirm: true }) });
    clearLogBefore(data);
  } catch (error) { reportError(error, undefined, account); }
  finally { logClearing = false; updateLogSummary(); }
};
function reportError(error, context, account = current) {
  if (error?.logged) return;
  const api = context?.startsWith('/api/');
  const action = api ? operationNames[context.split('?')[0]] || '控制台操作' : context;
  const raw = error?.message || String(error);
  const reason = raw === 'Failed to fetch' ? '无法连接本地控制台，请检查控制台是否仍在运行' : raw;
  appendLog({ t: Date.now(), account, level: 'error', message: (action ? action + '失败：' : '') + reason,
    detail: api ? context + ' · ' + raw : undefined });
  if (error instanceof Error) error.logged = true;
}
window.addEventListener('unhandledrejection', (event) => { reportError(event.reason); event.preventDefault(); });
for (const [id, filtered] of [['log-all', false], ['log-issues', true]]) {
  $(id).onclick = () => {
    stateActions.setView({ onlyIssues: filtered });
    $('journal').classList.toggle('issues', filtered);
    $('log-all').setAttribute('aria-pressed', String(!filtered));
    $('log-issues').setAttribute('aria-pressed', String(filtered));
    updateLogSummary();
  };
}
function subscribe() {
  updateLogSummary();
  if (stream) return;
  stream = new EventSource('/api/events?scope=all');
  stream.addEventListener('logs-cleared', event => clearLogBefore(JSON.parse(event.data)));
  stream.addEventListener('lineup-changed', event => {
    const { account } = JSON.parse(event.data);
    if (account === current) void refreshSavedLineups();
  });
  stream.addEventListener('guild-aid-changed', event => {
    const account = JSON.parse(event.data).account;
    if (account !== current) return;
    clearTimeout(guildRefreshTimer);
    guildRefreshTimer = setTimeout(() => {
      if (account === current && !snapshot.paused && !$('tab-guild').classList.contains('hidden')) {
        void refreshProgression('guild');
      }
    }, 300);
  });
  stream.onmessage = (event) => {
    const entry = JSON.parse(event.data);
    appendLog(entry);
    if ((entry.extra?.pauseChanged || entry.extra?.loginBlocked) && entry.account === current) void loadAccounts(false);
    if (entry.extra?.worldUpdated && entry.account === current && Date.now() - entry.t < 10_000) refreshManualWorld();
    if (entry.extra?.lineupChanged && entry.account === current && Date.now() - entry.t < 10_000) void refreshSavedLineups();
  };
}

// ---- 账号 ------------------------------------------------------------------
let snapshot = { connected: false, state: 'IDLE', busy: null, looping: false };
let disconnected = new Set();
let connectingAccounts = new Set();
let hostingActions = new Set();
let accountStatusRevision = 0;
let accountStatusPending = null;
let accountsLoading = 0;
let accountLoadVersion = 0;
let accountSelectionVersion = 0;

function syncAccountState(state) {
  current = state.currentAccountId;
  accounts = CWConsoleState.selectAccounts(state);
  snapshot = CWConsoleState.selectCurrentStatus(state);
  disconnected = state.disconnected;
  connectingAccounts = state.connecting;
  hostingActions = state.hosting;
}
consoleStore.subscribe((state, previous) => {
  if (state.accountsById !== previous.accountsById || state.accountIds !== previous.accountIds
      || state.currentAccountId !== previous.currentAccountId || state.disconnected !== previous.disconnected
      || state.connecting !== previous.connecting || state.hosting !== previous.hosting) syncAccountState(state);
});
syncAccountState(consoleStore.getState());

function connectionStatus(status = {}) {
  if (status?.switching) return '正在切换区服';
  status = status ?? {};
  if (status.syncingProduction) return '正在同步生产状态';
  if (status.paused) return '已暂停 · 可自行上号';
  if (status.reconnecting) {
    if (status.loginRecovery?.status === 'connecting') return '异地登录 · 正在自动重连';
    const nextAttemptAt = status.loginRecovery?.nextAttemptAt;
    if (!Number.isFinite(nextAttemptAt)) return '异地登录 · 等待重连';
    const seconds = Math.max(0, Math.ceil((nextAttemptAt - Date.now()) / 1000));
    return '异地登录 · ' + seconds + ' 秒后重试';
  }
  if (status.loginBlocked) return '异地登录 · 等待恢复托管';
  if (status.loopStopping) return '暂停中…';
  if (status.connected) return status.looping ? '挂机中' : '已连接 · 未挂机';
  if (status.state === 'CONNECTING') return '连接中…';
  return status.looping ? '挂机中 · 等待连接' : '未连接';
}

function connectionStatusKind(status = {}, connecting = false) {
  status = status ?? {};
  return status.switching || status.paused || status.loginBlocked || status.reconnecting || status.syncingProduction
    || status.loopStopping || connecting || status.state === 'CONNECTING' || (status.looping && !status.connected)
    ? 'waiting' : status.connected ? 'done' : 'blocked';
}

function renderAccountOptions() {
  const box = $('account');
  const choices = accounts.length ? accounts.map(account => {
    const status = account.id === current ? snapshot : account.status;
    const text = connectingAccounts.has(account.id) ? '连接中…' : connectionStatus(status);
    return [account.id, '[' + text + '] ' + account.title];
  }) : [['', '没有账号']];
  if (box.options.length !== choices.length || choices.some(([id], index) => box.options[index]?.value !== id)) {
    box.replaceChildren(...choices.map(([id, text]) => new Option(text, id)));
  } else {
    choices.forEach(([, text], index) => {
      if (box.options[index].text !== text) box.options[index].text = text;
    });
  }
  box.disabled = !accounts.length;
  if (box.value !== (current || '')) box.value = current || '';
}

function setBusy(text) {
  const announcement = current ? text : '没有账号';
  if ($('busy').textContent !== announcement) $('busy').textContent = announcement;
  const account = accounts.find(row => row.id === current);
  const option = Array.from($('account').options).find(row => row.value === current);
  if (account && option) {
    const label = '[' + text + '] ' + account.title;
    if (option.text !== label) option.text = label;
  }
  $('account').title = option?.text || '选择账号并查看状态';
  if (typeof renderAccountPicker === 'function') renderAccountPicker(text);
}

function paintConnection() {
  renderAccountOptions();
  setBusy(connectingAccounts.has(current) ? '连接中…' : connectionStatus(snapshot));
}

function setAccountStatus(account, status) {
  accountStatusRevision++;
  stateActions.setStatus(account, status);
  paintConnection();
}

function refreshAccountStatuses() {
  if (document.hidden || !accounts.length || accountsLoading || accountStatusPending) return accountStatusPending;
  const revision = accountStatusRevision;
  accountStatusPending = (async () => {
    try {
      const data = await call('/api/accounts');
      if (revision !== accountStatusRevision) return;
      accountStatusRevision++;
      if (data.accounts.some(row => row.roleId && !accounts.some(account => account.id === row.id))) {
        stateActions.replaceAccounts(data.accounts, data.activeId);
      } else stateActions.mergeStatuses(data.accounts);
      renderAccountSelect();
    } catch {
      /* call 已记录错误，下次刷新继续读取。 */
    } finally {
      accountStatusPending = null;
    }
  })();
  return accountStatusPending;
}

let accountDetailsOwner=null;
function renderHostingControl() {
  const resume = snapshot.paused || (snapshot.loginBlocked && !snapshot.reconnecting);
  const running = snapshot.looping || snapshot.reconnecting;
  const hosting = running || snapshot.connected || snapshot.state === 'CONNECTING' || connectingAccounts.has(current);
  const pending = !current || hostingActions.has(current);
  $('loop-toggle').disabled = pending || !!snapshot.paused || !!snapshot.loopStopping || (!running && loopAccount !== current);
  $('loop-toggle').textContent = snapshot.loopStopping ? '暂停中…' : running ? '暂停挂机' : '开始挂机';
  $('loop-toggle').title = snapshot.paused ? '请先恢复托管' : running ? '停止自动循环，保留游戏连接和手动操作' : '按已保存的任务持续挂机，直到手动暂停';
  $('account-pause').disabled = pending || ((resume || !hosting) && (!!snapshot.loopStopping || loopAccount !== current));
  $('account-pause').textContent = resume ? '恢复托管' : hosting ? '暂停托管' : '开始托管';
  $('account-pause').title = resume ? '重新登录游戏并按已保存的任务开始持续托管' : hosting ? '停止任务并断开游戏连接，方便自行上号' : '按已保存的任务开始持续托管';
}
function renderAccountSelect() {
  appointmentsAccountChanged();
  if(accountDetailsOwner!==current){
    accountSelectionVersion++;
    accountDetailsOwner=current;
    clear($('worlds'));$('worlds-hint').textContent='';$('world-input').value='';
    $('who').textContent=current?'等待连接':'未选择账号';$('res').textContent='';
    if ($('account-info-dialog').open) $('account-info-dialog').close();
  }
  if(worldMapOwner!==null&&worldMapOwner!==current)resetWorldMap();
  siliconAccountChanged();
  resourceFieldsAccountChanged();
  if (productionPlanOwner !== null && (productionPlanOwner !== current || !snapshot.connected || snapshot.paused || disconnected.has(current))) resetProductionPlan();
  $('production-plan-refresh').disabled = productionPlanBusy || !snapshot.connected || snapshot.paused || disconnected.has(current);
  renderHostingControl();
  paintConnection();
  $('connect').disabled = snapshot.paused || snapshot.reconnecting || snapshot.connected || connectingAccounts.has(current) || !accounts.length;
  $('connect').hidden = !current || snapshot.connected || snapshot.paused || snapshot.reconnecting || snapshot.loginBlocked;
  $('account-info-refresh').disabled = !current || snapshot.paused || snapshot.reconnecting || connectingAccounts.has(current);
  $('account-info-refresh').textContent = snapshot.connected ? '刷新资料' : '连接并读取';
  if (!$('tab-account').classList.contains('hidden')) renderAccounts();
}

async function loadAccounts(reload) {
  const version = ++accountLoadVersion;
  const revision = ++accountStatusRevision;
  accountsLoading++;
  let data;
  try {
    data = await call('/api/accounts');
  } finally {
    accountsLoading--;
  }
  if (version !== accountLoadVersion) return;
  const preserveStatus = revision !== accountStatusRevision;
  accountStatusRevision++;
  const previous = current;
  stateActions.replaceAccounts(data.accounts, data.activeId, { preserveStatus });
  renderAccountSelect();
  if (previous !== current || reload) refreshProgression();
  if (previous !== current || reload) void refreshSavedLineups();
  if (previous !== current) refreshManualWorld();
  if (previous !== current) {configAccountChanged();giftAccountChanged();}
  if (reload) {
    subscribe();
    refreshOverview();
  }
}

function selectLoadedAccount(next) {
  accountSelectionVersion++;
  if (!stateActions.selectAccount(next)) return;
  giftAccountChanged();
  configAccountChanged();
  renderAccountSelect();
  refreshProgression();
  void refreshSavedLineups();
  refreshManualWorld();
  refreshActivities();
  refreshStages();
  refreshLoop();
  subscribe();
  refreshOverview();
}

$('account').onchange = async () => {
  if (typeof accountSwitchPending !== 'undefined' && accountSwitchPending) { $('account').value = current || ''; return; }
  const next = $('account').value;
  if (!accounts.find(account => account.id === next)?.roleId) {
    const version = ++accountSelectionVersion;
    if (!await configMayChangeAccount(next) || version !== accountSelectionVersion) { $('account').value = current || ''; return; }
    selectLoadedAccount(next);
    await call('/api/accounts/active', { method: 'POST', body: JSON.stringify({ confirm: true, id: next }) });
    return;
  }
  try { await useAccountCard(next); }
  catch (error) { reportError(error); }
  finally { $('account').value = current || ''; }
};
$('account-pause').onclick = async () => {
  const account = current;
  if (!account || $('account-pause').disabled) return;
  const paused = !snapshot.paused && !(snapshot.loginBlocked && !snapshot.reconnecting)
    && !!(snapshot.looping || snapshot.reconnecting || snapshot.connected || snapshot.state === 'CONNECTING' || connectingAccounts.has(account));
  stateActions.setFlag('hosting', account, true);
  accountStatusRevision++;
  loopVersion++;
  renderHostingControl();
  try {
    if (!paused) {
      if (!await configFlush()) throw new Error('配置尚未保存，请先处理配置页的提示');
      if (current !== account || !await saveLoopInterval()) return;
    }
    if (current !== account) return;
    const status = await call('/api/accounts/pause', { method: 'POST', body: JSON.stringify(paused ? { paused: true } : { paused: false, start: true, confirm: true }) });
    if (current === account) loopVersion++;
    setAccountStatus(account, status);
    if (!status.paused) stateActions.setFlag('disconnected', account, false);
    if (current !== account) return;
    renderAccountSelect();
    refreshProgression();
    refreshManualWorld();
    refreshOverview();
    refreshLoop();
    refreshActivities();
  } catch (error) {
    if (current === account) reportError(error);
  } finally {
    stateActions.setFlag('hosting', account, false);
    if (current === account) {
      renderAccountSelect();
      refreshAccountStatuses();
      refreshLoop();
    }
  }
};

$('loop-toggle').onclick = async () => {
  const account = current;
  if (!account || $('loop-toggle').disabled) return;
  const stop = !!(snapshot.looping || snapshot.reconnecting);
  stateActions.setFlag('hosting', account, true);
  accountStatusRevision++;
  loopVersion++;
  renderHostingControl();
  try {
    if (!stop) {
      if (!await configFlush()) throw new Error('配置尚未保存，请先处理配置页的提示');
      if (current !== account || !await saveLoopInterval()) return;
    }
    if (current !== account) return;
    const data = await call('/api/loop/' + (stop ? 'stop' : 'start'), {
      method: 'POST', body: JSON.stringify({ confirm: true }),
    });
    if (current === account) loopVersion++;
    setAccountStatus(account, data.status);
    if (!stop) stateActions.setFlag('disconnected', account, false);
    if (current !== account) return;
    renderAccountSelect();
    refreshStages();
    refreshProgression();
  } catch (error) {
    if (current === account) reportError(error);
  } finally {
    stateActions.setFlag('hosting', account, false);
    if (current === account) {
      renderAccountSelect();
      refreshAccountStatuses();
      refreshLoop();
    }
  }
};

$('connect').onclick = async () => {
  const account = current;
  if (!account || connectingAccounts.has(account)) return;
  accountStatusRevision++;
  stateActions.setFlag('connecting', account, true);
  renderAccountSelect();
  try {
    await call('/api/connect', { method: 'POST' });
    stateActions.setFlag('disconnected', account, false);
    const status = accounts.find(row => row.id === account)?.status ?? {};
    setAccountStatus(account, { ...status, connected: true, state: 'READY', loginBlocked: false, reconnecting: false });
    if (account !== current) return;
    refreshManualWorld();
    refreshProgression();
    refreshOverview();
  } catch (error) {
    reportError(error);
  } finally {
    accountStatusRevision++;
    stateActions.setFlag('connecting', account, false);
    renderAccountSelect();
    void refreshAccountStatuses();
  }
};
// ---- 总览 ------------------------------------------------------------------
function renderWho(view) {
  const box = clear($('who'));
  const role = view.player || {};
  const account = view.account || {};
  const status = view.status || {};
  const items = [
    ['账号', account.title || '-'],
    ['角色', role.nickname || '-'],
    ['等级', role.level == null ? '-' : String(role.level)],
    ['战力', fmt(role.power)],
    ['区服', role.worldId == null ? '-' : (role.worldName ? role.worldName + '（' + role.worldId + '）' : String(role.worldId))],
    ['状态', connectionStatus(status)],
  ];
  for (const [k, v] of items) {
    const cellBox = el('div', 'item');
    cellBox.appendChild(el('span', 'k', k));
    cellBox.appendChild(el('span', 'v', v));
    box.appendChild(cellBox);
  }
  if (view.afk) {
    const afk = el('div', 'item');
    afk.appendChild(el('span', 'k', '闯关挂机收益'));
    const finish = view.afk.finishTime;
    const status = view.afk.capped ? '收益已满' : finish > 0 ? new Date(finish * 1000).toLocaleTimeString() + ' 满额' : '暂无计时';
    afk.appendChild(el('span', 'v', '等级 ' + (view.afk.level ?? '-') + ' · ' + status));
    box.appendChild(afk);
  }
}

function renderOverview(data) {
  stateActions.setGameData(current, 'overview', data);
  renderWho(data);

  const res = clear($('res'));
  for (const entry of data.resources || []) res.appendChild(cell(entry.icon, 18, entry.name, entry.amount == null ? '未取得' : fmt(entry.amount), false));
  if (!res.childElementCount) res.appendChild(el('span', 'dim', '暂无数据'));

}

let overviewPending = false;
async function refreshOverview() {
  if (overviewPending===current || !current || snapshot.paused || snapshot.loginBlocked || disconnected.has(current) || document.hidden || ($('tab-overview').classList.contains('hidden')&&$('tab-heroes').classList.contains('hidden')&&(!$('account-info-dialog').open||!snapshot.connected))) return;
  const account = current;
  const statusRevision = accountStatusRevision;
  overviewPending = account;
  if (!snapshot.connected) setBusy('连接中…');
  try {
    const data = await call('/api/overview');
    if (account !== current || snapshot.paused || disconnected.has(account)) return;
    if (statusRevision === accountStatusRevision) setAccountStatus(account, data.status);
    else data.status = snapshot;
    renderAccountSelect();
    renderOverview(data);
    if(!$('tab-overview').classList.contains('hidden'))maybeRefreshWorldMap();
    maybeRefreshSilicon();
    $('hint').textContent = '';
    paintConnection();
  } catch (error) {
    reportError(error, '刷新总览');
    paintConnection();
  } finally { if(overviewPending===account)overviewPending=false; }
}


// ---- 挂机 ------------------------------------------------------------------
const HERO_STATUS = { ready: '可做', done: '已完成', blocked: '不可做' };

let stageVersion = 0;
let stageAccount = null;
function stagePreferences() {
  return { maxFailures: Number($('stage-failures').value), lineupId: selectedLineupId('mainline') };
}
function renderStages(data) {
  stateActions.setGameData(current, 'stages', data);
  $('stage-start').disabled = data.running || !current;
  $('stage-stop').disabled = !data.running || data.stopping;
  $('stage-failures').disabled = data.running;
  const lineupControl = $('stage-lineup-control');
  let lineupSelect = lineupControl.querySelector('select');
  if (!lineupSelect || lineupSelect.dataset.lineupAccount !== current) {
    lineupSelect?.remove();
    lineupControl.querySelector('button')?.remove();
    lineupControl.querySelector('[data-lineup-choice-status]')?.remove();
    lineupSelect = createLineupSelect(current, 'mainline');
    lineupControl.appendChild(lineupSelect);
    lineupControl.appendChild(createLineupPreviewButton(current, lineupSelect));
    lineupControl.appendChild(createLineupChoiceStatus(current));
  }
  lineupSelect.disabled = data.running || !current;
  if (data.running) $('stage-failures').value = data.maxFailures;
  const details = data.stage ? '第 ' + data.stage + ' 关 · 已过 ' + data.wins + ' 关 · 连续失败 ' + data.failures + ' 次' : '';
  const lineupPhase = { switching: '正在切换阵容', restoring: '正在恢复原阵容', pending: '阵容待恢复', conflict: '阵容变化待确认' }[data.lineupPhase];
  $('stage-view').textContent = [data.stopping ? '正在停止，等待战报和阵容恢复' : data.running ? '自动挑战中' : data.stage ? '已停止' : '未开启', details, lineupPhase, data.reason==='尚未开启'?'':data.reason].filter(Boolean).join('　');
}
async function refreshStages() {
  if(document.hidden)return;
  if ($('tab-stages').classList.contains('hidden')) return;
  const version = ++stageVersion;
  const account = current;
  if (stageAccount !== account) {
    stageAccount = account;
    const lineupControl = $('stage-lineup-control');
    lineupControl.querySelector('select')?.remove();
    lineupControl.querySelector('button')?.remove();
    lineupControl.querySelector('[data-lineup-choice-status]')?.remove();
    const lineupSelect = createLineupSelect(account, 'mainline');
    lineupSelect.disabled = true;
    lineupControl.appendChild(lineupSelect);
    lineupControl.appendChild(createLineupPreviewButton(account, lineupSelect));
    lineupControl.appendChild(createLineupChoiceStatus(account));
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('stages:' + account)) || {}; } catch {}
    $('stage-failures').value = saved.maxFailures || 3;
    $('stage-start').disabled = $('stage-stop').disabled = true;
    $('stage-view').textContent = '正在读取状态';
  }
  if (!account) { $('stage-view').textContent = '请先选择账号'; return; }
  try {
    const data = await call('/api/stages');
    if (current === account && stageVersion === version) renderStages(data);
  } catch (error) {
    if (current === account && stageVersion === version) { reportError(error); }
  }
}
async function stageCommand(start) {
  const account = current;
  const prefs = stagePreferences();
  if (start && (!Number.isSafeInteger(prefs.maxFailures) || prefs.maxFailures < 1)) {
    reportError(new Error('失败停止次数需要填写正整数'), '主线推关');
    return;
  }
  ++stageVersion;
  $('stage-start').disabled = $('stage-stop').disabled = true;
  try {
    const data = await call('/api/stages/' + (start ? 'start' : 'stop'), {
      method: 'POST', body: JSON.stringify({ confirm: true, ...prefs }),
    });
    if (start) { try { localStorage.setItem('stages:' + account, JSON.stringify({ maxFailures: prefs.maxFailures })); } catch {} }
    if (account === current) renderStages(data);
  } catch (error) {
    if (account === current) { reportError(error); }
  } finally { refreshStages(); }
}
$('stage-start').onclick = () => stageCommand(true);
$('stage-stop').onclick = () => stageCommand(false);

let loopVersion = 0;
let loopAccount = null,loopFieldDefaults=null;
const savingTasks = new Set();
const loopIntervalSaves = new Map();
let loopSettingsRevision = null;
function setTaskSwitch(input, enabled) {
  input.setAttribute('aria-checked', String(enabled));
  input.dataset.state = enabled ? 'checked' : 'unchecked';
  input.querySelector('[data-slot=switch-thumb]').dataset.state = input.dataset.state;
}
const pirateAdvanceErrors=new Map();
const pirateFailureOptions=new Map();
function renderPirateAdvance(data) {
  if(!data)return;
  $('pirate-advance-start').disabled=data.running || !current;
  $('pirate-advance-stop').disabled=!data.running || data.stopping;
  $('pirate-manual-failures').disabled=!!data.running;
  if(data.running)$('pirate-manual-failures').value=data.maxFailures;
  $('pirate-advance-state').textContent=[data.stopping?'正在停止':data.running?'推进中':'未运行',data.target,'本次已首杀 '+data.wins+' 级 · 已用汽油 '+data.spent,pirateAdvanceErrors.get(current)||data.reason].filter(Boolean).join(' · ');
}
async function pirateAdvanceCommand(start) {
  const account=current;
  const maxFailures=Number($('pirate-manual-failures').value);
  if(start&&(!$('pirate-manual-failures').reportValidity()||!Number.isSafeInteger(maxFailures)))return;
  if(start)pirateFailureOptions.set(account,maxFailures);
  pirateAdvanceErrors.delete(account);
  if(start && !await configFlush()){reportError(new Error('海盗参数尚未保存，请先处理配置页的提示'));return;}
  if(account!==current)return;
  $('pirate-advance-start').disabled=$('pirate-advance-stop').disabled=true;
  try{const data=await call('/api/pirates/advance/'+(start?'start':'stop'),{method:'POST',body:JSON.stringify({confirm:true,...(start?{maxFailures}:{})})});if(account===current)renderPirateAdvance(data);}
  catch(error){if(account===current){pirateAdvanceErrors.set(account,error.message);$('pirate-advance-state').textContent='未启动：'+error.message;reportError(error);}}
  finally{if(account===current)refreshLoop();}
}
$('pirate-advance-start').onclick=()=>pirateAdvanceCommand(true);
$('pirate-advance-stop').onclick=()=>pirateAdvanceCommand(false);
let overviewLoopData=null,overviewLoopOwner=null,overviewRenderKey="";
function compactOverviewText(text){
 return String(text||'—').replaceAll('本次连接尚无检查结果','待检查').replaceAll('尚未同步当前条件','待同步')
   .replaceAll('当前没有可读取的万吨货轮','暂无万吨货轮').replaceAll('当前不在服务器','未到')
   .replaceAll('受总控限制：','受限：').replaceAll('当前没有新的联盟福利礼包','暂无联盟福利礼包');
}
function renderAutomationOverview(data){
 overviewLoopData=data;overviewLoopOwner=current;
 const root=$('overview-task-groups'),opened=new Set([...root.querySelectorAll('details[open]')].map(d=>d.dataset.group));
 const query=$('overview-task-search').value.trim().toLowerCase(),mode=$('overview-task-filter').value;
 const issue=t=>t.enabled&&(t.blockedBy?.length||['error','pending'].includes(t.observation?.state));
 const controls=(data.controls??[]).map(t=>({...t,group:t.group==='总控制'?'运行范围与权限':t.group}));
 const renderKey=JSON.stringify([current,data.running,query,mode,controls,data.fleetMaintenance]);if(renderKey===overviewRenderKey)return;overviewRenderKey=renderKey;
 const filterKey=JSON.stringify([current,query,mode]);
 const previousGroups=root.filterKey===filterKey?new Set([...root.children].map(s=>s.dataset.group)):new Set();
 root.filterKey=filterKey;
 const expanded=key=>previousGroups.has(key)?opened.has(key):!!query||mode==='issues'||opened.has(key);
 const focusedGroup=document.activeElement?.closest('.overview-task-group')?.dataset.group;clear(root);
 if(!Array.isArray(data.controls)){clear(root);$('overview-task-summary').textContent='未同步';return;}
 const selected=controls.filter(t=>(mode==='all'||mode==='enabled'&&t.enabled||mode==='issues'&&issue(t))&&(!query||(t.label+' '+(t.observation?.text??'')).toLowerCase().includes(query)));
 $('overview-task-summary').textContent=(data.running?'运行中':'已停止')+' · 已开 '+controls.filter(t=>t.enabled).length+' · 异常/受限 '+controls.filter(issue).length+((query||mode!=='enabled')?' · 筛出 '+selected.length:'');
 for(const group of [...new Set(selected.map(t=>t.group))]){
  const items=selected.filter(t=>t.group===group),section=el('details','overview-task-group');section.dataset.group=group;section.open=expanded(group);
  section.append(el('summary','',group+' · '+items.length+' 项'));
  section.append(table(['功能','当前进度','当前条件'],items.map(t=>[t.label,compactOverviewText(t.progress),compactOverviewText(t.condition||t.observation?.text||'待同步')])));
  root.append(section);if(group===focusedGroup)section.querySelector('summary').focus({preventScroll:true});
 }
 const maintenance=data.fleetMaintenance,repairRows=(maintenance?.rows??[]).filter(r=>(!query||('战后维修 '+r.name+' '+r.source+' '+r.condition).toLowerCase().includes(query))&&(mode!=='issues'||['waiting','unknown'].includes(r.state)));
 const maintenanceShown=maintenance&&(mode==='all'||maintenance.enabled)&&(repairRows.length||(!query||'战后维修'.includes(query))&&maintenance.reason);
 if(maintenanceShown){
  const section=el('details','overview-task-group');section.dataset.group='fleet-maintenance';section.open=expanded('fleet-maintenance');section.append(el('summary','','战后维修 · '+repairRows.length+' 队'));
  section.append(el('p','dim','沿用城战/巨轮所选舰队和自动维修参数；重复选择按调度优先级取参数。'));
  if(maintenance.reason)section.append(el('p','dim',maintenance.reason));
  if(repairRows.length)section.append(table(['舰队','当前进度','当前条件'],repairRows.map(r=>[r.name+' · '+r.source,(r.durability??'未同步')+'/'+(r.maxDura??'未同步'),maintenance.enabled?r.condition:'监控未运行；'+r.condition])));
  root.append(section);
 }
 if(!selected.length&&!maintenanceShown)root.append(el('p','dim','没有符合当前筛选的项目。'));
}
$('overview-task-search').oninput=()=>{if(overviewLoopData&&overviewLoopOwner===current)renderAutomationOverview(overviewLoopData);};
$('overview-task-filter').onchange=$('overview-task-search').oninput;
function renderLoop(data) {
  renderAutomationOverview(data);
  renderPirateAdvance(data.pirateAdvance);
  loopSettingsRevision = data.settingsRevision;
  if (snapshot.looping !== data.running || snapshot.loopStopping !== data.stopping) accountStatusRevision++;
  stateActions.patchStatus(current, { looping: data.running, loopStopping: data.stopping });
  stateActions.setGameData(current, 'loop', data);
  if (loopAccount !== current || !loopIntervalSaves.has(current) && $('loop-every').value === String(loopFieldDefaults?.seconds)) {
    $('loop-every').value = data.everyMs / 1000;
  }
  loopFieldDefaults={seconds:data.everyMs/1000};
  loopAccount = current;
  renderHostingControl();
  paintConnection();
  if (!$('tab-account').classList.contains('hidden')) renderAccounts();
  $('loop-every').disabled = !current || loopIntervalSaves.has(current);
  $('loop-hint').textContent = (data.recovery ? '网络恢复中（第 ' + data.recovery.attempt + ' 次），已完成 ' : data.running ? '后台挂机中，已完成 ' : '未在挂机，累计 ') + data.completed + ' 轮' + (data.error ? '，已中止' : '');
  if (data.stopping) $('loop-hint').textContent = '正在暂停，等待在途请求结束';
  if (data.settingsRecovery?.required) $('loop-hint').textContent = configRecoveryMessage(data.settingsRecovery, true);
  configSyncRecovery(data);
}

let loopReads = 0;
async function refreshLoop() {
  if(document.hidden)return;
  const account = current, version = ++loopVersion;
  if (loopAccount !== account || !account) {
    $('loop-hint').textContent = account ? '正在读取设置' : '请选择账号';
    if(overviewLoopOwner!==account){overviewLoopData=null;overviewLoopOwner=account;overviewRenderKey='';clear($('overview-task-groups'));$('overview-task-summary').textContent=account?'正在读取运行状态':'请先选择账号';}
    loopSettingsRevision = null;
    $('loop-every').disabled = true;
    $('loop-every').value = '';
    $('loop-every').removeAttribute('aria-invalid');
    $('loop-interval-status').textContent = '';
    $('pirate-advance-start').disabled=$('pirate-advance-stop').disabled=true;
    $('pirate-advance-state').textContent=account?'正在读取首杀状态':'请选择账号';
    $('pirate-manual-failures').value=pirateFailureOptions.get(account)??1;
  }
  if (!account) return;
  loopReads++;
  try {
    const data = await call('/api/loop');
    if (account === current && version === loopVersion) renderLoop(data);
  } catch {
    /* call 已记录错误 */
  } finally {
    loopReads--;
  }
}

async function toggleAutoTask(input) {
  const account = current, key = input.dataset.autoTask, saving = account + ':' + key;
  if (savingTasks.has(saving)) return;
  const enabled = input.getAttribute('aria-checked') !== 'true';
  savingTasks.add(saving);
  input.disabled = true;
  ++loopVersion;
  try {
    if (!await configFlush()) throw new Error('配置尚未保存，请先处理配置页的提示');
    if (account !== current) return;
    setTaskSwitch(input, enabled);
    const eventTask = Boolean(input.dataset.eventTask);
    if (eventTask) activityTaskEdits.set(saving, { enabled, pending: true, version: ++activitiesVersion });
    const updated = await call(eventTask ? '/api/loop/task' : '/api/loop/control', { method: 'POST', body: JSON.stringify({ confirm: true, key, enabled, ...(eventTask ? {} : { revision: loopSettingsRevision }) }) });
    if (eventTask) { syncActivityTask(key, enabled, account); activityTaskEdits.set(saving, { enabled, pending: false, version: ++activitiesVersion }); }
    // 草稿仍属于当前账号；configLoad 按版本刷新，不能清空 owner 后绕过未保存保护。
    if (account === current) { loopSettingsRevision = updated.settingsRevision; }
  } catch (error) { if (input.dataset.eventTask) activityTaskEdits.delete(saving); if(account===current){setTaskSwitch(input, !enabled); reportError(error);} }
  finally {
    savingTasks.delete(saving);
    if (account === current) {
      if (input.dataset.eventTask) {
        for (const toggle of document.querySelectorAll('[data-event-task]')) {
          if (toggle.dataset.autoTask !== key) continue;
          setTaskSwitch(toggle, input.getAttribute('aria-checked') === 'true');
          toggle.disabled = false;
        }
      }
      else refreshLoop();
    }
  }
}

async function saveLoopInterval() {
  const account = current, input = $('loop-every');
  if (!account || loopAccount !== account) return false;
  if (loopIntervalSaves.has(account)) return loopIntervalSaves.get(account).promise;
  const everySeconds = Number(input.value);
  if (!input.reportValidity() || !Number.isSafeInteger(everySeconds) || everySeconds < 1 || everySeconds > 86400) {
    input.setAttribute('aria-invalid', 'true');
    $('loop-interval-status').textContent = '请输入 1–86400 的整数秒数';
    return false;
  }
  input.removeAttribute('aria-invalid');
  if (everySeconds === loopFieldDefaults?.seconds) return true;
  input.disabled = true;
  $('loop-interval-status').textContent = '正在保存间隔';
  ++loopVersion;
  const pending = { writing: false, promise: null };
  loopIntervalSaves.set(account, pending);
  pending.promise = (async () => {
    try {
      if (!await configFlush()) throw new Error('配置尚未保存，请先处理配置页的提示');
      if (account !== current) return false;
      const revision = loopSettingsRevision;
      pending.writing = true;
      const updated = await call('/api/loop/interval', {
        method: 'POST', body: JSON.stringify({ confirm: true, everySeconds, revision }),
      });
      if (account === current) {
        ++loopVersion;
        input.value = String(updated.everyMs / 1000);
        configIntervalSaved(account, everySeconds, revision, updated.settingsRevision);
        renderLoop(updated);
        $('loop-interval-status').textContent = '间隔已保存，下一轮生效';
      }
      return true;
    } catch (error) {
      if (account === current) {
        input.setAttribute('aria-invalid', 'true');
        $('loop-interval-status').textContent = '间隔保存失败，请重试';
        reportError(error);
      }
      return false;
    } finally {
      loopIntervalSaves.delete(account);
      if (account === current) {
        input.disabled = false;
        refreshLoop();
      }
    }
  })();
  return pending.promise;
}
$('loop-every').onchange = saveLoopInterval;
$('loop-every').onkeydown = event => {
  if (event.key === 'Enter') { event.preventDefault(); saveLoopInterval(); }
};

let orderClockOffset=0;
function orderRefreshLabel(at){
 const left=Math.max(0,Math.ceil(at-(Date.now()+orderClockOffset)/1000));
 const time=new Date(at*1000).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
 return time+' 刷新 · '+(left?('剩余 '+Math.floor(left/60)+'分'+left%60+'秒'):'已到时，等待同步');
}
setInterval(() => {
  if (document.hidden || $('tab-manual').classList.contains('hidden')) return;
  for (const node of document.querySelectorAll('[data-order-refresh-at]')) {
    node.textContent = orderRefreshLabel(Number(node.dataset.orderRefreshAt));
  }
  updateWorldProductionTimers();
}, 1000);
function orderState(order, data) {
  const box = el('div', 'order-state');
  const decision = order.decision;
  const labels = { ready: data.idleRunning ? '等待自动交付' : '等待开启挂机', disabled: '自动交付已关闭', refreshing: '订单刷新中',
    unknown: '等待核对', missing: '材料不足', reserved: '材料已预留', reroll: '等待换单', productionSkipped: '已跳过排产' };
  const state = decision?.status ?? 'unknown';
  const label = !data.autoDeliverOrders && !['reroll','refreshing'].includes(state) ? labels.disabled : labels[state] || labels.unknown;
  box.appendChild(chip(state === 'ready' && data.idleRunning && data.autoDeliverOrders ? 'ready' : 'waiting', label));
  if(order.refreshTime>0){const time=el('span','order-refresh-time',orderRefreshLabel(order.refreshTime));time.dataset.orderRefreshAt=String(order.refreshTime);box.append(time);}
  if (decision?.reason) box.appendChild(el('span', 'dim', decision.reason));
  return box;
}

const pendingResidentOrders = new Set();
function residentOrderButton(order) {
  const account = current, key = account + ':' + order.index;
  const pending = pendingResidentOrders.has(key);
  const button = smallButton(pending ? '提交中…' : '提交订单');
  button.dataset.residentOrder = String(order.index);
  const ready = Boolean(order.orderKey) && order.manualDecision?.status === 'ready';
  button.disabled = pending || !ready || !account || snapshot.paused || disconnected.has(account);
  button.title = pending ? '账号忙时自动排队，结果见运行日志'
    : ready ? '提交这份居民订单' : order.manualDecision?.reason || '请先刷新订单状态';
  button.setAttribute('aria-label', '提交' + (order.workerName || '居民') + '的订单 #' + order.index);
  button.onclick = async () => {
    if (button.disabled || pendingResidentOrders.has(key) || current !== account || snapshot.paused || disconnected.has(account)) return;
    pendingResidentOrders.add(key);
    button.disabled = true;
    button.textContent = '提交中…';
    try {
      await call('/api/world/order/submit', { method: 'POST', body: JSON.stringify({ confirm: true, index: order.index, orderKey: order.orderKey }) });
    } catch (error) {
      if (current === account) reportError(error, '提交居民订单');
    } finally {
      pendingResidentOrders.delete(key);
      if (current === account) {
        const displayed = $('world-orders').querySelector('[data-resident-order="' + order.index + '"]');
        if (displayed) {
          displayed.disabled = true;
          displayed.textContent = '待刷新';
        }
        refreshManualWorld(true);
      }
    }
  };
  return button;
}

function residentOrderActions(order){
 const root=el('div','order-manual-actions');root.append(residentOrderButton(order));
 const account=current,key=account+':'+order.index,button=smallButton('换单');button.setAttribute('aria-label','刷新'+(order.workerName||'居民')+'的订单 #'+order.index);
 button.disabled=pendingResidentOrders.has(key)||!order.manualRefresh?.allowed||!account||snapshot.paused||disconnected.has(account);button.title=order.manualRefresh?.reason||'放弃当前需求，等待新订单';
 button.onclick=()=>{if(button.disabled||current!==account||pendingResidentOrders.has(key))return;
  openConfirm('刷新居民订单',[el('p','','确认放弃'+(order.workerName||'居民')+'的订单 #'+order.index+'并换一单？'),el('p','dim','新需求按游戏刷新时间到达，不使用付费加速。')],async()=>{
   if(current!==account||snapshot.paused||disconnected.has(account)||pendingResidentOrders.has(key))throw Error('账号或订单状态已变化，请刷新后再试');
   pendingResidentOrders.add(key);button.disabled=true;button.textContent='换单中…';
   try{await call('/api/world/order/reroll',{method:'POST',body:JSON.stringify({confirm:true,index:order.index,orderKey:order.orderKey})});}
   finally{pendingResidentOrders.delete(key);if(current===account)await refreshManualWorld(true);}
  });
 };root.append(button);return root;
}

function worldProductionTime(finishTime, readyText, activeText = '剩余 ') {
  if (!Number.isFinite(finishTime) || finishTime <= 0) return '时间未同步';
  const remaining = Math.ceil(finishTime - (Date.now() + orderClockOffset) / 1000);
  return remaining > 0 ? '（' + activeText + productionPlanDuration(remaining) + '）' : readyText;
}

function worldProductionTimer(finishTime, readyText, activeText = '剩余 ') {
  const timer = el('span', 'production-time', worldProductionTime(finishTime, readyText, activeText));
  if (Number.isFinite(finishTime) && finishTime > 0) {
    timer.dataset.productionFinishAt = String(finishTime);
    timer.dataset.productionReadyText = readyText;
    timer.dataset.productionActiveText = activeText;
  }
  return timer;
}

function updateWorldProductionTimers() {
  for (const node of document.querySelectorAll('[data-production-finish-at]')) {
    node.textContent = worldProductionTime(Number(node.dataset.productionFinishAt),
      node.dataset.productionReadyText, node.dataset.productionActiveText);
  }
}

function factoryProductionQueue(factory) {
  if (!Array.isArray(factory.jobs) || factory.queueKnown === false) {
    return el('span', 'dim', '生产队列未同步');
  }
  const queue = el('div', 'factory-queue');
  queue.setAttribute('aria-label', factory.buildingId + '生产格');
  const capacity = Number.isInteger(factory.capacity) && factory.capacity > 0 ? factory.capacity : 0;
  const count = Math.max(factory.jobs.length, capacity);
  for (let index = 0; index < count; index++) {
    const job = factory.jobs[index];
    const slot = el('div', 'factory-slot');
    slot.appendChild(el('span', 'dim', '格子 ' + (index + 1)));
    if (job) {
      slot.appendChild(el('span', 'factory-product', job.name || job.productId || '产物未同步'));
      slot.appendChild(job.finishTime > 0
        ? worldProductionTimer(job.finishTime, '已完成 · 待收取')
        : el('span', 'dim', '等待生产'));
    } else {
      slot.appendChild(el('span', 'dim', '空闲'));
    }
    queue.appendChild(slot);
  }
  if (!capacity) queue.appendChild(el('span', 'dim', '生产格数量未同步'));
  return queue;
}

function updateFactoryProductionDialog(factory) {
  $('factory-production-dialog').dataset.factoryId = factory.buildingId;
  $('factory-production-title').textContent = factory.buildingId + ' · 排产详情';
  clear($('factory-production-body')).appendChild(factoryProductionQueue(factory));
}

function showFactoryProduction(factory) {
  updateFactoryProductionDialog(factory);
  const dialog = $('factory-production-dialog');
  if (!dialog.open) dialog.showModal();
  $('factory-production-close').focus();
}

function closeFactoryProduction() {
  const dialog = $('factory-production-dialog');
  if (dialog.open) dialog.close();
}

$('factory-production-close').onclick = closeFactoryProduction;
$('factory-production-dialog').onclose = () => {
  const dialog = $('factory-production-dialog');
  if (dialog.open) return;
  const factoryId = dialog.dataset.factoryId;
  delete dialog.dataset.factoryId;
  clear($('factory-production-body'));
  const trigger = [...document.querySelectorAll('[data-factory-production]')]
    .find(button => button.dataset.factoryProduction === factoryId);
  (trigger || $('world-plan')).focus();
};

function factoryCurrentProduction(factory) {
  if (!Array.isArray(factory.jobs) || factory.queueKnown === false) {
    return el('span', 'dim', '生产队列未同步');
  }
  const current = el('div', 'factory-current');
  const now = (Date.now() + orderClockOffset) / 1000;
  const active = factory.jobs.filter(job => job.finishTime > now);
  for (const job of active) {
    const product = el('div', 'factory-current-product');
    product.append(el('span', null, job.name || job.productId || '产物未同步'),
      worldProductionTimer(job.finishTime, '已完成 · 待收取'));
    current.appendChild(product);
  }
  if (!active.length) {
    const completed = factory.jobs.find(job => job.finishTime > 0 && job.finishTime <= now);
    const status = completed ? (completed.name || completed.productId || '产物未同步') + ' · 已完成 · 待收取'
      : factory.jobs.length ? '等待开工' : '空闲';
    current.appendChild(el('span', 'dim', status));
  }
  if (!factory.jobs.length) return current;
  const button = smallButton('查看排产（' + factory.jobs.length + '）');
  button.type = 'button';
  button.dataset.factoryProduction = factory.buildingId;
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-controls', 'factory-production-dialog');
  button.setAttribute('aria-label', factory.buildingId + '查看排产');
  button.onclick = () => showFactoryProduction(factory);
  current.appendChild(button);
  return current;
}

function renderWorld(data) {
  stateActions.setGameData(current, 'world', data);
  orderClockOffset=Number.isFinite(data.serverNow)?data.serverNow*1000-Date.now():0;
  $('world-view').textContent = '';
  const fbox = clear($('world-factories'));
  if (data.factories?.length) {
    fbox.appendChild(el('h2', null, '工厂'));
    const factories = [...data.factories].sort((a, b) => a.buildingId.localeCompare(b.buildingId, 'zh-CN', { numeric: true }));
    const factoryTable = table(['建筑', '类型', '等级', '当前产物', '自动生产', '下一产物'], factories.map((b) => {
      const queueKnown = b.queueKnown !== false && Array.isArray(b.jobs);
      const next = queueKnown ? b.jobs.find(job => !(job.finishTime > 0)) : null;
      return [
        { cell: b.icon, text: b.buildingId },
        b.typeName || b.type,
        'lv' + b.level,
        factoryCurrentProduction(b),
        b.autoEnabled == null ? '未同步' : b.autoEnabled ? '已开启' : '未开启',
        !queueKnown ? '未同步' : next ? next.name || next.productId || '产物未同步' : '—',
      ];
    }));
    factoryTable.classList.add('factory-table');
    fbox.appendChild(factoryTable);
  }
  const productionDialog = $('factory-production-dialog');
  if (productionDialog.open) {
    const factory = data.factories?.find(row => row.buildingId === productionDialog.dataset.factoryId);
    if (factory) updateFactoryProductionDialog(factory);
    else closeFactoryProduction();
  }
  if (data.farms?.length) {
    fbox.appendChild(el('h2', null, '农田'));
    const plots = [...data.farms].sort((a, b) => a.plot.localeCompare(b.plot, 'zh-CN', { numeric: true }));
    fbox.appendChild(table(['农田', '等级', '当前作物', '状态与计时'], plots.map((plot) => {
      let status = plot.status || '未同步';
      if (plot.productId && plot.ripeTime > 0) {
        status = worldProductionTimer(plot.ripeTime, '已成熟', '生长中 · 剩余 ');
      } else if (plot.state === 'building' && plot.finishTime > 0) {
        status = worldProductionTimer(plot.finishTime, '待竣工', '建造中 · 剩余 ');
      } else if (plot.productId) {
        status = '成熟时间未同步';
      }
      return [plot.plot, plot.level == null ? '未同步' : 'lv' + plot.level,
        plot.productName || plot.productId || '—', status];
    })));
  }
  // 空位：没盖的（待建）与正在盖的（施工中）。计划器只会建「待建」那些，
  // 施工中的只能等它盖完由竣工步骤收尾，所以两种状态要分开说，不然看不出差在哪。
  const slots = (data.buildings || []).filter((b) => b.level === 0);
  if (slots.length) {
    fbox.appendChild(el('h2', null, '空位'));
    fbox.appendChild(table(['空位', '类型', '状态'], slots.map((b) => [
      { cell: b.icon, text: b.buildingId },
      b.typeName || b.type || '未知类型',
      b.building ? chip('waiting', '施工中') : b.awaitingFinish ? chip('ready', '待竣工') : chip('ready', '待建'),
    ])));
  }
  const obox = clear($('world-orders'));
  if (data.orders.length) {
    obox.appendChild(el('h2', null, '居民订单'));
    obox.appendChild(el('p', 'dim', '可手动提交材料已齐的订单。账号忙时自动排队，交付结果见运行日志。'));
    obox.appendChild(table(['订单', '居民', '需求', '挂机交付', '手动操作'], data.orders.map((o) => [
      '#' + o.index,
      { cell: o.workerIcon, text: (o.workerName || '未知居民') + (o.isSpecial ? '（特殊）' : '') },
      o.requirements.length && o.decision?.status !== 'refreshing' ? { cells: o.requirements } : '—',
      orderState(o, data),
      residentOrderActions(o),
    ])));
  }
  renderInventory(data.stock);
  const fields=clear($('world-fields'));fields.append(el('p','dim','已占资源田 '+(data.resFields.fields?.length??'?')+'/'+(data.resFields.maxNum??'?')));
  const yields=el('div','field-yield-summary');yields.setAttribute('aria-label','资源田每小时基础总产量');for(const item of data.resFields.totals??[])yields.append(el('span','',item.name+' '+(item.perHour===null?'未同步':fmt(item.perHour)+'/小时')));fields.append(yields);
  if(data.resFields.rows?.length)fields.append(table(['建筑','产出','等级'],data.resFields.rows.map(r=>[r.name+' · '+r.cityName,r.product,r.level??'未同步'])));
  else fields.append(el('p','dim',data.resFields.fields?.length?'资源田信息未同步，请重新加载服务':'暂无已占资源田'));
  fields.append(el('p','dim','产出为每小时基础值，不含科技及其他加成。'));
}

let worldVersion = 0, worldRead = null, displayedWorldAccount;
function refreshManualWorld(force = false) {
  if (force) { worldVersion++; worldRead = null; }
  if ($('tab-manual').classList.contains('hidden')&&$('tab-inventory').classList.contains('hidden')) return;
  const account = current;
  const available = account && !snapshot.paused && !disconnected.has(account);
  if (displayedWorldAccount !== account || !available) {
    closeFactoryProduction();
    $('inventory-status').textContent='正在读取库存';
    displayedWorldAccount = account;
    resetInventory();
    worldVersion++;
    worldRead = null;
    for (const id of ['world-factories', 'world-orders', 'world-stock', 'world-fields', 'world-hint']) clear($(id));
    $('world-view').textContent = !account ? '请先选择账号' : !available ? '账号已断开连接' : '正在读取海面数据…';
  }
  if (!available || worldRead?.account === account) return;
  const version = ++worldVersion;
  worldRead = { account, version };
  $('world-hint').textContent = '正在读取…';
  call('/api/world?speedUp=' + isChecked($('world-speedup'))).then(data => {
    if (version === worldVersion && current === account) renderWorld(data);
  }).catch(error => {
    if (version === worldVersion && current === account) {
      $('inventory-status').textContent='库存读取失败，请重试';
      $('world-view').textContent = '海面数据读取失败，可点「刷新数据」重试。';
      reportError(error);
    }
  }).finally(() => {
    if (worldRead?.version === version) worldRead = null;
    if (version === worldVersion) $('world-hint').textContent = '';
  });
}
$('inventory-refresh').onclick=()=>refreshManualWorld(true);
$('world-plan').onclick = () => refreshManualWorld();
$('world-speedup').onclick = () => { setTaskSwitch($('world-speedup'), !isChecked($('world-speedup'))); refreshManualWorld(true); };
bindGameAction('world-run', async () => {
  const account = current;
  $('world-hint').textContent = '执行中 ...';
  try {
    const body = { confirm: true, speedUp: isChecked($('world-speedup')), reroll: isChecked($('world-reroll')) };
    const data = await call('/api/world/run', { method: 'POST', body: JSON.stringify(body) });
    if (account !== current || disconnected.has(account)) return;
    worldVersion++;
    $('world-hint').textContent = '执行 ' + data.results.length + ' 个动作，失败 ' + data.results.filter((r) => r.ok === false).length;
    if (!data.refreshError) renderWorld(data);
  } catch (error) {
    $('world-hint').textContent = '';
    reportError(error);
  }
});

// ---- 表格 ------------------------------------------------------------------
// 单元格可以是字符串、{num}、{chip}、{cell: 图标项}、{cells: [图标项]}
function putCell(td, spec) {
  if (spec == null) return;
  if (spec instanceof Node) {
    td.appendChild(spec);
    return;
  }
  if (typeof spec !== 'object') {
    td.textContent = spec;
    return;
  }
  if (spec.num) {
    td.classList.add('num');
    td.textContent = spec.text;
    return;
  }
  if (spec.chip) {
    td.appendChild(chip(spec.chip, spec.text));
    return;
  }
  if ('cell' in spec || spec.cells) {
    const list = spec.cells ?? [{ name: spec.text, icon: spec.cell }];
    if (spec.prefix) td.appendChild(el('span', 'dim', spec.prefix));
    for (const entry of list) {
      const who = el('span', 'who-cell');
      if (entry?.icon) who.appendChild(iconEl(entry.icon, 26, entry.name));
      who.appendChild(el('span', null, entry ? entry.name + (entry.num != null ? ' x' + fmt(entry.num) : '') : spec.text));
      td.appendChild(who);
      td.appendChild(document.createTextNode(' '));
    }
    if (!list.length) td.appendChild(el('span', 'dim', '齐'));
    return;
  }
  td.textContent = spec.text || '';
}

${activitiesScript}

function table(headers, rows) {
  const box = component('ui-table');
  const head = box.querySelector('thead tr');
  const headCell = head.firstElementChild;
  headCell.remove();
  for (const h of headers) {
    const th = headCell.cloneNode(false);
    th.textContent = typeof h === 'string' ? h : h.label;
    if (h.num) th.classList.add('num');
    head.appendChild(th);
  }
  const body = box.querySelector('tbody');
  const rowTemplate = body.firstElementChild;
  const cellTemplate = rowTemplate.firstElementChild;
  rowTemplate.remove();
  const labels = headers.map(h => typeof h === 'string' ? h : h.label);
  if (labels.length >= 4) box.classList.add('table-stack');
  for (const row of rows) {
    const tr = rowTemplate.cloneNode(false);
    row.forEach((spec, index) => {
      const td = cellTemplate.cloneNode(false);
      td.dataset.label = labels[index] ?? '';
      putCell(td, spec);
      tr.appendChild(td);
    });
    body.appendChild(tr);
  }
  return box;
}

// ---- 账号页 ----------------------------------------------------------------
${accountBackupScript}
${roleRotationScript}
function accountChannel(source) {
  return { alipay: '支付宝', phone: '益世界 APP', douyin: '抖音小游戏', 'douyin-mitm': '抖音小游戏', mitm: '微信小游戏', wechat: '微信小游戏' }[source] || '已导入账号';
}

var accountSwitchPending = null;
async function useAccountCard(id) {
  if (accountSwitchPending) return false;
  const version = ++accountSelectionVersion;
  if (id === current) return true;
  if (!await configMayChangeAccount(id) || version !== accountSelectionVersion) return false;
  const account = accounts.find(row => row.id === id);
  const connect = Boolean(account?.roleId && !account.status?.paused);
  accountSwitchPending = connect ? id : null;
  if (connect) stateActions.setFlag('connecting', id, true);
  if (connect) $('account-worlds-notice').textContent = '正在切换到 ' + account.title + '…';
  renderAccountSelect();
  try {
    const data = await call('/api/accounts/active', { method: 'POST', body: JSON.stringify({ confirm: true, id, ...(account?.roleId ? { connect } : {}) }) });
    if (version !== accountSelectionVersion) return false;
    if (data.status) setAccountStatus(id, data.status);
    selectLoadedAccount(id);
    await loadAccounts(false);
    if (connect) $('account-worlds-notice').textContent = '已切换到 ' + (data.account?.title || account.title);
    renderAccounts();
    return true;
  } catch (error) {
    if (connect) $('account-worlds-notice').textContent = '切换失败：' + error.message;
    throw error;
  } finally {
    if (accountSwitchPending === id) accountSwitchPending = null;
    if (connect) stateActions.setFlag('connecting', id, false);
    renderAccountSelect();
    void refreshAccountStatuses();
  }
}

async function toggleAccountCardLoop(id) {
  const account = accounts.find(row => row.id === id);
  if (!account || hostingActions.has(id)) return;
  const status = id === current ? snapshot : account.status ?? {};
  const stop = !!(status.looping || status.reconnecting);
  if (status.loopStopping || (!stop && id === current && loopAccount !== id)) return;
  stateActions.setFlag('hosting', id, true);
  accountStatusRevision++;
  if (id === current) loopVersion++;
  renderAccountSelect();
  try {
    if (!stop && id === current) {
      if (!await configFlush()) throw new Error('配置尚未保存，请先处理配置页的提示');
      if (current !== id || !await saveLoopInterval() || current !== id) return;
    }
    if (!accounts.some(row => row.id === id)) return;
    const data = await call((stop ? '/api/loop/stop' : '/api/accounts/pause') + '?account=' + encodeURIComponent(id), {
      method: 'POST', body: JSON.stringify(stop ? { confirm: true } : { confirm: true, paused: false, start: true }),
    });
    if (id === current) loopVersion++;
    setAccountStatus(id, stop ? data.status : data);
    if (!stop) stateActions.setFlag('disconnected', id, false);
    if (id === current) {
      refreshStages();
      refreshProgression();
    }
  } catch (error) {
    reportError(error);
  } finally {
    stateActions.setFlag('hosting', id, false);
    renderAccountSelect();
    refreshAccountStatuses();
    if (id === current) refreshLoop();
  }
}

function createAccountCard(id) {
  const card = component('ui-account-card');
  card.accountId = id;
  const action = name => card.querySelector('[data-account-action="' + name + '"]');
  action('select').onclick = () => useAccountCard(id).catch(reportError);
  action('loop').onclick = () => toggleAccountCardLoop(id);
  action('login-settings').onclick = () => {
    if (accounts.some(account => account.id === id)) stateActions.setView({ loginSettingsAccountId: id });
  };
  action('details').onclick = async () => {
    if (!await useAccountCard(id)) return;
    const account = accounts.find(row => row.id === id);
    if (!account || current !== id) return;
    $('account-info-title').textContent = (account.label || account.lastSeen?.nickname || account.title) + ' · 账号详情';
    renderWho({ account, player: account.lastSeen, status: snapshot });
    if (!snapshot.connected) $('res').textContent = '连接后读取资源';
    $('account-info-dialog').showModal();
    $('account-info-close').focus();
    if (snapshot.connected) void refreshOverview();
  };
  action('rename').onclick = async () => {
    card.querySelector('details').open = false;
    const account = accounts.find(row => row.id === id);
    if (!account) return;
    const label = await accountDialog('修改账号备注', account.lastSeen?.nickname || account.title, account.label ?? '');
    if (label == null) return;
    await call('/api/accounts/label', { method: 'POST', body: JSON.stringify({ confirm: true, id, label }) });
    await loadAccounts(false);
    renderAccounts();
  };
  action('export').onclick = () => {
    card.querySelector('details').open = false;
    return exportAccounts(id);
  };
  action('remove').onclick = async () => {
    card.querySelector('details').open = false;
    const account = accounts.find(row => row.id === id);
    if (!account || await accountDialog('删除本机账号', '删除「' + account.title + '」保存在本机的账号？') === null) return;
    await call('/api/accounts/remove', { method: 'POST', body: JSON.stringify({ confirm: true, id }) });
    await loadAccounts(true);
    renderAccounts();
  };
  return card;
}

function renderAccounts() {
  $('export-accounts').disabled = !accounts.length;
  const loginCount = new Set(accounts.map(account => account.loginAccountId || account.id)).size;
  $('account-count').textContent = accounts.some(account => account.roleId)
    ? loginCount + ' 个登录账号 · ' + accounts.length + ' 个区服角色' : accounts.length + ' 个账号';
  const box = $('accounts');
  if (!accounts.length) {
    if (!box.querySelector('.account-empty')) {
      clear(box);
      const empty = el('div', 'account-empty');
      empty.append(el('h3', null, '添加第一个游戏账号'), el('p', 'dim', '点击「添加账号」登录，或通过「导入账号」恢复备份。'));
      box.appendChild(empty);
    }
    return;
  }
  const cards = new Map(Array.from(box.children).map(card => [card.accountId, card]));
  for (const card of Array.from(box.children)) {
    if (!accounts.some(account => account.id === card.accountId)) card.remove();
  }
  accounts.forEach((account, index) => {
    const card = cards.get(account.id) || createAccountCard(account.id);
    const status = account.id === current ? snapshot : account.status ?? {};
    const seen = account.lastSeen;
    const fields = {
      title: account.roleId ? account.title : account.label || seen?.nickname || account.title,
      channel: accountChannel(account.source),
      status: connectingAccounts.has(account.id) ? '连接中…' : connectionStatus(status),
      role: seen?.nickname || '待连接读取',
      world: (account.bornWorldName && account.bornWorldId !== seen?.worldId
        ? account.bornWorldName + ' → ' + (seen?.worldName || '合服后区服') : seen?.worldName) || '待连接读取',
      level: seen?.level == null ? '—' : String(seen.level),
      power: seen?.power == null ? '—' : fmt(seen.power),
      seen: seen?.at ? '更新于 ' + when(seen.at) : '连接后更新角色资料',
    };
    for (const [name, value] of Object.entries(fields)) {
      const field = card.querySelector('[data-account-field="' + name + '"]');
      if (field.textContent !== value) field.textContent = value;
    }
    card.querySelector('[data-account-field="role"]').parentNode.hidden = fields.title === fields.role;
    card.classList.toggle('on', account.id === current);
    card.querySelector('[data-account-field="current"]').hidden = account.id !== current;
    const badge = card.querySelector('[data-account-field="status"]');
    badge.classList.remove('done', 'waiting', 'blocked');
    badge.classList.add(connectionStatusKind(status, connectingAccounts.has(account.id)));
    const select = card.querySelector('[data-account-action="select"]');
    select.disabled = account.id === current || Boolean(accountSwitchPending);
    select.textContent = accountSwitchPending === account.id ? '切换中…' : account.id === current
      ? account.roleId ? '当前区服' : '当前账号' : account.roleId ? '切换区服' : '切换账号';
    const loop = card.querySelector('[data-account-action="loop"]');
    const running = status.looping || status.reconnecting;
    loop.disabled = hostingActions.has(account.id) || !!status.loopStopping || (!running && account.id === current && loopAccount !== current);
    loop.textContent = status.loopStopping ? '暂停中…' : hostingActions.has(account.id) ? '处理中…' : running ? '暂停挂机' : '开始挂机';
    loop.title = running ? '停止此账号自动循环，保留游戏连接和手动操作' : '按此账号已保存的任务持续挂机，直到手动暂停';
    if (box.children[index] !== card) box.insertBefore(card, box.children[index] || null);
  });
}

$('account-info-close').onclick = () => $('account-info-dialog').close();
$('account-info-refresh').onclick = async () => {
  if ($('account-info-refresh').disabled) return;
  const owner = current;
  $('account-info-refresh').disabled = true;
  try {
    if (!snapshot.connected) await $('connect').onclick();
    if (owner === current && snapshot.connected) await refreshOverview();
  } finally {
    renderAccountSelect();
  }
};

async function renderWorlds() {
  const owner=current;
  const data = await call('/api/worlds');
  if(owner!==current)return;
  await loadAccounts(false);
  if(owner!==current)return;
  const box = clear($('worlds'));
  for (const world of data.recentWorlds) {
    const role = world.role || {};
    const row = el('div', 'acct');
    const top = el('div', 'top');
    top.appendChild(el('span', 'title', world.worldName ? world.worldName + '（' + world.worldId + '）' : String(world.worldId)));
    if (role.worldId && role.worldId !== world.worldId) top.appendChild(el('span', 'id', '合服后 -> ' + (role.worldName ? role.worldName + '（' + role.worldId + '）' : role.worldId)));
    top.appendChild(el('span', 'id', (role.nickname || '') + ' lv' + (role.level ?? '') + ' 战力' + fmt(role.power) + ' 上次登录 ' + when(role.lastLoginTime)));
    const enter = smallButton('进入');
    enter.onclick = () => enterWorld(world.worldId);
    top.appendChild(enter);
    row.appendChild(top);
    box.appendChild(row);
  }
  if (!data.recentWorlds.length) box.appendChild(el('div', 'dim', '这个账号下没有区服'));
  else box.appendChild(el('div', 'dim', '共 ' + data.recentWorlds.length + ' 个区服，分组 ' + data.latestGroupId));
}

async function enterWorld(worldId) {
  if (accountSwitchPending) return;
  const owner=current;
  const account = accounts.find(row => row.id === owner);
  const target = accounts.find(row => row.loginAccountId === account?.loginAccountId && row.bornWorldId === worldId);
  if (!await configMayChangeAccount(target?.id || owner + ':world:' + worldId) || owner !== current) return;
  accountSwitchPending = owner;
  $('enter-world').disabled = true;
  $('load-worlds').disabled = true;
  $('worlds-hint').textContent = '进入 ' + worldId + ' ...';
  try {
    const data = await call('/api/worlds/enter', { method: 'POST', body: JSON.stringify({ confirm: true, worldId, fromWorldId: 0 }) });
    if(owner!==current)return;
    const role = data.player || {};
    await loadAccounts(false);
    if (data.activeId && accounts.some(account => account.id === data.activeId)) selectLoadedAccount(data.activeId);
    $('worlds-hint').textContent = '已在 ' + (role.worldName || role.worldId || worldId) + '：' + (role.nickname || '') + ' lv' + (role.level ?? '') + ' 战力' + fmt(role.power);
    renderAccounts();
    refreshOverview();
  } catch (error) {
    $('worlds-hint').textContent = '';
    reportError(error);
  } finally {
    accountSwitchPending = null;
    $('enter-world').disabled = false;
    $('load-worlds').disabled = false;
    renderAccountSelect();
  }
}

var accountWorldsPending = false;
$('refresh-account-worlds').onclick = async () => {
  if (accountWorldsPending) return;
  accountWorldsPending = true;
  $('refresh-account-worlds').disabled = true;
  $('account-worlds-notice').textContent = '正在读取各账号已有的区服角色…';
  const loginAccounts = [...new Map(accounts.map(account => [account.loginAccountId || account.id, account])).values()];
  try {
    const results = await Promise.allSettled(loginAccounts.map(account => call('/api/worlds?account=' + encodeURIComponent(account.id))));
    await loadAccounts(false);
    const failures = results.filter(result => result.status === 'rejected');
    $('account-worlds-notice').textContent = failures.length
      ? '区服列表已更新，' + failures.length + ' 个账号读取失败，可再次刷新重试。' : '已有区服角色已分别展示。';
  } catch (error) {
    reportError(error);
  } finally {
    accountWorldsPending = false;
    $('refresh-account-worlds').disabled = false;
  }
};

$('load-worlds').onclick = async () => {
  $('worlds-hint').textContent = '加载中 ...';
  try {
    await renderWorlds();
    $('worlds-hint').textContent = '';
  } catch (error) {
    $('worlds-hint').textContent = '';
    reportError(error);
  }
};
$('enter-world').onclick = () => {
  const worldId = Number($('world-input').value.trim());
  if (!worldId) {
    $('worlds-hint').textContent = '先填 worldId';
    return;
  }
  enterWorld(worldId);
};

// ---- 添加账号：从电脑微信采集登录 -----------------------------------------
let capturePoll = null;
let captureView = null;
let captureOwner = null;
let captureFlowVersion = 0;
let captureActionBusy = false;
let captureConfirmation = false;

function renderCapture(state) {
  captureView = state;
  const hint = $('cap-hint');
  const previousQr = $('cap-box').querySelector('img');
  const box = clear($('cap-box'));
  const recovery = state.recovery;
  const cleanupPending = state.phase === 'error' || recovery?.pending;
  $('cap-start').disabled = captureActionBusy || state.running || cleanupPending;
  $('cap-douyin').disabled = captureActionBusy || state.running || cleanupPending;
  $('cap-stop').disabled = captureActionBusy || (!state.running && state.phase !== 'error');
  $('cap-stop').hidden = !state.running && state.phase !== 'error';
  $('cap-recover').hidden = !recovery?.pending;
  $('cap-recover').disabled = captureActionBusy || state.running || !recovery?.recoverable;
  const ownResult = captureOwner?.startedAt && captureOwner.startedAt === state.startedAt;
  const phase = cleanupPending || state.error ? 'error' : state.running ? state.phase : ownResult && state.accountId ? 'saved' : 'entry';
  const messages = { starting: '正在准备登录采集…', ca: '请完成 Windows 证书安装提示。', listening: '正在准备本机登录通道…', proxy: '正在准备本机登录通道…', waiting: '请在电脑客户端中重新打开游戏。', captured: '已读取账号，正在完成验证和清理…', stopping: '正在恢复本机代理和证书设置…', saved: '账号已添加。可关闭此窗口，在账号卡片中查看角色和运行状态。', entry: '' };
  hint.textContent = state.error ? cleanupPending ? '采集清理未完成，请点击「停止读取」重试。' : '本次读取失败，请重新开始或查看运行日志。' : messages[phase] || '';
  hint.className = state.error ? 'bad' : 'warn';
  if (recovery?.pending) {
    hint.textContent = recovery.error ? '本机设置尚未恢复，请重试恢复上次采集残留。' : '检测到上次采集残留，请先恢复原代理和本次安装的证书。';
    hint.className = recovery.error ? 'bad' : 'warn';
  }
  const notice = $('account-add-notice');
  notice.hidden = !state.running && !cleanupPending;
  notice.textContent = notice.hidden ? '' : state.platform === 'douyin'
    ? '电脑抖音账号添加尚未完成，请点击「添加账号」并选择「电脑抖音采集」继续处理。'
    : '微信账号添加尚未完成，请点击「添加账号」并选择对应渠道继续处理。';

  if (!state.running && !cleanupPending && phase !== 'saved') {
    const clientName = accountAddChannel() === 'douyin' ? '抖音' : '微信';
    const steps = el('ol', 'steps');
    for (const text of ['先登录电脑版' + clientName + '。', '点击「开始读取」，按提示完成本机登录通道的准备。', '从电脑' + clientName + '重新打开《疯狂水世界》，等待读取角色并自动保存。']) {
      steps.appendChild(el('li', null, text));
    }
    box.appendChild(steps);
  }

  if (state.running) {
    const steps = el('ol', 'steps');
    const lines = [
      '先登录电脑版' + (state.platform === 'douyin' ? '抖音' : '微信') + '，再从该客户端打开《疯狂水世界》',
      '如果游戏已经打开，请完全退出后重新进入，让它重新发送登录请求',
      '捕获后保存凭证，并尝试读取角色验证登录；验证失败会显示在日志中',
      '完成、失败或等待超时后会自动恢复代理，只移除本次新安装的证书',
    ];
    for (const text of lines) steps.appendChild(el('li', null, text));
    const qr = el('div', 'qr');
    const side = el('div', null, '');
    if (state.platform !== 'douyin' && state.qr && state.qr.kind === 'image') {
      const img=previousQr?.dataset.url===state.qr.url?previousQr:el('img');
      if(!img.dataset.url){img.dataset.url=state.qr.url;img.src=state.qr.url+'?t='+Date.now();}
      img.alt = '游戏入口码（非扫码登录授权）';
      qr.appendChild(img);
    }
    if (state.platform !== 'douyin') side.appendChild(el('div', 'dim', state.qr?.note || '请在电脑微信中打开游戏。'));
    side.appendChild(steps);
    qr.appendChild(side);
    box.appendChild(qr);

  }
  if (typeof accountAddChanged === 'function') {
    const selectedChannel = accountAddChannel();
    const channel = ['wechat', 'douyin'].includes(selectedChannel) ? selectedChannel : state.platform === 'douyin' ? 'douyin' : 'wechat';
    accountAddChanged(channel, phase, { busy: captureActionBusy });
  }
}

async function pollCapture() {
  const version = captureFlowVersion;
  try {
    const state = await call('/api/capture');
    if (version !== captureFlowVersion) return;
    renderCapture(state);
    if (state.running && !capturePoll && accountAddChannel() === state.platform) {
      capturePoll = setInterval(pollCapture, 1500);
    }
    if (!state.running && capturePoll) {
      clearInterval(capturePoll);
      capturePoll = null;
      await loadAccounts(false);
      renderAccounts();
    }
  } catch (error) {
    if (version !== captureFlowVersion) return;
    $('cap-hint').textContent = '';
    reportError(error);
  }
}


$('cap-start').onclick = () => beginCapture('wechat');
$('cap-douyin').onclick = () => beginCapture('douyin');
$('cap-recover').onclick = async () => {
  if (captureActionBusy) return;
  captureActionBusy = true;
  if (captureView) renderCapture(captureView);
  try {
    renderCapture(await call('/api/capture/recover', { method: 'POST', body: JSON.stringify({ confirm: true }) }));
  } catch (error) {
    reportError(error);
    await pollCapture();
  } finally {
    captureActionBusy = false;
    if (captureView) renderCapture(captureView);
  }
};
async function beginCapture(platform) {
  if (captureActionBusy || accountAddChannel() !== platform) return;
  const version = captureFlowVersion;
  captureActionBusy = true;
  accountAddChanged(platform, 'starting', { busy: true });
  let state;
  try {
    state = await call('/api/capture');
    if (version !== captureFlowVersion || accountAddChannel() !== platform) return;
    renderCapture(state);
  } catch (error) {
    $('cap-hint').textContent = '';
    reportError(error);
    return;
  } finally {
    captureActionBusy = false;
    if (captureView) renderCapture(captureView);
    accountAddChanged(platform, 'entry', { busy: false });
  }
  if (state.running || state.phase === 'error' || state.recovery?.pending) return;
  const body = [
    el('div', null, '抓包只做两处「仅当前用户」的改动，抓到账号后立刻自动还原：'),
    el('div', null, '1. 若缺少证书，Windows 会打开导入向导，目标已选定为当前用户的“受信任的根证书颁发机构”。点击“完成”；若出现安全警告，核对 CrazyWaterWorld Local Test CA 后选择“是”。'),
    el('div', null, '2. 临时使用本机代理读取本游戏的登录信息，结束后恢复原代理设置。'),
    el('div', null, '使用系统代理的其他程序也会临时经过本机代理，工具仅解密本游戏网关，结束后恢复原设置。随时可点「停止读取」。'),
    el('div', null, '采集就绪后，请只在电脑' + (platform === 'douyin' ? '抖音' : '微信') + '里重新打开《疯狂水世界》。'),
    el('div', null, '捕获后会尝试连接游戏验证角色，可能让正在运行的游戏掉线一次。'),
  ];
  captureConfirmation = true;
  openConfirm('开始抓包（将修改当前用户的系统设置）', body, async () => {
    captureConfirmation = false;
    if (version !== captureFlowVersion || accountAddChannel() !== platform || captureActionBusy) return;
    captureActionBusy = true;
    captureOwner = { platform, startedAt: null, previousStartedAt: state.startedAt };
    accountAddChanged(platform, 'starting', { busy: true });
    try {
      const next = await call('/api/capture/start', { method: 'POST', body: JSON.stringify({ confirm: true, platform }) });
      captureOwner.startedAt = next.startedAt;
      renderCapture(next);
      if (capturePoll) clearInterval(capturePoll);
      if (next.running) capturePoll = setInterval(pollCapture, 1500);
      else { await loadAccounts(false); renderAccounts(); }
    } catch (error) {
      if (/已经在抓包/.test(error.message)) captureOwner = null;
      await pollCapture();
      throw error;
    } finally {
      captureActionBusy = false;
      if (captureView) renderCapture(captureView);
      else accountAddChanged(platform, 'error', { busy: false });
    }
  });
}

async function stopAccountCapture() {
  if (captureActionBusy) return false;
  captureActionBusy = true;
  if (captureView) renderCapture(captureView);
  try {
    const state = await call('/api/capture/stop', { method: 'POST', body: JSON.stringify({ confirm: true }) });
    renderCapture(state);
    if (state.running || state.phase === 'error' || state.recovery?.pending) throw new Error(state.error || '采集清理未完成，请重试停止。');
    clearInterval(capturePoll);
    capturePoll = null;
    await loadAccounts(false);
    renderAccounts();
    return true;
  } finally {
    captureActionBusy = false;
    if (captureView) renderCapture(captureView);
  }
}
$('cap-stop').onclick = stopAccountCapture;

async function resetAccountAddCapture() {
  if (captureActionBusy) return false;
  captureActionBusy = true;
  captureFlowVersion++;
  clearInterval(capturePoll);
  capturePoll = null;
  if (captureConfirmation && $('modal').open) closeModal();
  captureConfirmation = false;
  try {
    if (captureView) renderCapture(captureView);
    if (captureOwner) {
      const state = await call('/api/capture');
      const ownRun = captureOwner.startedAt ? state.startedAt === captureOwner.startedAt
        : state.platform === captureOwner.platform && state.startedAt !== captureOwner.previousStartedAt;
      captureActionBusy = false;
      if (ownRun && (state.running || state.phase === 'error')) await stopAccountCapture();
    }
    captureOwner = null;
    clear($('cap-box'));
    $('cap-hint').textContent = '';
    return true;
  } finally {
    captureActionBusy = false;
    if (captureView) renderCapture(captureView);
  }
}

// ---- APP 账号登录 ---------------------------------------------------------
${phoneLoginScript}

// ---- 支付宝扫码登录 --------------------------------------------------------
${alipayLoginScript}

// ---- 添加账号引导 ----------------------------------------------------------
${accountAddScript}

// ---- 页头账号选择 ----------------------------------------------------------
${accountPickerScript}

// ---- 启动 ------------------------------------------------------------------
${lineupScript}
${progressionScript}
${helpTipsScript}
${mapMotionPosition.toString()}
${worldMapScript}
${siliconOverviewScript}
${resourceFieldsScript}
${inventoryScript}
${resultsScript}
${productionPlanningScript}
${settingsScript}
${appointmentsScript}
${giftCodeScript}
let selectedResource = 'guild';
consoleStore.subscribe((state, previous) => {
  if (state.view.resource !== previous.view.resource) selectedResource = state.view.resource;
});
function activateConsolePage(button, resource = selectedResource) {
    const isResource = button.dataset.tab === 'resources';
    const target = isResource ? resource : button.dataset.tab;
    // 当前历史记录随刷新保留；离开锚点对应的页面时移除旧地址。
    const staleAnchor = (target !== 'settings' && location.hash.startsWith('#config-group-'))
      || (target !== 'stages' && location.hash === '#pirate-first-kill')
      || (target !== 'overview' && location.hash === '#journal');
    const url = staleAnchor ? location.pathname + location.search : location.href;
    history.replaceState({ ...history.state, consoleView: { tab: button.dataset.tab, resource } }, '', url);
    stateActions.setView({ page: target, ...(isResource ? { resource } : {}) });
    $('resource-tabs').hidden = !isResource;
    for (const tab of document.querySelectorAll('[data-resource-tab]')) {
      const selected = tab.dataset.resourceTab === target;
      tab.setAttribute('aria-current', selected ? 'page' : 'false');
      if (selected && isResource) tab.scrollIntoView({ block: 'nearest', inline: 'center' });
    }
    closeHelpTip(false);
    for (const other of document.querySelectorAll('#tabs button')) other.removeAttribute('aria-current');
    button.setAttribute('aria-current', 'page');
    for (const section of document.querySelectorAll('main > section')) {
      section.classList.toggle('hidden', section.id !== 'tab-' + target);
    }
    refreshProgression();
    if (button.dataset.tab === 'overview') {refreshOverview();refreshLoop();}
    if(isResource&&resource==='inventory')refreshManualWorld();
    if (target === 'heroes') void appointmentsLoad(true);
    if (target === 'lineups') void refreshSavedLineups();
    if (button.dataset.tab === 'account') {
      renderAccounts();
      void refreshRoleRotations();
      pollCapture();
    }
    if (button.dataset.tab === 'manual') refreshManualWorld();
    if (button.dataset.tab === 'settings') {
      if (!location.hash.startsWith('#config-group-')) configActivate(configEditor.category);
      void configLoad(); void refreshLoop();
    }
    if(target==='giftcodes')void refreshGiftCodes();
    if (target === 'activities') refreshActivities();
    if (button.dataset.tab === 'stages') {refreshStages();void refreshSavedLineups();}
}
document.querySelectorAll('#tabs button').forEach(button => { button.onclick = () => activateConsolePage(button); });
for(const link of document.querySelectorAll('a[href^="#config-group-"]'))link.onclick=event=>{if(location.hash===link.getAttribute('href')){event.preventDefault();activateConsolePage(document.querySelector('#tabs [data-tab="settings"]'));configApplyHash();}};
document.querySelectorAll('[data-resource-tab]').forEach(button => { button.onclick = () => activateConsolePage(document.querySelector('#tabs [data-tab="resources"]'), button.dataset.resourceTab); });

// 配置页工具栏吸在页头下方；页头高度随触屏尺寸和提示文字变化，手机上页头不吸顶。
new ResizeObserver(() => {
  const header = document.querySelector('header');
  document.documentElement.style.setProperty('--header-h', (getComputedStyle(header).position === 'sticky' ? header.offsetHeight : 0) + 'px');
}).observe(document.querySelector('header'));

async function boot() {
  try {
    await loadAccounts(true);
  } catch (error) {
    $('hint').textContent = '';
    reportError(error);
    return;
  }
  // 显式链接优先，否则恢复当前历史记录的页面；配置分组由 configApplyHash 恢复。
  const savedView = history.state?.consoleView;
  const initialTab = location.hash.startsWith('#config-group-') ? 'settings'
    : location.hash === '#pirate-first-kill' ? 'stages' : location.hash === '#journal' ? 'overview'
    : savedView?.tab === 'login-settings' ? 'account'
    : savedView?.tab === 'resources' && savedView.resource === 'activities' ? 'activities' : savedView?.tab;
  const button = [...document.querySelectorAll('#tabs button')].find(tab => tab.dataset.tab === initialTab)
    || document.querySelector('#tabs [data-tab="overview"]');
  const resource = [...document.querySelectorAll('[data-resource-tab]')].some(tab => tab.dataset.resourceTab === savedView?.resource)
    ? savedView.resource : selectedResource;
  activateConsolePage(button, resource);
  if (location.hash === '#journal') openJournal();
  pollCapture();
}
// Coalesce related mutations before painting every account surface. The store
// subscription also covers writes made by React or another subscribed view.
let accountPaintPending = false;
consoleStore.subscribe((state, previous) => {
  if (state.accountsById !== previous.accountsById || state.currentAccountId !== previous.currentAccountId
      || state.connecting !== previous.connecting || state.disconnected !== previous.disconnected || state.hosting !== previous.hosting) {
    if (!accountPaintPending) {
      accountPaintPending = true;
      queueMicrotask(() => { accountPaintPending = false; renderAccountSelect(); });
    }
  }
  if (state.view !== previous.view) {
    if (state.view.logAccount !== previous.view.logAccount || state.view.logGroup !== previous.view.logGroup
        || state.view.onlyIssues !== previous.view.onlyIssues) {
      $('journal').classList.toggle('issues', state.view.onlyIssues);
      $('log-all').setAttribute('aria-pressed', String(!state.view.onlyIssues));
      $('log-issues').setAttribute('aria-pressed', String(state.view.onlyIssues));
      updateLogSummary();
    }
  }
});
boot();
setInterval(refreshOverview, 20000);
setInterval(() => { if (!document.hidden && accounts.some(account => account.status?.reconnecting)) paintConnection(); }, 1000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden){void refreshAccountStatuses();refreshLoop();refreshStages();}});
setInterval(() => { void refreshAccountStatuses(); if (!loopReads) refreshLoop(); }, 3000);
setInterval(refreshStages, 3000);
</script>
<script type="module" src="/ui/console-client.js"></script>
</body>
</html>`;
