import { existsSync } from 'node:fs';
import { makeReporter, launch, startServer, tempDir } from './lib.mjs';

/**
 * Usage: npm run e2e            (BROWSER=chromium|firefox|webkit, default chromium)
 *        BROWSER=all npm run e2e   runs all three
 * Builds nothing: run `npm run build` first. Exits non-zero on any FAIL.
 */
if (!existsSync('dist/index.html')) { console.error('dist/ not found. Run `npm run build` first.'); process.exit(2); }

const suites = process.env.SUITES ? process.env.SUITES.split(',') : ['2d', 'mesh', 'cloud', 'ai'];
const browsers = (process.env.BROWSER || 'chromium') === 'all' ? ['chromium', 'firefox', 'webkit'] : [process.env.BROWSER || 'chromium'];
const server = await startServer();
let failed = 0;
for (const name of browsers) {
  const browser = await launch(name);
  for (const s of suites) {
    const rep = makeReporter(s);
    const errors = [];
    const dir = tempDir();
    try {
      const mod = await import(`./suite-${s}.mjs`);
      await mod.run({ browser, base: server.url, rep, dir, errors, browserName: name });
      // Console errors are failures, except the known warning three.js prints for an all-NaN PLY.
      const real = errors.filter((e) => !/computeBoundingSphere/.test(e));
      rep.ok('no console or page errors', real.length === 0, real.slice(0, 3).join(' | '));
    } catch (e) {
      rep.ok('suite ran to completion', false, String(e && e.message || e).split('\n')[0]);
    }
    for (const r of rep.rows) {
      if (r.status === 'FAIL') failed++;
      console.log(`${r.status.padEnd(4)} [${name}/${s}] ${r.name}${r.detail ? '  (' + r.detail + ')' : ''}`);
    }
  }
  await browser.close();
}
await server.close();
console.log(failed ? `\n${failed} FAILED` : '\nAll e2e checks passed (SKIP lines were not run).');
process.exit(failed ? 1 : 0);
