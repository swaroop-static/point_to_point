import type { Project } from '../core/types';
import { rangesCount } from '../mesh/faces';
import { rleClasses } from '../mesh/faces';
import { downloadBytes, safeName, stamp } from './download';

/**
 * Mesh annotation export. Schema: docs/mesh-annotation.md. Face indices refer
 * to the triangle order of the model as loaded (see that doc), so they are only
 * meaningful together with the same model file.
 */
export const MESH_SCHEMA = 'annotate-anything/mesh-annotations';
export const MESH_SCHEMA_VERSION = 1;

export interface MeshExport {
  schema: typeof MESH_SCHEMA;
  schema_version: number;
  generated_by: 'annotate-anything';
  project_name: string;
  face_order: string;
  classes: { index: number; name: string }[];
  meshes: {
    file_name: string;
    format: string;
    face_count: number;
    /** Run-length encoding of the class index of every face in order, [class_index, run_length]; -1 = unlabeled. */
    face_class_rle: [number, number][];
    objects: {
      id: string;
      object_id: number;
      class_index: number;
      class_name: string;
      face_count: number;
      /** Half-open [start, end) triangle index ranges. */
      face_ranges: [number, number][];
    }[];
  }[];
}

export function exportMeshAnnotations(project: Project): { data: MeshExport; warnings: string[] } {
  const warnings: string[] = [];
  const classIndex = new Map(project.classes.map((c, i) => [c.id, i]));
  const data: MeshExport = {
    schema: MESH_SCHEMA,
    schema_version: MESH_SCHEMA_VERSION,
    generated_by: 'annotate-anything',
    project_name: project.name,
    face_order: 'Triangles in depth-first scene order; each mesh in its own index-buffer order (or consecutive vertex triples when non-indexed). Object transforms are baked in. OBJ/PLY polygons are triangulated by three.js. Face i is the i-th triangle in that order.',
    classes: project.classes.map((c, i) => ({ index: i, name: c.name })),
    meshes: [],
  };
  for (const m of project.meshes ?? []) {
    if (!m.labels.length) continue;
    const perFace = new Int32Array(m.faceCount).fill(-1);
    const objects: MeshExport['meshes'][number]['objects'] = [];
    for (const l of m.labels) {
      const ci = classIndex.get(l.classId);
      if (ci === undefined) { warnings.push(`Mesh "${m.name}": object ${l.objectId} has an unknown class; skipped.`); continue; }
      for (const [s, e] of l.ranges) perFace.fill(ci, s, e);
      objects.push({ id: l.id, object_id: l.objectId, class_index: ci, class_name: project.classes[ci].name, face_count: rangesCount(l.ranges), face_ranges: l.ranges.map((r) => [r[0], r[1]]) });
    }
    data.meshes.push({ file_name: m.name, format: m.format, face_count: m.faceCount, face_class_rle: rleClasses(perFace), objects });
  }
  return { data, warnings };
}

export function downloadMeshAnnotations(p: Project): { objects: number; warnings: string[] } {
  const { data, warnings } = exportMeshAnnotations(p);
  downloadBytes(`${safeName(p.name)}_mesh-annotations_${stamp()}.json`, new TextEncoder().encode(JSON.stringify(data, null, 2)), 'application/json');
  return { objects: data.meshes.reduce((n, m) => n + m.objects.length, 0), warnings };
}
