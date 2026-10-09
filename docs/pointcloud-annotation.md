# 3D point-cloud annotation

Workspace: **3D cloud** (top bar). Export: **Export > Point-cloud annotations JSON**. Schema id `annotate-anything/pointcloud-annotations`, version 1.

## What it does

Load a point cloud, place oriented 3D cuboids around objects, and label individual points with a class. Cuboids and point labels are saved in the project (`clouds[]`, see [project-format.md](project-format.md)). The points are **not** stored in the project: the file relinks by name, and the point count must match (a same-named file with a different count is refused).

## Formats (tested)

| Format | Notes |
|---|---|
| `.ply` | Vertices are the points; faces are ignored. Binary and ASCII (via three.js `PLYLoader`). Colors are used if present. Tested with a binary PLY with colors. |
| `.pcd` | My own parser: ASCII and uncompressed binary, `x y z` as 32/64-bit float, optional packed `rgb`/`rgba`. **`binary_compressed` (LZF) is rejected** with a message. Tested with hand-built ASCII and binary files, including rejection cases. |

Points with NaN or infinite coordinates are dropped before numbering and reported. Clouds above 6,000,000 points are refused. Other fields (intensity, normals, ...) are ignored.

## Up axis

Lidar and survey files are usually Z-up; some tools use Y-up. Each cloud has an **Up axis** setting (default Z, changeable in the Cuboids panel). It controls which axis is "height", and cuboid yaw rotates about it. Changing it re-interprets existing cuboids; it does not rotate the data.

## Cuboids

A cuboid is `center`, `size {length, width, height}` and `yaw`. The horizontal axes are a and b (up = Z gives a = x, b = y; up = Y gives a = x, b = z). `length` runs along local a, `width` along local b, `height` along up. Yaw is the angle from +a toward +b, in radians.

| Action | How |
|---|---|
| Add | `C`, then click a point on the object (the box sits on that point; default size is a fraction of the cloud) |
| Move | Drag it. It slides on the horizontal plane through its center |
| Rotate | `Q` / `E` (5 degrees) or the Yaw field |
| Resize, reposition | Length / Width / Height / Center fields |
| Class, hide, lock, delete | Class list, `H`, `L`, `Delete` |
| Select the points inside | "Select points inside" button |

There are no corner or edge handles yet. All edits are undoable; a whole drag is one step.

## Point labels

`Shift`+drag draws a rectangle and **adds** the points whose screen position falls inside it. There is **no occlusion test**: it selects points through the cloud, including those behind others. "Select points inside" on a cuboid is the precise alternative. Pick a class and press `Enter` to label the selection. A point has at most one class: labeling takes points from any other class. All points of one class share one label entry. `Esc` clears the selection.

## View

Left-drag orbits, right-drag pans, wheel zooms. Buttons and keys: Top (`T`), Front (`F`), Side (`S`), Reset (`R`). Color by height, file colors, or gray; point-size slider. Top view has +a to the right and +b up on screen.

## Export format

```json
{
  "schema": "annotate-anything/pointcloud-annotations",
  "schema_version": 1,
  "coordinate_system": { "...": "text description" },
  "classes": [{ "index": 0, "name": "car" }],
  "clouds": [{
    "file_name": "scene.ply", "format": "ply", "point_count": 6600, "up_axis": "z",
    "cuboids": [{
      "id": "...", "object_id": 1, "class_index": 0, "class_name": "car",
      "center": [10, 5, 0.75], "size": { "length": 4, "width": 2, "height": 1.5 }, "yaw": 0.25,
      "corners": [[x, y, z], "... 8 entries"],
      "point_count_inside": 1508, "point_index_ranges_inside": [[2314, 2316], "..."]
    }],
    "point_labels": [{ "class_index": 1, "class_name": "ground", "point_count": 1508, "ranges": [[2314, 2316]] }],
    "point_class_rle": [[-1, 2314], [0, 2], "..."]
  }]
}
```

- Corner order: bit0 = +length, bit1 = +width, bit2 = +height (up), so corner 0 is (-l/2, -w/2, -h/2) in the cuboid frame.
- `point_count_inside` and the ranges are computed at export time from the loaded points and are `null` if the file is not loaded (a warning is shown). Points on the box surface count as inside.
- `point_class_rle` covers semantic point labels only (cuboid membership is separate); `-1` = unlabeled. Run lengths sum to `point_count`.
- Point indices are in file order after dropping invalid points.

## Measured (and what is not)

Measured in headless Chrome with a synthetic 2,000,000-point binary PLY: reading and parsing 0.6 s; Shift+drag over half the cloud (1,000,121 points) 0.54 s; labeling those points 0.55 s. The export's `point_count_inside` and the "Select points inside" count were checked against an independent count on a 6,600-point scene (1,508 = 1,508).

**Not measured: drawing speed on a real GPU.** The test browser renders in software, where orbiting 2,000,000 points took about 2 seconds per frame; a real GPU is expected to be much faster but I could not test one. There is no level-of-detail, octree or chunking, so very large clouds on weak GPUs may orbit slowly; downsample such files first. Picking and selection scan every point in JavaScript (fine at 2M, not tested beyond).

## Limits

- No per-corner cuboid handles, no pitch/roll (yaw only), no occlusion-aware selection, no lasso, no instance ids for points (only cuboid object ids).
- Point labels are stored as index ranges. A scattered selection (for example, thousands of isolated points) creates many ranges, which makes the project file and autosave larger.
- Autosave keeps a copy of the cloud file in the browser; very large clouds may exceed storage.
