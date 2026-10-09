import type { MeshEntry } from '../core/types';

export type MeshFormat = MeshEntry['format'];

export interface LoadedMesh {
  format: MeshFormat;
  /** 9 floats per triangle (3 vertices x xyz), world space. Face i = floats [9i, 9i+9). */
  positions: Float32Array;
  faceCount: number;
}

export const MAX_FACES = 3_000_000;

export function meshFormatOf(name: string): MeshFormat | null {
  const n = name.toLowerCase();
  if (n.endsWith('.glb')) return 'glb';
  if (n.endsWith('.gltf')) return 'gltf';
  if (n.endsWith('.obj')) return 'obj';
  if (n.endsWith('.ply')) return 'ply';
  return null;
}

/**
 * Read a 3D model into a flat triangle list. Three.js is imported lazily, so
 * the editor loads without it. Only geometry is kept: textures and materials
 * are ignored, and objects' transforms are baked in (world space). Face order
 * is depth-first scene order, each mesh in its own index-buffer order, which
 * is stable for a given file and is what exported face indices refer to.
 *
 * Limits: .gltf must be self-contained (embedded buffers); external .bin or
 * texture files are not resolved. Point clouds and line models are rejected.
 */
export async function loadMeshFile(file: File): Promise<LoadedMesh> {
  const format = meshFormatOf(file.name);
  if (!format) throw new Error(`Unsupported 3D file: ${file.name}. Use .glb, .gltf, .obj or .ply.`);
  const THREE = await import('three');
  const chunks: Float32Array[] = [];
  let total = 0;

  const addGeometry = (g: import('three').BufferGeometry, m: import('three').Matrix4 | null): void => {
    const pos = g.getAttribute('position');
    if (!pos) return;
    const idx = g.getIndex();
    const nTri = idx ? Math.floor(idx.count / 3) : Math.floor(pos.count / 3);
    if (!nTri) return;
    const out = new Float32Array(nTri * 9);
    const v = new THREE.Vector3();
    for (let t = 0; t < nTri; t++) {
      for (let k = 0; k < 3; k++) {
        const vi = idx ? idx.getX(t * 3 + k) : t * 3 + k;
        v.fromBufferAttribute(pos, vi);
        if (m) v.applyMatrix4(m);
        out[t * 9 + k * 3] = v.x; out[t * 9 + k * 3 + 1] = v.y; out[t * 9 + k * 3 + 2] = v.z;
      }
    }
    total += nTri;
    if (total > MAX_FACES) throw new Error(`This model has more than ${MAX_FACES.toLocaleString()} triangles, which is more than the browser editor supports. Decimate it first.`);
    chunks.push(out);
  };

  const addScene = (root: import('three').Object3D): void => {
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      const mesh = o as import('three').Mesh;
      if (mesh.isMesh && mesh.geometry) addGeometry(mesh.geometry, mesh.matrixWorld);
    });
  };

  try {
    if (format === 'glb' || format === 'gltf') {
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      const buf = await file.arrayBuffer();
      const gltf = await new Promise<{ scene: import('three').Object3D }>((resolve, reject) => {
        new GLTFLoader().parse(buf, '', resolve, reject);
      });
      addScene(gltf.scene);
    } else if (format === 'obj') {
      const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js');
      addScene(new OBJLoader().parse(await file.text()));
    } else {
      const { PLYLoader } = await import('three/addons/loaders/PLYLoader.js');
      const g = new PLYLoader().parse(await file.arrayBuffer());
      if (!g.getIndex() && !/\belement\s+face\b/.test(await headText(file))) {
        throw new Error('This PLY has no faces (it is a point cloud). Point-cloud annotation is a separate, later feature.');
      }
      addGeometry(g, null);
    }
  } catch (e) {
    if (e instanceof Error && /triangles|point cloud/.test(e.message)) throw e;
    throw new Error(`Could not read ${file.name}: ${e instanceof Error ? e.message : 'the file may be corrupt or unsupported.'}`);
  }

  if (!total) throw new Error(`${file.name} contains no triangle mesh (point clouds and line models are not supported here).`);
  const positions = new Float32Array(total * 9);
  let o = 0;
  for (const c of chunks) { positions.set(c, o); o += c.length; }
  for (let i = 0; i < positions.length; i++) {
    if (!Number.isFinite(positions[i])) throw new Error(`${file.name} contains invalid (NaN or infinite) coordinates.`);
  }
  return { format, positions, faceCount: total };
}

async function headText(file: File): Promise<string> {
  return await file.slice(0, 4096).text();
}
