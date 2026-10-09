import type { SamFlavor } from './models';

/**
 * Click-to-segment engine for SAM-style ONNX models. Pure: it never touches
 * the DOM, and the ONNX runtime is passed in (onnxruntime-web in the app,
 * onnxruntime-node in tests) so the same code is tested against real models.
 *
 * Pipeline: image -> resize longest side to 1024 -> normalize -> pad to
 * 1024x1024 -> encoder (slow, once per image) -> decoder (fast, per click).
 */

export const SAM_SIZE = 1024;
const MEAN = [123.675, 116.28, 103.53];
const STD = [58.395, 57.12, 57.375];

/** Minimal slice of the onnxruntime API we use. */
export interface OrtLike {
  Tensor: new (type: string, data: ArrayLike<number> | BigInt64Array | Float32Array, dims: number[]) => OrtTensor;
  InferenceSession: { create(model: Uint8Array | string, opts?: object): Promise<OrtSession> };
}
export interface OrtTensor { data: ArrayLike<number> | BigInt64Array; dims: readonly number[] }
export interface OrtSession {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
}

export interface PromptPoint { x: number; y: number; positive: boolean }
export interface SamResult { mask: Uint8Array; width: number; height: number; score: number }

export function resizedSize(w: number, h: number): { rw: number; rh: number; scale: number } {
  const scale = SAM_SIZE / Math.max(w, h);
  return { rw: Math.max(1, Math.round(w * scale)), rh: Math.max(1, Math.round(h * scale)), scale };
}

/** RGBA pixels already resized to (rw, rh) -> normalized CHW float tensor data padded to 1024x1024. */
export function rgbaToTensorData(rgba: Uint8ClampedArray | Uint8Array, rw: number, rh: number): Float32Array {
  const S = SAM_SIZE, plane = S * S;
  const out = new Float32Array(3 * plane); // zeros = padding (after normalization, as SAM does)
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const i = (y * rw + x) * 4, o = y * S + x;
      out[o] = (rgba[i] - MEAN[0]) / STD[0];
      out[plane + o] = (rgba[i + 1] - MEAN[1]) / STD[1];
      out[2 * plane + o] = (rgba[i + 2] - MEAN[2]) / STD[2];
    }
  }
  return out;
}

export function rgbaToRawHWC(rgba: Uint8ClampedArray | Uint8Array, rw: number, rh: number): Float32Array {
  const out = new Float32Array(rw * rh * 3);
  for (let i = 0, o = 0; i < rw * rh * 4; i += 4, o += 3) { out[o] = rgba[i]; out[o + 1] = rgba[i + 1]; out[o + 2] = rgba[i + 2]; }
  return out;
}

export class SamEngine {
  private enc: OrtSession | null = null;
  private dec: OrtSession | null = null;
  private embeddings: { image: OrtTensor; pos?: OrtTensor } | null = null;
  private img: { w: number; h: number; scale: number; rw: number; rh: number } | null = null;

  constructor(private ort: OrtLike, readonly flavor: SamFlavor) {}

  async load(encoder: Uint8Array, decoder: Uint8Array, opts: object = {}): Promise<void> {
    this.enc = await this.ort.InferenceSession.create(encoder, opts);
    this.dec = await this.ort.InferenceSession.create(decoder, opts);
  }

  get ready(): boolean { return !!this.enc && !!this.dec; }
  get hasImage(): boolean { return !!this.embeddings; }
  clearImage(): void { this.embeddings = null; this.img = null; }

  /** Run the encoder. `rgba` is the image already resized to resizedSize(w, h). */
  async setImage(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): Promise<void> {
    if (!this.enc) throw new Error('Model not loaded.');
    const { rw, rh, scale } = resizedSize(w, h);
    if (rgba.length !== rw * rh * 4) throw new Error(`Expected ${rw}x${rh} RGBA pixels, got ${rgba.length / 4}.`);
    const input = this.flavor === 'sam1'
      // This MobileSAM export normalizes inside the model: raw 0-255 RGB, HWC, any size up to 1024, no padding.
      ? new this.ort.Tensor('float32', rgbaToRawHWC(rgba, rw, rh), [rh, rw, 3])
      : new this.ort.Tensor('float32', rgbaToTensorData(rgba, rw, rh), [1, 3, SAM_SIZE, SAM_SIZE]);
    const out = await this.enc.run({ [this.enc.inputNames[0]]: input });
    this.embeddings = this.flavor === 'sam1'
      ? { image: out['image_embeddings'] }
      : { image: out['image_embeddings'], pos: out['image_positional_embeddings'] };
    this.img = { w, h, scale, rw, rh };
  }

  /** Segment with positive/negative clicks given in ORIGINAL image pixels. */
  async predict(points: PromptPoint[]): Promise<SamResult> {
    if (!this.dec || !this.embeddings || !this.img) throw new Error('No image is prepared. Run setImage first.');
    if (!points.length) throw new Error('At least one click is required.');
    const { w, h, scale, rw, rh } = this.img;
    const n = points.length;
    const T = this.ort.Tensor;

    if (this.flavor === 'sam1') {
      // Original SAM decoder: one extra padding point with label -1 when no box is given.
      const coords = new Float32Array((n + 1) * 2), labels = new Float32Array(n + 1);
      points.forEach((p, i) => { coords[2 * i] = p.x * scale; coords[2 * i + 1] = p.y * scale; labels[i] = p.positive ? 1 : 0; });
      labels[n] = -1;
      const out = await this.dec.run({
        image_embeddings: this.embeddings.image,
        point_coords: new T('float32', coords, [1, n + 1, 2]),
        point_labels: new T('float32', labels, [1, n + 1]),
        mask_input: new T('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
        has_mask_input: new T('float32', new Float32Array([0]), [1]),
        orig_im_size: new T('float32', new Float32Array([h, w]), [2]),
      });
      const logits = out['masks'].data as ArrayLike<number>;
      const mask = new Uint8Array(w * h);
      for (let i = 0; i < mask.length; i++) mask[i] = logits[i] > 0 ? 1 : 0;
      const iou = out['iou_predictions']?.data as ArrayLike<number> | undefined;
      return { mask, width: w, height: h, score: iou ? Number(iou[0]) : NaN };
    }

    // Hugging Face / transformers.js SAM decoder: 3 candidate masks at 256x256 (in the padded 1024 frame).
    const coords = new Float32Array(n * 2), labels = new BigInt64Array(n);
    points.forEach((p, i) => { coords[2 * i] = p.x * scale; coords[2 * i + 1] = p.y * scale; labels[i] = p.positive ? 1n : 0n; });
    const out = await this.dec.run({
      input_points: new T('float32', coords, [1, 1, n, 2]),
      input_labels: new T('int64', labels, [1, 1, n]),
      image_embeddings: this.embeddings.image,
      image_positional_embeddings: this.embeddings.pos!,
    });
    const scores = out['iou_scores'].data as ArrayLike<number>;
    let best = 0;
    for (let k = 1; k < 3; k++) if (scores[k] > scores[best]) best = k;
    const lo = out['pred_masks'].data as ArrayLike<number>;
    const off = best * 256 * 256;
    // Low-res pixel (i, j) covers padded-frame pixels [4i, 4i+4); sample bilinearly at each original pixel.
    const mask = new Uint8Array(w * h);
    const maxX = Math.ceil(rw / 4) - 1, maxY = Math.ceil(rh / 4) - 1;
    for (let y = 0; y < h; y++) {
      const fy = Math.min(Math.max((y + 0.5) * scale / 4 - 0.5, 0), maxY);
      const y0 = Math.floor(fy), y1 = Math.min(y0 + 1, maxY), ty = fy - y0;
      for (let x = 0; x < w; x++) {
        const fx = Math.min(Math.max((x + 0.5) * scale / 4 - 0.5, 0), maxX);
        const x0 = Math.floor(fx), x1 = Math.min(x0 + 1, maxX), tx = fx - x0;
        const v = (lo[off + y0 * 256 + x0] * (1 - tx) + lo[off + y0 * 256 + x1] * tx) * (1 - ty)
          + (lo[off + y1 * 256 + x0] * (1 - tx) + lo[off + y1 * 256 + x1] * tx) * ty;
        mask[y * w + x] = v > 0 ? 1 : 0;
      }
    }
    return { mask, width: w, height: h, score: Number(scores[best]) };
  }
}
