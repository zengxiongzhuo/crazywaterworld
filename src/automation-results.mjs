import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJson, readJson } from './json-store.mjs';
import { dataDirectory, beijingDay } from './usage-ledger.mjs';

const emptyTotals = () => ({ completed: 0, failed: 0, rounds: 0, gains: {}, costs: {}, actions: {}, gainSources: {}, costSources: {} });
const clean = value => String(value ?? '').slice(0, 350);
const plus = (object, key, amount) => { if (!['__proto__', 'constructor', 'prototype'].includes(key)) object[key] = (object[key] ?? 0) + amount; };
const dayEnd = at => Date.parse(beijingDay(at) + 'T00:00:00+08:00') + 86400000;

// A report belongs to a hosting run; individual role visits are segments of it.
// Only sanitized business facts are stored here, never protocol bodies or credentials.
export function createAutomationResults({ file = path.join(dataDirectory(), 'automation-results.json'), now = Date.now, automatic = true, onError = () => {} } = {}) {
  const empty = { version: 1, trackingStartedAt: now(), checkpointAt: now(), runs: [] };
  let store, initialError = null;
  try {
    store = readJson(file, empty);
    if (store.version !== 1 || !Array.isArray(store.runs) || !store.runs.every(run => run && Array.isArray(run.segments) && Array.isArray(run.events) && run.roles && run.days && run.seen && run.operations)) throw new Error('挂机成果记录格式不支持');
  } catch (error) { store = empty; initialError = error; }
  let dirty = false, timer, closed = false, writeError = initialError ? clean(initialError.message) : null;
  // A crash must not turn the time the process was absent into online time.
  for (const run of store.runs) {
    run.durations ??= {};
    for (const segment of run.segments) {
      if (!segment.endedAt) { segment.endedAt = Math.max(segment.startedAt, store.checkpointAt); segment.onlineSince = null; segment.online = false; dirty = true; }
      foldDuration(run, segment);
    }
    run.segments = [];
  }
  function flush() {
    if (initialError) throw initialError;
    if (!dirty || closed) return;
    store.checkpointAt = now();
    try { atomicJson(file, store); writeError = null; } catch (error) { writeError = clean(error.message); throw error; }
    dirty = false;
  }
  function changed() { dirty = true; }
  const find = id => store.runs.find(run => run.id === id);
  function finish(run, reason) {
    if (!run || run.endedAt) return;
    for (const segment of run.segments) if (!segment.endedAt) endSegment(segment.id);
    run.endedAt = now(); run.reason = clean(reason); changed();
  }
  function begin(account, { kind = 'manual', key = account.id } = {}) {
    if (initialError) throw initialError;
    let run = store.runs.findLast(entry => !entry.endedAt && entry.loginId === account.loginId && entry.key === key && entry.kind === kind);
    if (!run) {
      if (kind === 'rotation') for (const previous of store.runs.filter(entry => !entry.endedAt && entry.loginId === account.loginId)) finish(previous, '开始新的区服轮换');
      run = { id: randomUUID(), loginId: account.loginId, key, kind, startedAt: now(), endedAt: null, reason: '', roles: {}, segments: [], durations: {}, days: {}, totals: emptyTotals(), events: [], seen: {}, operations: {} };
      store.runs.push(run);
      // Retain summaries for recent runs. Active and today's reports are never trimmed.
      const cutoff = now() - 30 * 86400000;
      store.runs = store.runs.filter(entry => !entry.endedAt || entry.endedAt >= cutoff);
    }
    run.roles[account.id] = { id: account.id, label: clean(account.label), world: clean(account.world) };
    for (const [id, entry] of Object.entries(run.operations)) if (entry.status !== 'pending' && entry.at < now() - 30 * 86400000) delete run.operations[id];
    const segment = { id: randomUUID(), roleId: account.id, startedAt: now(), endedAt: null, onlineSince: null, onlineMs: 0, onlineDays: {}, online: false };
    run.segments.push(segment); changed(); flush();
    return { runId: run.id, segmentId: segment.id };
  }
  function segmentFor(id) { for (const run of store.runs) { const segment = run.segments.find(entry => entry.id === id); if (segment) return segment; } }
  function foldDuration(run, segment) {
    const duration = run.durations[segment.roleId] ??= { elapsedMs: 0, elapsedDays: {}, onlineMs: 0, onlineDays: {} };
    duration.elapsedMs += Math.max(0, segment.endedAt - segment.startedAt);
    for (let at = segment.startedAt; at < segment.endedAt;) { const next = Math.min(segment.endedAt, dayEnd(at)); plus(duration.elapsedDays, beijingDay(at), next - at); at = next; }
    duration.onlineMs += segment.onlineMs;
    for (const [day, amount] of Object.entries(segment.onlineDays)) plus(duration.onlineDays, day, amount);
    changed();
  }
  function accrue(segment, until = now()) {
    if (segment.onlineSince == null) return;
    let at = segment.onlineSince;
    while (at < until) { const next = Math.min(until, dayEnd(at)); plus(segment.onlineDays, beijingDay(at), next - at); segment.onlineMs += next - at; at = next; }
    segment.onlineSince = until;
  }
  function online(id, value) {
    const segment = segmentFor(id);
    if (!segment || segment.endedAt) return;
    accrue(segment); segment.online = value; segment.onlineSince = value ? now() : null; changed();
  }
  function endSegment(id) {
    const segment = segmentFor(id);
    if (!segment || segment.endedAt) return;
    accrue(segment); segment.onlineSince = null; segment.online = false; segment.endedAt = now(); changed();
    const run = store.runs.find(entry => entry.segments.includes(segment));
    foldDuration(run, segment);
    run.segments = run.segments.filter(entry => entry !== segment);
  }
  function end(runId, reason, { preserve = false } = {}) { if (!preserve) finish(find(runId), reason); }
  function endLogin(loginId, reason) { for (const run of store.runs.filter(entry => entry.loginId === loginId && !entry.endedAt)) finish(run, reason); }
  function record(runId, roleId, input) {
    const run = find(runId);
    if (!run || !run.roles[roleId]) return;
    const at = input.at ?? now(), day = beijingDay(at), id = roleId + ':' + clean(input.id || randomUUID());
    if (run.seen[id]) return;
    run.seen[id] = true;
    const event = { id, at, day, roleId, kind: input.kind, label: clean(input.label), category: clean(input.category || '其他'), status: input.status || 'confirmed', gains: {}, costs: {}, detail: clean(input.detail) };
    for (const field of ['gains', 'costs']) for (const [item, amount] of Object.entries(input[field] ?? {})) if (!['__proto__', 'constructor', 'prototype'].includes(item) && Number.isSafeInteger(amount) && amount > 0 && amount <= Number.MAX_SAFE_INTEGER) event[field][clean(item)] = amount;
    const daily = run.days[day] ??= {};
    const role = daily[roleId] ??= emptyTotals();
    for (const totals of [role, run.totals]) {
      if (event.kind === 'action') {
        if (event.status === 'confirmed') { totals.completed++; plus(totals.actions, event.category, 1); }
        else if (event.status === 'failed') totals.failed++;
      }
      if (event.kind === 'round') totals.rounds++;
      for (const field of ['gains', 'costs']) for (const [item, amount] of Object.entries(event[field])) plus(totals[field], item, amount);
      for (const field of ['gains', 'costs']) for (const [item, amount] of Object.entries(event[field])) {
        const sources = totals[field === 'gains' ? 'gainSources' : 'costSources'] ??= {};
        plus(sources[item] ??= {}, event.label || event.category, amount);
      }
    }
    run.events.push(event);
    if (run.events.length > 2000) {
      for (const removed of run.events.splice(0, run.events.length - 2000)) if (!removed.id.includes(':step:')) delete run.seen[removed.id];
    }
    changed();
    return event;
  }
  function operation(runId, roleId, input) {
    const run = find(runId); if (!run || !input.operationId) return;
    const old = run.operations[input.operationId];
    const status = ['confirmed', 'cancelled'].includes(input.phase) ? input.phase : 'pending';
    if (old && (old.status === status || ['confirmed', 'cancelled'].includes(old.status))) return;
    run.operations[input.operationId] = { roleId, status, at: old?.at ?? now(), label: clean(input.label || old?.label || input.request), detail: clean(input.reason), attempt: input.attempt ?? old?.attempt };
    changed();
  }
  function step(runId, roleId, entry) {
    const run = find(runId), taskId = entry.taskKey || entry.step?.request || entry.label || entry.title;
    const pendingId = 'task:' + roleId + ':' + clean(taskId);
    if (entry.status === 'pending' || entry.status === 'unknown') {
      const attempt = (entry.resultVisitId || '') + ':' + (entry.round || 0);
      const old = run?.operations[pendingId];
      if (old && old.status !== 'pending' && old.attempt !== attempt) delete run.operations[pendingId];
      operation(runId, roleId, { operationId: pendingId, phase: 'unknown', label: entry.step?.label || entry.label || entry.title, reason: entry.error || entry.reason, attempt });
      return;
    }
    if (run?.operations[pendingId] && (entry.ok || entry.status === 'empty')) operation(runId, roleId, { operationId: pendingId, phase: 'confirmed' });
    if (entry.skipped || entry.planned || !entry.ok && !entry.error) return;
    const label = entry.step?.label || entry.label || entry.title || entry.note || '挂机操作';
    // Recurring observation messages describe state, not completed work.
    if (!entry.step?.request && /检查|复查|已同步|尚无|等待/.test(label)) return;
    record(runId, roleId, { id: entry.operationId && 'step:' + entry.operationId, kind: 'action', status: entry.ok ? 'confirmed' : 'failed', label, category: entry.resultCategory || entry.category || '其他', detail: entry.error || entry.reason || entry.note });
  }
  function view(account, { scope = 'role', period = 'current', page = 1, limit = 50 } = {}) {
    const at = now(), day = beijingDay(at), matches = run => run.loginId === account.loginId && (scope === 'login' || run.roles[account.id] || run.kind === 'rotation');
    const latest = store.runs.findLast(matches);
    const runs = period === 'today' ? store.runs.filter(matches) : latest ? [latest] : [];
    const totals = emptyTotals(), roles = new Map(), events = [], pending = [];
    for (const run of runs) {
      const roleIds = scope === 'login' ? Object.keys(run.roles) : [account.id];
      for (const roleId of roleIds) {
        const meta = run.roles[roleId]; if (!meta) continue;
        const summary = roles.get(roleId) ?? { ...meta, ...emptyTotals(), elapsedMs: 0, onlineMs: 0 };
        roles.set(roleId, summary);
        const duration = run.durations[roleId];
        if (duration) {
          summary.elapsedMs += period === 'today' ? duration.elapsedDays[day] ?? 0 : duration.elapsedMs;
          summary.onlineMs += period === 'today' ? duration.onlineDays[day] ?? 0 : duration.onlineMs;
        }
        for (const [date, values] of Object.entries(run.days)) {
          if (period === 'today' && date !== day || !values[roleId]) continue;
          for (const target of [totals, summary]) {
            for (const field of ['completed', 'failed', 'rounds']) target[field] += values[roleId][field];
            for (const field of ['gains', 'costs', 'actions']) for (const [key, amount] of Object.entries(values[roleId][field])) plus(target[field], key, amount);
            for (const field of ['gainSources', 'costSources']) for (const [item, sources] of Object.entries(values[roleId][field] ?? {})) {
              const destination = target[field][item] ??= {};
              for (const [label, amount] of Object.entries(sources)) plus(destination, label, amount);
            }
          }
        }
        for (const segment of run.segments.filter(entry => entry.roleId === roleId)) {
          const end = segment.endedAt ?? at, start = period === 'today' ? Math.max(segment.startedAt, dayEnd(at) - 86400000) : segment.startedAt;
          summary.elapsedMs += Math.max(0, end - start);
          let onlineMs = period === 'today' ? segment.onlineDays[day] ?? 0 : segment.onlineMs;
          if (segment.onlineSince != null) onlineMs += Math.max(0, end - Math.max(segment.onlineSince, period === 'today' ? dayEnd(at) - 86400000 : 0));
          summary.onlineMs += onlineMs;
        }
      }
      events.push(...run.events.filter(entry => roleIds.includes(entry.roleId) && (period !== 'today' || entry.day === day) && entry.kind !== 'round'));
      pending.push(...Object.values(run.operations).filter(entry => entry.status === 'pending' && roleIds.includes(entry.roleId) && (period !== 'today' || beijingDay(entry.at) === day)));
    }
    events.sort((a, b) => b.at - a.at);
    return { trackingStartedAt: store.trackingStartedAt, warning: writeError, now: at, day, scope, period, run: latest ? { id: latest.id, kind: latest.kind, startedAt: latest.startedAt, endedAt: latest.endedAt, reason: latest.reason } : null,
      totals: { ...totals, elapsedMs: [...roles.values()].reduce((n, entry) => n + entry.elapsedMs, 0), onlineMs: [...roles.values()].reduce((n, entry) => n + entry.onlineMs, 0), pending: pending.length },
      roles: [...roles.values()], pending: pending.slice(-50), events: events.slice((page - 1) * limit, page * limit), page, pages: Math.max(1, Math.ceil(events.length / limit)), retainedEvents: events.length };
  }
  if (automatic) { timer = setInterval(() => { for (const run of store.runs) for (const segment of run.segments) if (segment.onlineSince != null) { accrue(segment); changed(); } try { flush(); } catch (error) { onError(error); } }, 5000); timer.unref?.(); }
  return { begin, online, endSegment, end, endLogin, record, step, operation, view, flush,
    close() { clearInterval(timer); for (const run of store.runs) for (const segment of run.segments) if (!segment.endedAt) endSegment(segment.id); flush(); closed = true; },
  };
}
