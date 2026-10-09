import type { CameraModel, PhotoCuboid, Point2D, Vec3 } from './types';

/**
 * Cuboid and pinhole-camera math. Pure functions, no DOM.
 *
 * Camera frame (OpenCV): +x right, +y down, +z forward. A point (X, Y, Z)
 * with Z > 0 projects to  u = fx*X/Z + cx,  v = fy*Y/Z + cy.
 *
 * Cuboid local frame before rotation: x = width, y = height (y points DOWN,
 * so the "top" of the box is at -y), z = length (front at +z). Rotation is
 * about the camera +y axis (right-handed):
 *     x' =  x*cos(t) + z*sin(t)
 *     z' = -x*sin(t) + z*cos(t)
 * Corner index bits: bit0 = +x side, bit1 = +y side (bottom), bit2 = +z side (front).
 */

export const MIN_DEPTH = 0.05;

export function cameraFromHorizontalFov(width: number, height: number, hfovDeg: number): CameraModel {
  const fx = width / 2 / Math.tan((hfovDeg * Math.PI) / 360);
  return { fx, fy: fx, cx: width / 2, cy: height / 2, calibrated: false };
}

/** Horizontal field of view implied by the camera, in degrees. */
export function horizontalFovDeg(cam: CameraModel, width: number): number {
  return (2 * Math.atan(width / 2 / cam.fx) * 180) / Math.PI;
}

export function project(cam: CameraModel, p: Vec3): Point2D | null {
  if (!(p.z > 1e-9)) return null;
  return { x: (cam.fx * p.x) / p.z + cam.cx, y: (cam.fy * p.y) / p.z + cam.cy };
}

export function cuboidCorners3D(c: PhotoCuboid): Vec3[] {
  const hw = c.size.width / 2, hh = c.size.height / 2, hl = c.size.length / 2;
  const cos = Math.cos(c.rotationY), sin = Math.sin(c.rotationY);
  const out: Vec3[] = [];
  for (let i = 0; i < 8; i++) {
    const lx = i & 1 ? hw : -hw;
    const ly = i & 2 ? hh : -hh;
    const lz = i & 4 ? hl : -hl;
    out.push({
      x: c.center.x + lx * cos + lz * sin,
      y: c.center.y + ly,
      z: c.center.z - lx * sin + lz * cos,
    });
  }
  return out;
}

export function projectCuboid(cam: CameraModel, c: PhotoCuboid): (Point2D | null)[] {
  return cuboidCorners3D(c).map((p) => project(cam, p));
}

/** The 12 edges as corner-index pairs (corners that differ in exactly one bit). */
export const CUBOID_EDGES: readonly [number, number][] = (() => {
  const e: [number, number][] = [];
  for (let a = 0; a < 8; a++) for (const bit of [1, 2, 4]) { const b = a ^ bit; if (a < b) e.push([a, b]); }
  return e;
})();

/** Faces as corner quads (in loop order) with the local outward normal. Front is the +z face. */
export const CUBOID_FACES: readonly { corners: [number, number, number, number]; normal: Vec3; name: string }[] = [
  { name: 'front',  corners: [4, 5, 7, 6], normal: { x: 0, y: 0, z: 1 } },
  { name: 'rear',   corners: [0, 1, 3, 2], normal: { x: 0, y: 0, z: -1 } },
  { name: 'right',  corners: [1, 5, 7, 3], normal: { x: 1, y: 0, z: 0 } },
  { name: 'left',   corners: [0, 4, 6, 2], normal: { x: -1, y: 0, z: 0 } },
  { name: 'bottom', corners: [2, 3, 7, 6], normal: { x: 0, y: 1, z: 0 } },
  { name: 'top',    corners: [0, 1, 5, 4], normal: { x: 0, y: -1, z: 0 } },
];

/** Which faces are turned toward the camera (at the origin) for this cuboid. */
export function visibleFaces(c: PhotoCuboid): boolean[] {
  const cos = Math.cos(c.rotationY), sin = Math.sin(c.rotationY);
  return CUBOID_FACES.map((f) => {
    const n = { x: f.normal.x * cos + f.normal.z * sin, y: f.normal.y, z: -f.normal.x * sin + f.normal.z * cos };
    const half = f.normal.x ? c.size.width / 2 : f.normal.y ? c.size.height / 2 : c.size.length / 2;
    const fc = { x: c.center.x + n.x * half, y: c.center.y + n.y * half, z: c.center.z + n.z * half };
    // Visible when the outward normal points toward the camera: n . (camera - faceCenter) > 0.
    return n.x * -fc.x + n.y * -fc.y + n.z * -fc.z > 0;
  });
}

/** Indices (into CUBOID_EDGES) of edges that border at least one visible face. */
export function visibleEdges(c: PhotoCuboid): boolean[] {
  const vis = visibleFaces(c);
  return CUBOID_EDGES.map(([a, b]) =>
    CUBOID_FACES.some((f, i) => vis[i] && f.corners.includes(a) && f.corners.includes(b)));
}

/** Where the cuboid's center lands in the image (null if behind the camera). */
export function projectedCenter(cam: CameraModel, c: PhotoCuboid): Point2D | null {
  return project(cam, c.center);
}

/** Move the cuboid so its center projects to (u, v), keeping its depth. */
export function withCenterAtPixel(cam: CameraModel, c: PhotoCuboid, u: number, v: number): PhotoCuboid {
  const z = c.center.z;
  return { ...c, center: { x: ((u - cam.cx) / cam.fx) * z, y: ((v - cam.cy) / cam.fy) * z, z } };
}

/** Change depth to newZ while keeping the center's pixel position fixed. */
export function withDepth(cam: CameraModel, c: PhotoCuboid, newZ: number): PhotoCuboid {
  const z = Math.max(MIN_DEPTH, newZ);
  const p = projectedCenter(cam, c);
  if (!p) return { ...c, center: { ...c.center, z } };
  return withCenterAtPixel(cam, { ...c, center: { ...c.center, z } }, p.x, p.y);
}

/**
 * A starting cuboid at pixel (u, v): unit-ish size, placed at the depth where
 * its height covers about `fraction` of the image height. Illustrative only.
 */
export function defaultCuboidAt(
  cam: CameraModel, imageHeight: number, u: number, v: number,
  base: Pick<PhotoCuboid, 'id' | 'objectId' | 'classId'>, fraction = 0.25,
): PhotoCuboid {
  const size = { length: 1, width: 1, height: 1 };
  const z = Math.max(MIN_DEPTH, (cam.fy * size.height) / (fraction * imageHeight));
  return withCenterAtPixel(cam, { ...base, center: { x: 0, y: 0, z }, size, rotationY: 0 }, u, v);
}

/** Convex hull (monotone chain). Returns the hull in order. */
export function convexHull(points: Point2D[]): Point2D[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length <= 2) return pts;
  const cross = (o: Point2D, a: Point2D, b: Point2D) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point2D[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point2D[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return [...lower, ...upper];
}

/** Normalize an angle to (-pi, pi]. */
export function wrapAngle(a: number): number {
  const t = ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  return t === -Math.PI ? Math.PI : t;
}
