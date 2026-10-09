# AI click-to-segment (optional)

Everything else in the app works without this. It is off until you enable a model.

## How to use

1. 2D image workspace, open **AI assist (optional)** in the right panel (or press `M`).
2. Pick a model and press **Download ... and enable**, or **Use my own .onnx files** (select the encoder and decoder files together; the names must contain "encoder" and "decoder").
3. Press `M`, then click an object. Left-click includes, right-click (or Shift/Alt+click) excludes. The first click on each image takes several seconds while the image is analyzed; later clicks are fast.
4. **Enter** accepts: a normal polygon annotation is added (active class) that you can refine with the Select tool. **Esc** discards, **Backspace** removes the last click. Ctrl+Z undoes an accepted polygon.

## Models

| Model | Download | License (from the model card, read 2026-10-10) | Source |
|---|---|---|---|
| SlimSAM-77, quantized | about 14 MB | Apache-2.0 | huggingface.co/Xenova/slimsam-77-uniform |
| MobileSAM | about 45 MB | Code Apache-2.0; ONNX conversion tagged MIT; the upstream weights repository states no separate license | huggingface.co/Acly/MobileSAM |

Measured in headless Chrome on the development machine with a synthetic image (not a benchmark): MobileSAM took about 7 s to analyze the first click; SlimSAM about 12 s despite the smaller download (the quantized encoder is not faster here). Later clicks took about 0.1 to 0.4 s. Real photos and other machines will differ.

Mask quality was measured only on a synthetic solid disc (IoU 0.99 for both models). **I have not evaluated either model on real photographs.** Expect imperfect masks on cluttered scenes and thin objects; the output is a starting polygon to edit, not a finished label.

## Privacy: what leaves your device

- Your images and clicks **never** leave the browser. Inference runs locally in WebAssembly in a Web Worker.
- Enabling a model makes one request per model file to `huggingface.co` (the file, nothing about you is sent beyond what any HTTPS request reveals: your IP address and the request itself; no referrer is sent). The files are stored in this browser's Cache Storage, so a later enable needs no download. "Delete downloaded copy" removes them.
- The first use also loads the ONNX Runtime WebAssembly (about 11 MB) from the same site that served the app, not from a third party.
- "Use my own .onnx files" makes no network request for the model.

## Technical notes

- Models are SAM-style ONNX encoder/decoder pairs. Two interfaces are supported (MobileSAM's original SAM decoder, and the Hugging Face / transformers.js SAM decoder used by SlimSAM). Other SAM variants will not work unless they use one of these interfaces.
- Runtime: onnxruntime-web (WASM, one thread). Multi-threading needs cross-origin-isolation headers that free static hosts cannot set.
- The mask is converted to ONE polygon: the connected component under your first include click, outer boundary only (holes are ignored), simplified with Ramer-Douglas-Peucker at 1.5 px.
- The model's `iou` score is **not shown**: the exported models return values slightly above 1, which are not valid confidences.
- Large images are downscaled to 1024 px on the long side for analysis; polygon coordinates are in original image pixels.

## Not done

- Box prompts, multi-mask choice, and mask refinement from previous masks.
- WebGPU acceleration.
- Evaluation on real data.
