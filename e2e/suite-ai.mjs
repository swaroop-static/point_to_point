import { join } from 'node:path';
import { makeImages } from './fixtures.mjs';
import { chooseFiles, newPage } from './lib.mjs';

/**
 * AI click-to-segment through the real UI. Needs the internet (it downloads
 * the model from huggingface.co), so it only runs with E2E_AI=1.
 */
export async function run({ browser, base, rep, dir, errors }) {
  if (!process.env.E2E_AI) { rep.skip('AI click-to-segment', 'set E2E_AI=1 to run (downloads a model)'); return; }
  const files = makeImages(join(dir, 'images-ai'));
  const page = await newPage(browser, errors);
  await page.goto(base); await page.waitForTimeout(400);
  await chooseFiles(page, 'Choose images', files.disc); await page.waitForTimeout(600);
  rep.ok('AI click button is visible', await page.getByRole('button', { name: 'AI click' }).isVisible());
  await page.getByRole('button', { name: 'AI click' }).click();
  await page.locator('label.ai-model', { hasText: 'SlimSAM' }).locator('input').check();
  const simd = await page.evaluate(() => WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])));
  await page.getByRole('button', { name: /Download .* MB and enable|Enable \(already/ }).click();
  if (!simd) {
    await page.waitForSelector('.ai-status.err', { timeout: 10000 });
    rep.ok('without WebAssembly SIMD, a clear message is shown (no download attempted)', /SIMD/.test(await page.locator('.ai-status.err').innerText()));
    await page.close();
    return;
  }
  await page.waitForSelector('.ai-status.ok, .ai-status.err', { timeout: 240000 });
  rep.ok('model downloads and starts', await page.locator('.ai-status.ok').count() === 1, await page.locator('.ai-status').first().innerText());
  const cv = await page.locator('canvas.stage-canvas').first().boundingBox();
  await page.mouse.click(cv.x + cv.width / 2, cv.y + cv.height / 2);
  await page.waitForFunction(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent === 'Accept polygon'); return b && !b.disabled; }, null, { timeout: 240000 });
  await page.getByRole('button', { name: 'Accept polygon' }).click(); await page.waitForTimeout(300);
  const rows = await page.locator('.ann-row').allInnerTexts();
  rep.ok('accepting adds an editable polygon', rows.length === 1 && /polygon, \d+ vertices/.test(rows[0]), rows.join('|').replace(/\n/g, ' '));
  await page.close();
}
