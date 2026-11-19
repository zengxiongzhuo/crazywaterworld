import { readFileSync } from 'node:fs';
import { consoleLogin } from './ui/dist/console.mjs';

const css = readFileSync(new URL('./ui/dist/theme.css', import.meta.url), 'utf8');
const theme = readFileSync(new URL('./theme-ui.js', import.meta.url), 'utf8');

export const LOGIN_PAGE = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#ffffff">
<title>登录 · 疯狂水世界</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3E%3Crect fill='%23102d39' width='40' height='40' rx='8'/%3E%3Cpath fill='%23ffbd77' d='m20 3 4 13 13 4-13 4-4 13-4-13-13-4 13-4z'/%3E%3C/svg%3E">
<script>${theme}</script>
<style>@layer properties, theme, base, components, page, utilities;
@layer page {
  .console-login { min-height: 100svh; display: grid; place-items: center; padding: 32px 20px; }
  .console-login-wrap { width: 100%; max-width: 400px; }
  .console-login-brand { display: flex; align-items: center; justify-content: center; gap: 10px; margin-bottom: 24px; font-size: 14px; font-weight: 600; }
  .console-login-brand svg { width: 22px; height: 22px; }
  .console-login-icon { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 12px; background: var(--muted); }
  .console-login-icon svg { width: 22px; height: 22px; }
  .console-login-note { margin-top: 20px; text-align: center; font-size: 12px; color: var(--muted-foreground); }
} ${css}</style>
</head><body>${consoleLogin()}
<script>
const form = document.getElementById('console-login-form');
const password = document.getElementById('console-password');
const button = document.getElementById('console-login-submit');
const error = document.getElementById('console-login-error');
password.addEventListener('input', () => { error.hidden = true; password.removeAttribute('aria-invalid'); });
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (button.disabled) return;
  error.hidden = true; button.disabled = true; button.textContent = '正在登录…';
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: password.value })
    });
    const data = await response.json();
    if (!response.ok) {
      password.value = ''; password.setAttribute('aria-invalid', 'true');
      throw new Error(data.error || '登录失败，请重试');
    }
    password.value = ''; location.replace('/');
  } catch (failure) {
    error.textContent = failure.message || '连接失败，请检查控制台是否运行'; error.hidden = false;
    button.disabled = false; button.textContent = '进入控制台'; password.focus();
  }
});
</script></body></html>`;
