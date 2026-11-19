// 在样式加载前恢复主题，避免刷新时短暂显示白天配色。
(() => {
  const storageKey = 'cw-theme';
  const labels = { system: '跟随系统', light: '白天', dark: '黑夜' };
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  let renderControls = () => {};

  function readMode() {
    try {
      const saved = localStorage.getItem(storageKey);
      if (Object.hasOwn(labels, saved)) return saved;
    } catch {}
    return 'system';
  }

  let mode = readMode();

  function applyTheme() {
    const dark = mode === 'dark' || (mode === 'system' && systemTheme.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.querySelector('meta[name="theme-color"]').content = dark ? '#0a0a0a' : '#ffffff';
    renderControls();
  }

  applyTheme();
  systemTheme.addEventListener('change', () => {
    if (mode === 'system') applyTheme();
  });
  window.addEventListener('storage', event => {
    if (event.key !== storageKey && event.key !== null) return;
    mode = readMode();
    applyTheme();
  });

  document.addEventListener('DOMContentLoaded', () => {
    const picker = document.getElementById('theme-picker');
    const trigger = document.getElementById('theme-trigger');
    const menu = document.getElementById('theme-menu');
    if (!picker || !trigger || !menu) return;
    const options = Array.from(menu.querySelectorAll('[data-theme-option]'));

    renderControls = () => {
      const title = '切换主题，当前为' + labels[mode];
      trigger.title = title;
      trigger.setAttribute('aria-label', title);
      for (const icon of trigger.querySelectorAll('[data-theme-icon]')) {
        icon.hidden = icon.dataset.themeIcon !== mode;
      }
      for (const option of options) {
        const selected = option.dataset.themeOption === mode;
        option.setAttribute('aria-checked', String(selected));
        option.querySelector('[data-theme-check]').hidden = !selected;
      }
    };
    renderControls();

    function closeMenu(restoreFocus = false) {
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      if (restoreFocus) trigger.focus();
    }

    function openMenu(option = options.find(item => item.dataset.themeOption === mode)) {
      menu.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      option.focus();
    }

    trigger.addEventListener('click', () => {
      if (menu.hidden) openMenu();
      else closeMenu();
    });
    trigger.addEventListener('keydown', event => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      openMenu(event.key === 'ArrowUp' ? options.at(-1) : options[0]);
    });
    for (const option of options) {
      option.addEventListener('click', () => {
        mode = option.dataset.themeOption;
        try { localStorage.setItem(storageKey, mode); } catch {}
        applyTheme();
        closeMenu(true);
      });
    }
    menu.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu(true);
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = options.indexOf(document.activeElement);
      let next = index + (event.key === 'ArrowUp' ? -1 : 1);
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = options.length - 1;
      options[(next + options.length) % options.length].focus();
    });
    document.addEventListener('pointerdown', event => {
      if (!picker.contains(event.target)) closeMenu();
    });
    picker.addEventListener('focusout', event => {
      if (!picker.contains(event.relatedTarget)) closeMenu();
    });
  }, { once: true });
})();
