import type { Project, PolygonGeom, BoxGeom } from '../core/types';

/**
 * COCO JSON export.
 *
 * Scope (deliberate, documented in docs/exports.md):
 *   - Supports: boxes, polygon segmentation.
 *   - Does NOT emit RLE masks. Projects with polygon annotations only.
 *   - Deferred: polylines, keypoints — they aren't representable in a
 *     COCO *instance* file in a standard way, so we won't fake it.
 *
 * COCO's `bbox` is [x, y, width, height] in image pixels — same as our
 * internal BoxGeom. For polygons: `bbox` is the AXIS-ALIGNED bounding box of
 * the polygon vertices, `segmentation` is a list of one flat [x1,y1,x2,y2,...]
 * array (single-contour polygon), `area` is the polygon's shoelace-formula
 * absolute area.
 *
 * Image/annotation/category IDs are integers starting at 1 (COCO convention —
 * some downstream tools treat id=0 as "no annotation"). We generate them
 * fresh here and keep a stable mapping to our internal string IDs so a user
 * can trace which COCO row came from which project annotation.
 */

export interface CocoCategory {
  id: number;
  name: string;
  supercategory: string;
}
export interface CocoImage {
  id: number;
  file_name: string;
  width: number;
  height: number;
}
export interface CocoAnnotation {
  id: number;
  image_id: number;
  category_id: number;
  bbox: [number, number, number, number];
  area: number;
  iscrowd: 0 | 1;
  segmentation?: number[][];
}
export interface CocoDataset {
  info: {
    description: string;
    version: string;
    year: number;
    date_created: string;
    source: 'annotate-anything';
  };
  licenses: never[];
  categories: CocoCategory[];
  images: CocoImage[];
  annotations: CocoAnnotation[];
}

export interface CocoExportResult {
  dataset: CocoDataset;
  /** Human-readable notes about what was skipped and why. */
  warnings: string[];
}

export function exportCoco(project: Project): CocoExportResult {
  const warnings: string[] = [];

  // 1. Categories — one per class, id starts at 1.
  const classIdToCoco = new Map<string, number>();
  const categories: CocoCategory[] = project.classes.map((cls, i) => {
    const id = i + 1;
    classIdToCoco.set(cls.id, id);
    return { id, name: cls.name, supercategory: 'object' };
  });

  // 2. Images — one row per image. Images with no annotations ARE included;
  //    some COCO consumers rely on this to compute true negatives.
  const imgIdToCoco = new Map<string, number>();
  const images: CocoImage[] = project.images.map((img, i) => {
    const id = i + 1;
    imgIdToCoco.set(img.id, id);
    return { id, file_name: img.name, width: img.width, height: img.height };
  });

  // 3. Annotations.
  const annotations: CocoAnnotation[] = [];
  const skippedKinds = new Set<string>();
  let annCounter = 0;
  for (const img of project.images) {
    const imgId = imgIdToCoco.get(img.id)!;
    for (const ann of img.annotations) {
      const catId = classIdToCoco.get(ann.classId);
      if (!catId) {
        warnings.push(`Image "${img.name}": annotation references unknown class — skipped.`);
        continue;
      }
      if (ann.geom.kind === 'box') {
        const bbox = clampBoxToImage(ann.geom, img.width, img.height);
        if (bbox[2] <= 0 || bbox[3] <= 0) {
          warnings.push(`Image "${img.name}": zero-area box skipped.`);
          continue;
        }
        annCounter += 1;
        annotations.push({
          id: annCounter,
          image_id: imgId,
          category_id: catId,
          bbox,
          area: bbox[2] * bbox[3],
          iscrowd: 0,
        });
      } else if (ann.geom.kind === 'polygon') {
        const pts = clampPointsToImage(ann.geom.points, img.width, img.height);
        if (pts.length < 3) {
          warnings.push(`Image "${img.name}": polygon with fewer than 3 vertices skipped.`);
          continue;
        }
        const bbox = polygonAABB(pts);
        if (bbox[2] <= 0 || bbox[3] <= 0) {
          warnings.push(`Image "${img.name}": degenerate polygon (zero-area bbox) skipped.`);
          continue;
        }
        const area = polygonArea(pts);
        if (area <= 0) {
          warnings.push(`Image "${img.name}": polygon with zero area (collinear vertices) skipped.`);
          continue;
        }
        const flat: number[] = [];
        for (const p of pts) flat.push(p.x, p.y);
        annCounter += 1;
        annotations.push({
          id: annCounter,
          image_id: imgId,
          category_id: catId,
          bbox,
          area,
          iscrowd: 0,
          segmentation: [flat],
        });
      } else {
        skippedKinds.add(ann.geom.kind);
      }
    }
  }

  for (const k of skippedKinds) {
    warnings.push(`${k} annotations cannot be written to a COCO instance file and were skipped. They are kept in the project file.`);
  }

  const dataset: CocoDataset = {
    info: {
      description: project.name,
      version: '1.0',
      year: new Date().getFullYear(),
      date_created: new Date().toISOString(),
      source: 'annotate-anything',
    },
    licenses: [],
    categories,
    images,
    annotations,
  };

  // Light structural self-check — nothing left with NaN, nothing escapes
  // image bounds by more than a rounding error. Push a warning if hit; don't
  // fail the export.
  const audit = auditCoco(dataset);
  warnings.push(...audit);

  return { dataset, warnings };
}

export function downloadCoco(project: Project): CocoExportResult {
  const result = exportCoco(project);
  const json = JSON.stringify(result.dataset, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safe = (project.name || 'project').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60);
  a.download = `${safe}_coco_${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return result;
}

// -- helpers --

function clampBoxToImage(b: BoxGeom, imgW: number, imgH: number): [number, number, number, number] {
  // Normalize: a user may have dragged top-left past bottom-right.
  const x1 = Math.max(0, Math.min(b.x, b.x + b.w));
  const y1 = Math.max(0, Math.min(b.y, b.y + b.h));
  const x2 = Math.min(imgW, Math.max(b.x, b.x + b.w));
  const y2 = Math.min(imgH, Math.max(b.y, b.y + b.h));
  return [round(x1), round(y1), round(Math.max(0, x2 - x1)), round(Math.max(0, y2 - y1))];
}

function clampPointsToImage(pts: PolygonGeom['points'], imgW: number, imgH: number): PolygonGeom['points'] {
  return pts.map((p) => ({
    x: round(Math.max(0, Math.min(imgW, p.x))),
    y: round(Math.max(0, Math.min(imgH, p.y))),
  }));
}

function polygonAABB(pts: PolygonGeom['points']): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return [round(minX), round(minY), round(maxX - minX), round(maxY - minY)];
}

function polygonArea(pts: PolygonGeom['points']): number {
  // Shoelace formula. Returns a non-negative area.
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return round(Math.abs(a) / 2);
}

function round(n: number): number {
  // 2 decimal places — sub-pixel precision for polygon vertices, enough for
  // downstream training pipelines, keeps JSON file size reasonable.
  return Math.round(n * 100) / 100;
}

function auditCoco(ds: CocoDataset): string[] {
  const problems: string[] = [];
  const imgSize = new Map<number, { w: number; h: number }>();
  for (const im of ds.images) imgSize.set(im.id, { w: im.width, h: im.height });
  for (const a of ds.annotations) {
    for (const v of a.bbox) if (!Number.isFinite(v)) problems.push(`annotation ${a.id}: non-finite bbox value.`);
    if (!Number.isFinite(a.area)) problems.push(`annotation ${a.id}: non-finite area.`);
    const sz = imgSize.get(a.image_id);
    if (sz) {
      const [x, y, w, h] = a.bbox;
      if (x < 0 || y < 0 || x + w > sz.w + 0.5 || y + h > sz.h + 0.5) {
        problems.push(`annotation ${a.id}: bbox escapes image bounds — check your drag.`);
      }
    }
    if (a.segmentation) {
      for (const ring of a.segmentation) {
        if (ring.length < 6 || ring.length % 2 !== 0) problems.push(`annotation ${a.id}: malformed polygon ring.`);
        for (const v of ring) if (!Number.isFinite(v)) problems.push(`annotation ${a.id}: non-finite polygon coord.`);
      }
    }
  }
  return problems;
}
