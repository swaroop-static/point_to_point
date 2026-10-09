import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeClouds } from './fixtures.mjs';
import { chooseFiles, hasWebGL, newPage, toasts } from './lib.mjs';

export async function run({ browser, base, rep, dir, errors }) {
  const { files: f, points: P } = makeClouds(join(dir, 'clouds'));
  const page = await newPage(browser, errors);
  await page.goto(base); await page.waitForTimeout(400);
  if (!(await hasWebGL(page))) { rep.skip('point-cloud workspace', 'this browser has no WebGL'); await page.close(); return; }
  await page.getByRole('button', { name: '3D cloud' }).click(); await page.waitForTimeout(500);
  rep.ok('empty state shown', await page.getByText('Drop a point cloud to annotate').isVisible());
  const rowsText = async () => (await page.locator('.image-row').allInnerTexts()).join('|').replace(/\n/g, ' ');
  const add = async (p) => { await chooseFiles(page, /Choose point cloud|Add cloud/, p); await page.waitForTimeout(1500); };
  const N = P.length;
  const insideRef = (c, s, yaw) => { let n = 0; for (const p of P) { const da = p[0] - c[0], db = p[1] - c[1], du = p[2] - c[2]; const la = da * Math.cos(yaw) + db * Math.sin(yaw), lb = -da * Math.sin(yaw) + db * Math.cos(yaw); if (Math.abs(la) <= s[0] / 2 && Math.abs(lb) <= s[1] / 2 && Math.abs(du) <= s[2] / 2) n++; } return n; };

  await add(f.junk); rep.ok('all-invalid PLY rejected', /no valid points|Could not read/i.test(await toasts(page)));
  await add(f.compressed); rep.ok('compressed PCD rejected clearly', /Compressed/i.test(await toasts(page)));
  await add(f.ply); rep.ok('PLY loaded with the right point count', (await rowsText()).includes(N.toLocaleString()), await rowsText());

  let box; for (const c of await page.locator('canvas.stage-canvas').all()) { const b = await c.boundingBox(); if (b && b.width > 0) box = b; }
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.keyboard.press('t'); await page.waitForTimeout(400);
  await page.keyboard.press('c'); await page.mouse.click(cx, cy); await page.waitForTimeout(500);
  rep.ok('clicking the cloud in Add mode creates a cuboid', (await page.locator('.ann-row').count()) === 1);
  const field = (l) => page.getByLabel(l, { exact: true });
  const val = async (l) => Number(await field(l).inputValue());
  const setField = async (l, v) => { await field(l).fill(String(v)); await field(l).press('Enter'); await field(l).blur(); await page.waitForTimeout(150); };
  const x0 = await val('Center x');
  await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 60, cy, { steps: 10 }); await page.mouse.up(); await page.waitForTimeout(300);
  const x1 = await val('Center x');
  rep.ok('dragging the cuboid right moves it toward +x (top view)', x1 - x0 > 2, `x ${x0.toFixed(2)} -> ${x1.toFixed(2)}`);
  await page.keyboard.press('Control+z'); await page.waitForTimeout(250);
  rep.ok('undo reverts the drag in one step', Math.abs((await val('Center x')) - x0) < 1e-3);
  await page.keyboard.press('Control+y'); await page.waitForTimeout(200);

  const car = [10, 5, 0.75], size = [4, 2, 1.5], yaw = 0.25;
  await setField('Length', 4); await setField('Width', 2); await setField('Height', 1.5);
  await setField('Center x', 10); await setField('Center y', 5); await setField('Center z', 0.75); await setField('Yaw (degrees)', ((yaw * 180) / Math.PI).toFixed(6));
  await page.keyboard.press('q'); await page.waitForTimeout(150);
  rep.ok('Q rotates yaw by -5 degrees', Math.abs((await val('Yaw (degrees)')) - ((yaw * 180) / Math.PI - 5)) < 0.01);
  await page.keyboard.press('e'); await page.waitForTimeout(150);
  await page.getByRole('button', { name: 'Select points inside' }).click(); await page.waitForTimeout(500);
  const ref = insideRef(car, size, yaw);
  const sel = await page.locator('.props .hint').filter({ hasText: 'selected' }).first().innerText();
  const selN = Number((sel.match(/([\d,]+) point/) || [])[1]?.replace(/,/g, '') || 0);
  rep.ok('"Select points inside" equals an independent count', selN === ref && ref >= 1500, `app=${selN} reference=${ref}`);
  await page.keyboard.press('Enter'); await page.waitForTimeout(500);
  rep.ok('point label created with the same count', (await page.locator('.ann-row').allInnerTexts()).some((t) => t.includes(ref.toLocaleString() + ' points')));
  await page.keyboard.down('Shift'); await page.mouse.move(box.x + 5, box.y + 5); await page.mouse.down(); await page.mouse.move(box.x + box.width - 5, box.y + box.height - 5, { steps: 6 }); await page.mouse.up(); await page.keyboard.up('Shift'); await page.waitForTimeout(600);
  const all = await page.locator('.props .hint').filter({ hasText: 'selected' }).first().innerText().catch(() => '');
  const allN = Number((all.match(/([\d,]+) point/) || [])[1]?.replace(/,/g, '') || 0);
  rep.ok('Shift+drag rectangle selects (nearly) every visible point', allN >= N * 0.98, `selected=${allN} of ${N}`);
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);

  await page.locator('summary', { hasText: 'Export' }).click();
  let [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Point-cloud annotations JSON' }).click()]);
  const ex = JSON.parse(readFileSync(await dl.path(), 'utf8')); const cc = ex.clouds[0];
  rep.ok('export: schema, counts, 8 corners, up axis', ex.schema === 'annotate-anything/pointcloud-annotations' && cc.point_count === N && cc.cuboids.length === 1 && cc.cuboids[0].corners.length === 8 && cc.up_axis === 'z');
  rep.ok('export: point_count_inside equals the independent count', cc.cuboids[0].point_count_inside === ref, `export=${cc.cuboids[0].point_count_inside} ref=${ref}`);
  rep.ok('export: RLE sums to the point count', cc.point_class_rle.reduce((a, r) => a + r[1], 0) === N && cc.point_labels[0].point_count === ref);

  await page.locator('summary', { hasText: 'File' }).click();
  [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Save project/ }).click()]);
  const saved = join(dir, 'cloud.aa.json'); writeFileSync(saved, readFileSync(await dl.path()));
  await page.reload(); await page.waitForTimeout(600);
  await page.getByRole('button', { name: '3D cloud' }).click();
  await page.locator('summary', { hasText: 'File' }).click();
  await chooseFiles(page, /Open project/, saved); await page.waitForTimeout(800);
  rep.ok('reopened: cloud not loaded, annotations kept', (await rowsText()).includes('not loaded') && (await page.locator('.ann-row').count()) >= 1, await rowsText());
  await add(f.ply);
  rep.ok('adding the same file relinks it by name and point count', /Linked/.test(await toasts(page)));
  await add(f.asciiPcd);
  rep.ok('ASCII PCD loads with the same point count', /scene_ascii\.pcd/.test(await rowsText()) && (await rowsText()).split('scene_ascii.pcd')[1].includes(N.toLocaleString()));
  await add(f.binPcd);
  rep.ok('binary PCD loads with the same point count', (await rowsText()).split('scene_bin.pcd')[1]?.includes(N.toLocaleString()));
  await page.getByRole('button', { name: '2D image' }).click(); await page.waitForTimeout(300);
  rep.ok('2D class badge is not polluted by cloud annotations', (await page.locator('.class-row .count').first().innerText()) === '0');
  await page.close();
}
