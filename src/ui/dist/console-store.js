var CWConsoleState = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/ui/console-store.mjs
  var console_store_exports = {};
  __export(console_store_exports, {
    bindConsoleSlice: () => bindConsoleSlice,
    createConsoleRuntime: () => createConsoleRuntime,
    createConsoleStore: () => createConsoleStore,
    selectAccounts: () => selectAccounts,
    selectCurrentAccount: () => selectCurrentAccount,
    selectCurrentStatus: () => selectCurrentStatus
  });

  // node_modules/zustand/esm/vanilla.mjs
  var createStoreImpl = (createState) => {
    let state;
    const listeners = /* @__PURE__ */ new Set();
    const setState = (partial, replace) => {
      const nextState = typeof partial === "function" ? partial(state) : partial;
      if (!Object.is(nextState, state)) {
        const previousState = state;
        state = (replace != null ? replace : typeof nextState !== "object" || nextState === null) ? nextState : Object.assign({}, state, nextState);
        listeners.forEach((listener) => listener(state, previousState));
      }
    };
    const getState = () => state;
    const getInitialState = () => initialState;
    const subscribe = (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    const api = { setState, getState, getInitialState, subscribe };
    const initialState = state = createState(setState, getState, api);
    return api;
  };
  var createStore = ((createState) => createState ? createStoreImpl(createState) : createStoreImpl);

  // src/ui/console-store.mjs
  var emptyStatus = Object.freeze({ connected: false, state: "IDLE", busy: null, looping: false });
  var selectCurrentStatus = (state) => state.accountsById[state.currentAccountId]?.status ?? emptyStatus;
  var selectCurrentAccount = (state) => state.accountsById[state.currentAccountId] ?? null;
  var selectAccounts = (state) => state.accountIds.map((id) => state.accountsById[id]);
  function createConsoleStore() {
    return createStore((set, get) => ({
      currentAccountId: null,
      accountIds: [],
      accountsById: {},
      disconnected: /* @__PURE__ */ new Set(),
      connecting: /* @__PURE__ */ new Set(),
      hosting: /* @__PURE__ */ new Set(),
      gameByAccount: {},
      slices: {},
      view: { page: "overview", resource: "guild", logAccount: "all", logGroup: "all", onlyIssues: false, loginSettingsAccountId: null },
      actions: {
        replaceAccounts(rows, activeId, { preserveStatus = false, select = false } = {}) {
          set((state) => {
            const accountsById = Object.fromEntries(rows.map((row) => [row.id, {
              ...row,
              status: preserveStatus && state.accountsById[row.id] ? state.accountsById[row.id].status : { ...row.status ?? {} }
            }]));
            const accountIds = rows.map((row) => row.id);
            const preferred = select ? activeId : state.currentAccountId;
            const currentAccountId = Object.hasOwn(accountsById, preferred) ? preferred : Object.hasOwn(accountsById, activeId) ? activeId : accountIds[0] ?? null;
            const keep = (values) => new Set([...values].filter((id) => Object.hasOwn(accountsById, id)));
            return {
              accountsById,
              accountIds,
              currentAccountId,
              view: state.view.loginSettingsAccountId && !Object.hasOwn(accountsById, state.view.loginSettingsAccountId) ? { ...state.view, loginSettingsAccountId: null } : state.view,
              disconnected: keep(state.disconnected),
              connecting: keep(state.connecting),
              hosting: keep(state.hosting),
              gameByAccount: Object.fromEntries(Object.entries(state.gameByAccount).filter(([id]) => Object.hasOwn(accountsById, id))),
              slices: Object.fromEntries(Object.entries(state.slices).filter(([key]) => !key.startsWith("loginSettings:") || key === "loginSettings:none" || Object.hasOwn(accountsById, key.slice("loginSettings:".length))))
            };
          });
        },
        mergeStatuses(rows) {
          set((state) => {
            const accountsById = { ...state.accountsById };
            for (const row of rows) {
              if (!Object.hasOwn(accountsById, row.id)) continue;
              accountsById[row.id] = {
                ...accountsById[row.id],
                status: { ...row.status ?? {} },
                ...Object.hasOwn(row, "lastSeen") ? { lastSeen: row.lastSeen } : {},
                ...Object.hasOwn(row, "label") ? { label: row.label } : {},
                ...Object.hasOwn(row, "title") && row.roleId ? { title: row.title } : {},
                ...Object.hasOwn(row, "roleId") ? {
                  roleId: row.roleId,
                  bornWorldId: row.bornWorldId,
                  bornWorldName: row.bornWorldName,
                  loginAccountId: row.loginAccountId
                } : {}
              };
            }
            return { accountsById };
          });
        },
        upsertAccount(account) {
          set((state) => ({
            accountsById: { ...state.accountsById, [account.id]: { ...account, status: { ...account.status ?? {} } } },
            accountIds: Object.hasOwn(state.accountsById, account.id) ? state.accountIds : [...state.accountIds, account.id]
          }));
        },
        selectAccount(id) {
          if (id !== null && !Object.hasOwn(get().accountsById, id)) return false;
          set({ currentAccountId: id });
          return true;
        },
        setStatus(id, status) {
          if (!Object.hasOwn(get().accountsById, id)) return;
          set((state) => ({ accountsById: {
            ...state.accountsById,
            [id]: { ...state.accountsById[id], status: { ...status ?? {} } }
          } }));
        },
        patchStatus(id, patch) {
          const row = get().accountsById[id];
          if (row) get().actions.setStatus(id, { ...row.status, ...patch });
        },
        setFlag(flag, id, enabled) {
          if (!["connecting", "disconnected", "hosting"].includes(flag)) throw new Error("\u672A\u77E5\u8D26\u53F7\u64CD\u4F5C\u72B6\u6001");
          if (!Object.hasOwn(get().accountsById, id) || get()[flag].has(id) === enabled) return;
          set((state) => {
            const values = new Set(state[flag]);
            if (enabled) values.add(id);
            else values.delete(id);
            return { [flag]: values };
          });
        },
        setGameData(id, key, data) {
          if (!Object.hasOwn(get().accountsById, id)) return;
          set((state) => ({ gameByAccount: {
            ...state.gameByAccount,
            [id]: { ...state.gameByAccount[id], [key]: data }
          } }));
        },
        setView(patch) {
          set((state) => Object.keys(patch).every((key) => Object.is(state.view[key], patch[key])) ? state : { view: { ...state.view, ...patch } });
        },
        patchSlice(key, patch) {
          if (key.startsWith("loginSettings:") && key !== "loginSettings:none" && !Object.hasOwn(get().accountsById, key.slice("loginSettings:".length))) return;
          set((state) => ({ slices: { ...state.slices, [key]: { ...state.slices[key], ...patch } } }));
        }
      }
    }));
  }
  function bindConsoleSlice(store, key, initial, listener) {
    if (!Object.hasOwn(store.getState().slices, key)) store.getState().actions.patchSlice(key, initial);
    listener(store.getState().slices[key]);
    return store.subscribe((state, previous) => {
      if (state.slices[key] !== previous.slices[key]) listener(state.slices[key]);
    });
  }
  function createConsoleRuntime(consoleStore = createConsoleStore()) {
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
      patchConsoleSlice(slice, Object.fromEntries(fields.map((key) => [key, object[key]])));
      for (const key of fields) Object.defineProperty(object, key, {
        enumerable: true,
        get: () => consoleStore.getState().slices[slice][key],
        set: (value) => setConsoleValue(slice, key, value)
      });
      return object;
    };
    return {
      consoleStore,
      stateActions,
      patchConsoleSlice,
      setConsoleValue,
      mutateConsoleValue,
      bindConsoleObject,
      bindConsoleSlice: (key, initial, listener) => bindConsoleSlice(consoleStore, key, initial, listener)
    };
  }
  return __toCommonJS(console_store_exports);
})();
