import type {
  Annotation, BoxGeom, BoxHandle, Geom, HitResult, ImageEntry, Point2D, Viewport,
} from '../../core/types';
import type { Store } from '../../core/store';
import { newAnnotationId } from '../../core/ids';
import { snapPoint } from '../../core/geometry';
import { getBitmap } from '../../io/images';
import { canvasToImage, fitViewport, imageToCanvas, makeInitialViewport, pan, zoomAt } from './viewport';
import { ALL_BOX_HANDLES, boxHandlePoint, hitTest } from './hittest';

export interface WorkspaceCallbacks {
  onStatus(s: { cursor: Point2D | null; scale: number }): void;
  onNotice(msg: string): void;
}

type Drag =
  | { kind: 'pan'; lastX: number; lastY: number }
  | { kind: 'draw-box'; start: Point2D; annId: string }
  | { kind: 'move'; annId: string; startImg: Point2D; orig: Geom; moved: boolean }
  | { kind: 'vertex'; annId: string; index: number; moved: boolean }
  | { kind: 'edge'; annId: string; a: number; b: number; orig: Point2D[]; startImg: Point2D; moved: boolean }
  | { kind: 'resize'; annId: string; handle: BoxHandle; orig: BoxGeom; moved: boolean };

/**
 * A tool implemented outside the workspace (the optional AI click tool). The
 * workspace only forwards clicks in image pixels and lets it paint an overlay;
 * it knows nothing about models.
 */
export interface ExternalTool {
  onPoint(p: Point2D, negative: boolean): void;
  draw(ctx: CanvasRenderingContext2D, vp: Viewport, dpr: number): void;
}

interface Draft { kind: 'polygon' | 'polyline'; points: Point2D[] }
interface Preview { annId: string; points: Point2D[]; closed: boolean }

const CLOSE_POLYGON_PX = 10;
const MIN_BOX_SCREEN_PX = 3;
const SNAP_PX = 8;

/**
 * The 2D annotation canvas. Owns: viewport, pointer/wheel input, rendering,
 * and the Select / Box / Polygon / Polyline / Keypoint tools. All persistent
 * changes go through the Store (gestures for drags, mutate() for discrete
 * edits) so undo/redo works. Hold Shift to snap; hold Alt and drag a polygon
 * or polyline edge to move that edge.
 */
export class Image2DWorkspace {
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private dpr = window.devicePixelRatio || 1;
  private vp: Viewport = makeInitialViewport();
  private drag: Drag | null = null;
  private hover: HitResult = { kind: 'none' };
  private cursorImg: Point2D | null = null;
  private snapped = false;
  private draft: Draft | null = null;
  private preview: Preview | null = null;
  private spaceDown = false;
  private lastImageId: string | null = null;
  private renderQueued = false;

  constructor(
    private container: HTMLElement,
    private store: Store,
    private cb: WorkspaceCallbacks,
  ) {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas is not supported in this browser.');
    this.ctx = ctx;
    this.canvas.className = 'stage-canvas';
    this.canvas.setAttribute('aria-label', 'Annotation canvas');
    this.canvas.tabIndex = 0;
    container.appendChild(this.canvas);

    new ResizeObserver(() => this.resize()).observe(container);
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerCancel);
    this.canvas.addEventListener('pointerleave', this.onPointerLeave);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('dblclick', this.onDblClick);
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);

    store.subscribe(() => this.onStoreChange());
    this.resize();
  }

  // ---- public API ----

  private external: ExternalTool | null = null;
  setExternalTool(t: ExternalTool | null): void { this.external = t; this.requestRender(); }
  /** Repaint (the external tool changed its overlay). */
  repaint(): void { this.requestRender(); }

  fit(): void {
    const img = this.store.getActiveImage();
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    this.vp = img ? fitViewport(img.width, img.height, w, h) : makeInitialViewport();
    this.emitStatus();
    this.requestRender();
  }

  zoomBy(factor: number): void {
    const c = { x: this.canvas.clientWidth / 2, y: this.canvas.clientHeight / 2 };
    this.vp = zoomAt(this.vp, c, factor);
    this.emitStatus();
    this.requestRender();
  }

  resetZoom(): void {
    const c = { x: this.canvas.clientWidth / 2, y: this.canvas.clientHeight / 2 };
    this.vp = zoomAt(this.vp, c, 1 / this.vp.scale);
    this.emitStatus();
    this.requestRender();
  }

  cancelDraft(): void {
    if (this.draft) { this.draft = null; this.requestRender(); }
  }

  /** Show (or clear, with null) a dashed preview of a simplified outline. */
  setPreview(p: Preview | null): void {
    this.preview = p;
    this.requestRender();
  }

  /** Finish the unfinished polygon/polyline (Enter). */
  finishDraft(): void {
    const img = this.store.getActiveImage();
    const cls = this.store.getUI().activeClassId;
    const d = this.draft;
    if (!img || !d) return;
    const min = d.kind === 'polygon' ? 3 : 2;
    if (d.points.length < min) {
      this.cb.onNotice(d.kind === 'polygon' ? 'A polygon needs at least 3 vertices.' : 'A polyline needs at least 2 points.');
      return;
    }
    if (!cls) { this.cb.onNotice('Create a class before drawing.'); return; }
    const points = d.points.map((p) => ({ ...p }));
    const id = newAnnotationId();
    this.draft = null;
    this.store.mutate((p) => {
      p.images.find((i) => i.id === img.id)?.annotations.push({ id, classId: cls, geom: { kind: d.kind, points } });
    });
    this.store.setUI({ selectedAnnotationId: id });
  }

  /** Delete the hovered vertex of the selected shape if any, else the selected annotation. */
  deleteSelection(): void {
    const sel = this.store.getSelectedAnnotation();
    if (!sel) return;
    if (sel.locked) { this.cb.onNotice('This annotation is locked. Unlock it to delete.'); return; }
    if (this.hover.kind === 'vertex' && this.hover.annId === sel.id) {
      this.deleteVertex(sel.id, this.hover.vertexIndex);
      return;
    }
    this.deleteAnnotation(sel.id);
  }

  deleteAnnotation(annId: string): void {
    const img = this.store.getActiveImage();
    if (!img) return;
    this.store.mutate((p) => {
      const im = p.images.find((i) => i.id === img.id);
      if (im) im.annotations = im.annotations.filter((a) => a.id !== annId);
    });
    if (this.store.getUI().selectedAnnotationId === annId) this.store.setUI({ selectedAnnotationId: null });
  }

  getScale(): number { return this.vp.scale; }

  // ---- store sync ----

  private onStoreChange(): void {
    const ui = this.store.getUI();
    if (ui.activeImageId !== this.lastImageId) {
      this.lastImageId = ui.activeImageId;
      this.draft = null;
      this.drag = null;
      this.preview = null;
      this.fit();
    }
    if (this.draft && ((this.draft.kind === 'polygon' && ui.activeTool !== 'polygon') ||
                       (this.draft.kind === 'polyline' && ui.activeTool !== 'polyline'))) this.draft = null;
    this.requestRender();
  }

  private resize(): void {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.floor(w * this.dpr));
    this.canvas.height = Math.max(1, Math.floor(h * this.dpr));
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    if (this.lastImageId === null && this.store.getActiveImage()) {
      this.lastImageId = this.store.getUI().activeImageId;
      this.fit();
    } else {
      this.requestRender();
    }
  }

  // ---- input helpers ----

  private canvasPoint(e: { clientX: number; clientY: number }): Point2D {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private clampPt(p: Point2D, img: ImageEntry): Point2D {
    return { x: Math.max(0, Math.min(img.width, p.x)), y: Math.max(0, Math.min(img.height, p.y)) };
  }

  /** Clamp, then (when Shift is held) snap to nearby vertices or H/V alignment. */
  private place(p: Point2D, img: ImageEntry, shift: boolean, excludeAnn: string | null, neighbors: Point2D[]): Point2D {
    let q = this.clampPt(p, img);
    this.snapped = false;
    if (shift) {
      const targets: Point2D[] = [];
      for (const a of img.annotations) {
        if (a.hidden || a.id === excludeAnn) continue;
        collectPoints(a.geom, targets);
      }
      const s = snapPoint(q, { targets, neighbors, radius: SNAP_PX / this.vp.scale });
      this.snapped = s.x !== q.x || s.y !== q.y;
      q = this.clampPt(s, img);
    }
    return q;
  }

  private liveEdit(annId: string, fn: (a: Annotation, img: ImageEntry) => void): void {
    const imgId = this.store.getUI().activeImageId;
    this.store.liveMutate((p) => {
      const img = p.images.find((i) => i.id === imgId);
      const a = img?.annotations.find((x) => x.id === annId);
      if (img && a) fn(a, img);
    });
  }

  // ---- pointer input ----

  private onPointerDown = (e: PointerEvent): void => {
    const img = this.store.getActiveImage();
    if (!img) return;
    this.canvas.focus({ preventScroll: true });
    const c = this.canvasPoint(e);

    if (e.button === 1 || (e.button === 0 && this.spaceDown)) {
      this.canvas.setPointerCapture(e.pointerId);
      this.drag = { kind: 'pan', lastX: c.x, lastY: c.y };
      this.updateCursor();
      return;
    }
    if (this.store.getUI().activeTool === 'sam' && this.external && (e.button === 0 || e.button === 2)) {
      if (!getBitmap(img.id)) {
        this.cb.onNotice(`"${img.name}" is not loaded. Add the image file again to edit it.`);
        return;
      }
      this.external.onPoint(canvasToImage(this.vp, c), e.button === 2 || e.shiftKey || e.altKey);
      return;
    }
    if (e.button === 2) {
      if (this.draft) {
        this.draft.points.pop();
        if (this.draft.points.length === 0) this.draft = null;
        this.requestRender();
      }
      return;
    }
    if (e.button !== 0) return;

    if (!getBitmap(img.id)) {
      this.cb.onNotice(`"${img.name}" is not loaded. Add the image file again to edit it.`);
      return;
    }
    this.canvas.setPointerCapture(e.pointerId);
    const p = canvasToImage(this.vp, c);
    const tool = this.store.getUI().activeTool;

    if (tool === 'box') this.beginBox(img, p, e.shiftKey);
    else if (tool === 'polygon' || tool === 'polyline') this.addDraftPoint(img, p, c, tool, e.shiftKey);
    else if (tool === 'keypoint') this.placeKeypoint(img, p, e.shiftKey);
    else this.beginSelectInteraction(img, p, c, e.altKey);
  };

  private beginBox(img: ImageEntry, p: Point2D, shift: boolean): void {
    const cls = this.store.getUI().activeClassId;
    if (!cls) { this.cb.onNotice('Create a class before drawing.'); return; }
    const start = this.place(p, img, shift, null, []);
    const id = newAnnotationId();
    this.store.beginGesture();
    this.store.liveMutate((pr) => {
      pr.images.find((i) => i.id === img.id)?.annotations.push({
        id, classId: cls, geom: { kind: 'box', x: start.x, y: start.y, w: 0, h: 0 },
      });
    });
    this.store.setUI({ selectedAnnotationId: id });
    this.drag = { kind: 'draw-box', start, annId: id };
  }

  private placeKeypoint(img: ImageEntry, p: Point2D, shift: boolean): void {
    const cls = this.store.getUI().activeClassId;
    if (!cls) { this.cb.onNotice('Create a class before drawing.'); return; }
    const q = this.place(p, img, shift, null, []);
    const id = newAnnotationId();
    this.store.mutate((pr) => {
      pr.images.find((i) => i.id === img.id)?.annotations.push({ id, classId: cls, geom: { kind: 'keypoint', x: q.x, y: q.y } });
    });
    this.store.setUI({ selectedAnnotationId: id });
  }

  private addDraftPoint(img: ImageEntry, p: Point2D, canvasPt: Point2D, kind: 'polygon' | 'polyline', shift: boolean): void {
    if (kind === 'polygon' && this.draft && this.draft.points.length >= 3) {
      const first = imageToCanvas(this.vp, this.draft.points[0]);
      if (Math.hypot(first.x - canvasPt.x, first.y - canvasPt.y) <= CLOSE_POLYGON_PX) {
        this.finishDraft();
        return;
      }
    }
    if (!this.draft || this.draft.kind !== kind) this.draft = { kind, points: [] };
    const last = this.draft.points[this.draft.points.length - 1];
    this.draft.points.push(this.place(p, img, shift, null, last ? [last] : []));
    this.requestRender();
  }

  private beginSelectInteraction(img: ImageEntry, p: Point2D, c: Point2D, alt: boolean): void {
    const ui = this.store.getUI();
    const hit = hitTest(img, p, this.vp, ui.selectedAnnotationId);

    if (hit.kind === 'none') {
      this.store.setUI({ selectedAnnotationId: null });
      this.drag = { kind: 'pan', lastX: c.x, lastY: c.y };
      this.updateCursor();
      return;
    }
    this.store.setUI({ selectedAnnotationId: hit.annId });
    const ann = img.annotations.find((a) => a.id === hit.annId);
    if (!ann || ann.locked) return;

    if (hit.kind === 'vertex') {
      this.store.beginGesture();
      this.drag = { kind: 'vertex', annId: ann.id, index: hit.vertexIndex, moved: false };
    } else if (hit.kind === 'edge-midpoint' && (ann.geom.kind === 'polygon' || ann.geom.kind === 'polyline')) {
      this.store.beginGesture();
      if (alt) {
        const n = ann.geom.points.length;
        const a = hit.edgeIndex, b = (hit.edgeIndex + 1) % n;
        this.drag = { kind: 'edge', annId: ann.id, a, b, orig: structuredClone(ann.geom.points), startImg: p, moved: false };
      } else {
        const insertAt = hit.edgeIndex + 1;
        const pt = this.clampPt(hit.at, img);
        this.liveEdit(ann.id, (a) => {
          if (a.geom.kind === 'polygon' || a.geom.kind === 'polyline') a.geom.points.splice(insertAt, 0, pt);
        });
        this.drag = { kind: 'vertex', annId: ann.id, index: insertAt, moved: true };
      }
    } else if (hit.kind === 'box-handle' && ann.geom.kind === 'box') {
      this.store.beginGesture();
      this.drag = { kind: 'resize', annId: ann.id, handle: hit.handle, orig: { ...ann.geom }, moved: false };
    } else {
      this.store.beginGesture();
      this.drag = { kind: 'move', annId: ann.id, startImg: p, orig: structuredClone(ann.geom), moved: false };
    }
    this.updateCursor();
  }

  private onPointerMove = (e: PointerEvent): void => {
    const img = this.store.getActiveImage();
    const c = this.canvasPoint(e);
    if (!img) return;
    const p = canvasToImage(this.vp, c);
    this.cursorImg = p;
    this.emitStatus();
    const d = this.drag;

    if (!d) {
      const tool = this.store.getUI().activeTool;
      this.hover = tool === 'select'
        ? hitTest(img, p, this.vp, this.store.getUI().selectedAnnotationId)
        : { kind: 'none' };
      if (this.draft && e.shiftKey) {
        const last = this.draft.points[this.draft.points.length - 1];
        this.cursorImg = this.place(p, img, true, null, last ? [last] : []);
      } else {
        this.snapped = false;
      }
      this.updateCursor();
      this.requestRender();
      return;
    }

    switch (d.kind) {
      case 'pan':
        this.vp = pan(this.vp, c.x - d.lastX, c.y - d.lastY);
        d.lastX = c.x; d.lastY = c.y;
        this.requestRender();
        break;
      case 'draw-box': {
        const q = this.place(p, img, e.shiftKey, d.annId, []);
        this.liveEdit(d.annId, (a) => {
          a.geom = { kind: 'box', x: d.start.x, y: d.start.y, w: q.x - d.start.x, h: q.y - d.start.y };
        });
        break;
      }
      case 'vertex': {
        d.moved = true;
        const ann = this.findAnn(d.annId);
        const neighbors: Point2D[] = [];
        if (ann && (ann.geom.kind === 'polygon' || ann.geom.kind === 'polyline')) {
          const pts = ann.geom.points, n = pts.length;
          if (ann.geom.kind === 'polygon' || d.index > 0) neighbors.push(pts[(d.index - 1 + n) % n]);
          if (ann.geom.kind === 'polygon' || d.index < n - 1) neighbors.push(pts[(d.index + 1) % n]);
        }
        const q = this.place(p, img, e.shiftKey, d.annId, neighbors);
        this.liveEdit(d.annId, (a) => {
          if ((a.geom.kind === 'polygon' || a.geom.kind === 'polyline') && a.geom.points[d.index]) a.geom.points[d.index] = q;
        });
        break;
      }
      case 'edge': {
        const dx0 = p.x - d.startImg.x, dy0 = p.y - d.startImg.y;
        if (!d.moved && Math.hypot(dx0, dy0) * this.vp.scale < 2) break;
        d.moved = true;
        const pa = d.orig[d.a], pb = d.orig[d.b];
        const dx = Math.max(-Math.min(pa.x, pb.x), Math.min(img.width - Math.max(pa.x, pb.x), dx0));
        const dy = Math.max(-Math.min(pa.y, pb.y), Math.min(img.height - Math.max(pa.y, pb.y), dy0));
        this.liveEdit(d.annId, (a) => {
          if (a.geom.kind !== 'polygon' && a.geom.kind !== 'polyline') return;
          a.geom.points[d.a] = { x: pa.x + dx, y: pa.y + dy };
          a.geom.points[d.b] = { x: pb.x + dx, y: pb.y + dy };
        });
        break;
      }
      case 'resize': {
        d.moved = true;
        const q = this.place(p, img, e.shiftKey, d.annId, []);
        this.liveEdit(d.annId, (a) => { a.geom = resizeBox(d.orig, d.handle, q); });
        break;
      }
      case 'move': {
        const dx0 = p.x - d.startImg.x, dy0 = p.y - d.startImg.y;
        if (!d.moved && Math.hypot(dx0, dy0) * this.vp.scale < 2) break;
        d.moved = true;
        const b = geomBounds(d.orig);
        const dx = Math.max(-b.minX, Math.min(img.width - b.maxX, dx0));
        const dy = Math.max(-b.minY, Math.min(img.height - b.maxY, dy0));
        this.liveEdit(d.annId, (a) => { a.geom = translateGeom(d.orig, dx, dy); });
        break;
      }
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    this.finishDrag(false);
  };

  private onPointerCancel = (e: PointerEvent): void => {
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    this.finishDrag(true);
  };

  private onPointerLeave = (): void => {
    this.cursorImg = null;
    this.hover = { kind: 'none' };
    this.emitStatus();
    this.requestRender();
  };

  private finishDrag(cancel: boolean): void {
    const d = this.drag;
    this.drag = null;
    this.snapped = false;
    if (!d) return;
    if (d.kind === 'pan') { this.updateCursor(); return; }

    if (d.kind === 'draw-box') {
      const ann = this.findAnn(d.annId);
      const tooSmall = !ann || ann.geom.kind !== 'box' ||
        Math.abs(ann.geom.w) * this.vp.scale < MIN_BOX_SCREEN_PX ||
        Math.abs(ann.geom.h) * this.vp.scale < MIN_BOX_SCREEN_PX;
      if (cancel || tooSmall) {
        this.store.endGesture(false);
      } else {
        this.liveEdit(d.annId, (a) => {
          if (a.geom.kind === 'box') a.geom = normalizeBox(a.geom);
        });
        this.store.endGesture(true);
      }
    } else {
      this.store.endGesture(!cancel && d.moved);
    }
    this.updateCursor();
  }

  private onDblClick = (e: MouseEvent): void => {
    const img = this.store.getActiveImage();
    if (!img) return;
    const tool = this.store.getUI().activeTool;
    if ((tool === 'polygon' || tool === 'polyline') && this.draft) {
      // The two clicks of the double-click each added a point at the same spot.
      this.draft.points.pop();
      const min = this.draft.kind === 'polygon' ? 3 : 2;
      if (this.draft.points.length >= min) this.finishDraft();
      else this.requestRender();
      return;
    }
    if (tool === 'select') {
      const p = canvasToImage(this.vp, this.canvasPoint(e));
      const hit = hitTest(img, p, this.vp, this.store.getUI().selectedAnnotationId);
      if (hit.kind === 'vertex') this.deleteVertex(hit.annId, hit.vertexIndex);
    }
  };

  private deleteVertex(annId: string, index: number): void {
    const ann = this.findAnn(annId);
    if (!ann || (ann.geom.kind !== 'polygon' && ann.geom.kind !== 'polyline')) return;
    const min = ann.geom.kind === 'polygon' ? 3 : 2;
    if (ann.geom.points.length <= min) {
      this.cb.onNotice(`A ${ann.geom.kind} needs at least ${min} ${ann.geom.kind === 'polygon' ? 'vertices' : 'points'}. Delete the annotation instead.`);
      return;
    }
    const imgId = this.store.getUI().activeImageId;
    this.store.mutate((p) => {
      const a = p.images.find((i) => i.id === imgId)?.annotations.find((x) => x.id === annId);
      if (a && (a.geom.kind === 'polygon' || a.geom.kind === 'polyline')) a.geom.points.splice(index, 1);
    });
    this.hover = { kind: 'none' };
  }

  private onWheel = (e: WheelEvent): void => {
    if (!this.store.getActiveImage()) return;
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
    this.vp = zoomAt(this.vp, this.canvasPoint(e), factor);
    this.emitStatus();
    this.requestRender();
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'Space' && !isTypingTarget(e.target)) {
      this.spaceDown = true;
      this.updateCursor();
      if (e.target === document.body || e.target === this.canvas) e.preventDefault();
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === 'Space') { this.spaceDown = false; this.updateCursor(); }
    // Releasing Alt on Windows would otherwise focus the browser menu bar.
    if (e.key === 'Alt' && this.drag) e.preventDefault();
  };

  private findAnn(annId: string): Annotation | null {
    return this.store.getActiveImage()?.annotations.find((a) => a.id === annId) ?? null;
  }

  private updateCursor(): void {
    let cur = 'default';
    const tool = this.store.getUI().activeTool;
    if (this.drag?.kind === 'pan') cur = 'grabbing';
    else if (this.spaceDown) cur = 'grab';
    else if (tool !== 'select') cur = 'crosshair';
    else {
      const h = this.hover;
      if (h.kind === 'vertex') cur = 'pointer';
      else if (h.kind === 'edge-midpoint') cur = 'copy';
      else if (h.kind === 'annotation') cur = 'move';
      else if (h.kind === 'box-handle') cur = handleCursor(h.handle);
    }
    this.canvas.style.cursor = cur;
  }

  private emitStatus(): void {
    this.cb.onStatus({ cursor: this.cursorImg, scale: this.vp.scale });
  }

  // ---- rendering ----

  private requestRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => { this.renderQueued = false; this.draw(); });
  }

  private draw(): void {
    const { ctx, dpr, canvas } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const img = this.store.getActiveImage();
    if (!img) return;
    const vp = this.vp;

    const bm = getBitmap(img.id);
    ctx.save();
    ctx.translate(vp.tx, vp.ty);
    ctx.scale(vp.scale, vp.scale);
    if (bm) {
      ctx.imageSmoothingEnabled = vp.scale < 3;
      ctx.drawImage(bm, 0, 0);
    } else {
      ctx.fillStyle = '#6b7078';
      ctx.fillRect(0, 0, img.width, img.height);
    }
    ctx.restore();
    if (!bm) {
      ctx.fillStyle = '#ffffff';
      ctx.font = '14px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`"${img.name}" is not loaded - add the file again to relink it`,
        vp.tx + (img.width * vp.scale) / 2, vp.ty + (img.height * vp.scale) / 2);
      ctx.textAlign = 'start';
    }

    const selId = this.store.getUI().selectedAnnotationId;
    for (const a of img.annotations) {
      if (a.hidden) continue;
      this.drawAnnotation(a, a.id === selId);
    }
    if (this.preview) this.drawPreview(this.preview);
    if (this.draft) this.drawDraft(this.draft);
    if (this.external && this.store.getUI().activeTool === 'sam') this.external.draw(ctx, vp, dpr);
  }

  private drawAnnotation(a: Annotation, selected: boolean): void {
    const { ctx, vp } = this;
    const cls = this.store.getClassById(a.classId);
    const color = cls?.color ?? '#ff00ff';
    ctx.save();
    ctx.lineWidth = selected ? 2.5 : 2;
    ctx.strokeStyle = color;
    ctx.fillStyle = hexA(color, selected ? 0.3 : 0.16);
    if (a.locked) ctx.setLineDash([6, 4]);
    const g = a.geom;

    if (g.kind === 'box') {
      const b = normalizeBox(g);
      const p1 = imageToCanvas(vp, { x: b.x, y: b.y });
      const w = b.w * vp.scale, h = b.h * vp.scale;
      ctx.fillRect(p1.x, p1.y, w, h);
      ctx.strokeRect(p1.x, p1.y, w, h);
      ctx.setLineDash([]);
      if (selected && !a.locked) {
        for (const handle of ALL_BOX_HANDLES) {
          const hp = imageToCanvas(vp, boxHandlePoint(b, handle));
          const active = this.hover.kind === 'box-handle' && this.hover.annId === a.id && this.hover.handle === handle;
          drawSquare(ctx, hp, active ? 10 : 7, color);
        }
      }
    } else if (g.kind === 'keypoint') {
      const c = imageToCanvas(vp, { x: g.x, y: g.y });
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(c.x, c.y, selected ? 7 : 6, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
    } else {
      const closed = g.kind === 'polygon';
      const pts = g.points.map((p) => imageToCanvas(vp, p));
      ctx.beginPath();
      pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      if (closed) { ctx.closePath(); ctx.fill(); }
      ctx.stroke();
      ctx.setLineDash([]);
      if (selected && !a.locked) {
        pts.forEach((p, i) => {
          const active = this.hover.kind === 'vertex' && this.hover.annId === a.id && this.hover.vertexIndex === i;
          drawSquare(ctx, p, active ? 11 : 7, color);
        });
        if (this.hover.kind === 'edge-midpoint' && this.hover.annId === a.id) {
          const at = imageToCanvas(vp, this.hover.at);
          ctx.beginPath();
          ctx.arc(at.x, at.y, 5, 0, Math.PI * 2);
          ctx.fillStyle = '#ffffff';
          ctx.fill();
          ctx.lineWidth = 2;
          ctx.strokeStyle = color;
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  private drawPreview(pv: Preview): void {
    const { ctx, vp } = this;
    const pts = pv.points.map((p) => imageToCanvas(vp, p));
    if (pts.length < 2) return;
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ffffff';
    ctx.setLineDash([7, 5]);
    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    if (pv.closed) ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    for (const p of pts) drawSquare(ctx, p, 5, '#000000');
    ctx.restore();
  }

  private drawDraft(draft: Draft): void {
    const { ctx, vp } = this;
    if (draft.points.length === 0) return;
    const cls = this.store.getActiveClass();
    const color = cls?.color ?? '#E58A3C';
    const pts = draft.points.map((p) => imageToCanvas(vp, p));
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    if (this.cursorImg) {
      const cur = imageToCanvas(vp, this.cursorImg);
      ctx.setLineDash([5, 4]);
      ctx.lineTo(cur.x, cur.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    pts.forEach((p, i) => drawSquare(ctx, p, i === 0 && draft.kind === 'polygon' && pts.length >= 3 ? 10 : 6, color));
    if (this.snapped && this.cursorImg) {
      const cur = imageToCanvas(vp, this.cursorImg);
      ctx.beginPath();
      ctx.arc(cur.x, cur.y, 7, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
    }
    ctx.restore();
  }
}

// ---- geometry helpers ----

function collectPoints(g: Geom, out: Point2D[]): void {
  if (g.kind === 'box') {
    const b = normalizeBox(g);
    out.push({ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h });
  } else if (g.kind === 'keypoint') {
    out.push({ x: g.x, y: g.y });
  } else {
    out.push(...g.points);
  }
}

function normalizeBox(b: BoxGeom): BoxGeom {
  return { kind: 'box', x: Math.min(b.x, b.x + b.w), y: Math.min(b.y, b.y + b.h), w: Math.abs(b.w), h: Math.abs(b.h) };
}

function resizeBox(orig: BoxGeom, handle: BoxHandle, q: Point2D): BoxGeom {
  const o = normalizeBox(orig);
  let x1 = o.x, y1 = o.y, x2 = o.x + o.w, y2 = o.y + o.h;
  if (handle.includes('w')) x1 = q.x;
  if (handle.includes('e')) x2 = q.x;
  if (handle.includes('n')) y1 = q.y;
  if (handle.includes('s')) y2 = q.y;
  return { kind: 'box', x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

function geomBounds(g: Geom): { minX: number; minY: number; maxX: number; maxY: number } {
  if (g.kind === 'box') {
    const b = normalizeBox(g);
    return { minX: b.x, minY: b.y, maxX: b.x + b.w, maxY: b.y + b.h };
  }
  if (g.kind === 'keypoint') return { minX: g.x, minY: g.y, maxX: g.x, maxY: g.y };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of g.points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

function translateGeom(g: Geom, dx: number, dy: number): Geom {
  if (g.kind === 'box') return { kind: 'box', x: g.x + dx, y: g.y + dy, w: g.w, h: g.h };
  if (g.kind === 'keypoint') return { kind: 'keypoint', x: g.x + dx, y: g.y + dy };
  return { kind: g.kind, points: g.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
}

function handleCursor(h: BoxHandle): string {
  switch (h) {
    case 'n': case 's': return 'ns-resize';
    case 'e': case 'w': return 'ew-resize';
    case 'nw': case 'se': return 'nwse-resize';
    default: return 'nesw-resize';
  }
}

function drawSquare(ctx: CanvasRenderingContext2D, c: Point2D, size: number, color: string): void {
  const h = size / 2;
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.fillRect(c.x - h, c.y - h, size, size);
  ctx.strokeRect(c.x - h, c.y - h, size, size);
}

function hexA(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable;
}
