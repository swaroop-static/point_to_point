import type { CameraModel, ImageEntry, PhotoCuboid, Point2D, Viewport } from '../core/types';
import {
  CUBOID_EDGES, CUBOID_FACES, cameraFromHorizontalFov, convexHull, defaultCuboidAt, horizontalFovDeg,
  project, projectCuboid, projectedCenter, visibleEdges, visibleFaces, withCenterAtPixel, withDepth, wrapAngle,
} from '../core/cuboid';
import { newAnnotationId } from '../core/ids';
import { addImageFiles } from '../io/imageImport';
import { getBitmap } from '../io/images';
import { downloadPhotoCuboids } from '../io/photoCuboids';
import { pickFiles } from '../io/download';
import { canvasToImage, fitViewport, imageToCanvas, makeInitialViewport, pan, zoomAt } from '../workspaces/image2d/viewport';
import { isTypingTarget } from '../workspaces/image2d/workspace';
import { clear, h } from '../ui/dom';
import type { ExportItem, ModeContext, ModeController } from '../ui/mode';

type Tool = 'select' | 'add';
const ROT_STEP = (5 * Math.PI) / 180;
const DEFAULT_HFOV = 60;

/**
 * Cuboids on ordinary photographs. A single photo does not determine metric
 * depth: unless the user declares a real calibration, every size and distance
 * here is relative and the camera is only an assumed field of view.
 */
export class ModePhoto3D implements ModeController {
  readonly id = 'photo3d' as const;
  readonly label = '3D photo';
  readonly toolbar: HTMLElement;
  readonly stage: HTMLElement;
  readonly rightPanel: HTMLElement;
  readonly leftPanel = null;

  private canvas = document.createElement('canvas');
  private g: CanvasRenderingContext2D;
  private dpr = window.devicePixelRatio || 1;
  private vp: Viewport = makeInitialViewport();
  private tool: Tool = 'select';
  private toolBtns = new Map<Tool, HTMLButtonElement>();
  private empty: HTMLElement;
  private list: HTMLElement;
  private props: HTMLElement;
  private sig = '';
  private fitFor: string | null = null;
  private drawQueued = false;
  private drag:
    | { kind: 'pan'; last: Point2D }
    | { kind: 'move'; id: string; off: Point2D; moved: boolean }
    | null = null;
  private spaceDown = false;

  constructor(private ctx: ModeContext) {
    const g = this.canvas.getContext('2d');
    if (!g) throw new Error('2D canvas is not supported in this browser.');
    this.g = g;

    const mk = (t: Tool, label: string, key: string) => {
      const b = h('button', { class: 'btn tool', type: 'button', title: `${label} (${key})`, onclick: () => this.setTool(t) }, label);
      this.toolBtns.set(t, b);
      return b;
    };
    const zoom = h('div', { class: 'btn-group' },
      h('button', { class: 'btn', type: 'button', title: 'Zoom out (-)', 'aria-label': 'Zoom out', onclick: () => this.zoomBy(0.8) }, '−'),
      h('button', { class: 'btn', type: 'button', title: 'Zoom in (+)', 'aria-label': 'Zoom in', onclick: () => this.zoomBy(1.25) }, '+'),
      h('button', { class: 'btn', type: 'button', title: 'Fit image to screen (F)', onclick: () => this.fit() }, 'Fit'),
    );
    this.toolbar = h('div', { class: 'mode-toolbar' },
      h('div', { class: 'btn-group', role: 'group', 'aria-label': 'Tools' }, mk('select', 'Select', 'V'), mk('add', 'Add cuboid', 'C')),
      zoom);

    this.empty = h('div', { class: 'empty' },
      h('h1', {}, 'Drop a photo to place 3D cuboids'),
      h('p', {}, 'JPEG, PNG or WebP. Files stay on your computer; nothing is uploaded.'),
      h('button', { class: 'btn primary', type: 'button', onclick: () => void this.pick() }, 'Choose images'),
    );
    this.canvas.className = 'stage-canvas';
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('aria-label', '3D photo canvas');
    this.stage = h('div', { class: 'stage' }, this.canvas, this.empty);

    this.list = h('div', { class: 'list', role: 'list' });
    this.props = h('div', { class: 'props' });
    this.rightPanel = h('div', {},
      h('div', { class: 'panel-head' }, h('h2', {}, 'Cuboids')),
      this.list,
      this.props,
    );

    new ResizeObserver(() => this.resize()).observe(this.stage);
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    c.addEventListener('pointermove', (e) => this.onMove(e));
    c.addEventListener('pointerup', (e) => this.onUp(e, true));
    c.addEventListener('pointercancel', (e) => this.onUp(e, false));
    c.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keyup', (e) => { if (e.key === ' ') this.spaceDown = false; });
  }

  // ---------------------------------------------------------------- mode API

  activate(): void { this.fitFor = null; this.resize(); this.render(); }
  deactivate(): void { this.drag = null; }
  onClassSelected(classId: string): void {
    const c = this.selected();
    if (c && !c.locked && c.classId !== classId) this.patch(c.id, { classId });
  }
  async handleFiles(files: File[]): Promise<void> { await addImageFiles(this.ctx.store, files, (m) => this.ctx.toast(m)); }
  private async pick(): Promise<void> {
    const files = await pickFiles('image/jpeg,image/png,image/webp', true);
    if (files.length) await this.handleFiles(files);
  }

  exportItems(): ExportItem[] {
    return [{
      label: 'Photo cuboids JSON',
      run: () => {
        const proj = this.ctx.store.getProject();
        if (!proj.images.some((i) => i.cuboids?.length)) { this.ctx.toast('No cuboids to export yet.'); return; }
        const { count, warnings } = downloadPhotoCuboids(proj);
        this.ctx.toast(`Exported ${count} cuboid${count === 1 ? '' : 's'}.`);
        for (const w of warnings.slice(0, 3)) this.ctx.toast(`Export note: ${w}`);
      },
    }];
  }

  statusLeft(): string {
    const img = this.ctx.store.getActiveImage();
    return img ? `${img.name} · ${img.width}×${img.height}px` : 'No image';
  }
  statusCount(): string {
    const img = this.ctx.store.getActiveImage();
    const total = this.ctx.store.getProject().images.reduce((n, i) => n + (i.cuboids?.length ?? 0), 0);
    return img ? `${img.cuboids?.length ?? 0} cuboids on this image · ${total} total` : `${total} total`;
  }

  // ---------------------------------------------------------------- helpers

  private img(): ImageEntry | null { return this.ctx.store.getActiveImage(); }
  private cuboids(): PhotoCuboid[] { return this.img()?.cuboids ?? []; }
  private selected(): PhotoCuboid | null {
    const id = this.ctx.store.getUI().selectedAnnotationId;
    return id ? this.cuboids().find((c) => c.id === id) ?? null : null;
  }
  private camera(img: ImageEntry): CameraModel { return img.camera ?? cameraFromHorizontalFov(img.width, img.height, DEFAULT_HFOV); }

  private setTool(t: Tool): void { this.tool = t; this.render(); }

  private patch(id: string, p: Partial<PhotoCuboid>): void {
    const imgId = this.ctx.store.getUI().activeImageId;
    this.ctx.store.mutate((proj) => {
      const c = proj.images.find((i) => i.id === imgId)?.cuboids?.find((x) => x.id === id);
      if (c) Object.assign(c, p);
    });
  }

  /** Replace a cuboid's geometry through a pure function of (camera, cuboid). */
  private edit(fn: (cam: CameraModel, c: PhotoCuboid) => PhotoCuboid): void {
    const img = this.img(), sel = this.selected();
    if (!img || !sel || sel.locked) return;
    const cam = this.camera(img);
    const next = fn(cam, sel);
    this.ctx.store.mutate((proj) => {
      const list = proj.images.find((i) => i.id === img.id)?.cuboids;
      const i = list?.findIndex((x) => x.id === sel.id) ?? -1;
      if (list && i >= 0) list[i] = next;
    });
  }

  private addAt(img: ImageEntry, p: Point2D): void {
    const cls = this.ctx.store.getActiveClass() ?? this.ctx.store.getProject().classes[0];
    if (!cls) { this.ctx.toast('Add a class first.'); return; }
    const cam = this.camera(img);
    const objectId = (img.cuboids ?? []).reduce((m, c) => Math.max(m, c.objectId), 0) + 1;
    const id = newAnnotationId();
    const cub = defaultCuboidAt(cam, img.height, p.x, p.y, { id, objectId, classId: cls.id });
    this.ctx.store.mutate((proj) => {
      const t = proj.images.find((i) => i.id === img.id);
      if (!t) return false;
      if (!t.camera) t.camera = cam;
      (t.cuboids ??= []).push(cub);
    });
    this.ctx.store.setUI({ selectedAnnotationId: id });
    this.tool = 'select';
    this.render();
  }

  private deleteSelected(): void {
    const img = this.img(), sel = this.selected();
    if (!img || !sel) return;
    if (sel.locked) { this.ctx.toast('This cuboid is locked. Unlock it to delete.'); return; }
    this.ctx.store.mutate((p) => {
      const t = p.images.find((i) => i.id === img.id);
      if (t?.cuboids) t.cuboids = t.cuboids.filter((c) => c.id !== sel.id);
    });
    this.ctx.store.setUI({ selectedAnnotationId: null });
  }

  // ---------------------------------------------------------------- viewport

  private resize(): void {
    const w = this.stage.clientWidth, hgt = this.stage.clientHeight;
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.floor(w * this.dpr));
    this.canvas.height = Math.max(1, Math.floor(hgt * this.dpr));
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${hgt}px`;
    if (this.fitFor === null) this.fit(); else this.queueDraw();
  }

  private fit(): void {
    const img = this.img();
    if (!img) { this.queueDraw(); return; }
    this.vp = fitViewport(img.width, img.height, this.canvas.clientWidth, this.canvas.clientHeight);
    this.fitFor = img.id;
    this.emitStatus(null);
    this.queueDraw();
  }

  private zoomBy(f: number): void {
    this.vp = zoomAt(this.vp, { x: this.canvas.clientWidth / 2, y: this.canvas.clientHeight / 2 }, f);
    this.emitStatus(null);
    this.queueDraw();
  }

  private emitStatus(cursor: Point2D | null): void {
    this.ctx.setCursorText(cursor ? `x ${Math.round(cursor.x)}, y ${Math.round(cursor.y)}` : '');
    this.ctx.setZoomText(`${Math.round(this.vp.scale * 100)}%`);
  }

  private pt(e: { clientX: number; clientY: number }): Point2D {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // ---------------------------------------------------------------- input

  private hit(img: ImageEntry, p: Point2D): PhotoCuboid | null {
    const cam = this.camera(img);
    const list = img.cuboids ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i];
      if (c.hidden) continue;
      const pts = projectCuboid(cam, c);
      if (pts.some((q) => q === null)) continue;
      if (pointInConvex(convexHull(pts as Point2D[]), p)) return c;
    }
    return null;
  }

  private onDown(e: PointerEvent): void {
    this.canvas.focus({ preventScroll: true });
    const img = this.img();
    if (!img) return;
    const cp = this.pt(e);
    this.canvas.setPointerCapture(e.pointerId);
    if (e.button === 1 || e.button === 2 || this.spaceDown) { this.drag = { kind: 'pan', last: cp }; return; }
    if (e.button !== 0) return;
    const ip = canvasToImage(this.vp, cp);
    if (this.tool === 'add') { this.addAt(img, ip); return; }
    const c = this.hit(img, ip);
    this.ctx.store.setUI({ selectedAnnotationId: c ? c.id : null });
    if (!c) { this.drag = { kind: 'pan', last: cp }; return; }
    if (c.locked) return;
    const center = projectedCenter(this.camera(img), c);
    if (!center) return;
    this.ctx.store.beginGesture();
    this.drag = { kind: 'move', id: c.id, off: { x: ip.x - center.x, y: ip.y - center.y }, moved: false };
  }

  private onMove(e: PointerEvent): void {
    const cp = this.pt(e);
    const img = this.img();
    this.emitStatus(img ? canvasToImage(this.vp, cp) : null);
    const d = this.drag;
    if (!d || !img) { this.canvas.style.cursor = this.tool === 'add' ? 'crosshair' : 'default'; return; }
    if (d.kind === 'pan') {
      this.vp = pan(this.vp, cp.x - d.last.x, cp.y - d.last.y);
      d.last = cp;
      this.queueDraw();
      return;
    }
    const ip = canvasToImage(this.vp, cp);
    const cam = this.camera(img);
    d.moved = true;
    this.ctx.store.liveMutate((p) => {
      const list = p.images.find((i) => i.id === img.id)?.cuboids;
      const i = list?.findIndex((x) => x.id === d.id) ?? -1;
      if (list && i >= 0) list[i] = withCenterAtPixel(cam, list[i], ip.x - d.off.x, ip.y - d.off.y);
    });
  }

  private onUp(e: PointerEvent, commit: boolean): void {
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    const d = this.drag;
    this.drag = null;
    if (d?.kind === 'move') this.ctx.store.endGesture(commit && d.moved);
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    if (!this.img()) return;
    this.vp = zoomAt(this.vp, this.pt(e), e.deltaY < 0 ? 1.1 : 1 / 1.1);
    this.emitStatus(null);
    this.queueDraw();
  }

  handleKey(e: KeyboardEvent): boolean {
    if (isTypingTarget(e.target)) return false;
    const sel = this.selected();
    switch (e.key) {
      case ' ': this.spaceDown = true; e.preventDefault(); return true;
      case 'v': case 'V': this.setTool('select'); return true;
      case 'c': case 'C': this.setTool('add'); return true;
      case 'f': case 'F': this.fit(); return true;
      case '+': case '=': this.zoomBy(1.25); return true;
      case '-': case '_': this.zoomBy(0.8); return true;
      case 'q': case 'Q': this.edit((_, c) => ({ ...c, rotationY: wrapAngle(c.rotationY - ROT_STEP) })); return true;
      case 'e': case 'E': this.edit((_, c) => ({ ...c, rotationY: wrapAngle(c.rotationY + ROT_STEP) })); return true;
      case 'w': case 'W': this.edit((cam, c) => withDepth(cam, c, c.center.z / 1.05)); return true;
      case 's': case 'S': this.edit((cam, c) => withDepth(cam, c, c.center.z * 1.05)); return true;
      case 'h': case 'H': if (sel) this.patch(sel.id, { hidden: !sel.hidden }); return true;
      case 'l': case 'L': if (sel) this.patch(sel.id, { locked: !sel.locked }); return true;
      case 'Escape': this.tool = 'select'; this.ctx.store.setUI({ selectedAnnotationId: null }); this.render(); return true;
      case 'Delete': case 'Backspace': e.preventDefault(); this.deleteSelected(); return true;
      default: return false;
    }
  }

  // ---------------------------------------------------------------- drawing

  private queueDraw(): void {
    if (this.drawQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => { this.drawQueued = false; this.draw(); });
  }

  private draw(): void {
    const { g, dpr, canvas } = this;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);
    const img = this.img();
    if (!img) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const o = imageToCanvas(this.vp, { x: 0, y: 0 });
    const bm = getBitmap(img.id);
    if (bm) {
      g.imageSmoothingEnabled = this.vp.scale < 3;
      g.drawImage(bm, o.x, o.y, img.width * this.vp.scale, img.height * this.vp.scale);
    } else {
      g.fillStyle = '#2a2d33';
      g.fillRect(o.x, o.y, img.width * this.vp.scale, img.height * this.vp.scale);
      g.fillStyle = '#9aa0aa';
      g.font = '14px system-ui, sans-serif';
      g.fillText('Image file not loaded. Add it again to relink by file name.', o.x + 16, o.y + 28);
    }
    const cam = this.camera(img);
    const classes = this.ctx.store.getProject().classes;
    const selId = this.ctx.store.getUI().selectedAnnotationId;
    for (const c of img.cuboids ?? []) {
      if (c.hidden) continue;
      const color = classes.find((k) => k.id === c.classId)?.color ?? '#ff00ff';
      this.drawCuboid(cam, c, color, c.id === selId);
    }
  }

  private drawCuboid(cam: CameraModel, c: PhotoCuboid, color: string, selected: boolean): void {
    const { g } = this;
    const pts = projectCuboid(cam, c).map((p) => (p ? imageToCanvas(this.vp, p) : null));
    const vis = visibleFaces(c);
    const visE = visibleEdges(c);
    g.save();
    g.globalAlpha = c.locked ? 0.55 : 1;
    g.lineJoin = 'round';
    g.fillStyle = hexA(color, selected ? 0.28 : 0.16);
    CUBOID_FACES.forEach((f, i) => {
      if (!vis[i]) return;
      const q = f.corners.map((k) => pts[k]);
      if (q.some((p) => !p)) return;
      g.beginPath();
      q.forEach((p, j) => (j ? g.lineTo(p!.x, p!.y) : g.moveTo(p!.x, p!.y)));
      g.closePath();
      g.fill();
    });
    g.strokeStyle = color;
    g.lineWidth = selected ? 2.5 : 1.75;
    CUBOID_EDGES.forEach(([a, b], i) => {
      const p = pts[a], q = pts[b];
      if (!p || !q) return;
      g.setLineDash(visE[i] ? [] : [5, 4]);
      g.globalAlpha = (c.locked ? 0.55 : 1) * (visE[i] ? 1 : 0.55);
      g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(q.x, q.y); g.stroke();
    });
    g.setLineDash([]);
    g.globalAlpha = 1;
    // Front-face marker so orientation is readable.
    const ctr = project(cam, c.center);
    const front = CUBOID_FACES[0].corners.map((k) => pts[k]);
    if (ctr && front.every((p) => p)) {
      const f = front as Point2D[];
      const mid = { x: (f[0].x + f[1].x + f[2].x + f[3].x) / 4, y: (f[0].y + f[1].y + f[2].y + f[3].y) / 4 };
      const cc = imageToCanvas(this.vp, ctr);
      g.strokeStyle = color; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(cc.x, cc.y); g.lineTo(mid.x, mid.y); g.stroke();
      g.fillStyle = color;
      g.beginPath(); g.arc(cc.x, cc.y, selected ? 4 : 3, 0, Math.PI * 2); g.fill();
      g.font = '12px system-ui, sans-serif';
      g.fillText(`#${c.objectId}`, cc.x + 7, cc.y - 7);
    }
    g.restore();
  }

  // ---------------------------------------------------------------- panels

  render(): void {
    const { store } = this.ctx;
    for (const [t, b] of this.toolBtns) {
      b.classList.toggle('active', t === this.tool);
      b.setAttribute('aria-pressed', String(t === this.tool));
    }
    this.empty.style.display = store.getProject().images.length ? 'none' : 'flex';
    this.canvas.style.display = store.getProject().images.length ? '' : 'none';
    const img = this.img();
    if (img && this.fitFor !== img.id) this.fit();
    this.renderPanels(img);
    this.queueDraw();
  }

  private renderPanels(img: ImageEntry | null): void {
    const { store } = this.ctx;
    const sel = this.selected();
    const classes = store.getProject().classes;
    const cubs = img?.cuboids ?? [];
    const cam = img ? this.camera(img) : null;
    const sig = JSON.stringify([img?.id, store.getUI().selectedAnnotationId, classes.map((c) => [c.id, c.name, c.color]), cubs, cam, this.tool]);
    if (sig === this.sig) return;
    this.sig = sig;

    clear(this.list);
    if (!cubs.length) {
      this.list.appendChild(h('p', { class: 'hint' }, img ? 'No cuboids yet. Press C, then click the photo where the object is.' : 'Add an image to start.'));
    }
    for (const c of cubs) {
      const cls = classes.find((k) => k.id === c.classId);
      this.list.appendChild(h('div', {
        class: 'row ann-row' + (c.id === sel?.id ? ' active' : '') + (c.hidden ? ' dim' : ''), role: 'listitem',
        onclick: () => store.setUI({ selectedAnnotationId: c.id }),
      },
        h('span', { class: 'dot', style: `background:${cls?.color ?? '#f0f'}` }),
        h('div', { class: 'grow' },
          h('div', { class: 'name' }, cls?.name ?? 'unknown class'),
          h('div', { class: 'sub' }, `object #${c.objectId}`)),
        h('button', {
          class: 'icon-btn' + (c.hidden ? ' on' : ''), type: 'button', 'aria-pressed': String(!!c.hidden),
          onclick: (e: Event) => { e.stopPropagation(); this.patch(c.id, { hidden: !c.hidden }); },
        }, c.hidden ? 'Show' : 'Hide'),
        h('button', {
          class: 'icon-btn' + (c.locked ? ' on' : ''), type: 'button', 'aria-pressed': String(!!c.locked),
          onclick: (e: Event) => { e.stopPropagation(); this.patch(c.id, { locked: !c.locked }); },
        }, c.locked ? 'Unlock' : 'Lock'),
        h('button', {
          class: 'icon-btn', type: 'button', 'aria-label': 'Delete cuboid',
          onclick: (e: Event) => { e.stopPropagation(); store.setUI({ selectedAnnotationId: c.id }); this.deleteSelected(); },
        }, '×'),
      ));
    }

    clear(this.props);
    if (img && cam) this.props.appendChild(this.cameraPanel(img, cam));
    if (sel) this.props.appendChild(this.cuboidPanel(sel));
  }

  private num(label: string, value: number, min: number, max: number, step: number, disabled: boolean, onSet: (v: number) => void): HTMLElement {
    const input = h('input', {
      class: 'select', type: 'number', min, max, step, value: round(value, 4), disabled, 'aria-label': label,
      onchange: (e: Event) => {
        const v = Number((e.target as HTMLInputElement).value);
        if (!Number.isFinite(v) || v < min || v > max) {
          (e.target as HTMLInputElement).value = String(round(value, 4));
          this.ctx.toast(`${label} must be between ${min} and ${max}.`);
          return;
        }
        onSet(v);
      },
    });
    return h('label', { class: 'field' }, h('span', {}, label), input);
  }

  private cuboidPanel(sel: PhotoCuboid): HTMLElement {
    const classes = this.ctx.store.getProject().classes;
    const dis = !!sel.locked;
    const select = h('select', {
      class: 'select', 'aria-label': 'Cuboid class', disabled: dis,
      onchange: (e: Event) => this.patch(sel.id, { classId: (e.target as HTMLSelectElement).value }),
    });
    for (const c of classes) {
      const o = h('option', { value: c.id }, c.name);
      if (c.id === sel.classId) o.selected = true;
      select.appendChild(o);
    }
    const size = (k: 'width' | 'height' | 'length') => this.num(
      `${k[0].toUpperCase()}${k.slice(1)}`, sel.size[k], 0.01, 1000, 0.05, dis,
      (v) => this.edit((_, c) => ({ ...c, size: { ...c.size, [k]: v } })));
    const deg = (sel.rotationY * 180) / Math.PI;
    return h('div', { class: 'cuboid-props' },
      h('label', { class: 'field' }, h('span', {}, 'Class'), select),
      size('width'), size('height'), size('length'),
      this.num('Depth (distance from camera)', sel.center.z, 0.05, 100000, 0.1, dis, (v) => this.edit((c2, c) => withDepth(c2, c, v))),
      this.num('Rotation (degrees)', deg, -180, 180, 1, dis, (v) => this.edit((_, c) => ({ ...c, rotationY: wrapAngle((v * Math.PI) / 180) }))),
      h('p', { class: 'hint' }, 'Drag the cuboid to move it. Q/E rotate, W/S change depth, H hide, L lock, Delete removes. Changing depth keeps the cuboid in place on the photo.'),
    );
  }

  private cameraPanel(img: ImageEntry, cam: CameraModel): HTMLElement {
    const fov = round(horizontalFovDeg(cam, img.width), 1);
    const apply = (next: Partial<CameraModel>): void => {
      this.ctx.store.mutate((p) => {
        const t = p.images.find((i) => i.id === img.id);
        if (t) t.camera = { ...this.camera(img), ...next };
      });
    };
    return h('div', { class: 'camera-props' },
      h('div', { class: 'panel-head' }, h('h2', {}, 'Camera')),
      this.num('Horizontal field of view (degrees)', fov, 10, 150, 1, false,
        (v) => { const c = cameraFromHorizontalFov(img.width, img.height, v); apply({ fx: c.fx, fy: c.fy }); }),
      h('label', { class: 'field' },
        h('span', {}, 'Camera is calibrated (sizes are metric)'),
        h('input', {
          type: 'checkbox', checked: cam.calibrated ? true : undefined,
          onchange: (e: Event) => apply({ calibrated: (e.target as HTMLInputElement).checked }),
        })),
      h('p', { class: 'hint' }, cam.calibrated
        ? 'Marked calibrated: exported sizes and distances are treated as metric. Only keep this on if the field of view comes from a real calibration.'
        : 'Assumed camera. A single photo cannot give true depth, so sizes and distances here are relative, not metric.'),
    );
  }
}

function pointInConvex(hull: Point2D[], p: Point2D): boolean {
  if (hull.length < 3) return false;
  let sign = 0;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const cr = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (cr === 0) continue;
    const s = cr > 0 ? 1 : -1;
    if (sign === 0) sign = s; else if (s !== sign) return false;
  }
  return true;
}

function round(v: number, d: number): number { const m = 10 ** d; return Math.round(v * m) / m; }

function hexA(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return `rgba(255,0,255,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
