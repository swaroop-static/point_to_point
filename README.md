# Annotate Anything

A browser-based annotation tool. Draw boxes, polygons, polylines and keypoints on your images, place 3D cuboids on photos, label faces of 3D models, optionally click-to-segment with a small AI model, manage classes, undo/redo, save your project, and export COCO, YOLO or documented JSON. Everything runs in your browser: your files are never uploaded, there is no server, no account, no telemetry.

**Status: 0.4.0.** The 2D editor is the most tested part. Photo cuboids, AI click-to-segment, mesh annotation and point-cloud annotation work and were exercised in a real browser with synthetic data, but have **not** been tried on real-world images, real scans or large models, and drawing speed on a real GPU was not measured. See the [roadmap](docs/roadmap.md).

## What works today

| Area | Status |
|---|---|
| Add images (picker or drag-and-drop), JPEG / PNG / WebP | Works |
| Zoom (wheel, cursor-centered), pan, fit, 1:1 | Works |
| Tools: Select, Box, Polygon, Polyline, Keypoint | Works |
| Box: draw, move, resize with 8 handles | Works |
| Polygon / polyline: drag vertex, click edge to insert, double-click vertex to delete, Alt+drag edge to move it | Works |
| Shift snapping to nearby vertices and horizontal/vertical alignment | Works (logic unit-tested; not exercised by the browser test) |
| Polygon / polyline simplification (Ramer-Douglas-Peucker) with preview, counts and undo | Works |
| Classes: add, rename, recolor, delete (blocked while in use), reassign class | Works |
| Hide / lock / delete annotations; click a border to select | Works |
| Undo / redo (a whole drag is one step) | Works |
| Save / open project (`.aa.json`, versioned, validated on load) | Works |
| Autosave to this browser (IndexedDB) with a restore prompt after a crash or reload | Works |
| Export COCO JSON (boxes + polygon segmentation) | Works |
| Export YOLO detection and YOLO segmentation (`.zip` with images, labels, `data.yaml`) | Works |
| Import COCO JSON as a new project | Works (no RLE masks) |
| Unsaved-changes indicator and close-tab warning | Works (project level) |
| **3D photo**: place, drag, rotate, resize cuboids over a photo with an assumed pinhole camera; export JSON | Works, relative units only unless you declare a calibrated camera ([docs](docs/photo-cuboids.md)) |
| **AI click** (optional): click an object, get an editable polygon; models downloaded on request (about 14 or 45 MB) or loaded from your files | Works; verified on a synthetic image only ([docs](docs/ai-assist.md)) |
| **3D cloud**: load `.ply` / `.pcd`; orbit; place, drag, rotate, resize cuboids with class and object id; Shift+drag to select points and label them; export JSON | Works; synthetic data only, 2M points tested for select/label speed ([docs](docs/pointcloud-annotation.md)) |
| **3D model**: load `.glb`, `.gltf` (self-contained), `.obj`, `.ply` with faces; select face / smooth region / part; label as numbered class objects; export JSON | Works; geometry only, textures ignored ([docs](docs/mesh-annotation.md)) |

## Not built yet (no placeholder buttons exist for these)

YOLO import, train/val split, per-corner cuboid handles (photo and cloud), level-of-detail rendering for huge clouds. See [docs/roadmap.md](docs/roadmap.md).

## Run locally

Requires Node.js 18+.

```powershell
cd C:\Users\swaroop.kandukuri\Downloads\annotate_anything
npm install
npm run dev        # http://127.0.0.1:5173
npm test           # unit tests (vitest)
npm run typecheck
npm run build      # outputs static files to dist/ (app 136 KB JS; three.js 688 KB and the 11 MB AI runtime load only when you open those features)
npm run preview    # serve dist/ at http://127.0.0.1:4173
```

## Important limitations

- **Images are not stored in the `.aa.json` project file.** It holds dimensions, file names, classes and annotations only. After opening a project file, add the same image files again; they relink by file name and are checked against the saved dimensions. (The browser autosave does keep the image bytes, see below.)
- **Autosave is a safety net, not storage.** It lives in this browser's IndexedDB, can be evicted by the browser or cleared with site data, may be unavailable in private windows, and can fill up with very large images (you are warned once if a write fails). Use **File > Save project** for a real copy.
- Undo history covers the current session only. Removing an image keeps its pixels in memory so undo can restore it.
- COCO export is polygon-only (no RLE). YOLO has no standard form for polylines or keypoints, and COCO instance files have none either: those annotations are skipped with a notice and stay in the project file.
- YOLO export has no train/val split; `data.yaml` points both at `images/`.
- Large images are decoded fully in memory. Measured so far: hit-testing 50 annotations (five with 2000 vertices) takes under 1 ms per call in Node. Rendering speed with huge images or hundreds of images has not been benchmarked.

## Privacy

Files are read with the browser File API and processed locally. The app makes no network requests on its own and uses system fonts only. There is no analytics. Autosaved data stays in this browser. The **only** network request the app can make is the optional AI model download (from huggingface.co) after you press the download button; your images and clicks never leave the browser. Details in [docs/ai-assist.md](docs/ai-assist.md).

## Docs

- [Keyboard shortcuts](docs/shortcuts.md)
- [3D cuboids on photos](docs/photo-cuboids.md)
- [AI click-to-segment](docs/ai-assist.md)
- [3D model annotation](docs/mesh-annotation.md)
- [Point-cloud annotation](docs/pointcloud-annotation.md)
- [Project file format](docs/project-format.md)
- [Exports and imports](docs/exports.md)
- [Deployment (free static hosting)](docs/deployment.md)
- [Roadmap](docs/roadmap.md)
- [Third-party licenses](docs/third-party.md)

## License

MIT, see [LICENSE](LICENSE). This project is written independently and contains no code, data or assets from any employer or other project.
