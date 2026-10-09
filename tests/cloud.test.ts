import { describe, expect, it } from 'vitest';
import type { Cuboid3D } from '../src/core/types';
import {
  CUBOID_EDGES, cuboidCorners, extentOf, pickPoint, pointsInCuboid, pointsInRect, rayCuboid, screenProject, wrapYaw,
} from '../src/cloud/geom';
import { parsePcd } from '../src/cloud/load';
import { parseProjectJson } from '../src/core/validate';

const cub = (over: Partial<Cuboid3D> = {}): Cuboid3D => ({
  id: 'c', objectId: 1, classId: 'k', center: { x: 10, y: 20, z: 5 }, size: { length: 4, width: 2, height: 6 }, yaw: 0, ...over,
});

describe('cuboid geometry', () => {
  it('up=z: unrotated corners match hand-computed positions and bit order', () => {
    const c = cuboidCorners(cub(), 'z');
    expect(c[0]).toEqual({ x: 8, y: 19, z: 2 });   // -length, -width, -height
    expect(c[7]).toEqual({ x: 12, y: 21, z: 8 });  // +,+,+
    expect(c[1]).toEqual({ x: 12, y: 19, z: 2 });  // bit0 only: +length
    expect(c[4]).toEqual({ x: 8, y: 19, z: 8 });   // bit2 only: +height
  });
  it('up=y: height runs along y and the horizontal plane is x,z', () => {
    const c = cuboidCorners(cub({ center: { x: 0, y: 0, z: 0 } }), 'y');
    expect(c[7]).toEqual({ x: 2, y: 3, z: 1 });   // length->x, width->z, height->y
  });
  it('yaw = +90 degrees turns length from +a toward +b', () => {
    const c = cuboidCorners(cub({ center: { x: 0, y: 0, z: 0 }, yaw: Math.PI / 2 }), 'z');
    // local (+length/2, +width/2) = (2, 1) -> world (-1, 2)
    expect(c[3].x).toBeCloseTo(-1, 12); expect(c[3].y).toBeCloseTo(2, 12);
  });
  it('has 12 edges, each joining corners that differ in one bit', () => {
    expect(CUBOID_EDGES).toHaveLength(12);
    for (const [a, b] of CUBOID_EDGES) expect([1, 2, 4]).toContain(a ^ b);
  });
  it('keeps edge lengths equal to the size under rotation', () => {
    const c = cuboidCorners(cub({ yaw: 0.7 }), 'z');
    const d = (i: number, j: number) => Math.hypot(c[i].x - c[j].x, c[i].y - c[j].y, c[i].z - c[j].z);
    expect(d(0, 1)).toBeCloseTo(4, 9); expect(d(0, 2)).toBeCloseTo(2, 9); expect(d(0, 4)).toBeCloseTo(6, 9);
  });
});

describe('points in cuboid', () => {
  // 5x5x5 integer grid at 0..4 (125 points)
  const pts: number[] = [];
  for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) for (let z = 0; z < 5; z++) pts.push(x, y, z);
  const P = new Float32Array(pts);
  it('counts exactly the grid points inside, boundary included', () => {
    const c = cub({ center: { x: 2, y: 2, z: 2 }, size: { length: 2, width: 2, height: 2 } }); // x,y,z in [1,3] -> 3^3
    expect(pointsInCuboid(P, c, 'z')).toHaveLength(27);
  });
  it('a 45 degree yaw about a thin slab includes the diagonal points only', () => {
    const c = cub({ center: { x: 2, y: 2, z: 2 }, size: { length: 8, width: 0.5, height: 8 }, yaw: Math.PI / 4 });
    const inside = pointsInCuboid(P, c, 'z');
    // diagonal x == y: 5 positions x 5 z levels
    expect(inside).toHaveLength(25);
    for (const i of inside) expect(P[i * 3]).toBe(P[i * 3 + 1]);
  });
  it('is invariant to the box being tiny or empty of points', () => {
    expect(pointsInCuboid(P, cub({ center: { x: 100, y: 0, z: 0 } }), 'z')).toHaveLength(0);
  });
});

describe('ray vs cuboid', () => {
  it('hits the near face at the right distance and misses when offset', () => {
    const c = cub({ center: { x: 0, y: 0, z: 0 }, size: { length: 2, width: 2, height: 2 } });
    expect(rayCuboid({ x: -10, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, c, 'z')).toBeCloseTo(9, 9);
    expect(rayCuboid({ x: -10, y: 5, z: 0 }, { x: 1, y: 0, z: 0 }, c, 'z')).toBeNull();
    expect(rayCuboid({ x: 10, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, c, 'z')).toBeNull(); // box is behind
  });
  it('respects yaw: a long thin box rotated 90 degrees is hit along the other axis', () => {
    const c = cub({ center: { x: 0, y: 0, z: 0 }, size: { length: 10, width: 1, height: 1 }, yaw: Math.PI / 2 });
    expect(rayCuboid({ x: 0, y: -20, z: 0 }, { x: 0, y: 1, z: 0 }, c, 'z')).toBeCloseTo(15, 9);
    expect(rayCuboid({ x: -20, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, c, 'z')).toBeCloseTo(19.5, 9);
  });
});

describe('screen projection and picking', () => {
  // Identity matrix: ndc = xyz directly (orthographic unit cube), w = 1.
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const P = new Float32Array([0, 0, 0, 1, 1, -1, -1, -1, 0.5, 0, 0, 2]);
  it('maps ndc to pixels with y flipped and rejects points outside depth range', () => {
    const s = screenProject(P, I, 200, 100);
    expect([s[0], s[1], s[2]]).toEqual([100, 50, 0]);
    expect([s[3], s[4]]).toEqual([200, 0]);   // ndc (1,1) -> top right
    expect([s[6], s[7]]).toEqual([0, 100]);   // ndc (-1,-1) -> bottom left
    expect(Number.isNaN(s[9])).toBe(true); // 4th point has depth 2, outside the near/far range
  });
  it('NaN for points behind the camera (w <= 0)', () => {
    const behind = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, -1]; // w = z - 1; z=0 -> w=-1
    expect(Number.isNaN(screenProject(new Float32Array([0, 0, 0]), behind, 10, 10)[0])).toBe(true);
  });
  it('rect selection and nearest-to-camera picking', () => {
    const pts = new Float32Array([0, 0, 0.5, 0.01, 0.0, -0.5, 0.9, 0.9, 0]); // two overlap near center, one far
    const s = screenProject(pts, I, 200, 200);
    expect(pointsInRect(s, 90, 90, 110, 110)).toEqual([0, 1]);
    expect(pointsInRect(s, 110, 110, 90, 90)).toEqual([0, 1]); // reversed corners
    expect(pickPoint(s, 100, 100, 6)).toBe(1); // smaller ndc depth wins
    expect(pickPoint(s, 20, 20, 6)).toBe(-1);
  });
});

describe('misc', () => {
  it('extent and yaw wrap', () => {
    const e = extentOf(new Float32Array([0, 0, 0, 3, 4, 12]));
    expect(e.diag).toBeCloseTo(13, 9);
    expect(wrapYaw(3 * Math.PI)).toBeCloseTo(Math.PI, 9);
    expect(wrapYaw(-Math.PI)).toBeCloseTo(Math.PI, 9);
    expect(wrapYaw(0.5)).toBe(0.5);
  });
});

function pcdAscii(): ArrayBuffer {
  const t = 'VERSION .7\nFIELDS x y z rgb\nSIZE 4 4 4 4\nTYPE F F F F\nCOUNT 1 1 1 1\nWIDTH 3\nHEIGHT 1\nVIEWPOINT 0 0 0 1 0 0 0\nPOINTS 3\nDATA ascii\n' +
    '1 2 3 4.2108e+06\n4 5 6 0\nnan 0 0 0\n';
  return new TextEncoder().encode(t).buffer as ArrayBuffer;
}

describe('PCD parser', () => {
  it('reads ASCII, drops non-finite points and counts them', () => {
    const r = parsePcd(pcdAscii());
    expect(Array.from(r.positions)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(r.dropped).toBe(1);
    expect(r.colors).not.toBeNull();
  });
  it('reads uncompressed binary with packed rgb', () => {
    const head = 'VERSION .7\nFIELDS x y z rgb\nSIZE 4 4 4 4\nTYPE F F F U\nCOUNT 1 1 1 1\nWIDTH 2\nHEIGHT 1\nVIEWPOINT 0 0 0 1 0 0 0\nPOINTS 2\nDATA binary\n';
    const h = new TextEncoder().encode(head);
    const body = new DataView(new ArrayBuffer(32));
    [[1.5, -2, 3, 0xff8000], [7, 8, 9, 0x0000ff]].forEach((p, i) => {
      body.setFloat32(i * 16, p[0], true); body.setFloat32(i * 16 + 4, p[1], true); body.setFloat32(i * 16 + 8, p[2], true); body.setUint32(i * 16 + 12, p[3], true);
    });
    const buf = new Uint8Array(h.length + 32); buf.set(h, 0); buf.set(new Uint8Array(body.buffer), h.length);
    const r = parsePcd(buf.buffer);
    expect(Array.from(r.positions)).toEqual([1.5, -2, 3, 7, 8, 9]);
    expect(Array.from(r.colors!).map((v) => Math.round(v * 255))).toEqual([255, 128, 0, 0, 0, 255]);
  });
  it('rejects compressed data, missing header, short data and absurd sizes', () => {
    const mk = (d: string, extra = '') => new TextEncoder().encode(`VERSION .7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\nWIDTH 1\nHEIGHT 1\nPOINTS ${extra || 1}\nDATA ${d}\n1 2 3\n`).buffer as ArrayBuffer;
    expect(() => parsePcd(mk('binary_compressed'))).toThrow(/Compressed/);
    expect(() => parsePcd(new TextEncoder().encode('hello').buffer as ArrayBuffer)).toThrow(/DATA line/);
    expect(() => parsePcd(mk('binary'))).toThrow(/shorter/);
    expect(() => parsePcd(mk('ascii', '99999999'))).toThrow(/limit/);
    expect(() => parsePcd(mk('ascii', '5'))).toThrow(/only 1/);
  });
});

function projJson(clouds: unknown): string {
  return JSON.stringify({
    formatVersion: 2, app: 'annotate-anything', name: 'p', savedAt: 'x', images: [],
    classes: [{ id: 'k1', name: 'a', color: '#112233' }, { id: 'k2', name: 'b', color: '#445566' }],
    clouds,
  });
}
const goodCloud = (over: Record<string, unknown> = {}) => ({
  id: 'c1', name: 'scan.ply', format: 'ply', pointCount: 100, upAxis: 'z',
  cuboids: [{ id: 'b1', objectId: 1, classId: 'k1', center: { x: 0, y: 0, z: 0 }, size: { length: 1, width: 1, height: 1 }, yaw: 0.3 }],
  pointLabels: [{ id: 'l1', classId: 'k2', ranges: [[0, 10], [20, 30]] }], ...over,
});

describe('project validation of clouds', () => {
  it('accepts a valid cloud', () => {
    const p = parseProjectJson(projJson([goodCloud()]));
    expect(p.clouds?.[0].cuboids[0].yaw).toBe(0.3);
    expect(p.clouds?.[0].pointLabels[0].ranges).toEqual([[0, 10], [20, 30]]);
  });
  it('rejects bad input with specific messages', () => {
    expect(() => parseProjectJson(projJson([goodCloud({ upAxis: 'x' })]))).toThrow(/upAxis/);
    expect(() => parseProjectJson(projJson([goodCloud({ pointLabels: [{ id: 'l', classId: 'k2', ranges: [[0, 101]] }] })]))).toThrow(/invalid index ranges/);
    expect(() => parseProjectJson(projJson([goodCloud({ pointLabels: [{ id: 'l', classId: 'k2', ranges: [[0, 10]] }, { id: 'm', classId: 'k1', ranges: [[5, 12]] }] })]))).toThrow(/more than one label/);
    expect(() => parseProjectJson(projJson([goodCloud({ cuboids: [{ id: 'b', objectId: 1, classId: 'zz', center: { x: 0, y: 0, z: 0 }, size: { length: 1, width: 1, height: 1 }, yaw: 0 }] })]))).toThrow(/unknown class/);
    expect(() => parseProjectJson(projJson([goodCloud({ cuboids: [{ id: 'b', objectId: 1, classId: 'k1', center: { x: 0, y: 0, z: 0 }, size: { length: 0, width: 1, height: 1 }, yaw: 0 }] })]))).toThrow(/positive/);
    expect(() => parseProjectJson(projJson([goodCloud({ cuboids: [{ id: 'b', objectId: 1, classId: 'k1', center: { x: NaN, y: 0, z: 0 }, size: { length: 1, width: 1, height: 1 }, yaw: 0 }] })]))).toThrow();
  });
});

import { flagsToRanges, rangesToFlags } from '../src/mesh/faces';
describe('index-set helpers', () => {
  it('flags and ranges round-trip, including the last index and empty sets', () => {
    const r: [number, number][] = [[0, 2], [4, 5], [7, 10]];
    expect(flagsToRanges(rangesToFlags(r, 10))).toEqual(r);
    expect(flagsToRanges(new Uint8Array(5))).toEqual([]);
    expect(flagsToRanges(new Uint8Array([1, 1, 1]))).toEqual([[0, 3]]);
  });
});
