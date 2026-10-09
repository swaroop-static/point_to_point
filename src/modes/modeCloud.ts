import type * as THREE_NS from 'three';
import type { OrbitControls as OrbitControlsT } from 'three/addons/controls/OrbitControls.js';
import type { CloudEntry, Cuboid3D, PointLabel } from '../core/types';
import { newAnnotationId, newImageId } from '../core/ids';
import { getSourceFile, setSourceFile } from '../io/images';
import { pickFiles } from '../io/download';
import { downloadCloudAnnotations } from '../io/cloudExport';
import { cloudFormatOf, loadCloudFile, type LoadedCloud } from '../cloud/load';
import {
  CUBOID_EDGES, axesOf, cuboidCorners, extentOf, pickPoint, pointsInCuboid, pointsInRect, rayCuboid, screenProject, wrapYaw,
  type Extent, type UpAxis,
} from '../cloud/geom';
import { flagsToRanges, rangesCount, rangesToFlags } from '../mesh/faces';
import { isTypingTarget } from '../workspaces/image2d/workspace';
import { clear, h } from '../ui/dom';
import type { ExportItem, ModeContext, ModeController } from '../ui/mode';

type Tool = 'select' | 'add';
type ColorMode = 'height' | 'rgb' | 'gray';
const ACCEPT = '.ply,.pcd';
const YAW_STEP = (5 * Math.PI) / 180;
const SELECT_RGB = [1.0, 0.86, 0.25];

interface Runtime { data: LoadedCloud; ext: Extent }

/**
 * Point-cloud annotation: orbit a cloud, place and edit oriented 3D cuboids,
 * and label points by class. Points stay in the local file; cuboids and point
 * labels live in the project (project.clouds).
 */
export class ModeCloud implements ModeController {
  readonly id = 'cloud' as const;
  readonly label = '3D cloud';
  readonly toolbar: HTMLElement;
  readonly stage: HTMLElement;
  readonly rightPanel: HTMLElement;
  readonly leftPanel: HTMLElement;

  private canvas = document.createElement('canvas');
  private empty: HTMLElement;
  private notice: HTMLElement;
  private rectEl: HTMLElement;
  private cloudList: HTMLElement;
  private cuboidList: HTMLElement;
  private labelList: HTMLElement;
  private props: HTMLElement;
  private selInfo: HTMLElement;
  private toolBtns = new Map<Tool, HTMLButtonElement>();
  private tool: Tool = 'select';
  private colorMode: ColorMode = 'height';
  private pointSize = 2;

  private activeCloudId: string | null = null;
  private activeCuboidId: string | null = null;
  private runtimes = new Map<string, Runtime>();
  private flags: Uint8Array | null = null; // selected points of the active cloud
  private flagCount = 0;
  private sig = '';
  private paintSig = '';
  private linesSig = '';

  private T: typeof THREE_NS | null = null;
  private OrbitControlsCtor: typeof OrbitControlsT | null = null;
  private renderer: THREE_NS.WebGLRenderer | null = null;
  private scene: THREE_NS.Scene | null = null;
  private camera: THREE_NS.PerspectiveCamera | null = null;
  private controls: OrbitControlsT | null = null;
  private controlsUp: UpAxis | null = null;
  private points: THREE_NS.Points | null = null;
  private lines: THREE_NS.Group | null = null;
  private shownCloudId: string | null = null;
  private initStarted = false;
  private drawQueued = false;

  private press: { x: number; y: number; shift: boolean; moved: boolean } | null = null;
  private rect: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private move: { id: string; off: [number, number] } | null = null;

  constructor(private ctx: ModeContext) {
    const mk = (t: Tool, label: string, key: string) => {
      const b = h('button', { class: 'btn tool', type: 'button', title: `${label} (${key})`, onclick: () => this.setTool(t) }, label);
      this.toolBtns.set(t, b);
      return b;
    };
    const colorSel = h('select', {
      class: 'select', 'aria-label': 'Point color',
      onchange: (e: Event) => { this.colorMode = (e.target as HTMLSelectElement).value as ColorMode; this.paintSig = ''; this.render(); },
    },
      h('option', { value: 'height' }, 'Color by height'), h('option', { value: 'rgb' }, 'File colors'), h('option', { value: 'gray' }, 'Gray'));
    const size = h('input', {
      type: 'range', min: 1, max: 8, step: 0.5, value: this.pointSize, 'aria-label': 'Point size',
      oninput: (e: Event) => {
        this.pointSize = Number((e.target as HTMLInputElement).value);
        if (this.points) (this.points.material as THREE_NS.PointsMaterial).size = this.pointSize;
        this.queueDraw();
      },
    });
    const view = (label: string, k: 'top' | 'front' | 'side' | 'reset') => h('button', { class: 'btn', type: 'button', onclick: () => this.setView(k) }, label);
    this.toolbar = h('div', { class: 'mode-toolbar' },
      h('div', { class: 'btn-group', role: 'group', 'aria-label': 'Tools' }, mk('select', 'Select', 'V'), mk('add', 'Add cuboid', 'C')),
      h('div', { class: 'btn-group' }, view('Top', 'top'), view('Front', 'front'), view('Side', 'side'), view('Reset', 'reset')),
      colorSel, size);

    this.empty = h('div', { class: 'empty' },
      h('h1', {}, 'Drop a point cloud to annotate'),
      h('p', {}, '.ply or .pcd (ASCII or binary). Files stay on your computer; nothing is uploaded.'),
      h('button', { class: 'btn primary', type: 'button', onclick: () => void this.pick() }, 'Choose point cloud'));
    this.notice = h('div', { class: 'hint', style: 'position:absolute;left:12px;bottom:10px;max-width:70%;pointer-events:none' });
    this.rectEl = h('div', { style: 'position:absolute;border:1px dashed #ffd84a;background:rgba(255,216,74,.12);display:none;pointer-events:none' });
    this.canvas.className = 'stage-canvas';
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('aria-label', 'Point cloud viewport');
    this.stage = h('div', { class: 'stage', style: 'position:relative' }, this.canvas, this.empty, this.notice, this.rectEl);

    this.cloudList = h('div', { class: 'list', role: 'list' });
    this.leftPanel = h('div', { class: 'images-panel' },
      h('div', { class: 'panel-head' }, h('h2', {}, 'Point clouds'),
        h('button', { class: 'btn small', type: 'button', onclick: () => void this.pick() }, 'Add cloud')),
      this.cloudList);

    this.selInfo = h('p', { class: 'hint' });
    this.props = h('div', { class: 'props' });
    this.cuboidList = h('div', { class: 'list', role: 'list' });
    this.labelList = h('div', { class: 'list', role: 'list' });
    this.rightPanel = h('div', {},
      h('div', { class: 'panel-head' }, h('h2', {}, 'Cuboids')), this.cuboidList, this.props,
      h('div', { class: 'panel-head' }, h('h2', {}, 'Point labels')),
      h('div', { class: 'props' }, this.selInfo,
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn small primary', type: 'button', onclick: () => this.labelPoints() }, 'Label points (Enter)'),
          h('button', { class: 'btn small', type: 'button', onclick: () => this.clearSelection() }, 'Clear (Esc)'))),
      this.labelList);

    new ResizeObserver(() => this.resize()).observe(this.stage);
    // Capture phase so we can switch OrbitControls off before it sees the press.
    this.canvas.addEventListener('pointerdown', (e) => this.onDown(e), true);
    this.canvas.addEventListener('pointermove', (e) => this.onMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.onUp(e));
    this.canvas.addEventListener('pointercancel', (e) => this.onUp(e));
  }

  // ---------------------------------------------------------------- mode API

  activate(): void { this.ctx.setCursorText(''); this.ctx.setZoomText(''); void this.ensureThree(); this.render(); }
  deactivate(): void { this.press = null; this.rect = null; this.move = null; this.rectEl.style.display = 'none'; if (this.controls) this.controls.enabled = true; }

  async handleFiles(files: File[]): Promise<void> {
    for (const f of files) {
      try {
        if (!cloudFormatOf(f.name)) { this.ctx.toast(`${f.name}: unsupported. Use .ply or .pcd.`); continue; }
        this.ctx.toast(`Reading ${f.name}...`);
        await new Promise((r) => setTimeout(r, 20));
        const data = await loadCloudFile(f);
        const existing = (this.ctx.store.getProject().clouds ?? []).find((c) => c.name === f.name);
        const rt: Runtime = { data, ext: extentOf(data.positions) };
        if (existing) {
          if (existing.pointCount !== data.pointCount) {
            this.ctx.toast(`${f.name} has ${data.pointCount.toLocaleString()} points but the saved annotations are for ${existing.pointCount.toLocaleString()}. It looks like a different cloud, so it was not linked.`);
            continue;
          }
          setSourceFile(existing.id, f);
          this.runtimes.set(existing.id, rt);
          this.selectCloud(existing.id);
          this.ctx.toast(`Linked ${f.name} to its saved annotations.`);
          continue;
        }
        const entry: CloudEntry = {
          id: newImageId().replace('img_', 'pcl_'), name: f.name, format: data.format, pointCount: data.pointCount,
          upAxis: 'z', cuboids: [], pointLabels: [],
        };
        setSourceFile(entry.id, f);
        this.runtimes.set(entry.id, rt);
        this.ctx.store.mutate((p) => { (p.clouds ??= []).push(entry); });
        this.selectCloud(entry.id);
        this.ctx.toast(`Loaded ${f.name}: ${data.pointCount.toLocaleString()} points${data.dropped ? ` (${data.dropped} invalid points skipped)` : ''}. Up axis is assumed to be Z; change it in the Cuboids panel if needed.`);
      } catch (e) {
        this.ctx.toast(e instanceof Error ? e.message : `Could not load ${f.name}.`);
      }
    }
  }

  private async pick(): Promise<void> {
    const files = await pickFiles(ACCEPT, true);
    if (files.length) await this.handleFiles(files);
  }

  onClassSelected(classId: string): void {
    const c = this.activeCuboid();
    if (c && !c.locked && c.classId !== classId) this.patchCuboid(c.id, { classId });
  }

  classCounts(): Map<string, number> {
    const out = new Map<string, number>();
    const cl = this.activeCloud();
    for (const c of cl?.cuboids ?? []) out.set(c.classId, (out.get(c.classId) ?? 0) + 1);
    return out;
  }

  exportItems(): ExportItem[] {
    return [{
      label: 'Point-cloud annotations JSON',
      run: () => {
        const proj = this.ctx.store.getProject();
        if (!(proj.clouds ?? []).some((c) => c.cuboids.length || c.pointLabels.length)) { this.ctx.toast('Add a cuboid or label some points before exporting.'); return; }
        const { cuboids, warnings } = downloadCloudAnnotations(proj, (id) => this.runtimes.get(id)?.data.positions ?? null);
        this.ctx.toast(`Exported ${cuboids} cuboid${cuboids === 1 ? '' : 's'}.`);
        for (const w of warnings.slice(0, 3)) this.ctx.toast(`Export note: ${w}`);
      },
    }];
  }

  statusLeft(): string {
    const c = this.activeCloud();
    return c ? `${c.name} · ${c.pointCount.toLocaleString()} points · up = ${c.upAxis.toUpperCase()}` : 'No point cloud';
  }
  statusCount(): string {
    const c = this.activeCloud();
    if (!c) return '';
    const labeled = c.pointLabels.reduce((n, l) => n + rangesCount(l.ranges), 0);
    return `${c.cuboids.length} cuboid${c.cuboids.length === 1 ? '' : 's'} · ${labeled.toLocaleString()} labeled points · ${this.flagCount.toLocaleString()} selected`;
  }

  // ---------------------------------------------------------------- state helpers

  private clouds(): CloudEntry[] { return this.ctx.store.getProject().clouds ?? []; }
  private activeCloud(): CloudEntry | null { return this.clouds().find((c) => c.id === this.activeCloudId) ?? null; }
  private activeRuntime(): Runtime | null { return this.activeCloudId ? this.runtimes.get(this.activeCloudId) ?? null : null; }
  private activeCuboid(): Cuboid3D | null { return this.activeCloud()?.cuboids.find((c) => c.id === this.activeCuboidId) ?? null; }

  private selectCloud(id: string | null): void {
    this.activeCloudId = id; this.activeCuboidId = null; this.flags = null; this.flagCount = 0;
    this.sig = ''; this.paintSig = ''; this.linesSig = '';
    this.render();
  }

  private setTool(t: Tool): void { this.tool = t; this.render(); }

  private patchCuboid(id: string, patch: Partial<Cuboid3D>): void {
    const cid = this.activeCloudId;
    this.ctx.store.mutate((p) => {
      const b = p.clouds?.find((c) => c.id === cid)?.cuboids.find((x) => x.id === id);
      if (b) Object.assign(b, patch);
    });
  }

  private editCuboid(fn: (c: Cuboid3D) => Cuboid3D): void {
    const sel = this.activeCuboid(), cid = this.activeCloudId;
    if (!sel || sel.locked) return;
    const next = fn(sel);
    this.ctx.store.mutate((p) => {
      const list = p.clouds?.find((c) => c.id === cid)?.cuboids;
      const i = list?.findIndex((x) => x.id === sel.id) ?? -1;
      if (list && i >= 0) list[i] = next;
    });
  }

  private deleteCuboid(): void {
    const sel = this.activeCuboid(), cid = this.activeCloudId;
    if (!sel) return;
    if (sel.locked) { this.ctx.toast('This cuboid is locked. Unlock it to delete.'); return; }
    this.ctx.store.mutate((p) => {
      const c = p.clouds?.find((x) => x.id === cid);
      if (c) c.cuboids = c.cuboids.filter((b) => b.id !== sel.id);
    });
    this.activeCuboidId = null;
  }

  private removeCloud(c: CloudEntry): void {
    if ((c.cuboids.length || c.pointLabels.length) && !confirm(`Remove "${c.name}" and its annotations from this project? You can undo this.`)) return;
    this.ctx.store.mutate((p) => { p.clouds = (p.clouds ?? []).filter((x) => x.id !== c.id); });
    this.runtimes.delete(c.id);
    if (this.activeCloudId === c.id) this.selectCloud(this.clouds()[0]?.id ?? null);
  }

  private addCuboidAt(point: { x: number; y: number; z: number }): void {
    const cl = this.activeCloud(), rt = this.activeRuntime();
    const cls = this.ctx.store.getActiveClass() ?? this.ctx.store.getProject().classes[0];
    if (!cl || !rt) return;
    if (!cls) { this.ctx.toast('Add a class first.'); return; }
    const r = rt.ext.diag / 40;
    const size = { length: 2 * r, width: r, height: r };
    const { u } = axesOf(cl.upAxis);
    const center = { ...point };
    if (u === 2) center.z += size.height / 2; else center.y += size.height / 2; // sit the box on the picked point
    const id = newAnnotationId();
    const objectId = cl.cuboids.reduce((m, c) => Math.max(m, c.objectId), 0) + 1;
    this.ctx.store.mutate((p) => {
      p.clouds?.find((c) => c.id === cl.id)?.cuboids.push({ id, objectId, classId: cls.id, center, size, yaw: 0 });
    });
    this.activeCuboidId = id;
    this.tool = 'select';
    this.render();
  }

  private clearSelection(): void { if (this.flags) this.flags.fill(0); this.flagCount = 0; this.paintSig = ''; this.sig = ''; this.render(); }

  private setFlags(idx: number[], add: boolean): void {
    const rt = this.activeRuntime();
    if (!rt) return;
    if (!this.flags || this.flags.length !== rt.data.pointCount) this.flags = new Uint8Array(rt.data.pointCount);
    if (!add) this.flags.fill(0);
    for (const i of idx) this.flags[i] = 1;
    let n = 0; for (let i = 0; i < this.flags.length; i++) n += this.flags[i];
    this.flagCount = n; this.paintSig = ''; this.sig = '';
    this.render();
  }

  private labelPoints(): void {
    const cl = this.activeCloud();
    if (!cl || !this.flags || !this.flagCount) { this.ctx.toast('Select points first: Shift+drag a rectangle, or use "Select points inside" on a cuboid.'); return; }
    const cls = this.ctx.store.getActiveClass();
    if (!cls) { this.ctx.toast('Create a class first.'); return; }
    const flags = this.flags.slice();
    const n = cl.pointCount;
    this.ctx.store.mutate((p) => {
      const t = p.clouds?.find((c) => c.id === cl.id);
      if (!t) return false;
      // A point has one class: take these points from every label, then add them to this class's label.
      const labels: PointLabel[] = [];
      let target: PointLabel | undefined;
      for (const l of t.pointLabels) {
        const f = rangesToFlags(l.ranges, n);
        if (l.classId === cls.id) { for (let i = 0; i < n; i++) if (flags[i]) f[i] = 1; target = { ...l, ranges: flagsToRanges(f) }; labels.push(target); continue; }
        for (let i = 0; i < n; i++) if (flags[i]) f[i] = 0;
        const ranges = flagsToRanges(f);
        if (ranges.length) labels.push({ ...l, ranges });
      }
      if (!target) labels.push({ id: newAnnotationId(), classId: cls.id, ranges: flagsToRanges(flags) });
      t.pointLabels = labels;
    });
    this.ctx.toast(`Labeled ${this.flagCount.toLocaleString()} points as ${cls.name}.`);
    this.flags.fill(0); this.flagCount = 0; this.paintSig = ''; this.sig = '';
    this.render();
  }

  private deletePointLabel(id: string): void {
    const cid = this.activeCloudId;
    this.ctx.store.mutate((p) => { const c = p.clouds?.find((x) => x.id === cid); if (c) c.pointLabels = c.pointLabels.filter((l) => l.id !== id); });
    this.paintSig = ''; this.render();
  }

  // ---------------------------------------------------------------- keyboard

  handleKey(e: KeyboardEvent): boolean {
    if (isTypingTarget(e.target)) return false;
    const sel = this.activeCuboid();
    switch (e.key) {
      case 'v': case 'V': this.setTool('select'); return true;
      case 'c': case 'C': this.setTool('add'); return true;
      case 't': case 'T': this.setView('top'); return true;
      case 'f': case 'F': this.setView('front'); return true;
      case 's': case 'S': this.setView('side'); return true;
      case 'r': case 'R': this.setView('reset'); return true;
      case 'q': case 'Q': this.editCuboid((c) => ({ ...c, yaw: wrapYaw(c.yaw - YAW_STEP) })); return true;
      case 'e': case 'E': this.editCuboid((c) => ({ ...c, yaw: wrapYaw(c.yaw + YAW_STEP) })); return true;
      case 'h': case 'H': if (sel) this.patchCuboid(sel.id, { hidden: !sel.hidden }); return true;
      case 'l': case 'L': if (sel) this.patchCuboid(sel.id, { locked: !sel.locked }); return true;
      case 'Enter': this.labelPoints(); return true;
      case 'Escape': this.activeCuboidId = null; this.tool = 'select'; this.clearSelection(); return true;
      case 'Delete': case 'Backspace': e.preventDefault(); this.deleteCuboid(); return true;
      default: return false;
    }
  }

  // ---------------------------------------------------------------- three.js

  private async ensureThree(): Promise<void> {
    if (this.initStarted) return;
    this.initStarted = true;
    try {
      const T = await import('three');
      const { OrbitControls } = await import('three/addons/controls/OrbitControls.js');
      const renderer = new T.WebGLRenderer({ canvas: this.canvas, antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      const scene = new T.Scene();
      scene.background = new T.Color(0x14171c);
      const camera = new T.PerspectiveCamera(50, 1, 0.01, 1000);
      this.T = T; this.OrbitControlsCtor = OrbitControls; this.renderer = renderer; this.scene = scene; this.camera = camera;
      this.lines = new T.Group();
      scene.add(this.lines);
      this.resize();
      this.render();
    } catch (e) {
      this.initStarted = false;
      this.ctx.toast(`3D view is unavailable: ${e instanceof Error ? e.message : 'WebGL could not start.'}`);
    }
  }

  /** OrbitControls fixes its notion of "up" at construction, so rebuild it when the up axis changes. */
  private ensureControls(up: UpAxis): void {
    const { T, camera, OrbitControlsCtor } = this;
    if (!T || !camera || !OrbitControlsCtor || this.controlsUp === up) return;
    const target = this.controls ? this.controls.target.clone() : new T.Vector3();
    this.controls?.dispose();
    camera.up.set(0, up === 'y' ? 1 : 0, up === 'z' ? 1 : 0);
    const c = new OrbitControlsCtor(camera, this.canvas);
    c.target.copy(target);
    c.addEventListener('change', () => this.queueDraw());
    c.update();
    this.controls = c; this.controlsUp = up;
  }

  private resize(): void {
    if (!this.renderer || !this.camera) return;
    const w = Math.max(1, this.stage.clientWidth), hgt = Math.max(1, this.stage.clientHeight);
    this.renderer.setSize(w, hgt, false);
    this.canvas.style.width = `${w}px`; this.canvas.style.height = `${hgt}px`;
    this.camera.aspect = w / hgt;
    this.camera.updateProjectionMatrix();
    this.queueDraw();
  }

  private queueDraw(): void {
    if (this.drawQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      this.drawQueued = false;
      if (this.renderer && this.scene && this.camera) this.renderer.render(this.scene, this.camera);
    });
  }

  private setView(kind: 'top' | 'front' | 'side' | 'reset'): void {
    const { T, camera, controls } = this;
    const cl = this.activeCloud(), rt = this.activeRuntime();
    if (!T || !camera || !controls || !cl || !rt) return;
    const { min, max } = rt.ext;
    const center = new T.Vector3((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
    const vHalf = (camera.fov * Math.PI) / 360;
    const hHalf = Math.atan(Math.tan(vHalf) * camera.aspect);
    const dist = ((rt.ext.diag / 2) / Math.sin(Math.min(vHalf, hHalf))) * 1.05;
    const up = cl.upAxis === 'z' ? new T.Vector3(0, 0, 1) : new T.Vector3(0, 1, 0);
    // Horizontal axes a (x) and b (y for z-up, z for y-up).
    const a = new T.Vector3(1, 0, 0), b = cl.upAxis === 'z' ? new T.Vector3(0, 1, 0) : new T.Vector3(0, 0, 1);
    let dir: THREE_NS.Vector3;
    // Offset toward -b so screen-up is +b (north up) and +a points right, not mirrored.
    if (kind === 'top') dir = up.clone().sub(b.clone().multiplyScalar(0.001));
    else if (kind === 'front') dir = b.clone().multiplyScalar(-1).add(up.clone().multiplyScalar(0.02));
    else if (kind === 'side') dir = a.clone().add(up.clone().multiplyScalar(0.02));
    else dir = a.clone().multiplyScalar(0.7).add(b.clone().multiplyScalar(-1)).add(up.clone().multiplyScalar(0.8));
    camera.near = dist / 1000; camera.far = dist * 50; camera.updateProjectionMatrix();
    camera.position.copy(center).add(dir.normalize().multiplyScalar(dist));
    controls.target.copy(center);
    controls.update();
    this.queueDraw();
  }

  private syncPoints(): void {
    const { T, scene } = this;
    if (!T || !scene) return;
    const cl = this.activeCloud(), rt = this.activeRuntime();
    const id = cl && rt ? cl.id : null;
    if (this.shownCloudId === id && (!cl || this.controlsUp === cl.upAxis)) return;
    if (cl) this.ensureControls(cl.upAxis);
    if (this.shownCloudId === id) { this.setView('reset'); return; }
    if (this.points) {
      scene.remove(this.points);
      this.points.geometry.dispose();
      (this.points.material as THREE_NS.Material).dispose();
      this.points = null;
    }
    this.shownCloudId = null;
    if (cl && rt) {
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(rt.data.positions, 3));
      g.setAttribute('color', new T.BufferAttribute(new Float32Array(rt.data.pointCount * 3), 3));
      g.computeBoundingSphere();
      const mat = new T.PointsMaterial({ size: this.pointSize, sizeAttenuation: false, vertexColors: true });
      this.points = new T.Points(g, mat);
      this.points.frustumCulled = false;
      scene.add(this.points);
      this.shownCloudId = cl.id;
      this.paintSig = ''; this.linesSig = '';
      this.setView('reset');
    }
  }

  private paint(): void {
    const cl = this.activeCloud(), rt = this.activeRuntime(), pts = this.points;
    if (!cl || !rt || !pts) return;
    const classes = this.ctx.store.getProject().classes;
    const sig = JSON.stringify([cl.id, cl.upAxis, this.colorMode, cl.pointLabels.map((l) => [l.id, l.classId, rangesCount(l.ranges), l.ranges.length]), classes.map((c) => [c.id, c.color])]) + ':' + this.flagCount;
    if (sig === this.paintSig) return;
    this.paintSig = sig;
    const n = rt.data.pointCount, P = rt.data.positions;
    const attr = pts.geometry.getAttribute('color') as THREE_NS.BufferAttribute;
    const arr = attr.array as Float32Array;
    const { u } = axesOf(cl.upAxis);
    const lo = u === 0 ? rt.ext.min.x : u === 1 ? rt.ext.min.y : rt.ext.min.z;
    const hi = u === 0 ? rt.ext.max.x : u === 1 ? rt.ext.max.y : rt.ext.max.z;
    const span = hi - lo || 1;
    const useRgb = this.colorMode === 'rgb' && rt.data.colors;
    const C = rt.data.colors;
    for (let i = 0; i < n; i++) {
      if (useRgb && C) { arr[i * 3] = C[i * 3]; arr[i * 3 + 1] = C[i * 3 + 1]; arr[i * 3 + 2] = C[i * 3 + 2]; }
      else if (this.colorMode === 'gray') { arr[i * 3] = arr[i * 3 + 1] = arr[i * 3 + 2] = 0.72; }
      else { ramp((P[i * 3 + u] - lo) / span, arr, i * 3); }
    }
    for (const l of cl.pointLabels) {
      const k = hexRgb(classes.find((c) => c.id === l.classId)?.color ?? '#ff00ff');
      for (const [s, e] of l.ranges) for (let i = s; i < e; i++) { arr[i * 3] = k[0]; arr[i * 3 + 1] = k[1]; arr[i * 3 + 2] = k[2]; }
    }
    if (this.flags && this.flagCount) for (let i = 0; i < n; i++) if (this.flags[i]) { arr[i * 3] = SELECT_RGB[0]; arr[i * 3 + 1] = SELECT_RGB[1]; arr[i * 3 + 2] = SELECT_RGB[2]; }
    attr.needsUpdate = true;
    this.queueDraw();
  }

  private drawCuboids(): void {
    const { T, lines } = this;
    const cl = this.activeCloud();
    if (!T || !lines) return;
    const classes = this.ctx.store.getProject().classes;
    const sig = JSON.stringify([cl?.id, cl?.upAxis, cl?.cuboids, this.activeCuboidId, classes.map((c) => [c.id, c.color])]);
    if (sig === this.linesSig) return;
    this.linesSig = sig;
    for (const child of [...lines.children]) {
      lines.remove(child);
      (child as THREE_NS.LineSegments).geometry.dispose();
      ((child as THREE_NS.LineSegments).material as THREE_NS.Material).dispose();
    }
    for (const b of cl?.cuboids ?? []) {
      if (b.hidden) continue;
      const corners = cuboidCorners(b, cl!.upAxis);
      const v: number[] = [];
      for (const [i, j] of CUBOID_EDGES) v.push(corners[i].x, corners[i].y, corners[i].z, corners[j].x, corners[j].y, corners[j].z);
      // Heading: from the center to the middle of the +length face.
      const front = [1, 3, 5, 7].map((i) => corners[i]);
      const m = { x: (front[0].x + front[1].x + front[2].x + front[3].x) / 4, y: (front[0].y + front[1].y + front[2].y + front[3].y) / 4, z: (front[0].z + front[1].z + front[2].z + front[3].z) / 4 };
      v.push(b.center.x, b.center.y, b.center.z, m.x, m.y, m.z);
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute(v, 3));
      const color = b.id === this.activeCuboidId ? '#ffffff' : classes.find((c) => c.id === b.classId)?.color ?? '#ff00ff';
      const seg = new T.LineSegments(g, new T.LineBasicMaterial({ color, transparent: true, opacity: b.locked ? 0.55 : 1 }));
      seg.frustumCulled = false;
      lines.add(seg);
    }
    this.queueDraw();
  }

  // ---------------------------------------------------------------- pointer input

  private ndcOf(e: { clientX: number; clientY: number }): { x: number; y: number; px: number; py: number } {
    const r = this.canvas.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    return { x: (px / r.width) * 2 - 1, y: -(py / r.height) * 2 + 1, px, py };
  }

  private ray(e: { clientX: number; clientY: number }): THREE_NS.Ray | null {
    const { T, camera } = this;
    if (!T || !camera) return null;
    const n = this.ndcOf(e);
    camera.updateMatrixWorld();
    const rc = new T.Raycaster();
    rc.setFromCamera(new T.Vector2(n.x, n.y), camera);
    return rc.ray;
  }

  private hitCuboid(e: { clientX: number; clientY: number }): Cuboid3D | null {
    const cl = this.activeCloud(), ray = this.ray(e);
    if (!cl || !ray) return null;
    let best: Cuboid3D | null = null, bt = Infinity;
    for (const c of cl.cuboids) {
      if (c.hidden) continue;
      const t = rayCuboid(ray.origin, ray.direction, c, cl.upAxis);
      if (t !== null && t < bt) { bt = t; best = c; }
    }
    return best;
  }

  private onDown(e: PointerEvent): void {
    if (e.button !== 0 || !this.activeRuntime()) return;
    const n = this.ndcOf(e);
    this.press = { x: e.clientX, y: e.clientY, shift: e.shiftKey, moved: false };
    if (e.shiftKey) {
      if (this.controls) this.controls.enabled = false;
      this.rect = { x0: n.px, y0: n.py, x1: n.px, y1: n.py };
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (this.tool !== 'select') return;
    const hit = this.hitCuboid(e);
    if (!hit) return;
    this.activeCuboidId = hit.id;
    this.linesSig = ''; this.sig = '';
    this.render();
    if (hit.locked) return;
    const ray = this.ray(e), cl = this.activeCloud();
    if (!ray || !cl) return;
    const p = this.planePoint(ray, hit, cl.upAxis);
    if (!p) return;
    if (this.controls) this.controls.enabled = false;
    this.canvas.setPointerCapture(e.pointerId);
    const { a, b } = axesOf(cl.upAxis);
    const comp = (v: { x: number; y: number; z: number }, i: number) => (i === 0 ? v.x : i === 1 ? v.y : v.z);
    this.move = { id: hit.id, off: [comp(p, a) - comp(hit.center, a), comp(p, b) - comp(hit.center, b)] };
    this.ctx.store.beginGesture();
  }

  /** Where the pointer ray meets the horizontal plane through the cuboid's center. */
  private planePoint(ray: THREE_NS.Ray, c: Cuboid3D, up: UpAxis): { x: number; y: number; z: number } | null {
    const { u } = axesOf(up);
    const o = [ray.origin.x, ray.origin.y, ray.origin.z], d = [ray.direction.x, ray.direction.y, ray.direction.z];
    const cu = u === 0 ? c.center.x : u === 1 ? c.center.y : c.center.z;
    if (Math.abs(d[u]) < 1e-6) return null;
    const t = (cu - o[u]) / d[u];
    if (t < 0) return null;
    return { x: o[0] + d[0] * t, y: o[1] + d[1] * t, z: o[2] + d[2] * t };
  }

  private onMove(e: PointerEvent): void {
    const pr = this.press;
    if (!pr) return;
    if (Math.hypot(e.clientX - pr.x, e.clientY - pr.y) > 4) pr.moved = true;
    const n = this.ndcOf(e);
    if (this.rect) {
      this.rect.x1 = n.px; this.rect.y1 = n.py;
      const r = this.rect;
      Object.assign(this.rectEl.style, {
        display: 'block', left: `${Math.min(r.x0, r.x1)}px`, top: `${Math.min(r.y0, r.y1)}px`,
        width: `${Math.abs(r.x1 - r.x0)}px`, height: `${Math.abs(r.y1 - r.y0)}px`,
      });
      return;
    }
    const mv = this.move, cl = this.activeCloud(), ray = this.ray(e);
    if (!mv || !cl || !ray) return;
    const cur = cl.cuboids.find((c) => c.id === mv.id);
    if (!cur) return;
    const p = this.planePoint(ray, cur, cl.upAxis);
    if (!p) return;
    const { a, b } = axesOf(cl.upAxis);
    const comp = (v: { x: number; y: number; z: number }, i: number) => (i === 0 ? v.x : i === 1 ? v.y : v.z);
    const na = comp(p, a) - mv.off[0], nb = comp(p, b) - mv.off[1];
    this.ctx.store.liveMutate((proj) => {
      const t = proj.clouds?.find((c) => c.id === cl.id)?.cuboids.find((c) => c.id === mv.id);
      if (!t) return;
      const set = (i: number, v: number) => { if (i === 0) t.center.x = v; else if (i === 1) t.center.y = v; else t.center.z = v; };
      set(a, na); set(b, nb);
    });
  }

  private onUp(e: PointerEvent): void {
    const pr = this.press;
    this.press = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    if (this.controls) this.controls.enabled = true;
    const rect = this.rect; this.rect = null; this.rectEl.style.display = 'none';
    const mv = this.move; this.move = null;
    if (mv) this.ctx.store.endGesture(!!pr?.moved);
    if (!pr || e.type === 'pointercancel') return;
    const rt = this.activeRuntime(), cam = this.camera, T = this.T;
    if (rect && rt && cam && T) {
      const proj = this.projectAll(rt);
      if (proj) this.setFlags(pointsInRect(proj, rect.x0, rect.y0, rect.x1, rect.y1), true);
      return;
    }
    if (pr.moved || mv) return; // an orbit/move drag, not a click
    if (this.tool === 'add' && rt) {
      const proj = this.projectAll(rt), n = this.ndcOf(e);
      const i = proj ? pickPoint(proj, n.px, n.py, 10) : -1;
      if (i < 0) { this.ctx.toast('No point near the click. Click directly on the cloud.'); return; }
      const P = rt.data.positions;
      this.addCuboidAt({ x: P[i * 3], y: P[i * 3 + 1], z: P[i * 3 + 2] });
      return;
    }
    if (this.tool === 'select' && !this.hitCuboid(e)) { this.activeCuboidId = null; this.sig = ''; this.linesSig = ''; this.render(); }
  }

  private projectAll(rt: Runtime): Float32Array | null {
    const { T, camera } = this;
    if (!T || !camera) return null;
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
    const m = new T.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    return screenProject(rt.data.positions, m.elements, this.canvas.clientWidth, this.canvas.clientHeight);
  }

  // ---------------------------------------------------------------- panels

  render(): void {
    const clouds = this.clouds();
    if (!this.activeCloudId || !clouds.some((c) => c.id === this.activeCloudId)) this.activeCloudId = clouds[0]?.id ?? null;
    const cl = this.activeCloud();
    const rt = this.activeRuntime();
    if (cl && !rt && getSourceFile(cl.id)) void this.loadFromCache(cl);

    for (const [t, b] of this.toolBtns) { b.classList.toggle('active', t === this.tool); b.setAttribute('aria-pressed', String(t === this.tool)); }
    this.empty.style.display = clouds.length ? 'none' : 'flex';
    this.canvas.style.display = clouds.length ? '' : 'none';
    this.notice.textContent = cl && !rt
      ? `"${cl.name}" is not loaded. Add the cloud file again (Add cloud) to relink it; its saved annotations are kept.`
      : cl ? 'Drag to orbit, right-drag to pan, wheel to zoom. Shift+drag selects points. Drag a cuboid to move it.' : '';

    this.syncPoints();
    this.paint();
    this.drawCuboids();
    this.renderPanels(clouds, cl);
  }

  private async loadFromCache(c: CloudEntry): Promise<void> {
    const f = getSourceFile(c.id);
    if (!f || this.runtimes.has(c.id)) return;
    try {
      const data = await loadCloudFile(f as File);
      if (data.pointCount !== c.pointCount) { this.ctx.toast(`${c.name}: stored file does not match the saved annotations.`); return; }
      this.runtimes.set(c.id, { data, ext: extentOf(data.positions) });
      this.render();
    } catch { /* leave as "not loaded" */ }
  }

  private num(label: string, value: number, min: number, max: number, step: number, disabled: boolean, onSet: (v: number) => void): HTMLElement {
    const r = (v: number) => Math.round(v * 1e4) / 1e4;
    const input = h('input', {
      class: 'select', type: 'number', min, max, step, value: r(value), disabled, 'aria-label': label,
      onchange: (e: Event) => {
        const v = Number((e.target as HTMLInputElement).value);
        if (!Number.isFinite(v) || v < min || v > max) { (e.target as HTMLInputElement).value = String(r(value)); this.ctx.toast(`${label} must be between ${min} and ${max}.`); return; }
        onSet(v);
      },
    });
    return h('label', { class: 'field' }, h('span', {}, label), input);
  }

  private renderPanels(clouds: CloudEntry[], cl: CloudEntry | null): void {
    const { store } = this.ctx;
    const classes = store.getProject().classes;
    const sig = JSON.stringify([this.activeCloudId, this.activeCuboidId, this.flagCount, this.tool, [...this.runtimes.keys()],
      clouds.map((x) => [x.id, x.name, x.pointCount, x.upAxis, x.cuboids, x.pointLabels.map((l) => [l.id, l.classId, rangesCount(l.ranges)])]), classes.map((c) => [c.id, c.name, c.color])]);
    if (sig === this.sig) return;
    this.sig = sig;

    clear(this.cloudList);
    if (!clouds.length) this.cloudList.appendChild(h('p', { class: 'hint' }, 'No point clouds yet.'));
    for (const x of clouds) {
      const loaded = this.runtimes.has(x.id);
      this.cloudList.appendChild(h('div', {
        class: 'row image-row' + (x.id === this.activeCloudId ? ' active' : ''), role: 'listitem', tabindex: 0,
        onclick: () => this.selectCloud(x.id),
        onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') this.selectCloud(x.id); },
      },
        h('div', { class: 'thumb' + (loaded ? '' : ' missing') }, x.format.toUpperCase()),
        h('div', { class: 'grow' }, h('div', { class: 'name', title: x.name }, x.name),
          h('div', { class: 'sub' }, `${x.pointCount.toLocaleString()} points · ${x.cuboids.length} cuboid${x.cuboids.length === 1 ? '' : 's'}${loaded ? '' : ' · not loaded'}`)),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Remove ${x.name}`, onclick: (e: Event) => { e.stopPropagation(); this.removeCloud(x); } }, '×')));
    }

    clear(this.cuboidList);
    const cubs = cl?.cuboids ?? [];
    if (!cubs.length) this.cuboidList.appendChild(h('p', { class: 'hint' }, cl ? 'No cuboids yet. Press C, then click a point on the object.' : 'Add a point cloud to start.'));
    for (const b of cubs) {
      const cls = classes.find((c) => c.id === b.classId);
      this.cuboidList.appendChild(h('div', {
        class: 'row ann-row' + (b.id === this.activeCuboidId ? ' active' : '') + (b.hidden ? ' dim' : ''), role: 'listitem',
        onclick: () => { this.activeCuboidId = b.id; this.sig = ''; this.linesSig = ''; this.render(); },
      },
        h('span', { class: 'dot', style: `background:${cls?.color ?? '#f0f'}` }),
        h('div', { class: 'grow' }, h('div', { class: 'name' }, cls?.name ?? 'unknown class'), h('div', { class: 'sub' }, `object #${b.objectId}`)),
        h('button', { class: 'icon-btn' + (b.hidden ? ' on' : ''), type: 'button', 'aria-pressed': String(!!b.hidden), onclick: (e: Event) => { e.stopPropagation(); this.patchCuboid(b.id, { hidden: !b.hidden }); } }, b.hidden ? 'Show' : 'Hide'),
        h('button', { class: 'icon-btn' + (b.locked ? ' on' : ''), type: 'button', 'aria-pressed': String(!!b.locked), onclick: (e: Event) => { e.stopPropagation(); this.patchCuboid(b.id, { locked: !b.locked }); } }, b.locked ? 'Unlock' : 'Lock'),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Delete cuboid', onclick: (e: Event) => { e.stopPropagation(); this.activeCuboidId = b.id; this.deleteCuboid(); } }, '×')));
    }

    clear(this.props);
    if (cl) {
      const upSel = h('select', {
        class: 'select', 'aria-label': 'Up axis',
        onchange: (e: Event) => {
          const v = (e.target as HTMLSelectElement).value as UpAxis;
          this.ctx.store.mutate((p) => { const c = p.clouds?.find((x) => x.id === cl.id); if (c) c.upAxis = v; });
          this.paintSig = ''; this.shownCloudId = null; this.render();
        },
      }, h('option', { value: 'z' }, 'Z is up'), h('option', { value: 'y' }, 'Y is up'));
      upSel.value = cl.upAxis;
      this.props.appendChild(h('label', { class: 'field' }, h('span', {}, 'Up axis of this cloud (cuboid yaw rotates about it)'), upSel));
    }
    const sel = this.activeCuboid();
    if (sel && cl) {
      const dis = !!sel.locked;
      const csel = h('select', { class: 'select', 'aria-label': 'Cuboid class', disabled: dis, onchange: (e: Event) => this.patchCuboid(sel.id, { classId: (e.target as HTMLSelectElement).value }) });
      for (const c of classes) { const o = h('option', { value: c.id }, c.name); if (c.id === sel.classId) o.selected = true; csel.appendChild(o); }
      const size = (k: 'length' | 'width' | 'height') => this.num(k[0].toUpperCase() + k.slice(1), sel.size[k], 0.0001, 1e9, 0.1, dis, (v) => this.editCuboid((c) => ({ ...c, size: { ...c.size, [k]: v } })));
      const ctr = (k: 'x' | 'y' | 'z') => this.num(`Center ${k}`, sel.center[k], -1e9, 1e9, 0.1, dis, (v) => this.editCuboid((c) => ({ ...c, center: { ...c.center, [k]: v } })));
      this.props.appendChild(h('div', { class: 'cuboid-props' },
        h('label', { class: 'field' }, h('span', {}, 'Class'), csel),
        size('length'), size('width'), size('height'), ctr('x'), ctr('y'), ctr('z'),
        this.num('Yaw (degrees)', (sel.yaw * 180) / Math.PI, -180, 180, 1, dis, (v) => this.editCuboid((c) => ({ ...c, yaw: wrapYaw((v * Math.PI) / 180) }))),
        h('div', { class: 'btn-row' }, h('button', { class: 'btn small', type: 'button', onclick: () => {
          const rt = this.activeRuntime();
          if (!rt) { this.ctx.toast('Load the cloud file first.'); return; }
          const idx = pointsInCuboid(rt.data.positions, sel, cl.upAxis);
          this.setFlags(idx, false);
          this.ctx.toast(`${idx.length.toLocaleString()} points inside this cuboid are selected. Pick a class and press Enter to label them.`);
        } }, 'Select points inside')),
        h('p', { class: 'hint' }, 'Drag the cuboid to move it on the ground plane. Q/E rotate, H hide, L lock, Delete removes. Edit size and height in the fields.')));
    }

    this.selInfo.textContent = this.flagCount
      ? `${this.flagCount.toLocaleString()} point${this.flagCount === 1 ? '' : 's'} selected. Pick a class, then press Enter to label them.`
      : 'Shift+drag a rectangle to select points (it selects through the cloud; there is no occlusion test).';

    clear(this.labelList);
    const labels = cl?.pointLabels ?? [];
    if (!labels.length) this.labelList.appendChild(h('p', { class: 'hint' }, cl ? 'No labeled points yet.' : ''));
    for (const l of labels) {
      const cls = classes.find((c) => c.id === l.classId);
      this.labelList.appendChild(h('div', { class: 'row ann-row', role: 'listitem' },
        h('span', { class: 'dot', style: `background:${cls?.color ?? '#f0f'}` }),
        h('div', { class: 'grow' }, h('div', { class: 'name' }, cls?.name ?? 'unknown class'), h('div', { class: 'sub' }, `${rangesCount(l.ranges).toLocaleString()} points`)),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Remove label', onclick: () => this.deletePointLabel(l.id) }, '×')));
    }
  }
}

function hexRgb(hex: string): number[] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Blue -> cyan -> green -> yellow -> red ramp for t in 0..1. */
function ramp(t0: number, out: Float32Array, o: number): void {
  const t = Math.min(1, Math.max(0, t0));
  const s = t * 4;
  const k = Math.min(3, Math.floor(s)), f = s - k;
  const stops = [[0.15, 0.25, 0.9], [0.1, 0.8, 0.9], [0.2, 0.85, 0.3], [0.95, 0.9, 0.2], [0.95, 0.25, 0.15]];
  out[o] = stops[k][0] + (stops[k + 1][0] - stops[k][0]) * f;
  out[o + 1] = stops[k][1] + (stops[k + 1][1] - stops[k][1]) * f;
  out[o + 2] = stops[k][2] + (stops[k + 1][2] - stops[k][2]) * f;
}
