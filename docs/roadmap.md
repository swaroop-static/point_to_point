# Roadmap

Each milestone is finished and verified before the next starts.

## Phase 1: 2D editor (done in 0.2.0)

Image import, canvas, box / polygon / polyline / keypoint, vertex and edge editing, snapping, simplification, classes, undo/redo, project save/open, autosave recovery, COCO export/import, YOLO export.

Still open inside Phase 1: validate exports against pycocotools / an Ultralytics run, YOLO import, train/val split, rendering benchmarks with large images, a browser test for Shift snapping.

## Phase 2: AI-assisted segmentation (optional)

Click-to-segment in the browser via ONNX Runtime Web. Requires verifying code and weights licenses separately, user-initiated model download, polygon conversion, accept/reject. Manual annotation must never depend on it.

## Phase 3: 3D cuboids on photos (in progress)

Done: camera/cuboid math with unit tests, project format v2 with validation, export schema ([photo-cuboids.md](photo-cuboids.md)), and the "3D photo" workspace (add, drag, rotate, depth, size, camera field of view, hide/lock/delete, undo).

Not yet verified: the workspace is type-checked and builds, but has **not been exercised in a real browser**. Missing: per-corner handles, pitch/roll, a browser test.

## Phase 4: Mesh annotation (GLB/glTF, OBJ)

## Phase 5: Point-cloud annotation (PLY first)

## Later, only if there is demand

Collaboration, hosted inference, advertising or paid tiers. None are part of the core and none are built.
