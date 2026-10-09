import type { CloudEntry } from '../core/types';

export type CloudFormat = CloudEntry['format'];

export interface LoadedCloud {
  format: CloudFormat;
  /** xyz per point, Float32. Non-finite points are dropped. */
  positions: Float32Array;
  /** rgb per point in 0..1 when the file has colors, else null. */
  colors: Float32Array | null;
  pointCount: number;
  /** Points skipped because a coordinate was NaN or infinite. */
  dropped: number;
}

export const MAX_POINTS = 6_000_000;

export function cloudFormatOf(name: string): CloudFormat | null {
  const n = name.toLowerCase();
  if (n.endsWith('.ply')) return 'ply';
  if (n.endsWith('.pcd')) return 'pcd';
  return null;
}

/**
 * Parse a PCD file (PCL point cloud data v0.7): ASCII or uncompressed binary,
 * with x, y, z as 32/64-bit float and an optional packed `rgb`/`rgba` field.
 * `binary_compressed` (LZF) is rejected with a clear message, not guessed at.
 */
export function parsePcd(buf: ArrayBuffer): { positions: Float32Array; colors: Float32Array | null; dropped: number } {
  const bytes = new Uint8Array(buf);
  // Header is ASCII lines up to and including the DATA line.
  let end = -1;
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 8192)));
  const m = /(^|\n)DATA\s+(\S+)[^\n]*\n/.exec(head);
  if (m) end = m.index + m[0].length;
  if (!m || end < 0) throw new Error('Not a valid PCD file (no DATA line in the header).');
  const header = head.slice(0, end);
  const get = (key: string): string[] | null => {
    const r = new RegExp(`(?:^|\\n)${key}\\s+([^\\n]*)`).exec(header);
    return r ? r[1].trim().split(/\s+/) : null;
  };
  const fields = get('FIELDS'), sizes = get('SIZE')?.map(Number), types = get('TYPE'), counts = (get('COUNT') ?? fields?.map(() => '1'))?.map(Number);
  const points = Number(get('POINTS')?.[0]);
  const data = m[2].toLowerCase();
  if (!fields || !sizes || !types || !counts || !Number.isInteger(points) || points < 0) throw new Error('PCD header is missing FIELDS, SIZE, TYPE or POINTS.');
  if (data === 'binary_compressed') throw new Error('Compressed (binary_compressed) PCD files are not supported. Re-save as ascii or binary.');
  if (data !== 'ascii' && data !== 'binary') throw new Error(`Unknown PCD DATA type "${m[2]}".`);
  if (points > MAX_POINTS) throw new Error(`This cloud has ${points.toLocaleString()} points, above the ${MAX_POINTS.toLocaleString()} limit of the browser editor. Downsample it first.`);

  const idx = (f: string): number => fields.indexOf(f);
  const ix = idx('x'), iy = idx('y'), iz = idx('z');
  if (ix < 0 || iy < 0 || iz < 0) throw new Error('PCD has no x, y, z fields.');
  const irgb = idx('rgb') >= 0 ? idx('rgb') : idx('rgba');
  // Byte offset of each field inside one point (binary layout).
  const offs: number[] = []; let stride = 0;
  fields.forEach((_, i) => { offs.push(stride); stride += sizes[i] * counts[i]; });

  const positions = new Float32Array(points * 3);
  const colors = irgb >= 0 ? new Float32Array(points * 3) : null;
  let n = 0, dropped = 0;
  const put = (x: number, y: number, z: number, packed: number | null): void => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) { dropped++; return; }
    positions[n * 3] = x; positions[n * 3 + 1] = y; positions[n * 3 + 2] = z;
    if (colors && packed !== null) {
      colors[n * 3] = ((packed >> 16) & 255) / 255; colors[n * 3 + 1] = ((packed >> 8) & 255) / 255; colors[n * 3 + 2] = (packed & 255) / 255;
    }
    n++;
  };

  if (data === 'ascii') {
    const lines = new TextDecoder().decode(bytes.subarray(end)).split('\n');
    let seen = 0;
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      if (seen >= points) break;
      const v = t.split(/\s+/);
      // COUNT > 1 fields shift later columns; compute each field's column.
      const col = (fi: number): number => { let c = 0; for (let k = 0; k < fi; k++) c += counts[k]; return c; };
      let packed: number | null = null;
      if (irgb >= 0) {
        const raw = Number(v[col(irgb)]);
        packed = types[irgb] === 'F' ? floatBitsToUint(raw) : raw >>> 0;
      }
      put(Number(v[col(ix)]), Number(v[col(iy)]), Number(v[col(iz)]), packed);
      seen++;
    }
    if (seen < points) throw new Error(`PCD declares ${points} points but only ${seen} were found.`);
  } else {
    if (bytes.length - end < points * stride) throw new Error('PCD binary data is shorter than the header says.');
    const dv = new DataView(buf, end);
    const rd = (i: number, base: number): number => {
      const o = base + offs[i], s = sizes[i], t = types[i];
      if (t === 'F') return s === 4 ? dv.getFloat32(o, true) : dv.getFloat64(o, true);
      if (t === 'U') return s === 1 ? dv.getUint8(o) : s === 2 ? dv.getUint16(o, true) : dv.getUint32(o, true);
      return s === 1 ? dv.getInt8(o) : s === 2 ? dv.getInt16(o, true) : dv.getInt32(o, true);
    };
    for (let p = 0; p < points; p++) {
      const base = p * stride;
      let packed: number | null = null;
      if (irgb >= 0) packed = types[irgb] === 'F' ? dv.getUint32(base + offs[irgb], true) : rd(irgb, base) >>> 0;
      put(rd(ix, base), rd(iy, base), rd(iz, base), packed);
    }
  }
  return { positions: positions.slice(0, n * 3), colors: colors ? colors.slice(0, n * 3) : null, dropped };
}

function floatBitsToUint(f: number): number {
  const b = new DataView(new ArrayBuffer(4));
  b.setFloat32(0, f, true);
  return b.getUint32(0, true);
}

/**
 * Read a .ply or .pcd file into a flat point list. three.js (PLY only) is
 * imported lazily. For PLY, the file's vertices are the points; any faces are ignored.
 */
export async function loadCloudFile(file: File): Promise<LoadedCloud> {
  const format = cloudFormatOf(file.name);
  if (!format) throw new Error(`Unsupported point-cloud file: ${file.name}. Use .ply or .pcd.`);
  let positions: Float32Array, colors: Float32Array | null, dropped: number;
  try {
    if (format === 'pcd') {
      ({ positions, colors, dropped } = parsePcd(await file.arrayBuffer()));
    } else {
      const { PLYLoader } = await import('three/addons/loaders/PLYLoader.js');
      const g = new PLYLoader().parse(await file.arrayBuffer());
      const pos = g.getAttribute('position');
      if (!pos) throw new Error('PLY has no vertices.');
      if (pos.count > MAX_POINTS) throw new Error(`This cloud has ${pos.count.toLocaleString()} points, above the ${MAX_POINTS.toLocaleString()} limit of the browser editor. Downsample it first.`);
      const col = g.getAttribute('color');
      const p = new Float32Array(pos.count * 3), c = col ? new Float32Array(pos.count * 3) : null;
      let n = 0; dropped = 0;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) { dropped++; continue; }
        p[n * 3] = x; p[n * 3 + 1] = y; p[n * 3 + 2] = z;
        if (c && col) { c[n * 3] = col.getX(i); c[n * 3 + 1] = col.getY(i); c[n * 3 + 2] = col.getZ(i); }
        n++;
      }
      positions = p.slice(0, n * 3); colors = c ? c.slice(0, n * 3) : null;
    }
  } catch (e) {
    if (e instanceof Error && /limit|PCD|Compressed|no vertices/.test(e.message)) throw e;
    throw new Error(`Could not read ${file.name}: ${e instanceof Error ? e.message : 'the file may be corrupt or unsupported.'}`);
  }
  const pointCount = positions.length / 3;
  if (!pointCount) throw new Error(`${file.name} contains no valid points.`);
  return { format, positions, colors, pointCount, dropped };
}
