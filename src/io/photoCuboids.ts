import type { Project } from '../core/types';
import { cuboidCorners3D, project } from '../core/cuboid';
import { downloadBytes, safeName, stamp } from './download';

/**
 * Photo-cuboid export. Schema: docs/photo-cuboids.md. It is its own format
 * (not COCO or YOLO) because those cannot express a 3D box with orientation.
 *
 * Every cuboid carries BOTH its parametric form (center, size, rotation_y)
 * and the derived 8 corners in 3D (camera frame) and in the image, so a
 * consumer can use whichever it needs and can cross-check them.
 */

export const PHOTO_CUBOID_SCHEMA = 'annotate-anything/photo-cuboids';
export const PHOTO_CUBOID_SCHEMA_VERSION = 1;

export interface PhotoCuboidExport {
  schema: typeof PHOTO_CUBOID_SCHEMA;
  schema_version: number;
  generated_by: 'annotate-anything';
  project_name: string;
  coordinate_system: {
    camera_frame: string;
    cuboid_local_frame: string;
    rotation: string;
    corner_order: string;
    units: string;
  };
  classes: { index: number; name: string }[];
  images: {
    file_name: string;
    width: number;
    height: number;
    camera: { fx: number; fy: number; cx: number; cy: number; calibrated: boolean } | null;
    /** True only when the camera is user-declared calibrated. Otherwise sizes/distances are relative. */
    metric: boolean;
    cuboids: {
      id: string;
      object_id: number;
      class_index: number;
      class_name: string;
      center: [number, number, number];
      size: { length: number; width: number; height: number };
      rotation_y: number;
      corners_3d: [number, number, number][];
      /** Image pixels, or null for a corner behind the camera. */
      corners_2d: ([number, number] | null)[];
    }[];
  }[];
}

export function exportPhotoCuboids(project_: Project): { data: PhotoCuboidExport; warnings: string[] } {
  const warnings: string[] = [];
  const classIndex = new Map(project_.classes.map((c, i) => [c.id, i]));
  const data: PhotoCuboidExport = {
    schema: PHOTO_CUBOID_SCHEMA,
    schema_version: PHOTO_CUBOID_SCHEMA_VERSION,
    generated_by: 'annotate-anything',
    project_name: project_.name,
    coordinate_system: {
      camera_frame: 'OpenCV: +x right, +y down, +z forward. Origin at the camera.',
      cuboid_local_frame: 'x = width, y = height (+y is DOWN, so the top face is at -y), z = length (front faces +z when rotation_y = 0).',
      rotation: 'rotation_y: right-handed rotation about the camera +y axis, radians. x\' = x*cos + z*sin, z\' = -x*sin + z*cos.',
      corner_order: 'Index bits: bit0 = +x side, bit1 = +y side (bottom), bit2 = +z side (front). Corner 0 = (-w/2,-h/2,-l/2), corner 7 = (+w/2,+h/2,+l/2).',
      units: 'Arbitrary relative units unless metric is true; then the unit is whatever the calibration used.',
    },
    classes: project_.classes.map((c, i) => ({ index: i, name: c.name })),
    images: [],
  };

  for (const img of project_.images) {
    const cuboids = img.cuboids ?? [];
    if (!cuboids.length) continue;
    if (!img.camera) { warnings.push(`Image "${img.name}": has cuboids but no camera; skipped.`); continue; }
    const cam = img.camera;
    const rows: PhotoCuboidExport['images'][number]['cuboids'] = [];
    for (const c of cuboids) {
      const ci = classIndex.get(c.classId);
      if (ci === undefined) { warnings.push(`Image "${img.name}": cuboid ${c.objectId} has an unknown class; skipped.`); continue; }
      const c3 = cuboidCorners3D(c);
      const c2 = c3.map((p) => project(cam, p));
      if (c2.some((p) => p === null)) warnings.push(`Image "${img.name}": cuboid ${c.objectId} has corners behind the camera (corners_2d contains null).`);
      rows.push({
        id: c.id,
        object_id: c.objectId,
        class_index: ci,
        class_name: project_.classes[ci].name,
        center: [c.center.x, c.center.y, c.center.z],
        size: { ...c.size },
        rotation_y: c.rotationY,
        corners_3d: c3.map((p) => [p.x, p.y, p.z]),
        corners_2d: c2.map((p) => (p ? [p.x, p.y] : null)),
      });
    }
    data.images.push({
      file_name: img.name, width: img.width, height: img.height,
      camera: { ...cam }, metric: cam.calibrated, cuboids: rows,
    });
  }
  return { data, warnings };
}

export function downloadPhotoCuboids(p: Project): { count: number; warnings: string[] } {
  const { data, warnings } = exportPhotoCuboids(p);
  const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2));
  downloadBytes(`${safeName(p.name)}_photo-cuboids_${stamp()}.json`, bytes, 'application/json');
  return { count: data.images.reduce((n, i) => n + i.cuboids.length, 0), warnings };
}
