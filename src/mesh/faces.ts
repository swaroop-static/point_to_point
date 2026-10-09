/**
 * Pure triangle-mesh helpers (no DOM, no three.js). A mesh is a "triangle
 * soup": `positions` holds 9 floats per face (3 vertices x xyz) and a face's
 * index is its position in that list. Face labels are stored as sorted,
 * non-overlapping half-open ranges [start, end) so large labels stay small.
 */

export type Range = [number, number];

/** Sorted unique face indices -> merged half-open ranges. Input need not be sorted. */
export function facesToRanges(faces: Iterable<number>): Range[] {
  const a = Array.from(new Set(faces)).sort((x, y) => x - y);
  const out: Range[] = [];
  for (const f of a) {
    const last = out[out.length - 1];
    if (last && last[1] === f) last[1] = f + 1; else out.push([f, f + 1]);
  }
  return out;
}

export function rangesToFaces(ranges: readonly Range[]): number[] {
  const out: number[] = [];
  for (const [s, e] of ranges) for (let i = s; i < e; i++) out.push(i);
  return out;
}

export function rangesCount(ranges: readonly Range[]): number {
  let n = 0;
  for (const [s, e] of ranges) n += e - s;
  return n;
}

/** Remove a set of faces from ranges. */
export function subtractFaces(ranges: readonly Range[], remove: ReadonlySet<number>): Range[] {
  if (!remove.size) return ranges.map((r) => [r[0], r[1]] as Range);
  const keep: number[] = [];
  for (const [s, e] of ranges) for (let i = s; i < e; i++) if (!remove.has(i)) keep.push(i);
  return facesToRanges(keep);
}

/** True when ranges are integers, 0 <= start < end <= faceCount, sorted and non-overlapping. */
export function rangesValid(ranges: readonly Range[], faceCount: number): boolean {
  let prevEnd = 0;
  for (const r of ranges) {
    if (!Array.isArray(r) || r.length !== 2) return false;
    const [s, e] = r;
    if (!Number.isInteger(s) || !Number.isInteger(e) || s < prevEnd || e <= s || e > faceCount) return false;
    prevEnd = e;
  }
  return true;
}

export function faceNormals(positions: Float32Array): Float32Array {
  const n = positions.length / 9;
  const out = new Float32Array(n * 3);
  for (let f = 0; f < n; f++) {
    const o = f * 9;
    const ax = positions[o + 3] - positions[o], ay = positions[o + 4] - positions[o + 1], az = positions[o + 5] - positions[o + 2];
    const bx = positions[o + 6] - positions[o], by = positions[o + 7] - positions[o + 1], bz = positions[o + 8] - positions[o + 2];
    let x = ay * bz - az * by, y = az * bx - ax * bz, z = ax * by - ay * bx;
    const l = Math.hypot(x, y, z);
    if (l > 0) { x /= l; y /= l; z /= l; }
    out[f * 3] = x; out[f * 3 + 1] = y; out[f * 3 + 2] = z;
  }
  return out;
}

/** Face adjacency in CSR form: neighbors of face f are list[offsets[f] .. offsets[f+1]). */
export interface Adjacency { offsets: Uint32Array; list: Uint32Array }

/**
 * Faces are neighbors when they share an edge, where vertices closer than
 * `weld` (a fraction of the bounding-box diagonal) count as the same vertex.
 * Welding matters because exporters often duplicate vertices along UV/normal seams.
 */
export function buildAdjacency(positions: Float32Array, weldFraction = 1e-6): Adjacency {
  const nFaces = positions.length / 9;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
  const q = diag * weldFraction;
  const ids = new Map<string, number>();
  const vid = new Uint32Array(nFaces * 3);
  for (let v = 0; v < nFaces * 3; v++) {
    const key = `${Math.round(positions[v * 3] / q)},${Math.round(positions[v * 3 + 1] / q)},${Math.round(positions[v * 3 + 2] / q)}`;
    let id = ids.get(key);
    if (id === undefined) { id = ids.size; ids.set(key, id); }
    vid[v] = id;
  }
  const V = ids.size;
  const edgeFaces = new Map<number, number[]>();
  for (let f = 0; f < nFaces; f++) {
    for (let k = 0; k < 3; k++) {
      const a = vid[f * 3 + k], b = vid[f * 3 + (k + 1) % 3];
      if (a === b) continue; // degenerate edge
      const key = a < b ? a * V + b : b * V + a;
      const l = edgeFaces.get(key);
      if (l) l.push(f); else edgeFaces.set(key, [f]);
    }
  }
  const nbrs: number[][] = Array.from({ length: nFaces }, () => []);
  for (const l of edgeFaces.values()) {
    for (let i = 0; i < l.length; i++) for (let j = 0; j < l.length; j++) if (i !== j && l[i] !== l[j]) nbrs[l[i]].push(l[j]);
  }
  const offsets = new Uint32Array(nFaces + 1);
  for (let f = 0; f < nFaces; f++) offsets[f + 1] = offsets[f] + nbrs[f].length;
  const list = new Uint32Array(offsets[nFaces]);
  for (let f = 0; f < nFaces; f++) list.set(nbrs[f], offsets[f]);
  return { offsets, list };
}

/**
 * Grow a region from `seed` across shared edges while the angle between a face
 * and the neighbor being added stays within `maxAngleDeg`. 180 means "the whole
 * connected part". Faces rejected by `blocked` are never entered.
 */
export function growRegion(adj: Adjacency, normals: Float32Array, seed: number, maxAngleDeg: number, blocked?: (f: number) => boolean): number[] {
  const cosMin = Math.cos((Math.min(Math.max(maxAngleDeg, 0), 180) * Math.PI) / 180);
  const seen = new Set<number>([seed]);
  const out: number[] = [];
  const stack = [seed];
  while (stack.length) {
    const f = stack.pop()!;
    out.push(f);
    const fx = normals[f * 3], fy = normals[f * 3 + 1], fz = normals[f * 3 + 2];
    for (let i = adj.offsets[f]; i < adj.offsets[f + 1]; i++) {
      const g = adj.list[i];
      if (seen.has(g) || (blocked && blocked(g))) continue;
      const dot = fx * normals[g * 3] + fy * normals[g * 3 + 1] + fz * normals[g * 3 + 2];
      if (dot >= cosMin - 1e-9) { seen.add(g); stack.push(g); }
    }
  }
  return out;
}

/** Run-length encode per-face class indices (-1 = unlabeled): [[classIndex, runLength], ...]. */
export function rleClasses(perFace: Int32Array): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < perFace.length; i++) {
    const last = out[out.length - 1];
    if (last && last[0] === perFace[i]) last[1]++; else out.push([perFace[i], 1]);
  }
  return out;
}
