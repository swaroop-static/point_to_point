import type { Cuboid3D, Vec3 } from '../core/types';

/**
 * Point-cloud geometry. Pure functions, no DOM, no three.js.
 *
 * Cuboid frame: the cuboid is described by its center, size {length, width,
 * height} and a yaw about the cloud's UP axis. "Horizontal axes" a and b are
 * the two non-up axes: up = z gives (a = x, b = y); up = y gives (a = x, b = z).
 * `length` runs along local a, `width` along local b, `height` along up.
 * Yaw is the angle from +a toward +b, in radians. Corner index bits:
 * bit0 = +length side, bit1 = +width side, bit2 = +height (up) side.
 */

export type UpAxis = 'y' | 'z';

export function axesOf(up: UpAxis): { a: 0 | 1 | 2; b: 0 | 1 | 2; u: 0 | 1 | 2 } {
  return up === 'z' ? { a: 0, b: 1, u: 2 } : { a: 0, b: 2, u: 1 };
}

const comp = (v: Vec3, i: 0 | 1 | 2): number => (i === 0 ? v.x : i === 1 ? v.y : v.z);
function fromAxes(a: number, b: number, u: number, up: UpAxis): Vec3 {
  return up === 'z' ? { x: a, y: b, z: u } : { x: a, y: u, z: b };
}

export function cuboidCorners(c: Cuboid3D, up: UpAxis): Vec3[] {
  const { a, b, u } = axesOf(up);
  const ca = comp(c.center, a), cb = comp(c.center, b), cu = comp(c.center, u);
  const cos = Math.cos(c.yaw), sin = Math.sin(c.yaw);
  const out: Vec3[] = [];
  for (let i = 0; i < 8; i++) {
    const la = (i & 1 ? 0.5 : -0.5) * c.size.length;
    const lb = (i & 2 ? 0.5 : -0.5) * c.size.width;
    const lu = (i & 4 ? 0.5 : -0.5) * c.size.height;
    out.push(fromAxes(ca + la * cos - lb * sin, cb + la * sin + lb * cos, cu + lu, up));
  }
  return out;
}

/** The 12 edges as corner-index pairs. */
export const CUBOID_EDGES: readonly [number, number][] = (() => {
  const e: [number, number][] = [];
  for (let a = 0; a < 8; a++) for (const bit of [1, 2, 4]) { const b = a ^ bit; if (a < b) e.push([a, b]); }
  return e;
})();

/** Indices of the points inside the cuboid (boundary inclusive). */
export function pointsInCuboid(positions: Float32Array, c: Cuboid3D, up: UpAxis): number[] {
  const { a, b, u } = axesOf(up);
  const ca = comp(c.center, a), cb = comp(c.center, b), cu = comp(c.center, u);
  const cos = Math.cos(c.yaw), sin = Math.sin(c.yaw);
  const hl = c.size.length / 2, hw = c.size.width / 2, hh = c.size.height / 2;
  const out: number[] = [];
  const n = positions.length / 3;
  for (let i = 0; i < n; i++) {
    const da = positions[i * 3 + a] - ca, db = positions[i * 3 + b] - cb, du = positions[i * 3 + u] - cu;
    const la = da * cos + db * sin, lb = -da * sin + db * cos;
    if (Math.abs(la) <= hl && Math.abs(lb) <= hw && Math.abs(du) <= hh) out.push(i);
  }
  return out;
}

/** Distance along the ray to where it enters the cuboid, or null when it misses (or the box is behind). */
export function rayCuboid(origin: Vec3, dir: Vec3, c: Cuboid3D, up: UpAxis): number | null {
  const { a, b, u } = axesOf(up);
  const cos = Math.cos(c.yaw), sin = Math.sin(c.yaw);
  const o = [comp(origin, a) - comp(c.center, a), comp(origin, b) - comp(c.center, b), comp(origin, u) - comp(c.center, u)];
  const d = [comp(dir, a), comp(dir, b), comp(dir, u)];
  const lo = [o[0] * cos + o[1] * sin, -o[0] * sin + o[1] * cos, o[2]];
  const ld = [d[0] * cos + d[1] * sin, -d[0] * sin + d[1] * cos, d[2]];
  const half = [c.size.length / 2, c.size.width / 2, c.size.height / 2];
  let tmin = -Infinity, tmax = Infinity;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(ld[k]) < 1e-12) {
      if (Math.abs(lo[k]) > half[k]) return null;
    } else {
      let t1 = (-half[k] - lo[k]) / ld[k], t2 = (half[k] - lo[k]) / ld[k];
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  if (tmax < 0) return null;
  return tmin >= 0 ? tmin : tmax;
}

/**
 * Project every point to the screen with a column-major 4x4 (projection * view).
 * Output: 3 floats per point (x px, y px, ndc depth); x is NaN when the point is
 * behind the camera or outside the near/far range.
 */
export function screenProject(positions: Float32Array, m: ArrayLike<number>, width: number, height: number): Float32Array {
  const n = positions.length / 3;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (!(w > 0)) { out[i * 3] = NaN; continue; }
    const nx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
    const ny = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
    const nz = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
    if (nz < -1 || nz > 1) { out[i * 3] = NaN; continue; }
    out[i * 3] = (nx * 0.5 + 0.5) * width;
    out[i * 3 + 1] = (1 - (ny * 0.5 + 0.5)) * height;
    out[i * 3 + 2] = nz;
  }
  return out;
}

/** Point indices whose projection falls inside the pixel rectangle. */
export function pointsInRect(proj: Float32Array, x0: number, y0: number, x1: number, y1: number): number[] {
  const lx = Math.min(x0, x1), hx = Math.max(x0, x1), ly = Math.min(y0, y1), hy = Math.max(y0, y1);
  const out: number[] = [];
  for (let i = 0; i < proj.length / 3; i++) {
    const x = proj[i * 3], y = proj[i * 3 + 1];
    if (x >= lx && x <= hx && y >= ly && y <= hy) out.push(i); // NaN fails every comparison
  }
  return out;
}

/** Index of the point closest to the camera among those within `radius` px of (x, y); -1 if none. */
export function pickPoint(proj: Float32Array, x: number, y: number, radius: number): number {
  let best = -1, bestZ = Infinity;
  const r2 = radius * radius;
  for (let i = 0; i < proj.length / 3; i++) {
    const px = proj[i * 3];
    if (px !== px) continue;
    const dx = px - x, dy = proj[i * 3 + 1] - y;
    if (dx * dx + dy * dy <= r2 && proj[i * 3 + 2] < bestZ) { bestZ = proj[i * 3 + 2]; best = i; }
  }
  return best;
}

export interface Extent { min: Vec3; max: Vec3; diag: number }

export function extentOf(positions: Float32Array): Extent {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ }, diag: Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1 };
}

/** Normalize an angle to (-pi, pi]. */
export function wrapYaw(a: number): number {
  const t = ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  return t === -Math.PI ? Math.PI : t;
}
