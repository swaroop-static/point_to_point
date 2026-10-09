import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeModels } from './fixtures.mjs';
import { chooseFiles, hasWebGL, newPage, toasts } from './lib.mjs';

export async function run({ browser, base, rep, dir, errors }) {
  const f = makeModels(join(dir, 'models'));
  const page = await newPage(browser, errors);
  await page.goto(base); await page.waitForTimeout(400);
  if (!(await hasWebGL(page))) { rep.skip('mesh workspace', 'this browser has no WebGL'); await page.close(); return; }
  await page.getByRole('button', { name: '3D model' }).click(); await page.waitForTimeout(500);
  rep.ok('empty state shown', await page.getByText('Drop a 3D model to annotate').isVisible());
  const rowsText = async () => (await page.locator('.image-row').allInnerTexts()).join('|').replace(/\n/g, ' ');
  const add = async (p) => { await chooseFiles(page, /Choose 3D model|Add model/, p); await page.waitForTimeout(1200); };

  await add(f.points); rep.ok('point-cloud PLY rejected with a message', /point cloud/i.test(await toasts(page)));
  await add(f.junk); rep.ok('junk OBJ rejected', /no triangle mesh|Could not read/i.test(await toasts(page)));
  await add(f.obj); rep.ok('OBJ listed with 24 faces', (await rowsText()).includes('24 faces'), await rowsText());

  let box; for (const c of await page.locator('canvas.stage-canvas').all()) { const b = await c.boundingBox(); if (b && b.width > 0) box = b; }
  const info = async () => await page.locator('.props .hint').first().innerText();
  const num = (t) => Number(((t.match(/([\d,]+) face/) || [])[1] || '0').replace(/,/g, ''));
  async function clickUntilSelected() {
    for (const [fx, fy] of [[.5, .5], [.45, .5], [.4, .55], [.55, .5], [.35, .5], [.5, .6], [.3, .5], [.6, .45]]) {
      await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy); await page.waitForTimeout(250);
      const t = await info(); if (/selected/.test(t)) return t;
    }
    return 'none';
  }
  await page.keyboard.press('r');
  const t1 = await clickUntilSelected();
  rep.ok('Region selects one flat side = 2 triangles', num(t1) === 2, t1.slice(0, 40));
  await page.keyboard.press('Enter'); await page.waitForTimeout(300);
  rep.ok('label created', (await page.locator('.ann-row').count()) === 1);
  await page.keyboard.press('Escape'); await page.keyboard.press('o');
  const t2 = await clickUntilSelected();
  rep.ok('Part selects the whole connected cube = 12 faces', num(t2) === 12, t2.slice(0, 40));
  await page.keyboard.press('Enter'); await page.waitForTimeout(300);
  const rows = await page.locator('.ann-row').allInnerTexts();
  rep.ok('relabeling takes faces from the older label (one label per face)', rows.length === 1 && rows[0].includes('12 faces'), rows.join('|').replace(/\n/g, ' '));
  await page.keyboard.press('Control+z'); await page.waitForTimeout(250);
  rep.ok('undo restores the 2-face label', (await page.locator('.ann-row').allInnerTexts()).join('').includes('2 faces'));
  await page.keyboard.press('Control+y'); await page.waitForTimeout(250);

  await page.locator('summary', { hasText: 'Export' }).click();
  let [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Mesh annotations JSON' }).click()]);
  const ex = JSON.parse(readFileSync(await dl.path(), 'utf8')); const m = ex.meshes[0];
  rep.ok('export: schema, face count and object', ex.schema === 'annotate-anything/mesh-annotations' && m.face_count === 24 && m.objects.length === 1 && m.objects[0].face_count === 12);
  rep.ok('export: RLE sums to the face count', m.face_class_rle.reduce((a, r) => a + r[1], 0) === 24);

  await page.locator('summary', { hasText: 'File' }).click();
  [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Save project/ }).click()]);
  const saved = join(dir, 'mesh.aa.json'); writeFileSync(saved, readFileSync(await dl.path()));
  await page.reload(); await page.waitForTimeout(600);
  await page.getByRole('button', { name: '3D model' }).click();
  await page.locator('summary', { hasText: 'File' }).click();
  await chooseFiles(page, /Open project/, saved); await page.waitForTimeout(800);
  rep.ok('reopened: model listed as not loaded, labels kept', (await rowsText()).includes('not loaded') && (await page.locator('.ann-row').count()) === 1, await rowsText());
  await add(f.obj);
  rep.ok('adding the same file relinks it by name and face count', /Linked/.test(await toasts(page)) && !(await rowsText()).includes('not loaded'));
  await add(f.glb); rep.ok('GLB loads (12 faces)', /cube\.glb.*12 faces/.test(await rowsText()), await rowsText());
  await add(f.plyQuads); rep.ok('PLY quads are triangulated (12 faces)', /quad_cube\.ply.*12 faces/.test(await rowsText()), await rowsText());
  await page.getByRole('button', { name: '2D image' }).click(); await page.waitForTimeout(300);
  rep.ok('2D class badge is not polluted by mesh labels', (await page.locator('.class-row .count').first().innerText()) === '0');
  await page.close();
}
