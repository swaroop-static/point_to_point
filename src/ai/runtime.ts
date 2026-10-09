import type { SamModelSpec } from './models';
import { SamEngine, type OrtLike, type PromptPoint, type SamResult, resizedSize } from './sam';
import { maskToPolygon } from './mask';
import type { Point2D } from '../core/types';

/**
 * Browser side of the optional AI assist. Everything is lazy: onnxruntime-web
 * (and its ~10 MB WebAssembly file) is only fetched after the user chooses to
 * enable a model. Models are downloaded from the host listed in models.ts to
 * this browser only, cached with the Cache API, and run locally.
 */

const CACHE = 'annotate-anything-models-v1';

/** True when this browser can run WebAssembly SIMD, which the ONNX runtime build we ship requires. */
export function wasmSimdSupported(): boolean {
  try {
    // A tiny module using a v128 instruction (the standard feature-detection snippet).
    return typeof WebAssembly === 'object' && WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
  } catch { return false; }
}

export type AiState =
  | { kind: 'off' }
  | { kind: 'working'; message: string; progress?: number }
  | { kind: 'ready'; model: string; source: 'download' | 'files' | 'cache' }
  | { kind: 'error'; message: string };

type Listener = () => void;

export class AiController {
  state: AiState = { kind: 'off' };
  private listeners = new Set<Listener>();
  private engine: SamEngine | null = null;
  private activeSpec: SamModelSpec | null = null;
  private encodedFor: string | null = null;
  private busy = false;

  subscribe(l: Listener): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
  private set(s: AiState): void { this.state = s; for (const l of this.listeners) l(); }

  get ready(): boolean { return this.state.kind === 'ready' && !!this.engine?.ready; }
  get working(): boolean { return this.state.kind === 'working'; }

  async isCached(spec: SamModelSpec): Promise<boolean> {
    try {
      if (!('caches' in window)) return false;
      const c = await caches.open(CACHE);
      return !!(await c.match(spec.encoder.url)) && !!(await c.match(spec.decoder.url));
    } catch { return false; }
  }

  async removeCached(spec: SamModelSpec): Promise<void> {
    try { const c = await caches.open(CACHE); await c.delete(spec.encoder.url); await c.delete(spec.decoder.url); } catch { /* nothing to do */ }
  }

  /** Download (or reuse the cached copy of) a model, then start it. */
  async enable(spec: SamModelSpec): Promise<void> {
    if (this.working) return;
    if (!wasmSimdSupported()) {
      this.set({ kind: 'error', message: 'AI click needs WebAssembly SIMD, which this browser does not support. Update to a current Chrome, Edge, Firefox or Safari 16.4+. Everything else works without it.' });
      return;
    }
    try {
      const total = spec.encoder.sizeMB + spec.decoder.sizeMB;
      let done = 0;
      const wasCached = await this.isCached(spec);
      const get = async (f: { name: string; url: string; sizeMB: number }): Promise<Uint8Array> => {
        const base = done;
        const bytes = await fetchCached(f.url, (loaded) => {
          this.set({ kind: 'working', message: `Downloading ${f.name}`, progress: Math.min(1, (base + loaded / 1048576) / total) });
        });
        done += f.sizeMB;
        return bytes;
      };
      this.set({ kind: 'working', message: wasCached ? 'Loading cached model' : `Downloading ${spec.label}`, progress: 0 });
      const enc = await get(spec.encoder);
      const dec = await get(spec.decoder);
      await this.start(spec, enc, dec, wasCached ? 'cache' : 'download');
    } catch (e) {
      this.set({ kind: 'error', message: friendly(e, 'Could not download the model. Check your connection, or load the .onnx files yourself.') });
    }
  }

  /** Use two .onnx files the user picked (nothing is downloaded). */
  async enableFromFiles(spec: SamModelSpec, encoderFile: File, decoderFile: File): Promise<void> {
    if (this.working) return;
    if (!wasmSimdSupported()) {
      this.set({ kind: 'error', message: 'AI click needs WebAssembly SIMD, which this browser does not support. Update to a current Chrome, Edge, Firefox or Safari 16.4+. Everything else works without it.' });
      return;
    }
    try {
      this.set({ kind: 'working', message: 'Reading model files' });
      const enc = new Uint8Array(await encoderFile.arrayBuffer());
      const dec = new Uint8Array(await decoderFile.arrayBuffer());
      await this.start(spec, enc, dec, 'files');
    } catch (e) {
      this.set({ kind: 'error', message: friendly(e, 'Could not read those model files.') });
    }
  }

  disable(): void {
    this.engine = null; this.activeSpec = null; this.encodedFor = null;
    this.set({ kind: 'off' });
  }

  private async start(spec: SamModelSpec, enc: Uint8Array, dec: Uint8Array, source: 'download' | 'files' | 'cache'): Promise<void> {
    this.set({ kind: 'working', message: 'Starting the AI runtime (first time loads about 10 MB of WebAssembly)' });
    const ort = await loadOrt();
    const engine = new SamEngine(ort, spec.flavor);
    this.set({ kind: 'working', message: 'Preparing the model' });
    await engine.load(enc, dec, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    this.engine = engine; this.activeSpec = spec; this.encodedFor = null;
    this.set({ kind: 'ready', model: spec.label, source });
  }

  /**
   * Segment from clicks (original image pixels). Encodes the image on first use
   * (slow, once per image) and reuses the result for later clicks.
   */
  async segment(imageKey: string, bitmap: ImageBitmap, w: number, h: number, points: PromptPoint[]): Promise<{ result: SamResult; polygon: Point2D[] }> {
    const engine = this.engine;
    if (!engine || !this.ready) throw new Error('No AI model is enabled.');
    if (this.busy) throw new Error('Still working on the previous click.');
    this.busy = true;
    try {
      if (this.encodedFor !== imageKey || !engine.hasImage) {
        this.set({ kind: 'working', message: 'Analyzing the image (once per image)' });
        await tick();
        const { rw, rh } = resizedSize(w, h);
        const c = document.createElement('canvas');
        c.width = rw; c.height = rh;
        const g = c.getContext('2d', { willReadFrequently: true });
        if (!g) throw new Error('2D canvas is not supported in this browser.');
        g.drawImage(bitmap, 0, 0, rw, rh);
        await engine.setImage(g.getImageData(0, 0, rw, rh).data, w, h);
        this.encodedFor = imageKey;
        this.set({ kind: 'ready', model: this.activeSpec!.label, source: (this.state as { source?: 'download' | 'files' | 'cache' }).source ?? 'cache' });
      }
      const result = await engine.predict(points);
      const seed = points.find((p) => p.positive) ?? null;
      const polygon = maskToPolygon(result.mask, w, h, seed ? { x: seed.x, y: seed.y } : null, 1.5);
      return { result, polygon };
    } finally {
      this.busy = false;
    }
  }

  /** Forget the cached encoding (e.g. image removed). */
  invalidate(): void { this.encodedFor = null; this.engine?.clearImage(); }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

let ortPromise: Promise<OrtLike> | null = null;
async function loadOrt(): Promise<OrtLike> {
  if (!ortPromise) {
    ortPromise = (async () => {
      const ort = await import('onnxruntime-web/wasm');
      const wasm = (await import('../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url')).default;
      const mjs = (await import('../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url')).default;
      ort.env.wasm.wasmPaths = { mjs, wasm };
      // One thread: multi-threading needs cross-origin isolation headers, which free static hosts can't set.
      ort.env.wasm.numThreads = 1;
      // Run inference in a worker so the page stays responsive while an image is analyzed.
      ort.env.wasm.proxy = true;
      return ort as unknown as OrtLike;
    })();
    ortPromise.catch(() => { ortPromise = null; });
  }
  return ortPromise;
}

async function fetchCached(url: string, onProgress: (loadedBytes: number) => void): Promise<Uint8Array> {
  let cache: Cache | null = null;
  try { if ('caches' in window) cache = await caches.open(CACHE); } catch { cache = null; }
  const hit = cache ? await cache.match(url) : undefined;
  if (hit) { const b = new Uint8Array(await hit.arrayBuffer()); onProgress(b.length); return b; }
  const res = await fetch(url, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}).`);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); loaded += value.length; onProgress(loaded);
  }
  const out = new Uint8Array(loaded);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  if (loaded < 100_000) throw new Error('Downloaded file is too small to be a model.');
  try { if (cache) await cache.put(url, new Response(out, { headers: { 'content-type': 'application/octet-stream' } })); } catch { /* storage full or blocked: still usable this session */ }
  return out;
}

function friendly(e: unknown, fallback: string): string {
  const m = e instanceof Error ? e.message : '';
  return m ? `${fallback} (${m})` : fallback;
}
