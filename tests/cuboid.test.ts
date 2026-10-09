import { describe, expect, it } from 'vitest';
import type { PhotoCuboid, Project } from '../src/core/types';
import {
  CUBOID_EDGES, MIN_DEPTH, cameraFromHorizontalFov, convexHull, cuboidCorners3D, defaultCuboidAt,
  horizontalFovDeg, project, projectCuboid, projectedCenter, visibleEdges, visibleFaces, withCenterAtPixel, withDepth, wrapAngle,
} from '../src/core/cuboid';
import { parseProjectJson } from '../src/core/validate';
import { exportPhotoCuboids } from '../src/io/photoCuboids';

const cam = { fx: 100, fy: 100, cx: 50, cy: 40, calibrated: false };
const box = (over: Partial<PhotoCuboid> = {}): PhotoCuboid => ({
  id: 'c1', objectId: 1, classId: 'k', center: { x: 0, y: 0, z: 10 },
  size: { length: 2, width: 2, height: 2 }, rotationY: 0, ...over,
});
const dist = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

describe('camera and projection', () => {
  it('field of view round-trips and the optical axis hits the principal point', () => {
    const c = cameraFromHorizontalFov(1000, 600, 60);
    expect(horizontalFovDeg(c, 1000)).toBeCloseTo(60, 9);
    expect(c.cx).toBe(500); expect(c.cy).toBe(300); expect(c.calibrated).toBe(false);
    expect(project(c, { x: 0, y: 0, z: 5 })).toEqual({ x: 500, y: 300 });
  });
  it('projects with hand-computed numbers and rejects points at or behind the camera', () => {
    expect(project(cam, { x: 1, y: 0.5, z: 2 })).toEqual({ x: 100, y: 65 }); // 100*1/2+50, 100*0.5/2+40
    expect(project(cam, { x: 1, y: 1, z: 0 })).toBeNull();
    expect(project(cam, { x: 1, y: 1, z: -3 })).toBeNull();
  });
});

describe('cuboid geometry', () => {
  it('unrotated corners match hand-computed positions and index bits', () => {
    const c = cuboidCorners3D(box());
    expect(c[0]).toEqual({ x: -1, y: -1, z: 9 });   // -x, top (-y), rear (-z)
    expect(c[7]).toEqual({ x: 1, y: 1, z: 11 });    // +x, bottom (+y), front (+z)
    expect(c[4]).toEqual({ x: -1, y: -1, z: 11 });  // bit2 only: front
  });
  it('rotationY = +90deg maps local (-1,.,+1) to camera (+1,.,+1) about the box center', () => {
    const c = cuboidCorners3D(box({ rotationY: Math.PI / 2 }));
    expect(c[4].x).toBeCloseTo(1, 12);
    expect(c[4].z).toBeCloseTo(11, 12);
    expect(c[4].y).toBeCloseTo(-1, 12);
  });
  it('is rigid: every edge keeps its length for any rotation, size and position', () => {
    const b = box({ center: { x: 3, y: -2, z: 7 }, size: { length: 4, width: 1.5, height: 3 }, rotationY: 0.9 });
    const c = cuboidCorners3D(b);
    for (const [a, z] of CUBOID_EDGES) {
      const bit = a ^ z;
      const want = bit === 1 ? 1.5 : bit === 2 ? 3 : 4;
      expect(dist(c[a], c[z])).toBeCloseTo(want, 12);
    }
    expect(CUBOID_EDGES).toHaveLength(12);
  });
  it('visible faces: a centered box shows only its near (rear, -z) face; an off-axis box shows three', () => {
    const f = visibleFaces(box());
    expect(f.filter(Boolean)).toHaveLength(1);
    expect(f[1]).toBe(true); // rear
    const off = visibleFaces(box({ center: { x: 3, y: 2, z: 10 } }));
    expect(off.filter(Boolean)).toHaveLength(3);
    const edges = visibleEdges(box({ center: { x: 3, y: 2, z: 10 } }));
    expect(edges.filter(Boolean)).toHaveLength(9); // 12 edges minus the 3 fully hidden ones
  });
  it('projectCuboid yields 8 points in front of the camera and nulls behind it', () => {
    expect(projectCuboid(cam, box()).every((p) => p !== null)).toBe(true);
    const behind = projectCuboid(cam, box({ center: { x: 0, y: 0, z: 0.5 } }));
    expect(behind.some((p) => p === null)).toBe(true);
  });
});

describe('editing helpers', () => {
  it('withCenterAtPixel puts the center exactly on the requested pixel and keeps depth', () => {
    const m = withCenterAtPixel(cam, box(), 77, 12);
    const p = projectedCenter(cam, m)!;
    expect(p.x).toBeCloseTo(77, 9); expect(p.y).toBeCloseTo(12, 9);
    expect(m.center.z).toBe(10);
  });
  it('withDepth keeps the center pixel fixed, scales the projected size inversely, and floors at MIN_DEPTH', () => {
    const start = withCenterAtPixel(cam, box(), 80, 60);
    const far = withDepth(cam, start, 20);
    const p0 = projectedCenter(cam, start)!, p1 = projectedCenter(cam, far)!;
    expect(p1.x).toBeCloseTo(p0.x, 9); expect(p1.y).toBeCloseTo(p0.y, 9);
    const w0 = Math.abs(projectCuboid(cam, start)[1]!.x - projectCuboid(cam, start)[0]!.x);
    const w1 = Math.abs(projectCuboid(cam, far)[1]!.x - projectCuboid(cam, far)[0]!.x);
    expect(w1 / w0).toBeCloseTo(0.5, 1);
    expect(withDepth(cam, start, -5).center.z).toBe(MIN_DEPTH);
  });
  it('defaultCuboidAt lands on the clicked pixel in front of the camera', () => {
    const c = cameraFromHorizontalFov(1000, 600, 60);
    const d = defaultCuboidAt(c, 600, 321, 222, { id: 'x', objectId: 4, classId: 'k' });
    const p = projectedCenter(c, d)!;
    expect(p.x).toBeCloseTo(321, 9); expect(p.y).toBeCloseTo(222, 9);
    expect(d.center.z).toBeGreaterThan(0);
    expect(d.objectId).toBe(4);
  });
  it('convex hull and angle wrapping', () => {
    const h = convexHull([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }, { x: 2, y: 2 }]);
    expect(h).toHaveLength(4);
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapAngle(-3 * Math.PI / 2)).toBeCloseTo(Math.PI / 2, 12);
  });
});

function project2(): Project {
  const c = cameraFromHorizontalFov(640, 480, 60);
  return {
    formatVersion: 2, app: 'annotate-anything', name: 'p3d', savedAt: '2026-01-01T00:00:00.000Z',
    classes: [{ id: 'k', name: 'car', color: '#ff0000' }],
    images: [{
      id: 'i', name: 'street.jpg', width: 640, height: 480, annotations: [], camera: c,
      cuboids: [
        box({ id: 'a', objectId: 1, center: { x: 1, y: 0.5, z: 8 }, rotationY: 0.4, size: { length: 4, width: 1.8, height: 1.5 } }),
        box({ id: 'b', objectId: 2, center: { x: -2, y: 0.5, z: 12 }, hidden: true, locked: true, note: 'parked' }),
      ],
    }, { id: 'j', name: 'none.jpg', width: 10, height: 10, annotations: [] }],
  };
}

describe('project file with cuboids', () => {
  it('round-trips camera and cuboids exactly', () => {
    const p = project2();
    expect(parseProjectJson(JSON.stringify(p))).toEqual(p);
  });
  it('rejects bad data: duplicate objectId, non-positive size, center behind camera, unknown class, bad camera', () => {
    const mk = (f: (p: Project) => void) => { const p = project2(); f(p); return JSON.stringify(p); };
    expect(() => parseProjectJson(mk((p) => { p.images[0].cuboids![1].objectId = 1; }))).toThrow(/two cuboids/);
    expect(() => parseProjectJson(mk((p) => { p.images[0].cuboids![0].size.width = 0; }))).toThrow(/positive/);
    expect(() => parseProjectJson(mk((p) => { p.images[0].cuboids![0].center.z = -1; }))).toThrow(/in front of the camera/);
    expect(() => parseProjectJson(mk((p) => { p.images[0].cuboids![0].classId = 'zzz'; }))).toThrow(/unknown classId/);
    expect(() => parseProjectJson(mk((p) => { p.images[0].camera!.fx = 0; }))).toThrow(/positive/);
  });
  it('a version-1 file (no cuboids) still loads and is stamped version 2', () => {
    const v1 = { ...project2(), formatVersion: 1, images: [{ id: 'i', name: 'a.jpg', width: 5, height: 5, annotations: [] }] };
    const out = parseProjectJson(JSON.stringify(v1));
    expect(out.formatVersion).toBe(2);
    expect(out.images[0].cuboids).toBeUndefined();
  });
});

describe('photo-cuboid export', () => {
  it('writes the documented schema; 2D corners are exactly the projection of the 3D corners', () => {
    const { data, warnings } = exportPhotoCuboids(project2());
    expect(warnings).toEqual([]);
    expect(data.schema).toBe('annotate-anything/photo-cuboids');
    expect(data.schema_version).toBe(1);
    expect(data.images).toHaveLength(1); // the image without cuboids is omitted
    const img = data.images[0];
    expect(img.metric).toBe(false);
    expect(img.cuboids).toHaveLength(2);
    const cam = img.camera!;
    for (const row of img.cuboids) {
      expect(row.corners_3d).toHaveLength(8);
      row.corners_3d.forEach((p, i) => {
        const uv = project(cam, { x: p[0], y: p[1], z: p[2] })!;
        expect(row.corners_2d[i]![0]).toBeCloseTo(uv.x, 9);
        expect(row.corners_2d[i]![1]).toBeCloseTo(uv.y, 9);
      });
    }
  });
  it('round-trips: rebuilding a cuboid from the exported parameters reproduces the exported corners', () => {
    const { data } = exportPhotoCuboids(project2());
    const row = data.images[0].cuboids[0];
    const rebuilt = cuboidCorners3D({
      id: row.id, objectId: row.object_id, classId: 'k',
      center: { x: row.center[0], y: row.center[1], z: row.center[2] }, size: row.size, rotationY: row.rotation_y,
    });
    rebuilt.forEach((p, i) => {
      expect(p.x).toBeCloseTo(row.corners_3d[i][0], 12);
      expect(p.y).toBeCloseTo(row.corners_3d[i][1], 12);
      expect(p.z).toBeCloseTo(row.corners_3d[i][2], 12);
    });
  });
  it('marks metric only for a declared calibration, warns on corners behind the camera, skips cameraless images', () => {
    const p = project2();
    p.images[0].camera!.calibrated = true;
    expect(exportPhotoCuboids(p).data.images[0].metric).toBe(true);
    p.images[0].cuboids![0].center.z = 0.5;
    const r = exportPhotoCuboids(p);
    expect(r.warnings.join(' ')).toMatch(/behind the camera/);
    expect(r.data.images[0].cuboids[0].corners_2d.some((c) => c === null)).toBe(true);
    delete p.images[0].camera;
    const r2 = exportPhotoCuboids(p);
    expect(r2.data.images).toHaveLength(0);
    expect(r2.warnings.join(' ')).toMatch(/no camera/);
  });
});
