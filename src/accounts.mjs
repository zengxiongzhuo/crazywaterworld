import fs from 'node:fs';
import path from 'node:path';
import { worldName } from './world-name.mjs';
import { uidText } from './hero-equipment.mjs';
import { atomicJson } from './json-store.mjs';

// 账号身份按渠道与 openId 区分；历史抖音凭证与电脑采集沿用同一身份空间。
// 登录身份共用凭证，accounts 中的每条记录代表一个区服角色。
// 首个角色沿用旧账号 ID，让已有配置、阵容和用量记录无需改名。
// 自检要在一个临时目录里验证「读 / 写 / 迁移」这条链，所以留一个环境变量出口。
// 正常运行时根本不会设它，路径与原来一致。
export const DATA_DIR = process.env.CW_DATA_DIR
  ? path.resolve(process.env.CW_DATA_DIR)
  : path.resolve(import.meta.dirname, '../data');
export const ACCOUNTS_PATH = path.join(DATA_DIR, 'accounts.json');
// 早期版本只有一个账号，凭证写在这个文件里。现在只作为迁移来源与备份，不再写。
export const LEGACY_CREDENTIALS_PATH = path.join(DATA_DIR, 'credentials.json');

function emptyStore() {
  return { version: 2, activeId: null, selectedRoles: {}, accounts: [] };
}

export function accountId(credential) {
  const id = credential?.login?.eworldParams?.openId;
  if (typeof id !== 'string' || !id) return null;
  if (credential.source === 'alipay') return 'alipay:' + id;
  return ['douyin', 'douyin-mitm'].includes(credential.source) ? 'douyin:' + id : id;
}

export function loginAccountId(account) {
  return accountId(account) || account.loginAccountId || account.id;
}

const positiveWorld = value => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};

export function roleEntryId(loginId, { roleId, bornWorldId } = {}) {
  const id = uidText(roleId);
  if (id) return `${loginId}:role:${id}`;
  const world = positiveWorld(bornWorldId);
  if (world) return `${loginId}:world:${world}`;
  return loginId;
}

export function findRoleAccount(store, credential, role = null) {
  const loginId = loginAccountId(credential);
  const siblings = store.accounts.filter(account => loginAccountId(account) === loginId);
  const id = uidText(role?.id ?? role?.playerId);
  const world = positiveWorld(credential.login?.worldId ?? role?.bornWorldId);
  if (id) {
    const found = siblings.find(account => account.roleId === id);
    if (found) return found;
  }
  if (world) return siblings.find(account => Number(account.bornWorldId || account.login?.worldId) === world
    && (!id || !account.roleId || account.roleId === id)) ?? null;
  return siblings.find(account => account.id === store.selectedRoles?.[loginId])
    || siblings.find(account => account.id === store.activeId) || siblings[0] || null;
}

// 网页和 CLI 要的都是这一小块，凭证本体不往外散。
export function toCredential(account) {
  return {
    url: account.url,
    login: account.login,
    ...(account.loginFrameHex ? { loginFrameHex: account.loginFrameHex } : {}),
    source: account.source ?? 'mitm',
    capturedAt: account.capturedAt ?? null,
  };
}

export function accountFromCredential(credential, { label = null, now = new Date().toISOString() } = {}) {
  const id = accountId(credential);
  if (!id) throw new Error('这份凭证里没有 login.eworldParams.openId，认不出是哪个账号');
  const url = credential.url || credential.wsUrl;
  const login = credential.login || credential.body;
  if (!url || !login) throw new Error('凭证必须同时有 url 和 login');
  return {
    id,
    loginAccountId: id,
    roleId: null,
    bornWorldId: positiveWorld(login.worldId),
    label,
    url,
    login,
    loginFrameHex: credential.loginFrameHex ?? null,
    source: credential.source ?? 'mitm',
    capturedAt: credential.capturedAt ?? null,
    addedAt: now,
    lastSeen: null,
    automation: { enabled: false, autoStart: false },
  };
}

// 文件不存在或读坏时不让整条命令挂掉，调用方拿到的要么是空仓库要么是旧凭证合成的一条。
export function loadStore() {
  if (fs.existsSync(ACCOUNTS_PATH)) {
    return normalizeStore(JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8')));
  }
  if (fs.existsSync(LEGACY_CREDENTIALS_PATH)) {
    const credential = JSON.parse(fs.readFileSync(LEGACY_CREDENTIALS_PATH, 'utf8'));
    const account = accountFromCredential(credential, { label: null });
    return { ...emptyStore(), activeId: account.id, accounts: [account] };
  }
  return emptyStore();
}

export function normalizeStore(raw) {
  const store = emptyStore();
  if (!raw || typeof raw !== 'object') return store;
  const accounts = Array.isArray(raw.accounts) ? raw.accounts : [];
  store.accounts = accounts.filter(account => account && typeof account.id === 'string').map(row => {
    const credential = raw.loginAccounts?.[row.loginAccountId];
    const account = credential ? { ...row, ...credential, login: { ...credential.login, worldId: row.bornWorldId || 0 } } : { ...row };
    if (!account.url || !account.login) return null;
    account.loginAccountId = loginAccountId(account);
    account.roleId = uidText(account.roleId ?? account.lastSeen?.id);
    account.bornWorldId = positiveWorld(account.bornWorldId || account.login?.worldId
      || account.lastSeen?.bornWorldId || account.lastSeen?.worldId);
    if (account.bornWorldId) account.login = { ...account.login, worldId: account.bornWorldId };
    return account;
  }).filter(Boolean);
  const active = store.accounts.find((account) => account.id === raw.activeId);
  store.activeId = active ? active.id : (store.accounts[0]?.id ?? null);
  for (const account of store.accounts) {
    const loginId = loginAccountId(account);
    const siblings = store.accounts.filter(row => loginAccountId(row) === loginId);
    const wanted = raw.selectedRoles?.[loginId];
    store.selectedRoles[loginId] = siblings.find(row => row.id === wanted)?.id
      || siblings.find(row => row.id === store.activeId)?.id
      || siblings.find(row => row.automation?.autoStart || row.automation?.enabled)?.id || siblings[0].id;
  }
  return store;
}

// 凭证只落盘一份。读取时补回角色视图，旧的账号文件仍可直接迁移。
export function serializeStore(store) {
  const loginAccounts = {};
  const accounts = store.accounts.map(account => {
    const loginId = loginAccountId(account);
    const { worldId: _worldId, ...login } = account.login;
    loginAccounts[loginId] = { ...toCredential(account), login };
    const { url: _url, login: _login, loginFrameHex: _frame, source: _source, capturedAt: _captured, ...row } = account;
    return { ...row, loginAccountId: loginId, bornWorldId: positiveWorld(account.bornWorldId || account.login.worldId) };
  });
  return { version: 2, activeId: store.activeId, selectedRoles: store.selectedRoles ?? {}, loginAccounts, accounts };
}

export function saveStore(store) {
  atomicJson(ACCOUNTS_PATH, serializeStore(store));
}

// 抓到同一账号的新凭证就地替换（凭证会过期，token/sign 每次登录都变），
// 但保留原来的人工标记与 lastSeen，只更新凭证本体。
export function upsertAccount(store, credential, { label = null, role = null, now = new Date().toISOString() } = {}) {
  const fresh = accountFromCredential(credential, { label, now });
  const siblings = store.accounts.filter(account => loginAccountId(account) === fresh.loginAccountId);
  const previousRole = findRoleAccount(store, credential, role);
  fresh.roleId = uidText(role?.id ?? role?.playerId);
  fresh.bornWorldId = positiveWorld(credential.login.worldId || role?.bornWorldId);
  // 未识别区服的旧记录在首次读取角色时原位补全。
  const previous = previousRole || siblings.find(account => !account.bornWorldId && !account.lastSeen?.worldId);
  const index = previous ? store.accounts.indexOf(previous) : -1;
  if (!previous && siblings.length) fresh.id = roleEntryId(fresh.loginAccountId, fresh);
  for (const sibling of siblings) {
    sibling.url = fresh.url;
    sibling.login = { ...fresh.login, worldId: sibling.bornWorldId || sibling.login.worldId || 0 };
    sibling.loginFrameHex = fresh.loginFrameHex;
    sibling.source = fresh.source;
    sibling.capturedAt = fresh.capturedAt;
  }
  if (index < 0) {
    store.accounts.push(fresh);
    if (!store.activeId) store.activeId = fresh.id;
    store.selectedRoles ??= {};
    store.selectedRoles[fresh.loginAccountId] ??= fresh.id;
    if (role) rememberSeen(fresh, role, now);
    return { account: fresh, created: true };
  }
  const merged = {
    ...previous,
    loginAccountId: fresh.loginAccountId,
    roleId: fresh.roleId || previous.roleId,
    bornWorldId: fresh.bornWorldId || previous.bornWorldId,
    label: label ?? previous.label,
    url: fresh.url,
    login: { ...fresh.login, worldId: fresh.bornWorldId || previous.bornWorldId || fresh.login.worldId || 0 },
    loginFrameHex: fresh.loginFrameHex,
    source: fresh.source,
    capturedAt: fresh.capturedAt,
  };
  if (role) rememberSeen(merged, role, now);
  store.accounts[index] = merged;
  return { account: merged, created: false };
}

export function rememberWorlds(store, account, worlds) {
  const saved = [];
  for (const world of worlds.recentWorlds ?? []) {
    if (!positiveWorld(world.worldId) || !uidText(world.role?.id)) continue;
    const credential = { ...toCredential(account), login: { ...account.login, worldId: world.worldId } };
    const { account: entry } = upsertAccount(store, credential, { role: world.role });
    saved.push(entry);
  }
  return saved;
}

export function rememberSeen(account, player, now = new Date().toISOString()) {
  if (!account) return;
  account.lastSeen = {
    id: uidText(player?.id ?? player?.playerId) || account.roleId || null,
    nickname: player?.nickname ?? account.lastSeen?.nickname ?? null,
    level: player?.level ?? account.lastSeen?.level ?? null,
    power: player?.power ?? account.lastSeen?.power ?? null,
    worldId: player?.worldId ?? account.lastSeen?.worldId ?? null,
    bornWorldId: player?.bornWorldId || account.bornWorldId || null,
    at: now,
  };
  account.roleId = account.lastSeen.id;
  account.bornWorldId = positiveWorld(player?.bornWorldId) || account.bornWorldId || positiveWorld(player?.worldId);
  if (account.bornWorldId) account.login = { ...account.login, worldId: account.bornWorldId };
  if (!account.label && account.lastSeen.nickname) account.label = account.lastSeen.nickname;
}

export function removeAccount(store, id) {
  const before = store.accounts.length;
  store.accounts = store.accounts.filter((account) => account.id !== id);
  if (store.activeId === id) store.activeId = store.accounts[0]?.id ?? null;
  for (const [loginId, selected] of Object.entries(store.selectedRoles ?? {})) {
    if (selected === id) {
      const next = store.accounts.find(account => loginAccountId(account) === loginId);
      if (next) store.selectedRoles[loginId] = next.id;
      else delete store.selectedRoles[loginId];
    }
  }
  return store.accounts.length !== before;
}

export function setActive(store, id) {
  if (!store.accounts.some((account) => account.id === id)) throw new Error(`没有账号 ${id}`);
  store.activeId = id;
}

// 选择顺序：显式指定（id / 昵称 / 1 起的序号）→ 当前选中 → 只有一条就用它。
export function pickAccount(store, selector = null) {
  if (selector !== null && selector !== undefined && selector !== '') {
    const wanted = String(selector).trim();
    const byId = store.accounts.find((account) => account.id === wanted);
    if (byId) return byId;
    const byLabel = store.accounts.find((account) => account.label && account.label === wanted);
    if (byLabel) return byLabel;
    const order = Number(wanted);
    if (Number.isInteger(order) && order >= 1 && order <= store.accounts.length) return store.accounts[order - 1];
    const partial = store.accounts.filter((account) => account.id.startsWith(wanted) || (account.label ?? '').includes(wanted));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) throw new Error(`"${wanted}" 匹配到多个账号: ${partial.map((account) => describeAccount(account).title).join(', ')}`);
    throw new Error(`找不到账号 "${wanted}"`);
  }
  if (store.activeId) {
    const active = store.accounts.find((account) => account.id === store.activeId);
    if (active) return active;
  }
  return store.accounts[0] ?? null;
}

// 控制台的账号描述只包含打码后的凭证信息。
function mask(value) {
  const text = String(value ?? '');
  if (!text) return '';
  if (text.length <= 8) return '*'.repeat(text.length);
  return `${text.slice(0, 4)}${'*'.repeat(8)}${text.slice(-4)}`;
}

export function describeAccount(account, { active = false } = {}) {
  const params = account.login?.eworldParams ?? {};
  const lastSeen = account.lastSeen
    ? { ...account.lastSeen, worldName: worldName(account.lastSeen.worldId) }
    : null;
  const scanChannel = ['alipay', 'wechat', 'douyin', 'douyin-mitm'].includes(account.source);
  const channelName = account.source === 'alipay' ? '支付宝' : account.source === 'wechat' ? '微信' : '抖音';
  let title = account.label || lastSeen?.nickname || (scanChannel
    ? `${channelName}账号 ${String(params.openId ?? '').slice(-6)}` : `账号 ${account.id.slice(0, 6)}`);
  if (scanChannel && lastSeen?.nickname) {
    const remark = account.label && account.label !== lastSeen.nickname ? account.label : null;
    title = [remark, lastSeen.nickname, lastSeen.worldName].filter(Boolean).join(' · ');
  }
  if (account.roleId && lastSeen?.nickname) {
    const remark = account.label && account.label !== lastSeen.nickname ? account.label : null;
    title = [worldName(account.bornWorldId) || lastSeen.worldName, remark, lastSeen.nickname].filter(Boolean).join(' · ');
  }
  return {
    id: account.id,
    loginAccountId: loginAccountId(account),
    roleId: account.roleId ?? null,
    bornWorldId: account.bornWorldId ?? null,
    bornWorldName: worldName(account.bornWorldId),
    title,
    label: account.label ?? null,
    url: account.url,
    source: account.source,
    capturedAt: account.capturedAt,
    addedAt: account.addedAt,
    lastSeen,
    active,
    masked: {
      openId: mask(params.openId),
      token: mask(params.token),
      sign: mask(params.sign),
    },
    hasFrame: Boolean(account.loginFrameHex),
  };
}

export function revealAccount(account) {
  const params = account.login?.eworldParams ?? {};
  return {
    ...describeAccount(account),
    raw: {
      openId: params.openId ?? null,
      token: params.token ?? null,
      timestamp: params.timestamp ?? null,
      sign: params.sign ?? null,
    },
    loginFrameHex: account.loginFrameHex ?? null,
  };
}
