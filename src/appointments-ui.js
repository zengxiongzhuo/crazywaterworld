// 委任设置按账号保存。在途保存继续归属原账号，连续调整按最新顺序串行提交。
const appointmentsEditors = new Map();
let appointmentsOwner = null;
let appointmentsDrag = null;

function appointmentsEditor() {
  if (!current) return null;
  if (!appointmentsEditors.has(current)) appointmentsEditors.set(current, {
    owner: current, data: null, draft: null, loading: false, saving: false, error: null,
  });
  return appointmentsEditors.get(current);
}

function appointmentsDirty(editor) {
  return !!editor?.draft && JSON.stringify(editor.draft) !== JSON.stringify(editor.data?.settings);
}

function appointmentsPaintState(editor = appointmentsEditor()) {
  if (editor && editor.owner !== current) return;
  const unavailable = !editor?.draft || editor.loading;
  const conflict = !!editor?.error?.fields?.revision;
  const button = $('appointments-enabled');
  setTaskSwitch(button, editor?.draft?.enabled === true);
  button.disabled = unavailable || conflict;
  $('appointments-priorities').setAttribute('aria-busy', String(!!editor?.loading));
  const status = $('appointments-state');
  status.dataset.error = String(!!editor?.error);
  status.textContent = !current ? '请选择账号'
    : editor?.loading ? '正在载入…'
    : conflict ? '设置已更新，请重新载入'
    : editor?.error ? editor.error.message
    : editor?.saving ? '正在保存…'
    : editor?.draft ? '已保存' : '尚未载入';
  $('appointments-retry').hidden = !editor?.error || conflict || !appointmentsDirty(editor);
  $('appointments-reload').hidden = !editor?.error;
  $('appointments-reload').disabled = !!editor?.saving || !!editor?.loading;
}

function appointmentsButton(label, onClick) {
  const button = el('button', 'config-small-button', label);
  button.type = 'button';
  button.onclick = onClick;
  return button;
}

function appointmentsRender(focusId, focusAction = 'drag') {
  appointmentsCancelDrag();
  const editor = appointmentsEditor();
  const list = clear($('appointments-priorities'));
  appointmentsPaintState(editor);
  if (!editor?.draft) return;
  const disabled = editor.loading || !!editor.error?.fields?.revision;
  const values = editor.draft.priorities;
  let focus;
  values.forEach((id, index) => {
    const label = editor.data.options.find(option => option.value === id)?.label || id;
    const row = el('li', 'appointments-priority');
    row.dataset.priority = id;
    const handle = appointmentsButton('', null);
    handle.classList.add('appointments-drag');
    handle.setAttribute('aria-label', '调整' + label + '优先级，可使用上下方向键');
    handle.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown');
    handle.title = '拖动调整优先级';
    handle.disabled = disabled;
    const grip = el('span', 'appointments-grip');
    grip.setAttribute('aria-hidden', 'true');
    handle.append(grip);
    handle.onpointerdown = event => appointmentsStartDrag(event, editor, id, row, handle);
    handle.onkeydown = event => {
      if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      appointmentsMove(editor, id, index + (event.key === 'ArrowUp' ? -1 : 1));
    };
    const tools = el('div', 'appointments-tools');
    const up = appointmentsButton('上移', () => appointmentsMove(editor, id, index - 1, 'up'));
    const down = appointmentsButton('下移', () => appointmentsMove(editor, id, index + 1, 'down'));
    up.setAttribute('aria-label', label + '上移');
    down.setAttribute('aria-label', label + '下移');
    up.disabled = disabled || index === 0;
    down.disabled = disabled || index === values.length - 1;
    tools.append(up, down);
    row.append(handle, el('span', 'appointments-number', String(index + 1)), el('span', 'appointments-label', label), tools);
    list.append(row);
    if (id === focusId) focus = focusAction === 'up' ? up : focusAction === 'down' ? down : handle;
    if (focus?.disabled && id === focusId) focus = handle;
  });
  focus?.focus();
}

function appointmentsMove(editor, id, to, action = 'drag') {
  if (editor.owner !== current || editor.loading || editor.error?.fields?.revision) return;
  const values = [...editor.draft.priorities];
  const from = values.indexOf(id);
  if (from < 0 || to < 0 || to >= values.length || to === from) return;
  values.splice(from, 1);
  values.splice(to, 0, id);
  editor.draft.priorities = values;
  editor.error = null;
  appointmentsRender(id, action);
  const label = editor.data.options.find(option => option.value === id)?.label || id;
  $('appointments-feedback').textContent = label + '已移至第' + (to + 1) + '位';
  void appointmentsSave(editor);
}

function appointmentsClearDrop() {
  for (const row of $('appointments-priorities').children) delete row.dataset.drop;
}

function appointmentsCancelDrag() {
  const drag = appointmentsDrag;
  appointmentsDrag = null;
  appointmentsClearDrop();
  if (!drag) return;
  delete drag.row.dataset.dragging;
  if (drag.handle.hasPointerCapture(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);
}

function appointmentsStartDrag(event, editor, id, row, handle) {
  if (event.button !== 0 || event.isPrimary === false || handle.disabled || editor.owner !== current) return;
  appointmentsCancelDrag();
  appointmentsDrag = { editor, id, row, handle, pointerId: event.pointerId, startY: event.clientY, to: editor.draft.priorities.indexOf(id), moved: false };
  handle.setPointerCapture(event.pointerId);
  handle.onpointermove = move => {
    const drag = appointmentsDrag;
    if (!drag || move.pointerId !== drag.pointerId) return;
    if (!drag.moved && Math.abs(move.clientY - drag.startY) < 5) return;
    drag.moved = true;
    drag.row.dataset.dragging = 'true';
    const rows = [...$('appointments-priorities').children].filter(item => item !== row);
    const index = rows.findIndex(item => {
      const rect = item.getBoundingClientRect();
      return move.clientY < rect.top + rect.height / 2;
    });
    drag.to = index < 0 ? rows.length : index;
    appointmentsClearDrop();
    if (index < 0 && rows.length) rows.at(-1).dataset.drop = 'after';
    else if (rows[index]) rows[index].dataset.drop = 'before';
    if (move.clientY < 48) window.scrollBy(0, -16);
    else if (move.clientY > window.innerHeight - 48) window.scrollBy(0, 16);
  };
  handle.onpointerup = up => {
    const drag = appointmentsDrag;
    if (!drag || up.pointerId !== drag.pointerId) return;
    appointmentsCancelDrag();
    if (drag.moved) appointmentsMove(editor, id, drag.to);
  };
  handle.onpointercancel = handle.onlostpointercapture = () => appointmentsCancelDrag();
}

async function appointmentsLoad(force = false) {
  const editor = appointmentsEditor();
  if (!editor || editor.loading || editor.saving || appointmentsDirty(editor) || (!force && editor.data)) return;
  editor.loading = true;
  editor.error = null;
  appointmentsRender();
  try {
    const data = await call('/api/appointments/settings?account=' + encodeURIComponent(editor.owner));
    editor.data = data;
    editor.draft = structuredClone(data.settings);
  } catch (error) {
    editor.error = error;
  } finally {
    editor.loading = false;
    if (editor.owner === current) appointmentsRender();
  }
}

async function appointmentsSave(editor) {
  if (!editor || editor.saving || editor.loading || editor.error?.fields?.revision) return;
  editor.saving = true;
  editor.error = null;
  appointmentsPaintState(editor);
  try {
    while (appointmentsDirty(editor)) {
      const text = JSON.stringify(editor.draft);
      const data = await call('/api/appointments/settings?account=' + encodeURIComponent(editor.owner), {
        method: 'POST', body: JSON.stringify({ settings: JSON.parse(text), revision: editor.data.revision, baseRevision: editor.data.baseRevision }),
      });
      editor.data = data;
      if (JSON.stringify(editor.draft) === text) editor.draft = structuredClone(data.settings);
      if (editor.owner === current) loopSettingsRevision = data.revision;
    }
  } catch (error) {
    editor.error = error;
  } finally {
    editor.saving = false;
    if (editor.owner === current) {
      if (editor.error?.fields?.revision) appointmentsRender();
      else appointmentsPaintState(editor);
    }
  }
}

function appointmentsAccountChanged() {
  if (appointmentsOwner === current) return;
  appointmentsOwner = current;
  appointmentsRender();
  if (current && !$('tab-heroes').classList.contains('hidden')) void appointmentsLoad(true);
}

$('appointments-enabled').onclick = () => {
  const editor = appointmentsEditor();
  if (!editor?.draft || $('appointments-enabled').disabled) return;
  editor.draft.enabled = !editor.draft.enabled;
  editor.error = null;
  appointmentsPaintState(editor);
  void appointmentsSave(editor);
};
$('appointments-retry').onclick = () => void appointmentsSave(appointmentsEditor());
$('appointments-reload').onclick = () => {
  const editor = appointmentsEditor();
  if (!editor || editor.saving || editor.loading) return;
  editor.draft = editor.data ? structuredClone(editor.data.settings) : null;
  void appointmentsLoad(true);
};
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && appointmentsDrag) appointmentsCancelDrag();
});
