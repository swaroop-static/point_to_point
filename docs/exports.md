# Exports and imports

All exports run in the browser and download straight to your machine. Nothing is uploaded.

## COCO JSON (export)

**Export > COCO JSON** downloads one `*_coco_<timestamp>.json` following the COCO instance layout (`info`, `licenses`, `categories`, `images`, `annotations`).

- IDs are integers starting at 1 (categories follow class order; images follow project order). Images with no annotations are still listed.
- `file_name` is the original file name; `width`/`height` are original pixels.
- Box: `bbox = [x, y, w, h]`, `area = w*h`, no `segmentation`. Negative sizes are normalized.
- Polygon: `segmentation = [[x1, y1, x2, y2, ...]]` (one ring), `bbox` is the axis-aligned bounds, `area` is the shoelace area. No RLE.
- Coordinates are clamped to the image and rounded to 2 decimals. `iscrowd` is always 0.
- Skipped with an on-screen note: zero-area boxes, zero-area polygons (collinear points), annotations whose class no longer exists, polylines and keypoints.

## COCO JSON (import)

**File > Import COCO JSON** starts a NEW project from a COCO instance file (it asks before discarding unsaved changes). Categories become classes, `bbox` becomes a box, polygon `segmentation` becomes polygons (one per ring; objects with several rings become several polygons, with a note). RLE masks and `iscrowd` objects are skipped with a note. COCO files contain no pixels: images show as "not loaded" until you add the files, then they relink by file name and dimensions.

## YOLO (export)

**Export > YOLO detection (.zip)** or **YOLO segmentation (.zip)** downloads an archive:

```
data.yaml
images/<name>.<ext>    original image bytes (when the file is in memory)
labels/<name>.txt
```

- Detection: one line per box or polygon, `class cx cy w h`; polygons use their axis-aligned bounds.
- Segmentation: one line per polygon, `class x1 y1 x2 y2 ...`; boxes become 4-corner polygons.
- All coordinates are normalized to 0..1 by the original image size and clamped. Class index is the 0-based position in the class list; `data.yaml` lists the names.
- File names are made safe and de-duplicated (names that differ only by case get `_2`, `_3`).
- No train/val split: `data.yaml` points both at `images/`. Split the folders yourself if you need a held-out set.
- Polylines and keypoints are skipped with a note (no standard detect/segment form); they stay in the project file. Images whose file is no longer in memory get a label but no image copy, with a note.

## What has been verified

Unit tests cover the COCO/YOLO numbers, clamping, degenerate geometry, name handling and a COCO export-then-import round trip. The ZIP writer is checked by an independent reader (including CRC-32) and by Windows `bsdtar`, and a headless-browser test downloads real COCO and YOLO exports and inspects them. **Not yet tested** against external consumers such as pycocotools or an actual Ultralytics training run.
