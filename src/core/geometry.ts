import type { Point2D } from './types';

/** Perpendicular distance from p to the segment a-b. */
export function distToSegment(p: Point2D, a: Point2D, b: Point2D): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Ramer-Douglas-Peucker on an OPEN path. Endpoints are always kept. Iterative
 * (explicit stack) so very long paths cannot overflow the call stack.
 */
export function simplifyOpen(pts: Point2D[], tolerance: number): Point2D[] {
  if (pts.length <= 2 || tolerance <= 0) return pts.map((p) => ({ ...p }));
  const keep = new Array<boolean>(pts.length).fill(false);
  keep[0] = true;
  keep[pts.length - 1] = true;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = -1, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = distToSegment(pts[i], pts[s], pts[e]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (idx !== -1 && maxD > tolerance) {
      keep[idx] = true;
      stack.push([s, idx], [idx, e]);
    }
  }
  return pts.filter((_, i) => keep[i]).map((p) => ({ ...p }));
}

/**
 * RDP for a CLOSED polygon. The ring has no natural endpoints, so it is split
 * at vertex 0 and the vertex farthest from it; each half is simplified as an
 * open path. Vertex order and winding are preserved. If simplification would
 * leave fewer than 3 vertices the original is returned unchanged.
 */
export function simplifyClosed(pts: Point2D[], tolerance: number): Point2D[] {
  if (pts.length <= 3 || tolerance <= 0) return pts.map((p) => ({ ...p }));
  let far = 0, farD = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - pts[0].x, pts[i].y - pts[0].y);
    if (d > farD) { farD = d; far = i; }
  }
  const first = simplifyOpen(pts.slice(0, far + 1), tolerance);
  const second = simplifyOpen([...pts.slice(far), pts[0]], tolerance);
  const out = [...first, ...second.slice(1, -1)];
  return out.length >= 3 ? out : pts.map((p) => ({ ...p }));
}

export interface SnapContext {
  /** Points to snap to (vertices and box corners of other shapes). */
  targets: Point2D[];
  /** Neighbouring vertices (e.g. previous point while drawing) for H/V alignment. */
  neighbors: Point2D[];
  /** Snap radius in IMAGE pixels (caller converts from screen pixels). */
  radius: number;
}

/**
 * Snap p to the nearest target vertex within radius; otherwise align its x
 * and/or y with a neighbour within radius. Returns p unchanged if nothing is close.
 */
export function snapPoint(p: Point2D, ctx: SnapContext): Point2D {
  let best: Point2D | null = null, bestD = ctx.radius;
  for (const t of ctx.targets) {
    const d = Math.hypot(t.x - p.x, t.y - p.y);
    if (d <= bestD) { bestD = d; best = t; }
  }
  if (best) return { x: best.x, y: best.y };
  let x = p.x, y = p.y, bx = ctx.radius, by = ctx.radius;
  for (const n of ctx.neighbors) {
    const dx = Math.abs(n.x - p.x), dy = Math.abs(n.y - p.y);
    if (dx <= bx) { bx = dx; x = n.x; }
    if (dy <= by) { by = dy; y = n.y; }
  }
  return { x, y };
}
