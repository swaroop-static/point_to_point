# Annotate Anything

A browser-based annotation tool. Draw boxes, polygons, polylines and keypoints on your images, manage classes, undo/redo, save your project, and export COCO or YOLO datasets. Everything runs in your browser: images are never uploaded, there is no server, no account, no telemetry.

**Status: 2D editor complete for version 0.2.0.** See the [roadmap](docs/roadmap.md) for AI-assisted segmentation and the 3D workspaces, which are not built yet.

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

## Not built yet (no placeholder buttons exist for these)

AI-assisted segmentation, photo 3D cuboids, mesh annotation, point-cloud annotation, YOLO import, train/val split. See [docs/roadmap.md](docs/roadmap.md).

## Run locally

Requires Node.js 18+.

```powershell
cd C:\Users\swaroop.kandukuri\Downloads\annotate_anything
npm install
npm run dev        # http://127.0.0.1:5173
npm test           # unit tests (vitest)
npm run typecheck
npm run build      # outputs static files to dist/
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

Files are read with the browser File API and drawn to a canvas locally. After the page loads, the app makes no network requests and uses system fonts only. There is no analytics. Autosaved data stays in this browser.

## Docs

- [Keyboard shortcuts](docs/shortcuts.md)
- [Project file format](docs/project-format.md)
- [Exports and imports](docs/exports.md)
- [Deployment (free static hosting)](docs/deployment.md)
- [Roadmap](docs/roadmap.md)
- [Third-party licenses](docs/third-party.md)

## License

MIT, see [LICENSE](LICENSE). This project is written independently and contains no code, data or assets from any employer or other project.
