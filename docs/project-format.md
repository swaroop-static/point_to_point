# Project file format (`.aa.json`), version 2

A single JSON file. Source of truth: `src/core/types.ts` (types) and `src/core/validate.ts` (checks on load).

```json
{
  "formatVersion": 2,
  "app": "annotate-anything",
  "name": "My project",
  "savedAt": "2026-10-10T09:00:00.000Z",
  "classes": [
    { "id": "cls_ab12_1", "name": "cat", "color": "#E58A3C" }
  ],
  "images": [
    {
      "id": "img_ab12_3",
      "name": "photo.jpg",
      "width": 1920,
      "height": 1080,
      "annotations": [
        { "id": "ann_ab12_4", "classId": "cls_ab12_1",
          "geom": { "kind": "box", "x": 10, "y": 20, "w": 50, "h": 30 } },
        { "id": "ann_ab12_5", "classId": "cls_ab12_1", "locked": true, "note": "optional",
          "geom": { "kind": "polygon", "points": [{ "x": 0, "y": 0 }, { "x": 100, "y": 0 }, { "x": 50, "y": 80 }] } }
      ]
    }
  ]
}
```

## Rules

- **Coordinates are original image pixels**, origin at the top-left, x right, y down. Zoom and pan never change stored values.
- Box: `x, y` is the top-left corner as drawn; `w`/`h` may be negative in stored data only transiently, exporters normalize them.
- Polygon: ordered vertices, implicitly closed, at least 3.
- Polyline: `{ "kind": "polyline", "points": [...] }`, an open path of at least 2 points (never closed).
- Keypoint: `{ "kind": "keypoint", "x": 0, "y": 0 }`.
- IDs are opaque strings, unique within the file. Classes are referenced by `classId`, never by name.
- `hidden`, `locked` (booleans) and `note` (string) are optional.
- Image pixels are **not** stored. Images relink by `name`, and `width`/`height` must match.

## Loading

A file is rejected with a specific message if it is not JSON, lacks `"app": "annotate-anything"`, has a `formatVersion` other than 1 or 2, has an invalid class color (`#RRGGBB`), references an unknown `classId`, has non-finite coordinates, or has a polygon with fewer than 3 vertices. Unknown extra keys are ignored.

## Version 2 additions (3D photo workspace)

Each image may carry two optional fields, kept separate from `annotations`:

- `camera`: `{ "fx", "fy", "cx", "cy", "calibrated" }`, a pinhole camera in image pixels. `calibrated` is true only when the user states the numbers come from a real calibration.
- `cuboids`: list of `{ id, objectId, classId, center{x,y,z}, size{length,width,height}, rotationY, hidden?, locked?, note? }` in the camera frame. See [photo-cuboids.md](photo-cuboids.md).

## Meshes (3D model workspace)

Optional top-level `meshes`: `[{ id, name, format: "glb"|"gltf"|"obj"|"ply", faceCount, labels: [{ id, objectId, classId, ranges: [[start, end], ...], hidden? }] }]`. `ranges` are sorted, non-overlapping half-open triangle index ranges; a face may be in only one label; `objectId` is an integer >= 1 unique per mesh. The model file is not stored; it relinks by `name` and `faceCount`. See [mesh-annotation.md](mesh-annotation.md).

## Point clouds (3D cloud workspace)

Optional top-level `clouds`: `[{ id, name, format: "ply"|"pcd", pointCount, upAxis: "y"|"z", cuboids: [{ id, objectId, classId, center{x,y,z}, size{length,width,height}, yaw, hidden?, locked? }], pointLabels: [{ id, classId, ranges: [[start, end], ...] }] }]`. Cuboid sizes must be positive; `objectId` is an integer >= 1 unique per cloud. `pointLabels[].ranges` are sorted, non-overlapping half-open point-index ranges, and a point may be in only one label. The points are not stored; the file relinks by `name` and `pointCount`. See [pointcloud-annotation.md](pointcloud-annotation.md).

## Versioning

`formatVersion` increments on any breaking change. This build writes version 2 and migrates version 1 files on load (they simply have no cameras or cuboids). Other versions are rejected.
