# 3D model (mesh) annotation

Workspace: **3D model** (top bar). Export: **Export > Mesh annotations JSON**. Schema id `annotate-anything/mesh-annotations`, version 1.

## What it does

Load a 3D model, select faces, and give each selection a class and a numbered object id. Labels are saved in the project file (`meshes[]`, see [project-format.md](project-format.md)). The model itself is **not** stored in the project: like images, it relinks by file name, and the triangle count must match (a same-named file with a different count is refused).

## Supported formats (tested)

| Format | Notes |
|---|---|
| `.glb` | Tested with a hand-built indexed cube. |
| `.gltf` | Must be self-contained (embedded buffers). External `.bin` or texture files are **not** resolved. Not separately tested beyond the shared GLTF code path. |
| `.obj` | Tested with two objects in one file. Polygons are triangulated by three.js. |
| `.ply` | Needs faces. Tested with quad faces (triangulated to 12 triangles). A PLY with no faces is a point cloud and is rejected with a message. |

Only geometry is used. **Textures and materials are ignored**; the model is drawn in a neutral gray so label colors are readable. Object transforms are baked in. Point clouds and line models are rejected. Models above 3,000,000 triangles are refused.

## Selecting

| Mode (key) | Effect of a click |
|---|---|
| Face (F) | One triangle |
| Region (R) | A smooth surface: grows across shared edges while neighboring faces differ by at most the angle limit (slider, default 25 degrees) |
| Part (O) | Every face connected to the clicked one by shared edges |

Click replaces the selection; Shift+click adds. Vertices within one millionth of the bounding-box diagonal count as the same point, so seams from duplicated vertices do not split a surface.

Then pick a class (click it in the class list, or press 1 to 9) and press **Enter** (or "Label selection"). Each label becomes one object (`#1`, `#2`, ...). **A face belongs to at most one object**: labeling faces that already had a label takes them away from the old one, and an object left with no faces is removed. Click an object in the list to select its faces; with an object selected, clicking another class changes its class. Delete removes it. Hide only hides its color. Everything is undoable.

## Export format

```json
{
  "schema": "annotate-anything/mesh-annotations",
  "schema_version": 1,
  "face_order": "Triangles in depth-first scene order; ...",
  "classes": [{ "index": 0, "name": "object" }],
  "meshes": [{
    "file_name": "two_cubes.obj", "format": "obj", "face_count": 24,
    "face_class_rle": [[0, 12], [-1, 12]],
    "objects": [{ "id": "...", "object_id": 1, "class_index": 0, "class_name": "object",
                  "face_count": 12, "face_ranges": [[0, 12]] }]
  }]
}
```

- `face_class_rle`: class index of every face in order as `[class_index, run_length]` pairs; `-1` means unlabeled. Run lengths sum to `face_count`.
- `face_ranges`: half-open `[start, end)` triangle indices.
- **Face order matters.** Face `i` is the i-th triangle in depth-first scene order, each mesh in its own index-buffer order (or consecutive vertex triples when non-indexed). Indices are only meaningful with the same model file read by the same logic. Other tools may order faces differently (for example after re-exporting the model), so check the order before using the labels elsewhere.

## Limits

- Picking is a plain ray test with no acceleration structure. It is instant on small models and slower on very large ones; I have **not** benchmarked models with hundreds of thousands of triangles.
- Vertex-level and sub-face (paint brush) selection are not built; the unit is a whole triangle.
- The autosave stores the model file in the browser together with images; very large models may exceed browser storage.
