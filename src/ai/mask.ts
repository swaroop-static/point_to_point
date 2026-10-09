import type { Point2D } from '../core/types';
import { simplifyClosed } from '../core/geometry';

/**
 * Turn a binary mask (1 = object) into ONE editable polygon.
 *
 * Takes the 4-connected component containing the seed (or the largest one if
 * the seed is outside the mask), follows its outer pixel boundary, and
 * simplifies it with Ramer-Douglas-Peucker. Holes are ignored (a polygon
 * annotation has no holes). Disconnected pieces other than the chosen one are
 * dropped. Returns [] when the mask is empty.
 */
export function maskToPolygon(mask: Uint8Array, w: number, h: number, seed: Point2D | null, tolerancePx = 1.5): Point2D[] {
  const comp = pickComponent(mask, w, h, seed);
  if (!comp) return [];
  const loop = outerLoop(comp, w, h);
  if (loop.length < 3) return [];
  const pts = dropCollinear(loop);
  const out = tolerancePx > 0 ? simplifyClosed(pts, tolerancePx) : pts;
  return out.length >= 3 ? out : pts;
}

export function maskArea(mask: Uint8Array): number { let n = 0; for (let i = 0; i < mask.length; i++) if (mask[i]) n++; return n; }

/** Returns a mask containing only the chosen component (1 = in), or null if the mask is empty. */
function pickComponent(mask: Uint8Array, w: number, h: number, seed: Point2D | null): Uint8Array | null {
  const label = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  let best = 0, bestSize = 0, next = 0, seedLabel = 0;
  const sx = seed ? Math.floor(seed.x) : -1, sy = seed ? Math.floor(seed.y) : -1;
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || label[i]) continue;
    next += 1;
    let sp = 0, size = 0;
    stack[sp++] = i; label[i] = next;
    while (sp) {
      const p = stack[--sp]; size++;
      const x = p % w, y = (p - x) / w;
      if (x > 0 && mask[p - 1] && !label[p - 1]) { label[p - 1] = next; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && !label[p + 1]) { label[p + 1] = next; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - w] && !label[p - w]) { label[p - w] = next; stack[sp++] = p - w; }
      if (y < h - 1 && mask[p + w] && !label[p + w]) { label[p + w] = next; stack[sp++] = p + w; }
    }
    if (size > bestSize) { bestSize = size; best = next; }
  }
  if (!best) return null;
  if (sx >= 0 && sy >= 0 && sx < w && sy < h && label[sy * w + sx]) seedLabel = label[sy * w + sx];
  const pick = seedLabel || best;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) if (label[i] === pick) out[i] = 1;
  return out;
}

/** Follow the pixel-edge boundary of a mask and return the loop with the largest area. */
function outerLoop(m: Uint8Array, w: number, h: number): Point2D[] {
  const W = w + 1;
  const starts = new Map<number, number[]>(); // vertex -> list of end vertices (unused edges)
  const add = (a: number, b: number): void => { const l = starts.get(a); if (l) l.push(b); else starts.set(a, [b]); };
  const on = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h && m[y * w + x] === 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!m[y * w + x]) continue;
      // Clockwise around the pixel (y down): top, right, bottom, left.
      if (!on(x, y - 1)) add(y * W + x, y * W + x + 1);
      if (!on(x + 1, y)) add(y * W + x + 1, (y + 1) * W + x + 1);
      if (!on(x, y + 1)) add((y + 1) * W + x + 1, (y + 1) * W + x);
      if (!on(x - 1, y)) add((y + 1) * W + x, y * W + x);
    }
  }
  let bestLoop: Point2D[] = [], bestArea = 0;
  for (const [start] of starts) {
    for (;;) {
      const list = starts.get(start);
      if (!list || !list.length) break;
      const loop: Point2D[] = [];
      let cur = start;
      for (;;) {
        loop.push({ x: cur % W, y: Math.floor(cur / W) });
        const l = starts.get(cur);
        if (!l || !l.length) break;
        cur = l.pop()!;
        if (cur === start) break;
      }
      let a = 0;
      for (let i = 0; i < loop.length; i++) { const p = loop[i], q = loop[(i + 1) % loop.length]; a += p.x * q.y - q.x * p.y; }
      a = Math.abs(a / 2);
      if (a > bestArea) { bestArea = a; bestLoop = loop; }
    }
  }
  return bestLoop;
}

function dropCollinear(pts: Point2D[]): Point2D[] {
  const n = pts.length, out: Point2D[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
    if ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) !== 0) out.push(b);
  }
  return out;
}
