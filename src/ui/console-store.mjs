import { createStore } from 'zustand/vanilla';

const emptyStatus = Object.freeze({ connected: false, state: 'IDLE', busy: null, looping: false });
export const selectCurrentStatus = state => state.accountsById[state.currentAccountId]?.status ?? emptyStatus;
export const selectCurrentAccount = state => state.accountsById[state.currentAccountId] ?? null;
export const selectAccounts = state => state.accountIds.map(id => state.accountsById[id]);

// One store per browser/fixture. Server sessions and credentials never live here.
// Actions replace objects and Sets; selectors can rely on reference equality.
export function createConsoleStore() {
  return createStore((set, get) => ({
    currentAccountId: null,
    accountIds: [],
    accountsById: {},
    disconnected: new Set(),
    connecting: new Set(),
    hosting: new Set(),
    gameByAccount: {},
    slices: {},
    view: { page: 'overview', resource: 'guild', logAccount: 'all', logGroup: 'all', onlyIssues: false, loginSettingsAccountId: null },
    actions: {
      replaceAccounts(rows, activeId, { preserveStatus = false, select = false } = {}) {
        set(state => {
          const accountsById = Object.fromEntries(rows.map(row => [row.id, {
            ...row,
            status: preserveStatus && state.accountsById[row.id]
              ? state.accountsById[row.id].status : { ...(row.status ?? {}) },
          }]));
          const accountIds = rows.map(row => row.id);
          const preferred = select ? activeId : state.currentAccountId;
          const currentAccountId = Object.hasOwn(accountsById, preferred) ? preferred
            : Object.hasOwn(accountsById, activeId) ? activeId : accountIds[0] ?? null;
          const keep = values => new Set([...values].filter(id => Object.hasOwn(accountsById, id)));
          return { accountsById, accountIds, currentAccountId,
            view: state.view.loginSettingsAccountId && !Object.hasOwn(accountsById, state.view.loginSettingsAccountId)
              ? { ...state.view, loginSettingsAccountId: null } : state.view,
            disconnected: keep(state.disconnected), connecting: keep(state.connecting), hosting: keep(state.hosting),
            gameByAccount: Object.fromEntries(Object.entries(state.gameByAccount).filter(([id]) => Object.hasOwn(accountsById, id))),
            slices: Object.fromEntries(Object.entries(state.slices).filter(([key]) =>
              !key.startsWith('loginSettings:') || key === 'loginSettings:none' || Object.hasOwn(accountsById, key.slice('loginSettings:'.length)))),
          };
        });
      },
      mergeStatuses(rows) {
        set(state => {
          const accountsById = { ...state.accountsById };
          for (const row of rows) {
            if (!Object.hasOwn(accountsById, row.id)) continue;
            accountsById[row.id] = { ...accountsById[row.id], status: { ...(row.status ?? {}) },
              ...(Object.hasOwn(row, 'lastSeen') ? { lastSeen: row.lastSeen } : {}),
              ...(Object.hasOwn(row, 'label') ? { label: row.label } : {}),
              ...(Object.hasOwn(row, 'title') && row.roleId ? { title: row.title } : {}),
              ...(Object.hasOwn(row, 'roleId') ? { roleId: row.roleId, bornWorldId: row.bornWorldId,
                bornWorldName: row.bornWorldName, loginAccountId: row.loginAccountId } : {}),
            };
          }
          return { accountsById };
        });
      },
      upsertAccount(account) {
        set(state => ({ accountsById: { ...state.accountsById, [account.id]: { ...account, status: { ...(account.status ?? {}) } } },
          accountIds: Object.hasOwn(state.accountsById, account.id) ? state.accountIds : [...state.accountIds, account.id] }));
      },
      selectAccount(id) {
        if (id !== null && !Object.hasOwn(get().accountsById, id)) return false;
        set({ currentAccountId: id });
        return true;
      },
      setStatus(id, status) {
        if (!Object.hasOwn(get().accountsById, id)) return;
        set(state => ({ accountsById: { ...state.accountsById,
          [id]: { ...state.accountsById[id], status: { ...(status ?? {}) } } } }));
      },
      patchStatus(id, patch) {
        const row = get().accountsById[id];
        if (row) get().actions.setStatus(id, { ...row.status, ...patch });
      },
      setFlag(flag, id, enabled) {
        if (!['connecting', 'disconnected', 'hosting'].includes(flag)) throw new Error('未知账号操作状态');
        if (!Object.hasOwn(get().accountsById, id) || get()[flag].has(id) === enabled) return;
        set(state => {
          const values = new Set(state[flag]);
          if (enabled) values.add(id); else values.delete(id);
          return { [flag]: values };
        });
      },
      setGameData(id, key, data) {
        if (!Object.hasOwn(get().accountsById, id)) return;
        set(state => ({ gameByAccount: { ...state.gameByAccount,
          [id]: { ...state.gameByAccount[id], [key]: data } } }));
      },
      setView(patch) {
        set(state => Object.keys(patch).every(key => Object.is(state.view[key], patch[key]))
          ? state : { view: { ...state.view, ...patch } });
      },
      patchSlice(key, patch) {
        if (key.startsWith('loginSettings:') && key !== 'loginSettings:none'
            && !Object.hasOwn(get().accountsById, key.slice('loginSettings:'.length))) return;
        set(state => ({ slices: { ...state.slices, [key]: { ...state.slices[key], ...patch } } }));
      },
    },
  }));
}

// Transitional subscriptions for the DOM pages. Local names are read-only
// projections; all writes go through actions. No second mutable store is kept.
export function bindConsoleSlice(store, key, initial, listener) {
  if (!Object.hasOwn(store.getState().slices, key)) store.getState().actions.patchSlice(key, initial);
  listener(store.getState().slices[key]);
  return store.subscribe((state, previous) => {
    if (state.slices[key] !== previous.slices[key]) listener(state.slices[key]);
  });
}

export function createConsoleRuntime(consoleStore = createConsoleStore()) {
  const stateActions = consoleStore.getState().actions;
  const patchConsoleSlice = (key, patch) => stateActions.patchSlice(key, patch);
  const setConsoleValue = (slice, key, value) => {
    patchConsoleSlice(slice, { [key]: value });
    return value;
  };
  const mutateConsoleValue = (slice, key, change) => {
    const value = structuredClone(consoleStore.getState().slices[slice][key]);
    const result = change(value);
    setConsoleValue(slice, key, value);
    return result;
  };
  const bindConsoleObject = (slice, object, fields) => {
    patchConsoleSlice(slice, Object.fromEntries(fields.map(key => [key, object[key]])));
    for (const key of fields) Object.defineProperty(object, key, {
      enumerable: true,
      get: () => consoleStore.getState().slices[slice][key],
      set: value => setConsoleValue(slice, key, value),
    });
    return object;
  };
  return { consoleStore, stateActions, patchConsoleSlice, setConsoleValue, mutateConsoleValue, bindConsoleObject,
    bindConsoleSlice: (key, initial, listener) => bindConsoleSlice(consoleStore, key, initial, listener) };
}
