# Testing

All test data is generated at run time by the tests themselves (`e2e/fixtures.mjs`, inline data in `tests/`). Nothing binary is committed and no real or private data is used.

| Layer | Command | What it covers |
|---|---|---|
| Type check | `npm run typecheck` | Whole `src/` tree |
| Unit tests | `npm test` | Geometry, projection, exports, parsers, validation, mask-to-polygon, mesh and cloud math (about 90 tests). Two extra tests run real SAM models when `SAM_TEST_DIR` points at the downloaded `.onnx` files; otherwise they are reported as skipped |
| End-to-end | `npm run build && npm run e2e` | The production build in a real browser: 2D editing (including vertex drag, edge insert, vertex delete verified from the saved project file), exports, 3D photo, mesh, point cloud, save/open/relink |
| All browsers | `BROWSER=all npm run e2e` | Same suites on Chromium, Firefox and WebKit. Install them once with `npx playwright install chromium firefox webkit` |
| AI end-to-end | `E2E_AI=1 SUITES=ai npm run e2e` | Downloads a model from huggingface.co and runs click-to-segment. Off by default because it needs the internet |
| COCO validity | `python tools/validate_coco.py export.json` | Loads an exported COCO file with **pycocotools** (`pip install pycocotools numpy`), checks ids/bboxes/mask areas, and requires a self-evaluation AP of 1.0 for bbox (and segm when every annotation has a mask) |

Set `CHROME_PATH` to use an installed Chrome instead of Playwright's Chromium. 3D suites skip themselves (reported as SKIP) in a browser without WebGL.

CI (`.github/workflows/ci.yml`) runs typecheck, unit tests, build, and the end-to-end suites on all three browsers on every push.

## What these tests do not show

- They use synthetic data only. Behavior on real photographs, real scans and large models is untested.
- Browsers are driven headless on one operating system at a time, with software rendering for WebGL. Drawing speed on a real GPU, touch input, and real Safari are not tested. (Playwright's WebKit build lacks WebAssembly SIMD, so AI click is only tested there as "shows a clear message".)
- YOLO exports are checked structurally, not by a training run.
