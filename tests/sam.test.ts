import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { maskArea, maskToPolygon } from '../src/ai/mask';
import { SamEngine, resizedSize, type OrtLike } from '../src/ai/sam';
import { SAM_MODELS } from '../src/ai/models';

function rect(w: number, h: number, x0: number, y0: number, x1: number, y1: number): Uint8Array {
  const m = new Uint8Array(w * h);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * w + x] = 1;
  return m;
}
function polyArea(p: { x: number; y: number }[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i].x * q.y - q.x * p[i].y; }
  return Math.abs(a / 2);
}

describe('maskToPolygon', () => {
  it('traces a rectangle to its 4 corners with the exact area', () => {
    const p = maskToPolygon(rect(40, 30, 5, 4, 25, 20), 40, 30, { x: 10, y: 10 }, 0.5);
    expect(p).toHaveLength(4);
    expect(polyArea(p)).toBe(20 * 16);
    const xs = p.map((q) => q.x), ys = p.map((q) => q.y);
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([5, 25, 4, 20]);
  });
  it('picks the component under the seed, else the largest', () => {
    const m = rect(60, 20, 2, 2, 12, 12); // small, 100 px
    const big = rect(60, 20, 30, 2, 55, 18); // big, 400 px
    for (let i = 0; i < m.length; i++) m[i] |= big[i];
    expect(polyArea(maskToPolygon(m, 60, 20, { x: 5, y: 5 }, 0))).toBe(100);
    expect(polyArea(maskToPolygon(m, 60, 20, null, 0))).toBe(400);
    expect(polyArea(maskToPolygon(m, 60, 20, { x: 20, y: 15 }, 0))).toBe(400); // seed on background -> largest
  });
  it('ignores holes (outer boundary only) and handles an empty mask', () => {
    const m = rect(30, 30, 3, 3, 27, 27);
    for (let y = 10; y < 20; y++) for (let x = 10; x < 20; x++) m[y * 30 + x] = 0;
    expect(polyArea(maskToPolygon(m, 30, 30, null, 0))).toBe(24 * 24);
    expect(maskToPolygon(new Uint8Array(100), 10, 10, null)).toEqual([]);
  });
  it('a circle simplifies to far fewer vertices than its raw boundary and stays close in area', () => {
    const w = 200, m = new Uint8Array(w * w);
    for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) if (Math.hypot(x - 100, y - 100) < 60) m[y * w + x] = 1;
    const raw = maskToPolygon(m, w, w, null, 0), simp = maskToPolygon(m, w, w, null, 1.5);
    expect(simp.length).toBeLessThan(raw.length / 3);
    expect(Math.abs(polyArea(simp) - maskArea(m)) / maskArea(m)).toBeLessThan(0.03);
  });
  it('handles a mask touching the image border', () => {
    const p = maskToPolygon(rect(10, 10, 0, 0, 10, 10), 10, 10, null, 0);
    expect(polyArea(p)).toBe(100);
  });
});

describe('resizedSize', () => {
  it('scales the longest side to 1024', () => {
    expect(resizedSize(2048, 1024)).toMatchObject({ rw: 1024, rh: 512, scale: 0.5 });
    expect(resizedSize(500, 1000)).toMatchObject({ rw: 512, rh: 1024 });
  });
});

describe('model registry', () => {
  it('lists real https download URLs, sizes and a license for every model', () => {
    for (const m of SAM_MODELS) {
      expect(m.encoder.url.startsWith('https://')).toBe(true);
      expect(m.decoder.url.startsWith('https://')).toBe(true);
      expect(m.license.length).toBeGreaterThan(5);
    }
  });
});

// Real-model test: set SAM_TEST_DIR to a folder containing the .onnx files and an
// installed onnxruntime-node. Skipped (reported as skipped) otherwise.
const dir = process.env.SAM_TEST_DIR;
const have = !!dir && SAM_MODELS.some((m) => existsSync(join(dir, m.encoder.name)));
describe.skipIf(!have)('real SAM models (SAM_TEST_DIR)', () => {
  for (const spec of SAM_MODELS) {
    it(`${spec.label}: a click on a disc yields a mask close to the disc`, async () => {
      if (!existsSync(join(dir!, spec.encoder.name))) return;
      const ort = createRequire(join(dir!, 'x.js'))('onnxruntime-node') as OrtLike;
      const W = 640, H = 480, cx = 300, cy = 240, R = 90;
      const { rw, rh, scale } = resizedSize(W, H);
      const rgba = new Uint8Array(rw * rh * 4);
      const truth = new Uint8Array(W * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (Math.hypot(x - cx, y - cy) < R) truth[y * W + x] = 1;
      for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
        const inside = Math.hypot(x / scale - cx, y / scale - cy) < R;
        const o = (y * rw + x) * 4;
        rgba[o] = inside ? 200 : 60; rgba[o + 1] = inside ? 40 : 90; rgba[o + 2] = inside ? 40 : 110; rgba[o + 3] = 255;
      }
      const eng = new SamEngine(ort, spec.flavor);
      await eng.load(readFileSync(join(dir!, spec.encoder.name)), readFileSync(join(dir!, spec.decoder.name)));
      await eng.setImage(rgba, W, H);
      const res = await eng.predict([{ x: cx, y: cy, positive: true }]);
      let inter = 0, uni = 0;
      for (let i = 0; i < truth.length; i++) { if (truth[i] && res.mask[i]) inter++; if (truth[i] || res.mask[i]) uni++; }
      const iou = inter / uni;
      console.log(`[sam] ${spec.id}: IoU vs ground truth = ${iou.toFixed(3)}, model score = ${res.score}`);
      expect(iou).toBeGreaterThan(0.85);
      // Round trip into an editable polygon.
      const poly = maskToPolygon(res.mask, W, H, { x: cx, y: cy }, 1.5);
      expect(poly.length).toBeGreaterThanOrEqual(8);
      expect(Math.abs(polyArea(poly) - maskArea(res.mask)) / maskArea(res.mask)).toBeLessThan(0.05);
      // A negative click outside must not grow the mask beyond the disc region.
      const res2 = await eng.predict([{ x: cx, y: cy, positive: true }, { x: 40, y: 40, positive: false }]);
      expect(res2.mask[40 * W + 40]).toBe(0);
    }, 120000);
  }
});
