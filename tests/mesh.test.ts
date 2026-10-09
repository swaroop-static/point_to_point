import { describe, expect, it } from 'vitest';
import {
  buildAdjacency, faceNormals, facesToRanges, growRegion, rangesCount, rangesToFaces, rangesValid, rleClasses, subtractFaces,
} from '../src/mesh/faces';

/** Unit cube as a triangle soup (12 faces, 2 per side), vertices duplicated per face like a real export. */
function cube(): Float32Array {
  const v = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
  // Outward-facing (counter-clockwise seen from outside).
  const tris = [
    [0, 3, 2], [0, 2, 1], // z=0 (-z)
    [4, 5, 6], [4, 6, 7], // z=1 (+z)
    [0, 1, 5], [0, 5, 4], // y=0 (-y)
    [3, 7, 6], [3, 6, 2], // y=1 (+y)
    [0, 4, 7], [0, 7, 3], // x=0 (-x)
    [1, 2, 6], [1, 6, 5], // x=1 (+x)
  ];
  const out = new Float32Array(tris.length * 9);
  tris.forEach((t, i) => t.forEach((k, j) => out.set(v[k], i * 9 + j * 3)));
  return out;
}

describe('range encoding', () => {
  it('merges, sorts and round-trips', () => {
    const r = facesToRanges([5, 1, 2, 3, 9, 10, 2]);
    expect(r).toEqual([[1, 4], [5, 6], [9, 11]]);
    expect(rangesToFaces(r)).toEqual([1, 2, 3, 5, 9, 10]);
    expect(rangesCount(r)).toBe(6);
  });
  it('subtracts faces and splits ranges', () => {
    expect(subtractFaces([[0, 10]], new Set([0, 4, 5, 9]))).toEqual([[1, 4], [6, 9]]);
    expect(subtractFaces([[0, 3]], new Set())).toEqual([[0, 3]]);
  });
  it('validates ranges strictly', () => {
    expect(rangesValid([[0, 2], [3, 5]], 5)).toBe(true);
    expect(rangesValid([[0, 2], [2, 5]], 5)).toBe(true); // touching is fine
    expect(rangesValid([[0, 3], [2, 5]], 5)).toBe(false); // overlap
    expect(rangesValid([[3, 3]], 5)).toBe(false); // empty
    expect(rangesValid([[0, 6]], 5)).toBe(false); // out of bounds
    expect(rangesValid([[0.5, 2]], 5)).toBe(false); // non-integer
    expect(rangesValid([[3, 4], [0, 1]], 5)).toBe(false); // unsorted
  });
});

describe('normals and adjacency on a cube', () => {
  const c = cube();
  it('face normals point outward with unit length', () => {
    const n = faceNormals(c);
    expect([n[0], n[1], n[2]]).toEqual([0, 0, -1]); // face 0 is on z=0
    expect([n[3 * 6], n[3 * 6 + 1], n[3 * 6 + 2]]).toEqual([0, 1, 0]); // face 6 is on y=1
    for (let f = 0; f < 12; f++) expect(Math.hypot(n[f * 3], n[f * 3 + 1], n[f * 3 + 2])).toBeCloseTo(1, 6);
  });
  it('every cube face has exactly 3 neighbors, found despite duplicated vertices', () => {
    const adj = buildAdjacency(c);
    for (let f = 0; f < 12; f++) expect(adj.offsets[f + 1] - adj.offsets[f]).toBe(3);
  });
});

describe('region growing', () => {
  const c = cube(), adj = buildAdjacency(c), n = faceNormals(c);
  it('with a small angle selects exactly the coplanar side (2 triangles)', () => {
    const r = growRegion(adj, n, 0, 10).sort((a, b) => a - b);
    expect(r).toEqual([0, 1]);
  });
  it('with 90 degrees crosses the cube edges and takes everything', () => {
    expect(growRegion(adj, n, 0, 90)).toHaveLength(12);
  });
  it('180 degrees is the whole connected part; blocked faces are respected', () => {
    expect(growRegion(adj, n, 3, 180)).toHaveLength(12);
    const r = growRegion(adj, n, 0, 10, (f) => f === 1);
    expect(r).toEqual([0]);
  });
  it('does not jump between disconnected parts', () => {
    const two = new Float32Array(c.length * 2);
    two.set(c, 0);
    const moved = c.map((v, i) => (i % 3 === 0 ? v + 10 : v));
    two.set(moved, c.length);
    const a = buildAdjacency(two), nn = faceNormals(two);
    const r = growRegion(a, nn, 0, 180);
    expect(r).toHaveLength(12);
    expect(Math.max(...r)).toBeLessThan(12);
  });
});

describe('rleClasses', () => {
  it('encodes runs including unlabeled (-1)', () => {
    expect(rleClasses(new Int32Array([-1, -1, 0, 0, 0, 2, -1]))).toEqual([[-1, 2], [0, 3], [2, 1], [-1, 1]]);
    expect(rleClasses(new Int32Array([]))).toEqual([]);
  });
});

import { parseProjectJson } from '../src/core/validate';
import { exportMeshAnnotations } from '../src/io/meshExport';
import type { Project } from '../src/core/types';

function proj(labels: unknown, faceCount = 12): string {
  return JSON.stringify({
    formatVersion: 2, app: 'annotate-anything', name: 'p', savedAt: 'x',
    classes: [{ id: 'k1', name: 'a', color: '#112233' }, { id: 'k2', name: 'b', color: '#445566' }],
    images: [],
    meshes: [{ id: 'm1', name: 'cube.glb', format: 'glb', faceCount, labels }],
  });
}

describe('project validation of meshes', () => {
  it('accepts valid labels and round-trips', () => {
    const p = parseProjectJson(proj([{ id: 'l1', objectId: 1, classId: 'k1', ranges: [[0, 4]] }, { id: 'l2', objectId: 2, classId: 'k2', ranges: [[4, 6], [8, 12]] }]));
    expect(p.meshes?.[0].labels).toHaveLength(2);
  });
  it('rejects overlapping labels, bad ranges, unknown class, duplicate object ids', () => {
    expect(() => parseProjectJson(proj([{ id: 'a', objectId: 1, classId: 'k1', ranges: [[0, 6]] }, { id: 'b', objectId: 2, classId: 'k1', ranges: [[5, 8]] }]))).toThrow(/more than one label/);
    expect(() => parseProjectJson(proj([{ id: 'a', objectId: 1, classId: 'k1', ranges: [[0, 13]] }]))).toThrow(/invalid face ranges/);
    expect(() => parseProjectJson(proj([{ id: 'a', objectId: 1, classId: 'nope', ranges: [[0, 2]] }]))).toThrow(/unknown class/);
    expect(() => parseProjectJson(proj([{ id: 'a', objectId: 1, classId: 'k1', ranges: [[0, 2]] }, { id: 'b', objectId: 1, classId: 'k1', ranges: [[3, 4]] }]))).toThrow(/objectId 1/);
    expect(() => parseProjectJson(proj([], 0))).toThrow(/faceCount/);
  });
  it('older files without meshes still load', () => {
    const p = parseProjectJson(JSON.stringify({ formatVersion: 1, app: 'annotate-anything', name: 'p', savedAt: 'x', classes: [{ id: 'k', name: 'a', color: '#112233' }], images: [] }));
    expect(p.meshes).toBeUndefined();
  });
});

describe('mesh export', () => {
  it('writes ranges and an RLE that sums to the face count', () => {
    const p = parseProjectJson(proj([{ id: 'a', objectId: 1, classId: 'k2', ranges: [[2, 5]] }])) as Project;
    const { data } = exportMeshAnnotations(p);
    const m = data.meshes[0];
    expect(m.face_class_rle).toEqual([[-1, 2], [1, 3], [-1, 7]]);
    expect(m.face_class_rle.reduce((n, r) => n + r[1], 0)).toBe(12);
    expect(m.objects[0]).toMatchObject({ object_id: 1, class_index: 1, class_name: 'b', face_count: 3, face_ranges: [[2, 5]] });
  });
  it('skips meshes with no labels', () => {
    const p = parseProjectJson(proj([])) as Project;
    expect(exportMeshAnnotations(p).data.meshes).toHaveLength(0);
  });
});
