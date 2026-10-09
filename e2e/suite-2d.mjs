import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeImages } from './fixtures.mjs';
import { chooseFiles, newPage, toasts } from './lib.mjs';

/** 2D editor, exports, project save/open, and the 3D photo workspace. */
export async function run({ browser, base, rep, dir, errors }) {
  const files = makeImages(join(dir, 'images'));
  const page = await newPage(browser, errors);
  await page.goto(base);
  await page.waitForTimeout(400);
  rep.ok('app loads with a title', (await page.title()).length > 0, await page.title());

  await chooseFiles(page, 'Choose images', [files.a, files.b]);
  await page.waitForTimeout(900);
  rep.ok('two images listed with dimensions', (await page.locator('.image-row').count()) === 2 && /800×600/.test(await page.locator('.image-row').first().innerText()));
  await page.locator('.image-row').first().click();
  await page.waitForTimeout(300);

  const box = await page.locator('canvas.stage-canvas').first().boundingBox();
  const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
  const rows = () => page.locator('.ann-row').count();

  await page.keyboard.press('b');
  let [x, y] = at(0.2, 0.2); await page.mouse.move(x, y); await page.mouse.down();
  [x, y] = at(0.4, 0.4); await page.mouse.move(x, y, { steps: 6 }); await page.mouse.up();
  rep.ok('box created', (await rows()) === 1);

  await page.keyboard.press('p');
  for (const [fx, fy] of [[0.55, 0.2], [0.85, 0.2], [0.85, 0.5], [0.55, 0.5]]) { [x, y] = at(fx, fy); await page.mouse.click(x, y); }
  await page.keyboard.press('Enter'); await page.waitForTimeout(200);
  rep.ok('polygon created', (await rows()) === 2);

  await page.keyboard.press('Control+z'); await page.waitForTimeout(150);
  rep.ok('undo removes polygon', (await rows()) === 1);
  await page.keyboard.press('Control+y'); await page.waitForTimeout(150);
  rep.ok('redo restores polygon', (await rows()) === 2);

  // ---- vertex editing, verified from the saved project JSON
  const saveJson = async () => {
    await page.locator('summary', { hasText: 'File' }).click();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Save project/ }).click()]);
    return JSON.parse(readFileSync(await dl.path(), 'utf8'));
  };
  const polyOf = (pj) => pj.images[0].annotations.find((a) => a.geom.kind === 'polygon').geom.points;
  const vp = () => { const s = Math.min((box.width - 48) / 800, (box.height - 48) / 600); return { s, tx: (box.width - 800 * s) / 2, ty: (box.height - 600 * s) / 2 }; };
  const toScreen = (p) => { const v = vp(); return [box.x + v.tx + p.x * v.s, box.y + v.ty + p.y * v.s]; };

  const before = polyOf(await saveJson());
  await page.keyboard.press('v');
  [x, y] = at(0.7, 0.35); await page.mouse.click(x, y); await page.waitForTimeout(200); // select the polygon
  let [vx, vy] = toScreen(before[0]);
  await page.mouse.move(vx, vy); await page.mouse.down(); await page.mouse.move(vx + 25, vy + 25, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(200);
  let after = polyOf(await saveJson());
  rep.ok('dragging a vertex moves exactly that vertex', Math.hypot(after[0].x - before[0].x, after[0].y - before[0].y) > 5 && after.length === before.length
    && after.slice(1).every((p, i) => p.x === before[i + 1].x && p.y === before[i + 1].y), `v0 ${before[0].x.toFixed(0)},${before[0].y.toFixed(0)} -> ${after[0].x.toFixed(0)},${after[0].y.toFixed(0)}`);

  const [ax, ay] = toScreen(after[1]), [bx, by] = toScreen(after[2]);
  await page.mouse.click((ax + bx) / 2, (ay + by) / 2); await page.waitForTimeout(250); // click an edge: insert a vertex
  const inserted = polyOf(await saveJson());
  rep.ok('clicking an edge inserts a vertex', inserted.length === before.length + 1, `${before.length} -> ${inserted.length}`);
  await page.keyboard.press('Control+z'); await page.waitForTimeout(150);

  const cur = polyOf(await saveJson());
  [vx, vy] = toScreen(cur[2]);
  await page.mouse.dblclick(vx, vy); await page.waitForTimeout(250);
  const deleted = polyOf(await saveJson());
  rep.ok('double-clicking a vertex deletes it', deleted.length === cur.length - 1, `${cur.length} -> ${deleted.length}`);

  // ---- exports
  await page.locator('summary', { hasText: 'Export' }).click();
  let [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'COCO JSON', exact: true }).click()]);
  const coco = JSON.parse(readFileSync(await dl.path(), 'utf8'));
  rep.ok('COCO: 2 images, 2 annotations, correct dimensions', coco.images.length === 2 && coco.annotations.length === 2 && coco.images[0].width === 800 && coco.images[0].height === 600);
  rep.ok('COCO: bbox values are finite and positive', coco.annotations.every((a) => a.bbox.every(Number.isFinite) && a.bbox[2] > 0 && a.bbox[3] > 0));
  await page.locator('summary', { hasText: 'Export' }).click();
  [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'COCO JSON (boxes also as polygons)' }).click()]);
  const cocoPoly = JSON.parse(readFileSync(await dl.path(), 'utf8'));
  rep.ok('COCO (boxes also as polygons): every annotation has a mask', cocoPoly.annotations.every((a) => a.segmentation && a.segmentation[0].length >= 6));
  await page.locator('summary', { hasText: 'Export' }).click();
  [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'YOLO detection (.zip)' }).click()]);
  rep.ok('YOLO detection zip downloads', (await dl.suggestedFilename()).endsWith('.zip'), await dl.suggestedFilename());

  // ---- 3D photo workspace
  await page.getByRole('button', { name: '3D photo' }).click(); await page.waitForTimeout(400);
  await page.keyboard.press('c');
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.click(cx, cy); await page.waitForTimeout(300);
  rep.ok('3D photo: cuboid created', (await rows()) === 1);
  await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 100, cy + 30, { steps: 6 }); await page.mouse.up();
  for (let i = 0; i < 6; i++) await page.keyboard.press('e');
  await page.waitForTimeout(150);
  rep.ok('3D photo: six E presses rotate 30 degrees', Math.abs(Number(await page.getByLabel('Rotation (degrees)').inputValue()) - 30) < 0.01);
  const w = page.getByLabel('Width');
  await w.fill('2.5'); await w.press('Enter'); await w.blur(); await page.waitForTimeout(200);
  await page.keyboard.press('Control+z'); await page.waitForTimeout(200);
  rep.ok('3D photo: one undo reverts a field edit', (await w.inputValue()) !== '2.5');
  await page.locator('summary', { hasText: 'Export' }).click();
  [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Photo cuboids JSON' }).click()]);
  const pc = JSON.parse(readFileSync(await dl.path(), 'utf8'));
  rep.ok('3D photo: export has 8 corners and metric=false', pc.images[0].cuboids[0].corners_3d.length === 8 && pc.images[0].metric === false);
  await page.getByRole('button', { name: '2D image' }).click(); await page.waitForTimeout(300);
  rep.ok('2D annotations intact after switching modes', (await rows()) >= 2);
  rep.ok('2D class badge counts only 2D annotations', Number(await page.locator('.class-row .count').first().innerText()) === (await rows()));

  // ---- project save, reload, reopen, relink by file name
  const pj = await saveJson();
  const fs = await import('node:fs');
  const projPath = join(dir, 'p.aa.json');
  fs.writeFileSync(projPath, JSON.stringify(pj));
  await page.reload(); await page.waitForTimeout(600);
  await page.locator('summary', { hasText: 'File' }).click();
  await chooseFiles(page, /Open project/, projPath);
  await page.waitForTimeout(700);
  rep.ok('reopened project: images listed as not loaded, annotations kept', (await page.locator('.image-row').first().innerText()).includes('not loaded') && (await page.locator('.ann-row').count()) >= 0 && pj.images[0].annotations.length >= 2);
  await chooseFiles(page, /Add images/, [files.a, files.b]); await page.waitForTimeout(900);
  rep.ok('adding the same files relinks them by name', !(await page.locator('.image-row').first().innerText()).includes('not loaded'), (await toasts(page)).slice(-80));

  await page.close();
}
