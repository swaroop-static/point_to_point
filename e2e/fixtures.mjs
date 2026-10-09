import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

/**
 * Synthetic test data, generated at run time (nothing binary is committed).
 * All of it is made up here, so there are no licensing or privacy questions.
 */

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

/** A PNG with a solid background and optional filled disc. */
export function png(w, h, bg, disc) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const inside = disc && Math.hypot(x - disc.cx, y - disc.cy) < disc.r;
      const c = inside ? disc.color : bg;
      const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2];
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const V = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
const T = [[0, 3, 2], [0, 2, 1], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]];

export function makeImages(dir) {
  mkdirSync(dir, { recursive: true });
  const f = {
    a: join(dir, 'imgA.png'), b: join(dir, 'imgB.png'), disc: join(dir, 'disc.png'),
  };
  writeFileSync(f.a, png(800, 600, [85, 102, 119]));
  writeFileSync(f.b, png(640, 480, [119, 85, 102]));
  writeFileSync(f.disc, png(800, 600, [70, 96, 122], { cx: 400, cy: 300, r: 120, color: [208, 58, 58] }));
  return f;
}

export function makeModels(dir) {
  mkdirSync(dir, { recursive: true });
  let obj = '';
  [[0, 0, 0], [3, 0, 0]].forEach((off, k) => {
    obj += `o cube${k}\n`;
    V.forEach((v) => (obj += `v ${v[0] + off[0]} ${v[1] + off[1]} ${v[2] + off[2]}\n`));
    T.forEach((t) => (obj += `f ${t.map((i) => i + 1 + 8 * k).join(' ')}\n`));
  });
  const f = { obj: join(dir, 'two_cubes.obj'), plyQuads: join(dir, 'quad_cube.ply'), points: join(dir, 'points.ply'), junk: join(dir, 'junk.obj'), glb: join(dir, 'cube.glb') };
  writeFileSync(f.obj, obj);
  const Q = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]];
  writeFileSync(f.plyQuads, `ply\nformat ascii 1.0\nelement vertex 8\nproperty float x\nproperty float y\nproperty float z\nelement face 6\nproperty list uchar int vertex_indices\nend_header\n${V.map((v) => v.join(' ')).join('\n')}\n${Q.map((q) => '4 ' + q.join(' ')).join('\n')}\n`);
  writeFileSync(f.points, 'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n1 0 0\n0 1 0\n');
  writeFileSync(f.junk, 'this is not a model\n');
  // Minimal GLB: one indexed cube.
  const posB = Buffer.from(new Float32Array(V.flat()).buffer), idxB = Buffer.from(new Uint16Array(T.flat()).buffer);
  const pad = (b) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
  const bin = Buffer.concat([pad(posB), pad(idxB)]);
  const json = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: bin.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: posB.length, target: 34962 }, { buffer: 0, byteOffset: pad(posB).length, byteLength: idxB.length, target: 34963 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 1] }, { bufferView: 1, componentType: 5123, count: 36, type: 'SCALAR' }] };
  let jb = Buffer.from(JSON.stringify(json)); jb = Buffer.concat([jb, Buffer.alloc((4 - (jb.length % 4)) % 4, 0x20)]);
  const hdr = Buffer.alloc(12); hdr.writeUInt32LE(0x46546c67, 0); hdr.writeUInt32LE(2, 4); hdr.writeUInt32LE(12 + 8 + jb.length + 8 + bin.length, 8);
  const c1 = Buffer.alloc(8); c1.writeUInt32LE(jb.length, 0); c1.writeUInt32LE(0x4e4f534a, 4);
  const c2 = Buffer.alloc(8); c2.writeUInt32LE(bin.length, 0); c2.writeUInt32LE(0x004e4942, 4);
  writeFileSync(f.glb, Buffer.concat([hdr, c1, jb, c2, bin]));
  return f;
}

/** Ground grid (60x60, z=0) plus two box-shaped clusters ("cars"). Returns file paths and ground truth. */
export function makeClouds(dir) {
  mkdirSync(dir, { recursive: true });
  let seed = 12345; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const pts = [], cols = [];
  for (let x = -30; x < 30; x++) for (let y = -30; y < 30; y++) { pts.push([x + 0.5, y + 0.5, 0]); cols.push([90, 90, 90]); }
  for (const [cx, cy, yaw] of [[10, 5, 0.25], [-12, -8, -0.6]]) {
    for (let i = 0; i < 1500; i++) {
      const lx = (rnd() - 0.5) * 4, ly = (rnd() - 0.5) * 2, lz = rnd() * 1.5;
      pts.push([cx + lx * Math.cos(yaw) - ly * Math.sin(yaw), cy + lx * Math.sin(yaw) + ly * Math.cos(yaw), lz]); cols.push([200, 60, 60]);
    }
  }
  const f = { ply: join(dir, 'scene.ply'), asciiPcd: join(dir, 'scene_ascii.pcd'), binPcd: join(dir, 'scene_bin.pcd'), junk: join(dir, 'junk.ply'), compressed: join(dir, 'compressed.pcd') };
  {
    const head = `ply\nformat binary_little_endian 1.0\nelement vertex ${pts.length}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n`;
    const body = Buffer.alloc(pts.length * 15);
    pts.forEach((p, i) => { body.writeFloatLE(p[0], i * 15); body.writeFloatLE(p[1], i * 15 + 4); body.writeFloatLE(p[2], i * 15 + 8); body[i * 15 + 12] = cols[i][0]; body[i * 15 + 13] = cols[i][1]; body[i * 15 + 14] = cols[i][2]; });
    writeFileSync(f.ply, Buffer.concat([Buffer.from(head), body]));
  }
  const pcdHead = (n, fields, size, type, data) => `# .PCD v0.7\nVERSION 0.7\nFIELDS ${fields}\nSIZE ${size}\nTYPE ${type}\nCOUNT ${fields.split(' ').map(() => 1).join(' ')}\nWIDTH ${n}\nHEIGHT 1\nVIEWPOINT 0 0 0 1 0 0 0\nPOINTS ${n}\nDATA ${data}\n`;
  writeFileSync(f.asciiPcd, pcdHead(pts.length, 'x y z', '4 4 4', 'F F F', 'ascii') + pts.map((p) => p.join(' ')).join('\n') + '\n');
  {
    const h = Buffer.from(pcdHead(pts.length, 'x y z rgb', '4 4 4 4', 'F F F U', 'binary')), b = Buffer.alloc(pts.length * 16);
    pts.forEach((p, i) => { b.writeFloatLE(p[0], i * 16); b.writeFloatLE(p[1], i * 16 + 4); b.writeFloatLE(p[2], i * 16 + 8); b.writeUInt32LE((cols[i][0] << 16) | (cols[i][1] << 8) | cols[i][2], i * 16 + 12); });
    writeFileSync(f.binPcd, Buffer.concat([h, b]));
  }
  writeFileSync(f.junk, 'ply\nformat ascii 1.0\nelement vertex 2\nproperty float x\nproperty float y\nproperty float z\nend_header\nnan 0 0\ninf 1 1\n');
  writeFileSync(f.compressed, pcdHead(3, 'x y z', '4 4 4', 'F F F', 'binary_compressed') + 'xxxx');
  return { files: f, points: pts };
}
