import type { Project } from '../core/types';
import { cuboidCorners, pointsInCuboid } from '../cloud/geom';
import { facesToRanges, rangesCount, rleClasses } from '../mesh/faces';
import { downloadBytes, safeName, stamp } from './download';

/**
 * Point-cloud annotation export. Schema: docs/pointcloud-annotation.md.
 * Point indices refer to the order of valid points as read from the file
 * (points with NaN/infinite coordinates are skipped before numbering).
 */
export const CLOUD_SCHEMA = 'annotate-anything/pointcloud-annotations';
export const CLOUD_SCHEMA_VERSION = 1;

export interface CloudExport {
  schema: typeof CLOUD_SCHEMA;
  schema_version: number;
  generated_by: 'annotate-anything';
  project_name: string;
  coordinate_system: { up_axis_note: string; cuboid: string; corner_order: string; point_order: string };
  classes: { index: number; name: string }[];
  clouds: {
    file_name: string;
    format: string;
    point_count: number;
    up_axis: 'y' | 'z';
    cuboids: {
      id: string;
      object_id: number;
      class_index: number;
      class_name: string;
      center: [number, number, number];
      size: { length: number; width: number; height: number };
      yaw: number;
      corners: [number, number, number][];
      /** Null when the point file was not loaded at export time. */
      point_count_inside: number | null;
      point_index_ranges_inside: [number, number][] | null;
    }[];
    point_labels: { class_index: number; class_name: string; point_count: number; ranges: [number, number][] }[];
    /** Class index of every point in order as [class_index, run_length]; -1 = no semantic label. */
    point_class_rle: [number, number][];
  }[];
}

export function exportCloudAnnotations(project: Project, getPositions: (cloudId: string) => Float32Array | null): { data: CloudExport; warnings: string[] } {
  const warnings: string[] = [];
  const classIndex = new Map(project.classes.map((c, i) => [c.id, i]));
  const data: CloudExport = {
    schema: CLOUD_SCHEMA,
    schema_version: CLOUD_SCHEMA_VERSION,
    generated_by: 'annotate-anything',
    project_name: project.name,
    coordinate_system: {
      up_axis_note: 'Coordinates are the file\'s own. up_axis says which axis points up. The two other axes are the horizontal axes a, b: up=z gives (a=x, b=y); up=y gives (a=x, b=z).',
      cuboid: 'center + size{length along a, width along b, height along up} + yaw (radians, rotation from +a toward +b about the up axis). Units are the file\'s units.',
      corner_order: 'Index bits: bit0 = +length side, bit1 = +width side, bit2 = +height (up) side. Corner 0 = (-l/2,-w/2,-h/2), corner 7 = (+l/2,+w/2,+h/2) in the cuboid frame.',
      point_order: 'Points in file order with non-finite points removed before numbering.',
    },
    classes: project.classes.map((c, i) => ({ index: i, name: c.name })),
    clouds: [],
  };
  for (const c of project.clouds ?? []) {
    if (!c.cuboids.length && !c.pointLabels.length) continue;
    const positions = getPositions(c.id);
    if (!positions && c.cuboids.length) warnings.push(`"${c.name}" is not loaded, so points inside each cuboid could not be computed. Add the file and export again for those fields.`);
    const cuboids: CloudExport['clouds'][number]['cuboids'] = [];
    for (const b of c.cuboids) {
      const ci = classIndex.get(b.classId);
      if (ci === undefined) { warnings.push(`"${c.name}": cuboid ${b.objectId} has an unknown class; skipped.`); continue; }
      const inside = positions ? pointsInCuboid(positions, b, c.upAxis) : null;
      cuboids.push({
        id: b.id, object_id: b.objectId, class_index: ci, class_name: project.classes[ci].name,
        center: [b.center.x, b.center.y, b.center.z], size: { ...b.size }, yaw: b.yaw,
        corners: cuboidCorners(b, c.upAxis).map((p) => [p.x, p.y, p.z] as [number, number, number]),
        point_count_inside: inside ? inside.length : null,
        point_index_ranges_inside: inside ? facesToRanges(inside) : null,
      });
    }
    const perPoint = new Int32Array(c.pointCount).fill(-1);
    const labels: CloudExport['clouds'][number]['point_labels'] = [];
    for (const l of c.pointLabels) {
      const ci = classIndex.get(l.classId);
      if (ci === undefined) { warnings.push(`"${c.name}": a point label has an unknown class; skipped.`); continue; }
      for (const [s, e] of l.ranges) perPoint.fill(ci, s, e);
      labels.push({ class_index: ci, class_name: project.classes[ci].name, point_count: rangesCount(l.ranges), ranges: l.ranges.map((r) => [r[0], r[1]] as [number, number]) });
    }
    data.clouds.push({ file_name: c.name, format: c.format, point_count: c.pointCount, up_axis: c.upAxis, cuboids, point_labels: labels, point_class_rle: rleClasses(perPoint) });
  }
  return { data, warnings };
}

export function downloadCloudAnnotations(p: Project, getPositions: (cloudId: string) => Float32Array | null): { cuboids: number; warnings: string[] } {
  const { data, warnings } = exportCloudAnnotations(p, getPositions);
  downloadBytes(`${safeName(p.name)}_pointcloud-annotations_${stamp()}.json`, new TextEncoder().encode(JSON.stringify(data, null, 2)), 'application/json');
  return { cuboids: data.clouds.reduce((n, c) => n + c.cuboids.length, 0), warnings };
}
