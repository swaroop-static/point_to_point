# Third-party software

Shipped in the browser bundle, loaded only when the feature is opened:

| Package | Used for | License |
|---|---|---|
| three 0.170.0 (and its `addons`: GLTFLoader, OBJLoader, PLYLoader, OrbitControls) | 3D model workspace | MIT |
| onnxruntime-web 1.19.2 (WebAssembly build) | optional AI click-to-segment | MIT |

The app's own code has no other runtime dependencies. The core 2D editor needs neither package.

Optional AI models are **not bundled and not redistributed**. They are downloaded by the user's browser from Hugging Face on request, or supplied by the user:

| Model | License as stated on its model card (read 2026-10-10) |
|---|---|
| SlimSAM-77 quantized ONNX (Xenova/slimsam-77-uniform) | Apache-2.0 |
| MobileSAM ONNX (Acly/MobileSAM) | MIT on the conversion; MobileSAM code is Apache-2.0; the upstream weights repository states no separate license. **Unresolved:** confirm weight redistribution terms before bundling or mirroring these files. |

Development-only tools (not shipped): typescript (Apache-2.0), vite (MIT), vitest (MIT), @types/three (MIT).

Licenses are recorded from published metadata and model cards as I read them; confirm with `npm ls` and each package's LICENSE file before a public release. No fonts, images or datasets are bundled. The app icon (`public/icon.svg`) was drawn for this project.
