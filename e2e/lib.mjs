import { chromium, firefox, webkit } from 'playwright';
import { preview } from 'vite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Shared end-to-end helpers. Tests run against the PRODUCTION build (dist/)
 * served by `vite preview`, in a real browser chosen with BROWSER=chromium|firefox|webkit.
 * Set CHROME_PATH to use an installed Chrome instead of Playwright's Chromium.
 */

export async function startServer() {
  const server = await preview({ preview: { port: 0, host: '127.0.0.1', strictPort: false }, logLevel: 'error' });
  const url = server.resolvedUrls?.local?.[0] ?? `http://127.0.0.1:${server.config.preview.port}/`;
  return { url, close: () => new Promise((r) => server.httpServer.close(() => r())) };
}

export async function launch(name) {
  const gl = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
  if (name === 'firefox') return firefox.launch({ headless: true });
  if (name === 'webkit') return webkit.launch({ headless: true });
  return chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined, args: gl });
}

export function tempDir(prefix = 'aa-e2e-') { return mkdtempSync(join(tmpdir(), prefix)); }

/** Collects PASS/FAIL/SKIP lines. */
export function makeReporter(suite) {
  const rows = [];
  return {
    rows,
    ok(name, cond, detail = '') { rows.push({ suite, status: cond ? 'PASS' : 'FAIL', name, detail }); },
    skip(name, why) { rows.push({ suite, status: 'SKIP', name, detail: why }); },
  };
}

export async function newPage(browser, errors, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true, ...opts });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  page.on('dialog', (d) => d.accept());
  return page;
}

export async function hasWebGL(page) {
  return page.evaluate(() => { try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; } });
}

export async function chooseFiles(page, buttonName, files) {
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: buttonName }).first().click()]);
  await fc.setFiles(files);
}

export const toasts = async (page) => (await page.locator('.toast').allInnerTexts()).join(' | ');
