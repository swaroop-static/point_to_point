import type { Annotation, ClassDef, ImageEntry, Project } from '../core/types';
import { newAnnotationId, newClassId, newImageId } from '../core/ids';

const PALETTE = ['#E58A3C', '#4A90B8', '#6BAF6B', '#C0504D', '#8E6BBF', '#D4B13E', '#3FB5A8', '#D16BA5'];

export interface CocoImportResult {
  project: Project;
  warnings: string[];
}

/**
 * Import a COCO instance file into a NEW project. Image pixels are not in a
 * COCO file, so images appear as "not loaded" until the user adds the files
 * (they relink by file_name and dimensions).
 *
 * Mapping: bbox -> box; polygon segmentation -> one polygon per ring (a COCO
 * object with several rings becomes several polygons, with a warning); RLE
 * segmentation and iscrowd objects are skipped with a warning.
 */
export function importCoco(text: string, projectName = 'Imported COCO'): CocoImportResult {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error('File is not valid JSON.'); }
  if (!isObj(raw)) throw new Error('COCO file must be a JSON object.');
  if (!Array.isArray(raw['images']) || !Array.isArray(raw['annotations']) || !Array.isArray(raw['categories'])) {
    throw new Error('Not a COCO file: expected "images", "annotations" and "categories" arrays.');
  }
  const warnings: string[] = [];

  const classes: ClassDef[] = [];
  const catToClass = new Map<number, string>();
  for (const c of raw['categories'] as unknown[]) {
    if (!isObj(c) || typeof c['id'] !== 'number' || typeof c['name'] !== 'string' || !c['name']) {
      throw new Error('Each COCO category needs a numeric "id" and a "name".');
    }
    const id = newClassId();
    catToClass.set(c['id'], id);
    classes.push({ id, name: c['name'], color: PALETTE[classes.length % PALETTE.length] });
  }
  if (!classes.length) throw new Error('COCO file has no categories.');

  const images: ImageEntry[] = [];
  const imgById = new Map<number, ImageEntry>();
  for (const i of raw['images'] as unknown[]) {
    if (!isObj(i) || typeof i['id'] !== 'number' || typeof i['file_name'] !== 'string' ||
        !isPos(i['width']) || !isPos(i['height'])) {
      throw new Error('Each COCO image needs "id", "file_name", and positive "width" and "height".');
    }
    // Only the base name: COCO file_name can contain folders.
    const name = i['file_name'].split(/[\\/]/).pop() || i['file_name'];
    const entry: ImageEntry = { id: newImageId(), name, width: i['width'], height: i['height'], annotations: [] };
    images.push(entry);
    imgById.set(i['id'], entry);
  }

  let skippedRle = 0, skippedCrowd = 0, skippedBad = 0, multiRing = 0;
  for (const a of raw['annotations'] as unknown[]) {
    if (!isObj(a)) { skippedBad++; continue; }
    const img = typeof a['image_id'] === 'number' ? imgById.get(a['image_id']) : undefined;
    const classId = typeof a['category_id'] === 'number' ? catToClass.get(a['category_id']) : undefined;
    if (!img || !classId) { skippedBad++; continue; }
    if (a['iscrowd'] === 1) { skippedCrowd++; continue; }

    const seg = a['segmentation'];
    if (Array.isArray(seg) && seg.length) {
      let made = 0;
      for (const ring of seg) {
        if (!Array.isArray(ring) || ring.length < 6 || ring.length % 2 !== 0 || !ring.every((v) => typeof v === 'number' && Number.isFinite(v))) continue;
        const points = [];
        for (let k = 0; k < ring.length; k += 2) points.push({ x: ring[k] as number, y: ring[k + 1] as number });
        const ann: Annotation = { id: newAnnotationId(), classId, geom: { kind: 'polygon', points } };
        img.annotations.push(ann);
        made++;
      }
      if (made > 1) multiRing++;
      if (made) continue;
      skippedBad++;
      continue;
    }
    if (isObj(seg)) { skippedRle++; continue; }

    const bb = a['bbox'];
    if (Array.isArray(bb) && bb.length === 4 && bb.every((v) => typeof v === 'number' && Number.isFinite(v)) && (bb[2] as number) > 0 && (bb[3] as number) > 0) {
      img.annotations.push({ id: newAnnotationId(), classId, geom: { kind: 'box', x: bb[0] as number, y: bb[1] as number, w: bb[2] as number, h: bb[3] as number } });
    } else {
      skippedBad++;
    }
  }
  if (skippedRle) warnings.push(`${skippedRle} annotation(s) use RLE masks, which are not supported, and were skipped.`);
  if (skippedCrowd) warnings.push(`${skippedCrowd} crowd annotation(s) were skipped.`);
  if (multiRing) warnings.push(`${multiRing} object(s) had several polygon rings and became separate polygons.`);
  if (skippedBad) warnings.push(`${skippedBad} malformed or unmatched annotation(s) were skipped.`);

  return {
    project: { formatVersion: 2, app: 'annotate-anything', name: projectName, savedAt: new Date().toISOString(), classes, images },
    warnings,
  };
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
function isPos(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x > 0;
}
