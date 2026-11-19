import { resourceFieldTargets } from './resource-field-allocation.mjs';

// A full personal field list distinguishes a lost holding from a slot that was never filled.
// Keep that distinction across restarts, scoped to the player within the account ledger.
export function observeResourceFieldHoldings(state, { scope, previous, policy, ledger, previewOnly, releasing, upgrades }) {
  if (!previous || !state.fieldsSynced) return;
  const targets = resourceFieldTargets(policy, state.maxNum);
  const owned = {};
  for (const field of state.owned) {
    const id = field.resourceId || previous.owned[field.grid] || previous.settled?.[field.grid];
    if (!id) { state.lossHistoryReason = '已占资源田的类型未同步，暂缓自动占田'; return; }
    owned[field.grid] = id;
  }
  if (previous.revision !== ledger.resourceFieldHistory(scope).revision) {
    state.lossHistoryReason = '资源田记录在同步期间已变化，等待重新读取';
    return;
  }
  const lost = { ...previous.lost };
  for (const [grid, id] of Object.entries({ ...previous.owned, ...previous.settled })) {
    if (!owned[grid] && !releasing.has(Number(grid))) lost[grid] = id;
  }
  // A recovered grid clears its own loss. A newly occupied different grid can
  // also fill a lost slot, while ordinary initial fills still count separately.
  const gains = {};
  const counts = {};
  for (const [grid, id] of Object.entries(owned)) {
    counts[id] = (counts[id] ?? 0) + 1;
    if (lost[grid]) delete lost[grid];
    else if (!previous.owned[grid] && !upgrades.has(Number(grid))) gains[id] = (gains[id] ?? 0) + 1;
  }
  for (const [id, gain] of Object.entries(gains)) {
    const missing = Object.keys(lost).filter(grid => lost[grid] === id);
    const recovered = policy?.refillAfterLoss ? gain : Math.min(gain, Math.max(0, counts[id] + missing.length - (targets[id] ?? 0)));
    for (const grid of missing.slice(0, recovered)) delete lost[grid];
  }
  state.lostFields = lost;
  if (previewOnly || !previous.settled && JSON.stringify(owned) === JSON.stringify(previous.owned) && JSON.stringify(lost) === JSON.stringify(previous.lost)) return;
  if (!ledger.saveResourceFieldHistory(scope, { revision: previous.revision, owned, lost })) {
    state.lossHistoryReason = '资源田记录在同步期间已变化，等待重新读取';
  }
}

export function forgetReleasedResourceField(ledger, worldId, playerId, grid) {
  if (!ledger?.resourceFieldHistory || !worldId || !playerId) return;
  const scope = worldId + ':' + playerId;
  for (;;) {
    const history = ledger.resourceFieldHistory(scope);
    if (!history.owned[grid] && !history.lost[grid] && !history.settled?.[grid]) return;
    delete history.owned[grid];
    delete history.lost[grid];
    if (history.settled) delete history.settled[grid];
    if (ledger.saveResourceFieldHistory(scope, history)) return;
  }
}
