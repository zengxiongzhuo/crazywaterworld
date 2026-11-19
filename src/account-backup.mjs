import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { ACCOUNTS_PATH, accountFromCredential, loadStore, loginAccountId, roleEntryId, serializeStore, normalizeStore, findRoleAccount } from './accounts.mjs';
import { accountKey } from './usage-ledger.mjs';
import { atomicJson, readJson, withFileLock } from './json-store.mjs';
import { exportAutomationSettings, importAutomationSettings, loadAutomationSettings,
  saveAutomationSettings, settingsFile, settingsFromNative } from './automation-settings.mjs';

export const ACCOUNT_BACKUP_FORMAT = 'crazywaterworld-accounts';
export const ACCOUNT_BACKUP_MAX_BYTES = 10 * 1024 * 1024;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Only portable account data belongs in a backup; runtime recovery and hosting
// flags remain local, even when the user includes game settings.
function portableAccount(account) {
  return structuredClone(Object.fromEntries(['id', 'label', 'url', 'login', 'loginFrameHex',
    'source', 'capturedAt', 'addedAt', 'lastSeen', 'loginAccountId', 'roleId', 'bornWorldId'].map(key => [key, account[key] ?? null])));
}

function savedSettings(account) {
  const saved = loadAutomationSettings(account.id);
  if (saved.revision) return saved.settings;
  return settingsFromNative(account.automation?.tasks, account.automation);
}

export function exportAccountBackup(store, { id, ids, all = false, includeSettings = false, getSettings = savedSettings } = {}) {
  if (typeof includeSettings !== 'boolean') throw new Error('请选择有效的账号导出方式');
  let selected;
  if (ids !== undefined) {
    if (!Array.isArray(ids) || !ids.length || ids.some(value => typeof value !== 'string' || !value.trim())) {
      throw new Error('请至少选择一个有效账号');
    }
    if (id !== undefined || all !== false) throw new Error('请只指定一种账号导出范围');
    const requested = new Set(ids);
    selected = store.accounts.filter(account => requested.has(account.id));
    if (selected.length !== requested.size) throw new Error('所选账号已不存在，请刷新账号列表后重试');
  } else {
    selected = all === true ? store.accounts : store.accounts.filter(account => account.id === id);
  }
  if (!selected.length) throw new Error('没有可导出的账号');
  return {
    format: ACCOUNT_BACKUP_FORMAT, version: 1, exportedAt: new Date().toISOString(), includeSettings,
    activeId: selected.some(account => account.id === store.activeId) ? store.activeId : selected[0].id,
    accounts: selected.map(account => ({ ...portableAccount(account),
      ...(includeSettings ? { settings: exportAutomationSettings(getSettings(account)) } : {}),
    })),
  };
}

export function parseAccountBackup(document) {
  if (document?.version === 2 && !document.format && document.loginAccounts) {
    const store = normalizeStore(document);
    document = { version: 1, activeId: store.activeId, accounts: store.accounts };
  }
  const modern = document?.format === ACCOUNT_BACKUP_FORMAT;
  if (!plain(document) || document.version !== 1 || document.format && !modern
    || !Array.isArray(document.accounts) || !document.accounts.length
    || modern && typeof document.includeSettings !== 'boolean') {
    throw new Error('请选择本工具导出的账号 JSON 文件（版本 1）');
  }
  const ids = new Set(), roles = new Set();
  const accounts = document.accounts.map((row, index) => {
    const fail = message => { throw new Error(`第 ${index + 1} 个账号：${message}`); };
    if (!plain(row) || !plain(row.login) || !plain(row.login.eworldParams)
      || typeof row.login.eworldParams.openId !== 'string' || !row.login.eworldParams.openId.trim()) fail('缺少有效的登录凭据');
    if (row.source != null && (typeof row.source !== 'string' || !row.source.trim())) fail('账号渠道无效');
    let url;
    try { url = new URL(row.url); } catch { fail('游戏网关地址无效'); }
    if (typeof row.url !== 'string' || !['ws:', 'wss:'].includes(url.protocol)) fail('游戏网关必须是 ws 或 wss 地址');
    if (row.label != null && typeof row.label !== 'string') fail('账号备注必须是文本');
    if (row.loginFrameHex != null && (typeof row.loginFrameHex !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(row.loginFrameHex))) fail('登录帧必须是完整的十六进制字节');
    const account = accountFromCredential(row, { label: row.label ?? null });
    const loginId = account.id;
    if (row.loginAccountId != null && row.loginAccountId !== loginId) fail('登录账号标识与凭据不一致');
    if (row.roleId != null && (typeof row.roleId !== 'string' || !/^[1-9]\d*$/.test(row.roleId))) fail('角色标识无效');
    if (row.bornWorldId != null && (!Number.isSafeInteger(row.bornWorldId) || row.bornWorldId <= 0
      || Number(row.login.worldId) !== row.bornWorldId)) fail('原区服与登录入口不一致');
    account.roleId = row.roleId ?? null;
    account.bornWorldId = row.bornWorldId ?? account.bornWorldId;
    const allowedIds = [loginId, roleEntryId(loginId, account), roleEntryId(loginId, { bornWorldId: account.bornWorldId })];
    if (!allowedIds.includes(row.id)) fail('账号标识与登录凭据或渠道不一致');
    account.id = row.id;
    if (account.roleId) {
      const identity = loginId + ':' + account.roleId;
      if (roles.has(identity)) fail('文件中包含重复区服角色');
      roles.add(identity);
    }
    // 备份只恢复账号资料；启停偏好保留本机值，新增账号在导入计划中默认关闭。
    delete account.automation;
    accountKey(account.id);
    if (ids.has(account.id)) fail('文件中包含重复账号');
    ids.add(account.id);
    for (const key of ['addedAt', 'capturedAt']) {
      if (row[key] != null && (typeof row[key] !== 'string' || !Number.isFinite(Date.parse(row[key])))) fail('账号时间格式无效');
      if (row[key] != null) account[key] = row[key];
    }
    if (row.lastSeen != null) {
      if (!plain(row.lastSeen)) fail('角色资料无效');
      account.lastSeen = Object.fromEntries(['id', 'nickname', 'level', 'power', 'worldId', 'bornWorldId', 'at'].map(key => {
        const value = row.lastSeen[key] ?? null;
        if (value !== null && typeof value !== 'string' && typeof value !== 'number') fail('角色资料字段无效');
        return [key, value];
      }));
    }
    const hasSettings = Object.hasOwn(row, 'settings');
    if (hasSettings !== (modern && document.includeSettings)) fail('文件声明的导出方式与配置内容不一致');
    let settings = null;
    if (hasSettings) {
      try { settings = importAutomationSettings(row.settings); }
      catch { fail('游戏配置无效，请检查配置文件版本和内容'); }
    }
    return { account, settings };
  });
  if (document.activeId != null && !ids.has(document.activeId)) throw new Error('备份中的当前账号不在账号列表中');
  return { activeId: document.activeId ?? accounts[0].account.id, accounts };
}

function importPlan(document) {
  const backup = parseAccountBackup(document);
  const store = loadStore();
  const next = structuredClone(store);
  let created = 0, updated = 0;
  const settingsEntries = [], baseline = [], importedIds = new Map();
  for (const { account, settings } of backup.accounts) {
    const originalId = account.id;
    const matching = findRoleAccount(next, account, account.roleId ? { id: account.roleId } : null);
    const collision = next.accounts.find(row => row.id === account.id);
    if (matching) account.id = matching.id;
    else if (collision && (account.roleId && collision.roleId && account.roleId !== collision.roleId
      || account.bornWorldId && collision.bornWorldId && account.bornWorldId !== collision.bornWorldId)) {
      account.id = roleEntryId(loginAccountId(account), account);
    }
    importedIds.set(originalId, account.id);
    const index = next.accounts.findIndex(row => row.id === account.id);
    baseline.push(index < 0 ? null : next.accounts[index]);
    if (index < 0) {
      next.accounts.push({ ...account, automation: { enabled: false, autoStart: false } });
      created++;
    } else {
      const previous = next.accounts[index];
      next.accounts[index] = { ...previous, ...account, label: account.label ?? previous.label,
        addedAt: previous.addedAt ?? account.addedAt, lastSeen: previous.lastSeen ?? account.lastSeen };
      updated++;
    }
    for (const sibling of next.accounts) {
      if (loginAccountId(sibling) !== loginAccountId(account) || sibling.id === account.id) continue;
      sibling.url = account.url;
      sibling.login = { ...account.login, worldId: sibling.bornWorldId || sibling.login.worldId || 0 };
      sibling.source = account.source;
      sibling.loginFrameHex = account.loginFrameHex;
      sibling.capturedAt = account.capturedAt;
    }
    if (settings) {
      const entry = loadAutomationSettings(account.id);
      settingsEntries.push({ id: account.id, settings, revision: entry.revision });
      baseline.push(entry);
    }
  }
  if (!store.activeId) next.activeId = importedIds.get(backup.activeId) || backup.activeId;
  const token = createHash('sha256').update(JSON.stringify([document, store, baseline])).digest('hex');
  return { next, settingsEntries, summary: { created, updated, settingsCount: settingsEntries.length, token } };
}

export function previewAccountImport(document) { return importPlan(document).summary; }

export function importAccountBackup(document, token) {
  return withFileLock(ACCOUNTS_PATH, () => withFileLock(settingsFile(), () => {
    // Revalidate the entire file and the preview baseline before writing anything.
    const plan = importPlan(document);
    if (typeof token !== 'string' || token !== plan.summary.token) throw new Error('账号或配置已变化，请重新选择文件并确认导入');
    const previousSettings = plan.settingsEntries.length ? readJson(settingsFile(), null) : null;
    const saved = [];
    try {
      for (const entry of plan.settingsEntries) saved.push({ id: entry.id,
        ...saveAutomationSettings(entry.id, entry.settings, { revision: entry.revision }) });
      atomicJson(ACCOUNTS_PATH, serializeStore(plan.next));
    } catch (error) {
      if (saved.length) {
        if (previousSettings === null) fs.unlinkSync(settingsFile());
        else atomicJson(settingsFile(), previousSettings);
      }
      throw error;
    }
    return { ...plan.summary, activeId: plan.next.activeId, saved };
  }));
}
