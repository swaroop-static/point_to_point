import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project } from '../src/core/types';
import { parseProjectJson } from '../src/core/validate';
import { simplifyClosed, simplifyOpen, snapPoint } from '../src/core/geometry';
import { crc32, makeZip } from '../src/io/zip';
import { exportYolo } from '../src/io/yolo';
import { exportCoco } from '../src/io/coco';
import { importCoco } from '../src/io/cocoImport';
import { hitTest } from '../src/workspaces/image2d/hittest';

function project(): Project {
  return {
    formatVersion: 2, app: 'annotate-anything', name: 'p', savedAt: '2026-01-01T00:00:00.000Z',
    classes: [{ id: 'c1', name: 'cat', color: '#ff0000' }, { id: 'c2', name: 'dog house', color: '#00ff00' }],
    images: [{
      id: 'i1', name: 'My Photo.JPG', width: 200, height: 100,
      annotations: [
        { id: 'a1', classId: 'c1', geom: { kind: 'box', x: 10, y: 20, w: 50, h: 30 } },
        { id: 'a2', classId: 'c2', geom: { kind: 'polygon', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }] } },
        { id: 'a3', classId: 'c1', geom: { kind: 'keypoint', x: 5, y: 5 } },
        { id: 'a4', classId: 'c1', geom: { kind: 'polyline', points: [{ x: 150, y: 10 }, { x: 190, y: 10 }, { x: 190, y: 90 }] } },
      ],
    }, { id: 'i2', name: 'my photo.jpg', width: 10, height: 10, annotations: [] }],
  };
}

describe('polyline and keypoint', () => {
  it('round-trip through project JSON', () => {
    const p = project();
    expect(parseProjectJson(JSON.stringify(p))).toEqual(p);
  });
  it('are validated', () => {
    const p = project();
    p.images[0].annotations[3].geom = { kind: 'polyline', points: [{ x: 1, y: 1 }] };
    expect(() => parseProjectJson(JSON.stringify(p))).toThrow(/fewer than 2/);
    const q = project();
    (q.images[0].annotations[2].geom as { x: number }).x = Number.NaN;
    expect(() => parseProjectJson(JSON.stringify(q))).toThrow(); // NaN serializes to null
  });
  it('hit testing: keypoint, polyline stroke, polyline has no interior', () => {
    const img = project().images[0];
    const vp = { scale: 1, tx: 0, ty: 0 };
    expect(hitTest(img, { x: 6, y: 5 }, vp, null)).toMatchObject({ kind: 'annotation', annId: 'a3' });
    // Unselected polyline: its stroke selects it. Selected: the same spot is an insert point.
    expect(hitTest(img, { x: 170, y: 10 }, vp, null)).toMatchObject({ kind: 'annotation', annId: 'a4' });
    expect(hitTest(img, { x: 170, y: 10 }, vp, 'a4')).toMatchObject({ kind: 'edge-midpoint', annId: 'a4', edgeIndex: 0 });
    // A polyline is open: no closing edge from the last point back to the first, and no interior.
    expect(hitTest(img, { x: 170, y: 50 }, vp, 'a4')).toEqual({ kind: 'none' });
    expect(hitTest(img, { x: 160, y: 30 }, vp, null)).toEqual({ kind: 'none' });
  });
});

describe('simplification (Ramer-Douglas-Peucker)', () => {
  const square = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 10, y: 10 }, { x: 5, y: 10 }, { x: 0, y: 10 }, { x: 0, y: 5 }];
  it('removes collinear vertices of a closed polygon, keeping the corners and order', () => {
    const out = simplifyClosed(square, 0.5);
    expect(out).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]);
  });
  it('keeps small features larger than the tolerance and drops those smaller', () => {
    const bump = [{ x: 0, y: 0 }, { x: 5, y: 3 }, { x: 10, y: 0 }];
    expect(simplifyOpen(bump, 2)).toHaveLength(3);
    expect(simplifyOpen(bump, 4)).toHaveLength(2);
  });
  it('tolerance 0 changes nothing; never returns fewer than 3 for a polygon; endpoints kept for polylines', () => {
    expect(simplifyClosed(square, 0)).toEqual(square);
    const tri = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 1 }];
    expect(simplifyClosed(tri, 50).length).toBeGreaterThanOrEqual(3);
    const line = [{ x: 0, y: 0 }, { x: 1, y: 0.1 }, { x: 2, y: 0 }, { x: 3, y: 0.1 }, { x: 4, y: 0 }];
    const s = simplifyOpen(line, 1);
    expect(s[0]).toEqual(line[0]);
    expect(s[s.length - 1]).toEqual(line[4]);
  });
  it('preserves winding direction on a noisy circle and stays within tolerance', () => {
    const circle = Array.from({ length: 400 }, (_, i) => {
      const a = (i / 400) * Math.PI * 2;
      return { x: 100 + 80 * Math.cos(a), y: 100 + 80 * Math.sin(a) };
    });
    const out = simplifyClosed(circle, 1);
    const area = (pts: { x: number; y: number }[]) => pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length]; return s + (p.x * q.y - q.x * p.y); }, 0) / 2;
    expect(Math.sign(area(out))).toBe(Math.sign(area(circle)));
    expect(out.length).toBeLessThan(80);
    expect(out.length).toBeGreaterThanOrEqual(3);
    expect(Math.abs(area(out) - area(circle)) / Math.abs(area(circle))).toBeLessThan(0.02);
  });
});

describe('snapping', () => {
  it('snaps to a nearby vertex, else aligns to a neighbour, else leaves the point alone', () => {
    const ctx = { targets: [{ x: 50, y: 50 }], neighbors: [{ x: 10, y: 80 }], radius: 5 };
    expect(snapPoint({ x: 52, y: 48 }, ctx)).toEqual({ x: 50, y: 50 });
    expect(snapPoint({ x: 12, y: 30 }, ctx)).toEqual({ x: 10, y: 30 });
    expect(snapPoint({ x: 30, y: 82 }, ctx)).toEqual({ x: 30, y: 80 });
    expect(snapPoint({ x: 30, y: 30 }, ctx)).toEqual({ x: 30, y: 30 });
  });
});

/** Independent ZIP reader: parses the central directory and verifies CRC-32 of each entry. */
function readZip(zip: Uint8Array): Map<string, Uint8Array> {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = zip.length - 22;
  while (eocd >= 0 && dv.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('no EOCD');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('bad central header');
    const crc = dv.getUint32(p + 16, true), size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), cmtLen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(zip.slice(p + 46, p + 46 + nameLen));
    const lnLen = dv.getUint16(lho + 26, true), leLen = dv.getUint16(lho + 28, true);
    const data = zip.slice(lho + 30 + lnLen + leLen, lho + 30 + lnLen + leLen + size);
    if (crc32(data) !== crc) throw new Error(`CRC mismatch for ${name}`);
    out.set(name, data);
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

describe('zip writer', () => {
  it('crc32 matches the known check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
  it('round-trips names (incl. unicode) and bytes via an independent reader', () => {
    const enc = new TextEncoder();
    const zip = makeZip([
      { name: 'a/b.txt', data: enc.encode('hello') },
      { name: 'empty.txt', data: new Uint8Array() },
      { name: 'café.txt', data: new Uint8Array([0, 255, 1, 254]) },
    ]);
    const files = readZip(zip);
    expect([...files.keys()]).toEqual(['a/b.txt', 'empty.txt', 'café.txt']);
    expect(new TextDecoder().decode(files.get('a/b.txt')!)).toBe('hello');
    expect([...files.get('café.txt')!]).toEqual([0, 255, 1, 254]);
  });
  // Windows ships bsdtar at System32; a bare "tar" may be Git's GNU tar, which mis-parses "C:\..." paths.
  const BSDTAR = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'tar';
  const hasBsdtar = (() => { const r = spawnSync(BSDTAR, ['--version'], { encoding: 'utf8' }); return !r.error && r.status === 0 && /bsdtar/i.test(r.stdout); })();
  it.skipIf(!hasBsdtar)('is readable by the OS archiver (bsdtar), contents byte-identical', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-zip-'));
    try {
      const f = join(dir, 't.zip');
      writeFileSync(f, makeZip([
        { name: 'x/y.txt', data: new TextEncoder().encode('data') },
        { name: 'z.bin', data: new Uint8Array([0, 1, 2, 250]) },
      ]));
      const list = spawnSync(BSDTAR, ['-tf', f], { encoding: 'utf8' });
      expect(list.status).toBe(0);
      expect(list.stdout.replace(/\r/g, '').trim().split('\n').sort()).toEqual(['x/y.txt', 'z.bin']);
      const one = spawnSync(BSDTAR, ['-xOf', f, 'x/y.txt'], { encoding: 'utf8' });
      expect(one.stdout).toBe('data');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('YOLO export', () => {
  const noBytes = async () => null;
  it('detection: normalized cx cy w h, class index by project order, polygon bounds', async () => {
    const r = await exportYolo(project(), 'detect', noBytes);
    const files = new Map(r.entries.map((e) => [e.name, new TextDecoder().decode(e.data)]));
    expect(files.get('labels/My_Photo.txt')).toBe('0 0.175 0.35 0.25 0.3\n1 0.25 0.25 0.5 0.5\n');
    expect(files.get('labels/my_photo.txt') ?? files.get('labels/my_photo_2.txt')).toBe('');
    expect(r.labelCount).toBe(2);
  });
  it('segmentation: polygon rings and boxes as 4-corner polygons', async () => {
    const r = await exportYolo(project(), 'segment', noBytes);
    const files = new Map(r.entries.map((e) => [e.name, new TextDecoder().decode(e.data)]));
    expect(files.get('labels/My_Photo.txt')).toBe('0 0.05 0.2 0.3 0.2 0.3 0.5 0.05 0.5\n1 0 0 0.5 0 0.5 0.5 0 0.5\n');
  });
  it('warns about skipped polyline/keypoint and missing image files; writes data.yaml with quoted odd names', async () => {
    const r = await exportYolo(project(), 'detect', noBytes);
    expect(r.warnings.join(' ')).toMatch(/keypoint/);
    expect(r.warnings.join(' ')).toMatch(/polyline/);
    expect(r.warnings.join(' ')).toMatch(/not loaded/);
    const yaml = new TextDecoder().decode(r.entries.find((e) => e.name === 'data.yaml')!.data);
    expect(yaml).toContain('names:\n  0: cat\n  1: dog house\n');
  });
  it('de-duplicates stems that differ only by case and includes image bytes when available', async () => {
    const r = await exportYolo(project(), 'detect', async () => new Uint8Array([1, 2, 3]));
    const names = r.entries.map((e) => e.name);
    expect(names).toContain('images/My_Photo.jpg');
    expect(names).toContain('images/my_photo_2.jpg');
    expect(new Set(names).size).toBe(names.length);
  });
  it('produces only values in 0..1 and no NaN even for out-of-bounds geometry', async () => {
    const p = project();
    p.images[0].annotations = [{ id: 'x', classId: 'c1', geom: { kind: 'box', x: -50, y: -50, w: 1000, h: 1000 } }];
    const r = await exportYolo(p, 'detect', noBytes);
    const line = new TextDecoder().decode(r.entries.find((e) => e.name === 'labels/My_Photo.txt')!.data).trim().split(' ');
    expect(line).toEqual(['0', '0.5', '0.5', '1', '1']);
  });
});

describe('COCO import', () => {
  it('round-trips boxes and polygons exported by this app', () => {
    const p = project();
    p.images[0].annotations = p.images[0].annotations.slice(0, 2);
    const { dataset } = exportCoco(p);
    const { project: back, warnings } = importCoco(JSON.stringify(dataset), 'back');
    expect(warnings).toEqual([]);
    expect(back.classes.map((c) => c.name)).toEqual(['cat', 'dog house']);
    expect(back.images.map((i) => [i.name, i.width, i.height])).toEqual([['My Photo.JPG', 200, 100], ['my photo.jpg', 10, 10]]);
    const [box, poly] = back.images[0].annotations;
    expect(box.geom).toEqual({ kind: 'box', x: 10, y: 20, w: 50, h: 30 });
    expect(poly.geom).toEqual({ kind: 'polygon', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }] });
    expect(parseProjectJson(JSON.stringify(back))).toEqual(back);
  });
  it('rejects non-COCO input and skips RLE / crowd with warnings', () => {
    expect(() => importCoco('{}')).toThrow(/Not a COCO file/);
    const ds = {
      categories: [{ id: 7, name: 'thing' }],
      images: [{ id: 1, file_name: 'sub/dir/a.png', width: 10, height: 10 }],
      annotations: [
        { id: 1, image_id: 1, category_id: 7, segmentation: { counts: 'x', size: [10, 10] } },
        { id: 2, image_id: 1, category_id: 7, iscrowd: 1, bbox: [0, 0, 1, 1] },
        { id: 3, image_id: 1, category_id: 7, bbox: [1, 1, 4, 4] },
      ],
    };
    const { project: p, warnings } = importCoco(JSON.stringify(ds));
    expect(p.images[0].name).toBe('a.png');
    expect(p.images[0].annotations).toHaveLength(1);
    expect(warnings.join(' ')).toMatch(/RLE/);
    expect(warnings.join(' ')).toMatch(/crowd/);
  });
});

describe('performance (measured, not a guarantee)', () => {
  it('hit-tests 50 annotations including 2000-vertex polygons quickly', () => {
    const ring = (n: number, cx: number, cy: number, r: number) => Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2; return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
    });
    const anns = Array.from({ length: 50 }, (_, i) => ({
      id: `a${i}`, classId: 'c1', geom: { kind: 'polygon' as const, points: ring(i < 5 ? 2000 : 30, 500 + i * 10, 500, 300) },
    }));
    const img = { id: 'i', name: 'x', width: 4000, height: 4000, annotations: anns };
    const vp = { scale: 1, tx: 0, ty: 0 };
    const N = 300;
    const t0 = performance.now();
    for (let k = 0; k < N; k++) hitTest(img, { x: 100 + k, y: 600 }, vp, 'a0');
    const per = (performance.now() - t0) / N;
    console.log(`[perf] hitTest, 50 annotations (5 x 2000 vertices): ${per.toFixed(3)} ms per call`);
    expect(per).toBeLessThan(16);
  });
});
