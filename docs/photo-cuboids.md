# 3D cuboids on photos

Workspace: **3D photo** (top bar). Export: **Export → Photo cuboids JSON**. Schema id `annotate-anything/photo-cuboids`, version 1. It is its own format; COCO and YOLO cannot express an oriented 3D box.

## Read this first: what the numbers mean

A single photograph does not determine real depth or real size. The workspace uses an **assumed pinhole camera** (default 60° horizontal field of view, principal point at the image center). Under that assumption, cuboid sizes and distances are **relative**, not metric: a 2-unit box at depth 10 looks identical to a 1-unit box at depth 5.

Only if you tick **Camera is calibrated** (and set a field of view that comes from a real calibration) does the export mark `metric: true`. Nothing is estimated or inferred automatically, and no depth model is used.

## Coordinate system

- Camera frame (OpenCV): +x right, +y down, +z forward, origin at the camera.
- Projection: `u = fx*X/Z + cx`, `v = fy*Y/Z + cy`, only for `Z > 0`.
- Cuboid local frame: x = width, y = height (+y is down, the top face is at -y), z = length (front faces +z at rotation 0).
- `rotation_y`: right-handed rotation about the camera +y axis, radians. `x' = x·cos + z·sin`, `z' = -x·sin + z·cos`.
- Corner index bits: bit0 = +x side, bit1 = +y side (bottom), bit2 = +z side (front). Corner 0 is (-w/2,-h/2,-l/2), corner 7 is (+w/2,+h/2,+l/2).

## Exported structure

```json
{
  "schema": "annotate-anything/photo-cuboids",
  "schema_version": 1,
  "project_name": "...",
  "coordinate_system": { "...": "text description of the above" },
  "classes": [{ "index": 0, "name": "car" }],
  "images": [{
    "file_name": "street.jpg", "width": 1920, "height": 1080,
    "camera": { "fx": 1662.8, "fy": 1662.8, "cx": 960, "cy": 540, "calibrated": false },
    "metric": false,
    "cuboids": [{
      "id": "...", "object_id": 1, "class_index": 0, "class_name": "car",
      "center": [0.4, 0.8, 12.0],
      "size": { "length": 4.5, "width": 1.8, "height": 1.5 },
      "rotation_y": 0.35,
      "corners_3d": [[0,0,0], "... 8 entries"],
      "corners_2d": [[812.1, 600.4], "... 8 entries, null if behind the camera"]
    }]
  }]
}
```

Both the parametric form and the derived corners are written so a consumer can cross-check them. Images with cuboids but no camera are skipped with a warning.

## Editing

| Action | How |
|---|---|
| Add cuboid | `C`, then click where the object is |
| Move | Drag (keeps depth; the cuboid slides across the photo) |
| Rotate | `Q` / `E` (5° steps) or the Rotation field |
| Depth | `W` / `S` or the Depth field (keeps the cuboid at the same spot on the photo) |
| Size | Width / Height / Length fields |
| Hide / lock / delete | `H` / `L` / `Delete` |
| Pan / zoom | Wheel to zoom, drag empty space (or Space+drag, or right-drag) to pan, `F` to fit |

All edits are undoable (Ctrl+Z).

## Limitations

- Rotation is about the vertical (camera y) axis only; no pitch or roll.
- Changing the camera field of view moves existing cuboids on the photo, because their 3D position is what is stored.
- Moving is done in the image plane at fixed depth; there are no per-corner handles yet.
- Cuboids cannot be placed from a single click with a meaningful real size; the starting box is a unit cube that you scale.
