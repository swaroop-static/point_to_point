import type { Point2D, Viewport } from '../core/types';
import type { Store } from '../core/store';
import { newAnnotationId } from '../core/ids';
import { getBitmap } from '../io/images';
import type { ExternalTool } from '../workspaces/image2d/workspace';
import type { AiController } from './runtime';
import type { PromptPoint } from './sam';

export interface SamToolHooks {
  repaint(): void;
  notice(msg: string): void;
  /** Pending-click state changed (for enabling buttons). */
  changed(): void;
}

/**
 * Click-to-segment interaction. Left click adds an "include" point, right
 * click (or Shift/Alt+click) an "exclude" point. Each click re-runs the fast
 * decoder; the user then accepts (Enter) or discards (Esc). Accepting adds an
 * ordinary polygon annotation that can be edited like any other.
 */
export class SamClickTool implements ExternalTool {
  points: PromptPoint[] = [];
  polygon: Point2D[] = [];
  private maskCanvas: HTMLCanvasElement | null = null;
  private imageId: string | null = null;
  private running = false;
  private queued = false;

  constructor(private store: Store, private ai: AiController, private hooks: SamToolHooks) {}

  get hasPending(): boolean { return this.points.length > 0; }
  get busy(): boolean { return this.running; }

  onPoint(p: Point2D, negative: boolean): void {
    const img = this.store.getActiveImage();
    if (!img) return;
    if (!this.ai.ready) { this.hooks.notice('Enable an AI model first (AI assist, right panel). Manual tools work without it.'); return; }
    if (this.imageId !== img.id) this.clear();
    this.imageId = img.id;
    if (p.x < 0 || p.y < 0 || p.x >= img.width || p.y >= img.height) return;
    this.points.push({ x: p.x, y: p.y, positive: !negative });
    this.hooks.changed();
    void this.run();
  }

  undoLast(): void {
    if (!this.points.length) return;
    this.points.pop();
    this.hooks.changed();
    if (this.points.length) void this.run(); else this.clearResult();
  }

  clear(): void {
    this.points = [];
    this.clearResult();
    this.hooks.changed();
  }

  private clearResult(): void {
    this.polygon = []; this.maskCanvas = null;
    this.hooks.repaint();
  }

  private async run(): Promise<void> {
    if (this.running) { this.queued = true; return; }
    const img = this.store.getActiveImage();
    const bm = img ? getBitmap(img.id) : null;
    if (!img || !bm) return;
    this.running = true;
    this.hooks.changed();
    try {
      do {
        this.queued = false;
        const pts = this.points.slice();
        if (!pts.length) break;
        const { result, polygon } = await this.ai.segment(img.id, bm, img.width, img.height, pts);
        if (this.imageId !== img.id) return; // user switched image meanwhile
        this.polygon = polygon;
        this.maskCanvas = this.paint(result.mask, result.width, result.height);
        if (!polygon.length) this.hooks.notice('No object found there. Try another click, or add an exclude point (right-click).');
        this.hooks.repaint();
      } while (this.queued);
    } catch (e) {
      this.hooks.notice(e instanceof Error ? e.message : 'Segmentation failed.');
    } finally {
      this.running = false;
      this.hooks.changed();
    }
  }

  private paint(mask: Uint8Array, w: number, h: number): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d')!;
    const id = g.createImageData(w, h);
    const color = this.store.getActiveClass()?.color ?? '#E58A3C';
    const n = parseInt(color.slice(1), 16);
    const r = (n >> 16) & 255, gr = (n >> 8) & 255, b = n & 255;
    for (let i = 0; i < mask.length; i++) {
      if (mask[i]) { const o = i * 4; id.data[o] = r; id.data[o + 1] = gr; id.data[o + 2] = b; id.data[o + 3] = 110; }
    }
    g.putImageData(id, 0, 0);
    return c;
  }

  /** Add the previewed polygon as a normal annotation. */
  accept(): void {
    const img = this.store.getActiveImage();
    const cls = this.store.getUI().activeClassId;
    if (!img || this.polygon.length < 3) { this.hooks.notice('Nothing to accept yet. Click on an object first.'); return; }
    if (!cls) { this.hooks.notice('Create a class before accepting.'); return; }
    const id = newAnnotationId();
    const pts = this.polygon.map((p) => ({ x: p.x, y: p.y }));
    this.store.mutate((pr) => {
      pr.images.find((i) => i.id === img.id)?.annotations.push({ id, classId: cls, geom: { kind: 'polygon', points: pts } });
    });
    this.store.setUI({ selectedAnnotationId: id });
    this.hooks.notice(`Polygon added (${pts.length} vertices). Switch to Select (V) to refine it. Ctrl+Z undoes.`);
    this.clear();
  }

  draw(ctx: CanvasRenderingContext2D, vp: Viewport): void {
    ctx.save();
    if (this.maskCanvas) {
      ctx.translate(vp.tx, vp.ty);
      ctx.scale(vp.scale, vp.scale);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.maskCanvas, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    ctx.restore();
    ctx.save();
    // The workspace already applied the device-pixel-ratio transform; undo our own transform changes above by redoing the point math in canvas space.
    if (this.polygon.length >= 3) {
      ctx.beginPath();
      this.polygon.forEach((p, i) => {
        const x = p.x * vp.scale + vp.tx, y = p.y * vp.scale + vp.ty;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      });
      ctx.closePath();
      ctx.lineWidth = 3; ctx.strokeStyle = '#ffffff'; ctx.stroke();
      ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]); ctx.strokeStyle = '#111111'; ctx.stroke();
      ctx.setLineDash([]);
    }
    for (const pt of this.points) {
      const x = pt.x * vp.scale + vp.tx, y = pt.y * vp.scale + vp.ty;
      ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fillStyle = pt.positive ? '#2ecc71' : '#e74c3c'; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = '#ffffff'; ctx.stroke();
    }
    ctx.restore();
  }
}
