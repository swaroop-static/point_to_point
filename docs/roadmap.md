# Roadmap

Each milestone is finished and verified before the next starts.

## Phase 1: 2D editor (done in 0.2.0)

Image import, canvas, box / polygon / polyline / keypoint, vertex and edge editing, snapping, simplification, classes, undo/redo, project save/open, autosave recovery, COCO export/import, YOLO export.

Still open inside Phase 1: validate exports against pycocotools / an Ultralytics run, YOLO import, train/val split, rendering benchmarks with large images, a browser test for Shift snapping.

## Phase 2: AI-assisted segmentation (done in 0.3.0, optional)

Click-to-segment in the browser with onnxruntime-web: include/exclude clicks, mask to polygon, accept/reject. Two user-downloadable models (SlimSAM-77 quantized, MobileSAM) or your own ONNX files. See [ai-assist.md](ai-assist.md).

Open: evaluation on real photographs, box prompts, WebGPU, a license review of the MobileSAM weights before any redistribution.

## Phase 3: 3D cuboids on photos (done in 0.3.0, basic)

Camera/cuboid math with unit tests, project format v2, export schema ([photo-cuboids.md](photo-cuboids.md)), and the "3D photo" workspace. Open: per-corner handles, pitch/roll, ground-plane placement.

## Phase 4: Mesh annotation (done in 0.3.0, basic)

GLB / glTF (self-contained) / OBJ / PLY with faces; face, smooth-region and part selection; numbered class objects; JSON export ([mesh-annotation.md](mesh-annotation.md)). Open: vertex-level selection, paint brush, textures, external glTF resources, an acceleration structure for very large models, benchmarks.

## Phase 5: Point-cloud annotation (not started)

PLY first, then PCD only after parsing is verified. Needs chunked or octree rendering for large clouds, 3D cuboids, classes and object ids, export.

## Later, only if there is demand

Collaboration, hosted inference, advertising or paid tiers. None are part of the core and none are built.
