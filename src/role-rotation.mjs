import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR, loginAccountId, describeAccount } from './accounts.mjs';
import { atomicJson, readJson, withFileLock } from './json-store.mjs';

export const ROLE_ROTATION_PATH = path.join(DATA_DIR, 'role-rotations.json');
const DAY = 86400000, OFFSET = 8 * 3600000;
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
export const defaultRotationSettings = () => ({ enabled: false, allDay: false, start: '23:00', end: '06:00', roles: [],
  reconnect: { enabled: true, maxRetries: 3, intervalSeconds: 10 } });
const readStore = () => readJson(ROLE_ROTATION_PATH, { version: 1, plans: {} });
const emptyEntry = () => ({ revision: 0, settings: defaultRotationSettings(), runtime: { paused: false, phase: 'disabled', cursor: 0 } });
const minutes = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

// Daily windows use Beijing time independently of the operating system timezone.
export function rotationWindow(settings, now) {
  if (settings.allDay) return { active: true, key: 'all-day', start: null, end: Infinity, nextStart: null, nextChange: Infinity };
  const day = Math.floor((now + OFFSET) / DAY) * DAY - OFFSET;
  let start = day + minutes(settings.start) * 60000;
  const duration = ((minutes(settings.end) - minutes(settings.start) + 1440) % 1440) * 60000;
  if (now < start && now < start - DAY + duration) start -= DAY;
  const end = start + duration;
  const active = now >= start && now < end;
  const nextStart = now < start ? start : start + DAY;
  return { active, key: String(start), start, end, nextStart, nextChange: active ? end : nextStart };
}

export function validateRotationSettings(settings, loginId, accounts) {
  if (!settings || typeof settings !== 'object' || typeof settings.enabled !== 'boolean' || typeof settings.allDay !== 'boolean'
    || !timePattern.test(settings.start) || !timePattern.test(settings.end) || !Array.isArray(settings.roles)) throw new Error('请填写完整的轮换开关、运行时段和区服列表');
  if (!settings.allDay && settings.start === settings.end) throw new Error('开始和结束时间不能相同，需要全天运行时请选择「全天」');
  const reconnect = settings.reconnect ?? defaultRotationSettings().reconnect;
  if (!reconnect || typeof reconnect.enabled !== 'boolean' || !Number.isSafeInteger(reconnect.maxRetries)
    || reconnect.maxRetries < 1 || reconnect.maxRetries > 1000 || !Number.isSafeInteger(reconnect.intervalSeconds)
    || reconnect.intervalSeconds < 1 || reconnect.intervalSeconds > 86400) throw new Error('断线重连次数请填写 1–1000 的整数，间隔请填写 1–86400 的整数秒');
  const seen = new Set();
  const roles = settings.roles.map(row => {
    if (!row || typeof row.id !== 'string' || seen.has(row.id)) throw new Error('区服列表包含无效或重复的角色');
    const account = accounts.find(account => account.id === row.id);
    if (!account?.roleId || loginAccountId(account) !== loginId) throw new Error('区服不属于此登录账号，请刷新区服后重试');
    if (typeof row.enabled !== 'boolean' || !Number.isSafeInteger(row.minutes) || row.minutes < 1 || row.minutes > 1440) throw new Error('每个区服的挂机时长必须是 1–1440 的整数分钟');
    seen.add(row.id);
    return { id: row.id, enabled: row.enabled, minutes: row.minutes };
  });
  if (settings.enabled && !roles.some(row => row.enabled)) throw new Error('请至少选择一个参与轮换的区服');
  return { enabled: settings.enabled, allDay: settings.allDay, start: settings.start, end: settings.end, roles,
    reconnect: { enabled: reconnect.enabled, maxRetries: reconnect.maxRetries, intervalSeconds: reconnect.intervalSeconds } };
}

function recoverableDisconnect(error) {
  return !error.loginResponse && error.recoverable !== false
    && !['stopped', 'kicked', 'protocol', 'login-rejected'].includes(error.closeReason)
    && (error.recoverable === true || ['network', 'heartbeat-timeout', 'sequence-gap'].includes(error.closeReason)
      || /login timeout|socket error during login|socket closed during login|^not connected$/i.test(error.message));
}

// The console supplies the existing connection/lineup handoff and loop operations.
export function createRoleRotationManager({ accounts, startRole, stopLogin, isRunning, onChange = () => {}, now = Date.now, automatic = true }) {
  const jobs = new Map(), stops = new Map();
  let timer = null, started = false, closed = false;
  const entryFor = id => {
    const entry = readStore().plans[id] ?? emptyEntry();
    return { ...entry, settings: { ...entry.settings, reconnect: entry.settings.reconnect ?? defaultRotationSettings().reconnect } };
  };
  const managed = account => entryFor(typeof account === 'string' ? account : loginAccountId(account)).settings.enabled;

  function updateRuntime(id, patch, expected = {}) {
    return withFileLock(ROLE_ROTATION_PATH, () => {
      const store = readStore(), entry = store.plans[id];
      if (!entry || expected.revision !== undefined && entry.revision !== expected.revision
        || expected.lease !== undefined && entry.runtime.lease !== expected.lease
        || expected.controlToken !== undefined && entry.runtime.controlToken !== expected.controlToken) return null;
      entry.runtime = { ...entry.runtime, ...patch };
      atomicJson(ROLE_ROTATION_PATH, store);
      onChange(id, entry);
      return entry;
    });
  }

  function activeLease(account, lease) {
    if (closed) return false;
    const entry = entryFor(loginAccountId(account)), state = entry.runtime;
    return entry.settings.enabled && !state.paused && state.currentId === account.id
      && (!lease || state.lease === lease) && ['connecting', 'running', 'retrying'].includes(state.phase)
      && rotationWindow(entry.settings, now()).active && (!state.endsAt || now() < state.endsAt);
  }

  function authorized(account, lease) {
    return activeLease(account, lease) && entryFor(loginAccountId(account)).runtime.phase !== 'retrying';
  }

  function stop(id, reason) {
    if (stops.has(id)) return stops.get(id);
    const job = Promise.resolve().then(() => stopLogin(id, reason));
    stops.set(id, job);
    const clear = () => { if (stops.get(id) === job) stops.delete(id); };
    job.then(clear, clear);
    return job;
  }

  function halt(id, patch, reason) {
    updateRuntime(id, { currentId: null, lease: null, startedAt: null, endsAt: null, reconnectAttempts: 0, ...patch });
    return stop(id, reason);
  }

  async function disconnected(account, error, lease) {
    if (!activeLease(account, lease)) return;
    const id = loginAccountId(account), entry = entryFor(id), policy = entry.settings.reconnect;
    const attempts = entry.runtime.reconnectAttempts ?? 0;
    if (recoverableDisconnect(error) && policy.enabled && attempts < policy.maxRetries) {
      updateRuntime(id, { phase: 'retrying', error: error.message, retryAt: now() + policy.intervalSeconds * 1000 }, { lease: entry.runtime.lease });
      await stop(id, '轮换区服意外断线，停止旧任务和连接，等待重试');
    } else {
      const reason = recoverableDisconnect(error) ? policy.enabled
        ? `断线重连已达到 ${policy.maxRetries} 次：${error.message}` : `断线重连已关闭：${error.message}` : error.message;
      await halt(id, { phase: 'error', cursor: (entry.runtime.cursor ?? 0) + 1, retryAt: now() + 30000, error: reason },
        '本区服轮换已停止，稍后尝试下一个区服');
    }
    arm();
  }

  function recovered(account) {
    if (!authorized(account)) return;
    const entry = entryFor(loginAccountId(account));
    if (entry.runtime.reconnectAttempts) updateRuntime(loginAccountId(account), { reconnectAttempts: 0 }, { lease: entry.runtime.lease });
  }

  async function reconcile(id) {
    let entry = entryFor(id), state = entry.runtime;
    if (!entry.settings.enabled || state.paused || closed) return;
    let window = rotationWindow(entry.settings, now());
    if (!window.active) {
      if (state.currentId) await halt(id, { phase: 'waiting', error: null, retryAt: null }, '轮换运行时段已结束，停止任务并断开连接');
      else if (state.phase !== 'waiting' || state.retryAt) updateRuntime(id, { phase: 'waiting', error: null, retryAt: null });
      return;
    }
    if (state.retryAt > now() && !(state.currentId && state.endsAt && now() >= state.endsAt)) return;
    const candidates = entry.settings.roles.filter(row => row.enabled).map(row => ({ ...row,
      account: accounts().find(account => account.id === row.id && loginAccountId(account) === id && account.roleId && !account.automation?.paused),
    })).filter(row => row.account);
    if (!candidates.length) {
      await halt(id, { phase: 'error', error: '没有可运行的区服，请刷新区服或恢复角色托管', retryAt: now() + 30000 }, '轮换没有可运行的区服');
      return;
    }
    let index = state.windowKey === window.key ? (state.cursor ?? 0) % candidates.length : 0;
    const currentIndex = candidates.findIndex(row => row.id === state.currentId);
    let resumeEnd = null, resumeStart = null, reconnectAttempts = 0;
    if (state.windowKey === window.key && ['running', 'retrying', 'connecting'].includes(state.phase) && currentIndex >= 0) {
      index = currentIndex;
      if (state.endsAt == null || state.endsAt > now()) {
        if (state.phase === 'running' && isRunning(candidates[index].account)) return;
        resumeStart = state.startedAt;
        resumeEnd = resumeStart == null ? null : state.endsAt;
        reconnectAttempts = (state.reconnectAttempts ?? 0) + (state.phase === 'retrying' ? 1 : 0);
      } else index = (index + 1) % candidates.length;
    }
    await halt(id, { phase: 'waiting', cursor: index, error: null, retryAt: null }, '区服轮换交接，停止上一角色的任务和连接');
    entry = entryFor(id);
    window = rotationWindow(entry.settings, now());
    if (closed || !entry.settings.enabled || entry.runtime.paused || !window.active) return;
    const row = candidates[index], revision = entry.revision, lease = randomUUID();
    updateRuntime(id, { phase: 'connecting', currentId: row.id, cursor: index, windowKey: window.key, lease,
      startedAt: resumeStart, endsAt: resumeEnd ?? (Number.isFinite(window.end) ? window.end : null), error: null, reconnectAttempts }, { revision });
    arm();
    try {
      await startRole(row.account, () => authorized(row.account, lease));
      if (!authorized(row.account, lease)) return;
      const began = now(), end = Math.min(resumeEnd ?? began + row.minutes * 60000, window.end);
      updateRuntime(id, { phase: 'running', startedAt: resumeStart ?? began, endsAt: end, retryAt: null }, { revision, lease });
    } catch (error) {
      if (closed || entryFor(id).runtime.lease !== lease) return;
      await disconnected(row.account, error, lease);
    }
  }

  function tick(id) {
    if (closed) return Promise.resolve();
    if (jobs.has(id)) {
      const entry = entryFor(id), current = accounts().find(account => account.id === entry.runtime.currentId);
      if (entry.runtime.currentId && (!current || !activeLease(current))) {
        const pending = jobs.get(id);
        const expired = !entry.runtime.paused && entry.settings.enabled && entry.runtime.endsAt && now() >= entry.runtime.endsAt
          && rotationWindow(entry.settings, now()).active;
        return halt(id, { phase: entry.runtime.paused ? 'paused' : entry.settings.enabled ? 'waiting' : 'disabled',
          cursor: (entry.runtime.cursor ?? 0) + (expired ? 1 : 0) }, '轮换已暂停或时段结束，取消正在进行的登录').then(() => pending);
      }
      return jobs.get(id);
    }
    if (stops.has(id)) return stops.get(id);
    const job = reconcile(id);
    jobs.set(id, job);
    const clear = () => { if (jobs.get(id) === job) jobs.delete(id); arm(); };
    job.then(clear, clear);
    return job;
  }
  async function tickAll() {
    const known = new Set(accounts().map(loginAccountId));
    const results = await Promise.allSettled(Object.keys(readStore().plans).filter(id => known.has(id) || jobs.has(id) || stops.has(id)).map(tick));
    for (const result of results) if (result.status === 'rejected') onChange(null, { runtime: { phase: 'error', error: result.reason.message } });
  }
  function arm() {
    if (!automatic || !started || closed) return;
    clearTimeout(timer);
    let deadline = now() + 30000;
    const known = new Set(accounts().map(loginAccountId));
    let pending = false;
    for (const [id, entry] of Object.entries(readStore().plans)) {
      if (!known.has(id) && !jobs.has(id) && !stops.has(id)) continue;
      if (!entry.settings.enabled || entry.runtime.paused) continue;
      pending = true;
      deadline = Math.min(deadline, rotationWindow(entry.settings, now()).nextChange);
      for (const at of [entry.runtime.endsAt, entry.runtime.retryAt]) if (at) deadline = Math.min(deadline, at);
    }
    if (!pending) return;
    timer = setTimeout(() => { void tickAll(); arm(); }, Math.max(25, deadline - now()));
    timer.unref?.();
  }

  async function configure(id, settings, revision) {
    const validated = validateRotationSettings(settings, id, accounts());
    let stopRequired = false;
    const controlToken = randomUUID();
    withFileLock(ROLE_ROTATION_PATH, () => {
      const store = readStore(), previous = store.plans[id] ?? emptyEntry();
      if (!Number.isSafeInteger(revision) || previous.revision !== revision) throw new Error('轮换配置已被修改，请载入最新配置后重试');
      stopRequired = previous.settings.enabled || validated.enabled;
      store.plans[id] = { revision: revision + 1, settings: validated, runtime: { paused: stopRequired, phase: stopRequired ? 'stopping' : 'disabled', cursor: 0, controlToken } };
      atomicJson(ROLE_ROTATION_PATH, store);
    });
    if (stopRequired) {
      await halt(id, {}, '轮换配置已更新，结束原有任务和连接');
      await jobs.get(id)?.catch(() => {});
    }
    const ready = updateRuntime(id, { paused: false, phase: validated.enabled ? 'waiting' : 'disabled', windowKey: null, retryAt: null }, { revision: revision + 1, controlToken });
    if (!ready) { arm(); return entryFor(id); }
    await tick(id);
    arm();
    return entryFor(id);
  }
  async function pause(id, reason = '已手动暂停区服轮换') {
    if (!managed(id)) return;
    await halt(id, { paused: true, phase: 'paused', retryAt: null, controlToken: randomUUID() }, reason);
    await jobs.get(id)?.catch(() => {});
    arm();
  }
  async function resume(id) {
    if (!managed(id)) throw new Error('请先保存并启用区服轮换');
    updateRuntime(id, { paused: false, phase: 'waiting', retryAt: null, error: null, controlToken: randomUUID() });
    await stops.get(id)?.catch(() => {});
    await jobs.get(id)?.catch(() => {});
    await tick(id);
    arm();
    return entryFor(id);
  }
  function view() {
    const known = accounts(), groups = new Map();
    for (const account of known) if (account.roleId) {
      const id = loginAccountId(account);
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(describeAccount(account));
    }
    return [...groups].map(([loginId, roles]) => {
      const entry = entryFor(loginId), present = new Set(roles.map(role => role.id));
      const rows = entry.settings.roles.filter(row => present.has(row.id));
      for (const role of roles) if (!rows.some(row => row.id === role.id)) rows.push({ id: role.id, enabled: false, minutes: 30 });
      const window = rotationWindow(entry.settings, now());
      return { loginId, roles, ...entry, settings: { ...entry.settings, roles: rows }, window: { ...window,
        end: Number.isFinite(window.end) ? window.end : null, nextChange: Number.isFinite(window.nextChange) ? window.nextChange : null } };
    });
  }
  return { managed, authorized, entryFor, configure, pause, resume, view, tick, tickAll, disconnected, recovered,
    start() { started = true; void tickAll(); arm(); },
    close() { closed = true; clearTimeout(timer); return Promise.allSettled([...jobs.values(), ...stops.values()]); },
  };
}
