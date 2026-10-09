import type { CloudEntry, MeshEntry, Project } from './types';
import { rangesValid } from '../mesh/faces';

/**
 * Minimal structural validation for a loaded project JSON.
 *
 * Deliberately strict about: formatVersion, app tag, shape of top-level
 * arrays, and class/annotation geometry basics. Deliberately lenient about:
 * optional fields (`hidden`, `locked`, `note`), unknown keys (ignored, not
 * rejected — so future-schema files from a newer release still load mostly
 * correctly).
 *
 * Returns the project on success, throws Error on failure with a message
 * safe to show in a toast.
 */
export function parseProjectJson(text: string): Project {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('File is not valid JSON.');
  }
  return assertProject(raw);
}

function assertProject(x: unknown): Project {
  if (!isObj(x))               throw new Error('Project file must be a JSON object.');
  if (x['app'] !== 'annotate-anything') {
    throw new Error('Not an Annotate Anything project file (missing "app" tag).');
  }
  // Version 1 (2D only) is a strict subset of version 2, so migration is just
  // re-stamping the version. Anything newer than we understand is refused
  // rather than loaded with data silently dropped.
  if (x['formatVersion'] !== 1 && x['formatVersion'] !== 2) {
    throw new Error(`Unsupported project format version: ${String(x['formatVersion'])}. This build understands versions 1 and 2.`);
  }
  if (typeof x['name'] !== 'string')   throw new Error('Project "name" must be a string.');
  if (typeof x['savedAt'] !== 'string') throw new Error('Project "savedAt" must be a string.');
  if (!Array.isArray(x['classes']))     throw new Error('Project "classes" must be an array.');
  if (!Array.isArray(x['images']))      throw new Error('Project "images" must be an array.');

  const classes = (x['classes'] as unknown[]).map(assertClass);
  const classIds = new Set(classes.map((c) => c.id));
  const images = (x['images'] as unknown[]).map((img) => assertImage(img, classIds));

  const proj: Project = {
    formatVersion: 2,
    app: 'annotate-anything',
    name: x['name'],
    savedAt: x['savedAt'],
    classes,
    images,
  };
  if (x['meshes'] !== undefined) {
    if (!Array.isArray(x['meshes'])) throw new Error('Project "meshes" must be an array.');
    const ids = new Set<string>();
    proj.meshes = (x['meshes'] as unknown[]).map((m) => {
      const mesh = assertMesh(m, classIds);
      if (ids.has(mesh.id)) throw new Error(`Two meshes share the id "${mesh.id}".`);
      ids.add(mesh.id);
      return mesh;
    });
  }
  if (x['clouds'] !== undefined) {
    if (!Array.isArray(x['clouds'])) throw new Error('Project "clouds" must be an array.');
    const ids = new Set<string>();
    proj.clouds = (x['clouds'] as unknown[]).map((c) => {
      const cloud = assertCloud(c, classIds);
      if (ids.has(cloud.id)) throw new Error(`Two point clouds share the id "${cloud.id}".`);
      ids.add(cloud.id);
      return cloud;
    });
  }
  return proj;
}

function assertCloud(x: unknown, classIds: Set<string>): CloudEntry {
  if (!isObj(x)) throw new Error('Each point cloud must be an object.');
  if (typeof x['id'] !== 'string' || !x['id']) throw new Error('Point cloud "id" must be a non-empty string.');
  if (typeof x['name'] !== 'string' || !x['name']) throw new Error('Point cloud "name" must be a non-empty string.');
  const name = x['name'];
  if (x['format'] !== 'ply' && x['format'] !== 'pcd') throw new Error(`Point cloud "${name}" has an unsupported format.`);
  if (!Number.isInteger(x['pointCount']) || (x['pointCount'] as number) < 1) throw new Error(`Point cloud "${name}" has an invalid pointCount.`);
  const pointCount = x['pointCount'] as number;
  if (x['upAxis'] !== 'y' && x['upAxis'] !== 'z') throw new Error(`Point cloud "${name}" upAxis must be "y" or "z".`);
  if (!Array.isArray(x['cuboids'])) throw new Error(`Point cloud "${name}" "cuboids" must be an array.`);
  if (!Array.isArray(x['pointLabels'])) throw new Error(`Point cloud "${name}" "pointLabels" must be an array.`);
  const objectIds = new Set<number>();
  const cuboids = (x['cuboids'] as unknown[]).map((c): CloudEntry['cuboids'][number] => {
    if (!isObj(c)) throw new Error(`A cuboid in "${name}" is not an object.`);
    if (typeof c['id'] !== 'string' || !c['id']) throw new Error(`Cuboid "id" must be a non-empty string in "${name}".`);
    if (typeof c['classId'] !== 'string' || !classIds.has(c['classId'])) throw new Error(`A cuboid in "${name}" refers to an unknown class.`);
    if (!Number.isInteger(c['objectId']) || (c['objectId'] as number) < 1) throw new Error(`Cuboid objectId must be an integer >= 1 in "${name}".`);
    if (objectIds.has(c['objectId'] as number)) throw new Error(`"${name}" has two cuboids with objectId ${String(c['objectId'])}.`);
    objectIds.add(c['objectId'] as number);
    const ce = c['center'], s = c['size'];
    if (!isObj(ce) || !num(ce['x']) || !num(ce['y']) || !num(ce['z'])) throw new Error(`Invalid cuboid center in "${name}".`);
    if (!isObj(s) || !num(s['length']) || !num(s['width']) || !num(s['height']) || s['length'] <= 0 || s['width'] <= 0 || s['height'] <= 0) {
      throw new Error(`Cuboid size must be three positive numbers in "${name}".`);
    }
    if (!num(c['yaw'])) throw new Error(`Invalid cuboid yaw in "${name}".`);
    const out: CloudEntry['cuboids'][number] = {
      id: c['id'], objectId: c['objectId'] as number, classId: c['classId'],
      center: { x: ce['x'], y: ce['y'], z: ce['z'] },
      size: { length: s['length'], width: s['width'], height: s['height'] }, yaw: c['yaw'],
    };
    if (typeof c['hidden'] === 'boolean') out.hidden = c['hidden'];
    if (typeof c['locked'] === 'boolean') out.locked = c['locked'];
    return out;
  });
  const pointLabels = (x['pointLabels'] as unknown[]).map((l): CloudEntry['pointLabels'][number] => {
    if (!isObj(l)) throw new Error(`A point label in "${name}" is not an object.`);
    if (typeof l['id'] !== 'string' || !l['id']) throw new Error(`Point label "id" must be a non-empty string in "${name}".`);
    if (typeof l['classId'] !== 'string' || !classIds.has(l['classId'])) throw new Error(`A point label in "${name}" refers to an unknown class.`);
    if (!Array.isArray(l['ranges']) || !rangesValid(l['ranges'] as [number, number][], pointCount)) throw new Error(`A point label in "${name}" has invalid index ranges.`);
    return { id: l['id'], classId: l['classId'], ranges: (l['ranges'] as [number, number][]).map((r) => [r[0], r[1]] as [number, number]) };
  });
  const all = pointLabels.flatMap((l) => l.ranges).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < all.length; i++) if (all[i][0] < all[i - 1][1]) throw new Error(`"${name}" has a point in more than one label.`);
  return { id: x['id'], name, format: x['format'], pointCount, upAxis: x['upAxis'], cuboids, pointLabels };
}

const MESH_FORMATS = new Set(['glb', 'gltf', 'obj', 'ply']);

function assertMesh(x: unknown, classIds: Set<string>): MeshEntry {
  if (!isObj(x)) throw new Error('Each mesh must be an object.');
  if (typeof x['id'] !== 'string' || !x['id']) throw new Error('Mesh "id" must be a non-empty string.');
  if (typeof x['name'] !== 'string' || !x['name']) throw new Error('Mesh "name" must be a non-empty string.');
  const name = x['name'];
  if (typeof x['format'] !== 'string' || !MESH_FORMATS.has(x['format'])) throw new Error(`Mesh "${name}" has an unsupported format.`);
  if (!Number.isInteger(x['faceCount']) || (x['faceCount'] as number) < 1) throw new Error(`Mesh "${name}" has an invalid faceCount.`);
  const faceCount = x['faceCount'] as number;
  if (!Array.isArray(x['labels'])) throw new Error(`Mesh "${name}" "labels" must be an array.`);
  const objectIds = new Set<number>();
  const labels = (x['labels'] as unknown[]).map((l): MeshEntry['labels'][number] => {
    if (!isObj(l)) throw new Error(`A label in mesh "${name}" is not an object.`);
    if (typeof l['id'] !== 'string' || !l['id']) throw new Error(`Label "id" must be a non-empty string in mesh "${name}".`);
    if (typeof l['classId'] !== 'string' || !classIds.has(l['classId'])) throw new Error(`A label in mesh "${name}" refers to an unknown class.`);
    if (!Number.isInteger(l['objectId']) || (l['objectId'] as number) < 1) throw new Error(`Label objectId must be an integer >= 1 in mesh "${name}".`);
    if (objectIds.has(l['objectId'] as number)) throw new Error(`Mesh "${name}" has two labels with objectId ${String(l['objectId'])}.`);
    objectIds.add(l['objectId'] as number);
    if (!Array.isArray(l['ranges']) || !rangesValid(l['ranges'] as [number, number][], faceCount)) {
      throw new Error(`A label in mesh "${name}" has invalid face ranges.`);
    }
    const out: MeshEntry['labels'][number] = {
      id: l['id'], objectId: l['objectId'] as number, classId: l['classId'],
      ranges: (l['ranges'] as [number, number][]).map((r) => [r[0], r[1]] as [number, number]),
    };
    if (typeof l['hidden'] === 'boolean') out.hidden = l['hidden'];
    return out;
  });
  // A face may belong to only one label.
  const all = labels.flatMap((l) => l.ranges).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < all.length; i++) if (all[i][0] < all[i - 1][1]) throw new Error(`Mesh "${name}" has a face in more than one label.`);
  return { id: x['id'], name, format: x['format'] as MeshEntry['format'], faceCount, labels };
}

function assertClass(x: unknown): Project['classes'][number] {
  if (!isObj(x)) throw new Error('Each class must be an object.');
  if (typeof x['id'] !== 'string'   || !x['id'])   throw new Error('Class "id" must be a non-empty string.');
  if (typeof x['name'] !== 'string' || !x['name']) throw new Error('Class "name" must be a non-empty string.');
  if (typeof x['color'] !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(x['color'])) {
    throw new Error(`Class "${x['name']}" has invalid color (expected #RRGGBB, got ${String(x['color'])}).`);
  }
  return { id: x['id'], name: x['name'], color: x['color'] };
}

function assertImage(x: unknown, classIds: Set<string>): Project['images'][number] {
  if (!isObj(x)) throw new Error('Each image must be an object.');
  if (typeof x['id'] !== 'string'   || !x['id'])   throw new Error('Image "id" must be a non-empty string.');
  if (typeof x['name'] !== 'string' || !x['name']) throw new Error('Image "name" must be a non-empty string.');
  if (!isFinitePositive(x['width']) || !isFinitePositive(x['height'])) {
    throw new Error(`Image "${x['name']}" has invalid dimensions.`);
  }
  if (!Array.isArray(x['annotations'])) throw new Error(`Image "${x['name']}" "annotations" must be an array.`);
  const annotations = (x['annotations'] as unknown[]).map((a) => assertAnnotation(a, classIds, x['name'] as string));
  const out: ProjectImage = {
    id: x['id'],
    name: x['name'],
    width: x['width'] as number,
    height: x['height'] as number,
    annotations,
  };
  if (x['camera'] !== undefined) out.camera = assertCamera(x['camera'], x['name']);
  if (x['cuboids'] !== undefined) {
    if (!Array.isArray(x['cuboids'])) throw new Error(`Image "${x['name']}" "cuboids" must be an array.`);
    const seen = new Set<number>();
    out.cuboids = (x['cuboids'] as unknown[]).map((c) => {
      const cub = assertCuboid(c, classIds, x['name'] as string);
      if (seen.has(cub.objectId)) throw new Error(`Image "${x['name']}" has two cuboids with objectId ${cub.objectId}.`);
      seen.add(cub.objectId);
      return cub;
    });
  }
  return out;
}

type ProjectImage = Project['images'][number];

function num(v: unknown): v is number { return typeof v === 'number' && Number.isFinite(v); }

function assertCamera(x: unknown, imgName: string): NonNullable<ProjectImage['camera']> {
  if (!isObj(x) || !num(x['fx']) || !num(x['fy']) || !num(x['cx']) || !num(x['cy']) || typeof x['calibrated'] !== 'boolean') {
    throw new Error(`Invalid camera in image "${imgName}".`);
  }
  if (x['fx'] <= 0 || x['fy'] <= 0) throw new Error(`Camera focal lengths must be positive in image "${imgName}".`);
  return { fx: x['fx'], fy: x['fy'], cx: x['cx'], cy: x['cy'], calibrated: x['calibrated'] };
}

function assertCuboid(x: unknown, classIds: Set<string>, imgName: string): NonNullable<ProjectImage['cuboids']>[number] {
  if (!isObj(x)) throw new Error(`Cuboid in image "${imgName}" is not an object.`);
  if (typeof x['id'] !== 'string' || !x['id']) throw new Error(`Cuboid "id" must be a non-empty string in image "${imgName}".`);
  if (typeof x['classId'] !== 'string' || !classIds.has(x['classId'])) {
    throw new Error(`Cuboid in image "${imgName}" refers to unknown classId "${String(x['classId'])}".`);
  }
  if (!Number.isInteger(x['objectId']) || (x['objectId'] as number) < 1) throw new Error(`Cuboid objectId must be an integer >= 1 in image "${imgName}".`);
  const c = x['center'], s = x['size'];
  if (!isObj(c) || !num(c['x']) || !num(c['y']) || !num(c['z'])) throw new Error(`Invalid cuboid center in image "${imgName}".`);
  if (c['z'] <= 0) throw new Error(`Cuboid center must be in front of the camera (z > 0) in image "${imgName}".`);
  if (!isObj(s) || !num(s['length']) || !num(s['width']) || !num(s['height']) || s['length'] <= 0 || s['width'] <= 0 || s['height'] <= 0) {
    throw new Error(`Cuboid size must be three positive numbers in image "${imgName}".`);
  }
  if (!num(x['rotationY'])) throw new Error(`Invalid cuboid rotationY in image "${imgName}".`);
  const out: NonNullable<ProjectImage['cuboids']>[number] = {
    id: x['id'], objectId: x['objectId'] as number, classId: x['classId'],
    center: { x: c['x'], y: c['y'], z: c['z'] },
    size: { length: s['length'], width: s['width'], height: s['height'] },
    rotationY: x['rotationY'],
  };
  if (typeof x['hidden'] === 'boolean') out.hidden = x['hidden'];
  if (typeof x['locked'] === 'boolean') out.locked = x['locked'];
  if (typeof x['note'] === 'string') out.note = x['note'];
  return out;
}

function assertAnnotation(x: unknown, classIds: Set<string>, imgName: string): Project['images'][number]['annotations'][number] {
  if (!isObj(x))                      throw new Error(`Annotation in image "${imgName}" is not an object.`);
  if (typeof x['id'] !== 'string')    throw new Error(`Annotation "id" must be a string in image "${imgName}".`);
  if (typeof x['classId'] !== 'string') throw new Error(`Annotation "classId" must be a string in image "${imgName}".`);
  if (!classIds.has(x['classId'])) {
    throw new Error(`Annotation in image "${imgName}" refers to unknown classId "${x['classId']}".`);
  }
  const geom = assertGeom(x['geom'], imgName);
  const out: Project['images'][number]['annotations'][number] = {
    id: x['id'],
    classId: x['classId'],
    geom,
  };
  if (typeof x['hidden'] === 'boolean') out.hidden = x['hidden'];
  if (typeof x['locked'] === 'boolean') out.locked = x['locked'];
  if (typeof x['note']   === 'string')  out.note   = x['note'];
  return out;
}

function assertGeom(x: unknown, imgName: string): Project['images'][number]['annotations'][number]['geom'] {
  if (!isObj(x)) throw new Error(`Geom missing in image "${imgName}".`);
  if (x['kind'] === 'box') {
    if (![x['x'], x['y'], x['w'], x['h']].every((v) => typeof v === 'number' && Number.isFinite(v))) {
      throw new Error(`Invalid box geometry in image "${imgName}".`);
    }
    return { kind: 'box', x: x['x'] as number, y: x['y'] as number, w: x['w'] as number, h: x['h'] as number };
  }
  if (x['kind'] === 'polygon') {
    if (!Array.isArray(x['points'])) throw new Error(`Polygon "points" must be an array in image "${imgName}".`);
    const points = (x['points'] as unknown[]).map((p) => {
      if (!isObj(p) || typeof p['x'] !== 'number' || typeof p['y'] !== 'number' ||
          !Number.isFinite(p['x']) || !Number.isFinite(p['y'])) {
        throw new Error(`Invalid polygon vertex in image "${imgName}".`);
      }
      return { x: p['x'], y: p['y'] };
    });
    if (points.length < 3) throw new Error(`Polygon in image "${imgName}" has fewer than 3 vertices.`);
    return { kind: 'polygon', points };
  }
  if (x['kind'] === 'polyline') {
    if (!Array.isArray(x['points'])) throw new Error(`Polyline "points" must be an array in image "${imgName}".`);
    const points = (x['points'] as unknown[]).map((p) => {
      if (!isObj(p) || typeof p['x'] !== 'number' || typeof p['y'] !== 'number' ||
          !Number.isFinite(p['x']) || !Number.isFinite(p['y'])) {
        throw new Error(`Invalid polyline vertex in image "${imgName}".`);
      }
      return { x: p['x'], y: p['y'] };
    });
    if (points.length < 2) throw new Error(`Polyline in image "${imgName}" has fewer than 2 points.`);
    return { kind: 'polyline', points };
  }
  if (x['kind'] === 'keypoint') {
    if (![x['x'], x['y']].every((v) => typeof v === 'number' && Number.isFinite(v))) {
      throw new Error(`Invalid keypoint in image "${imgName}".`);
    }
    return { kind: 'keypoint', x: x['x'] as number, y: x['y'] as number };
  }
  throw new Error(`Unknown geometry kind in image "${imgName}": ${String(x['kind'])}`);
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
function isFinitePositive(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x > 0;
}
