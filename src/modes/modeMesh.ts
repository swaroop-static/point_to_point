import type * as THREE_NS from 'three';
import type { OrbitControls as OrbitControlsT } from 'three/addons/controls/OrbitControls.js';
import type { MeshEntry, MeshLabel } from '../core/types';
import { newAnnotationId, newImageId } from '../core/ids';
import { getSourceFile, setSourceFile } from '../io/images';
import { pickFiles } from '../io/download';
import { downloadMeshAnnotations } from '../io/meshExport';
import { loadMeshFile, meshFormatOf, type LoadedMesh } from '../mesh/load';
import {
  buildAdjacency, faceNormals, facesToRanges, growRegion, rangesCount, rangesToFaces, subtractFaces, type Adjacency,
} from '../mesh/faces';
import { isTypingTarget } from '../workspaces/image2d/workspace';
import { clear, h } from '../ui/dom';
import type { ExportItem, ModeContext, ModeController } from '../ui/mode';

type Pick = 'face' | 'region' | 'part';
const ACCEPT = '.glb,.gltf,.obj,.ply';
const BASE = [0.72, 0.74, 0.78];
const SELECT = [1.0, 0.86, 0.25];

interface Runtime {
  data: LoadedMesh;
  normals: Float32Array;
  adj: Adjacency | null;
}

/**
 * Mesh annotation: load a 3D model, pick faces (single face, smooth region,
 * or whole connected part), and assign them a class as a numbered object.
 * Labels live in the project (project.meshes); the model stays a local file.
 */
export class ModeMesh implements ModeController {
  readonly id = 'mesh' as const;
  readonly label = '3D model';
  readonly toolbar: HTMLElement;
  readonly stage: HTMLElement;
  readonly rightPanel: HTMLElement;
  readonly leftPanel: HTMLElement;

  private canvas = document.createElement('canvas');
  private empty: HTMLElement;
  private notice: HTMLElement;
  private meshList: HTMLElement;
  private labelList: HTMLElement;
  private selInfo: HTMLElement;
  private pickBtns = new Map<Pick, HTMLButtonElement>();
  private angleInput: HTMLInputElement;
  private angleText: HTMLElement;
  private pickMode: Pick = 'region';
  private angle = 25;
  private wire = false;

  private activeMeshId: string | null = null;
  private activeLabelId: string | null = null;
  private runtimes = new Map<string, Runtime>();
  private selected = new Set<number>();
  private sig = '';
  private paintSig = '';

  // three.js, created on first activation
  private T: typeof THREE_NS | null = null;
  private renderer: THREE_NS.WebGLRenderer | null = null;
  private scene: THREE_NS.Scene | null = null;
  private camera: THREE_NS.PerspectiveCamera | null = null;
  private controls: OrbitControlsT | null = null;
  private mesh: THREE_NS.Mesh | null = null;
  private shownMeshId: string | null = null;
  private initStarted = false;
  private drawQueued = false;
  private down: { x: number; y: number } | null = null;

  constructor(private ctx: ModeContext) {
    const mkPick = (p: Pick, label: string, key: string) => {
      const b = h('button', { class: 'btn tool', type: 'button', title: `${label} (${key})`, onclick: () => this.setPick(p) }, label);
      this.pickBtns.set(p, b);
      return b;
    };
    this.angleInput = h('input', {
      type: 'range', min: 1, max: 90, step: 1, value: this.angle, 'aria-label': 'Region angle in degrees',
      oninput: (e: Event) => { this.angle = Number((e.target as HTMLInputElement).value); this.angleText.textContent = `${this.angle}°`; },
    }) as HTMLInputElement;
    this.angleText = h('span', { class: 'sub' }, `${this.angle}°`);
    this.toolbar = h('div', { class: 'mode-toolbar' },
      h('div', { class: 'btn-group', role: 'group', 'aria-label': 'Selection' },
        mkPick('face', 'Face', 'F'), mkPick('region', 'Region', 'R'), mkPick('part', 'Part', 'O')),
      h('div', { class: 'btn-group' },
        h('button', { class: 'btn', type: 'button', title: 'Reset view (V)', onclick: () => this.resetView() }, 'Reset view'),
        h('button', { class: 'btn', type: 'button', title: 'Toggle wireframe (W)', onclick: () => this.toggleWire() }, 'Wireframe')),
    );

    this.empty = h('div', { class: 'empty' },
      h('h1', {}, 'Drop a 3D model to annotate'),
      h('p', {}, '.glb, .gltf (self-contained), .obj or .ply with faces. Files stay on your computer; nothing is uploaded.'),
      h('button', { class: 'btn primary', type: 'button', onclick: () => void this.pick() }, 'Choose 3D model'),
    );
    this.notice = h('div', { class: 'hint', style: 'position:absolute;left:12px;bottom:10px;max-width:60%;pointer-events:none' });
    this.canvas.className = 'stage-canvas';
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('aria-label', '3D model viewport');
    this.stage = h('div', { class: 'stage' }, this.canvas, this.empty, this.notice);

    this.meshList = h('div', { class: 'list', role: 'list' });
    this.leftPanel = h('div', { class: 'images-panel' },
      h('div', { class: 'panel-head' }, h('h2', {}, '3D models'),
        h('button', { class: 'btn small', type: 'button', onclick: () => void this.pick() }, 'Add model')),
      this.meshList);

    this.selInfo = h('p', { class: 'hint' });
    this.labelList = h('div', { class: 'list', role: 'list' });
    this.rightPanel = h('div', {},
      h('div', { class: 'panel-head' }, h('h2', {}, 'Selection')),
      h('div', { class: 'props' },
        h('label', { class: 'field' }, h('span', {}, 'Region angle limit (used by Region)'), this.angleInput, this.angleText),
        this.selInfo,
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn small primary', type: 'button', onclick: () => this.assign() }, 'Label selection (Enter)'),
          h('button', { class: 'btn small', type: 'button', onclick: () => this.clearSelection() }, 'Clear (Esc)'))),
      h('div', { class: 'panel-head' }, h('h2', {}, 'Labeled objects')),
      this.labelList);

    new ResizeObserver(() => this.resize()).observe(this.stage);
    this.canvas.addEventListener('pointerdown', (e) => { this.down = { x: e.clientX, y: e.clientY }; });
    this.canvas.addEventListener('pointerup', (e) => this.onUp(e));
  }

  // ---------------------------------------------------------------- mode API

  activate(): void { this.ctx.setCursorText(''); this.ctx.setZoomText(''); void this.ensureThree(); this.render(); }
  deactivate(): void { /* keep GPU state; nothing to cancel */ }

  async handleFiles(files: File[]): Promise<void> {
    for (const f of files) {
      try {
        if (!meshFormatOf(f.name)) { this.ctx.toast(`${f.name}: unsupported. Use .glb, .gltf, .obj or .ply.`); continue; }
        this.ctx.toast(`Reading ${f.name}...`);
        await new Promise((r) => setTimeout(r, 20));
        const data = await loadMeshFile(f);
        const proj = this.ctx.store.getProject();
        const existing = (proj.meshes ?? []).find((m) => m.name === f.name);
        if (existing) {
          if (existing.faceCount !== data.faceCount) {
            this.ctx.toast(`${f.name} has ${data.faceCount} faces but the saved labels are for ${existing.faceCount}. It looks like a different model, so it was not linked.`);
            continue;
          }
          setSourceFile(existing.id, f);
          this.runtimes.set(existing.id, this.makeRuntime(data));
          this.selectMesh(existing.id);
          this.ctx.toast(`Linked ${f.name} to its saved labels.`);
          continue;
        }
        const entry: MeshEntry = { id: newImageId().replace('img_', 'msh_'), name: f.name, format: data.format, faceCount: data.faceCount, labels: [] };
        setSourceFile(entry.id, f);
        this.runtimes.set(entry.id, this.makeRuntime(data));
        this.ctx.store.mutate((p) => { (p.meshes ??= []).push(entry); });
        this.selectMesh(entry.id);
        this.ctx.toast(`Loaded ${f.name}: ${data.faceCount.toLocaleString()} triangles.`);
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
    const m = this.activeMesh(), l = m?.labels.find((x) => x.id === this.activeLabelId);
    if (m && l && l.classId !== classId) this.patchLabel(m.id, l.id, { classId });
  }

  classCounts(): Map<string, number> {
    const out = new Map<string, number>();
    for (const l of this.activeMesh()?.labels ?? []) out.set(l.classId, (out.get(l.classId) ?? 0) + 1);
    return out;
  }

  exportItems(): ExportItem[] {
    return [{
      label: 'Mesh annotations JSON',
      run: () => {
        const proj = this.ctx.store.getProject();
        if (!(proj.meshes ?? []).some((m) => m.labels.length)) { this.ctx.toast('Label some faces before exporting.'); return; }
        const { objects, warnings } = downloadMeshAnnotations(proj);
        this.ctx.toast(`Exported ${objects} labeled object${objects === 1 ? '' : 's'}.`);
        for (const w of warnings.slice(0, 3)) this.ctx.toast(`Export note: ${w}`);
      },
    }];
  }

  statusLeft(): string {
    const m = this.activeMesh();
    return m ? `${m.name} · ${m.faceCount.toLocaleString()} triangles` : 'No model';
  }
  statusCount(): string {
    const m = this.activeMesh();
    if (!m) return '';
    const labeled = m.labels.reduce((n, l) => n + rangesCount(l.ranges), 0);
    return `${m.labels.length} object${m.labels.length === 1 ? '' : 's'} · ${labeled.toLocaleString()} labeled faces · ${this.selected.size.toLocaleString()} selected`;
  }

  // ---------------------------------------------------------------- state helpers

  private meshes(): MeshEntry[] { return this.ctx.store.getProject().meshes ?? []; }
  private activeMesh(): MeshEntry | null { return this.meshes().find((m) => m.id === this.activeMeshId) ?? null; }

  private makeRuntime(data: LoadedMesh): Runtime { return { data, normals: faceNormals(data.positions), adj: null }; }

  private selectMesh(id: string | null): void {
    this.activeMeshId = id; this.activeLabelId = null; this.selected.clear(); this.paintSig = ''; this.sig = '';
    this.render();
  }

  private setPick(p: Pick): void { this.pickMode = p; this.render(); }
  private clearSelection(): void { this.selected.clear(); this.activeLabelId = null; this.sig = ''; this.paintSig = ''; this.render(); }
  private toggleWire(): void {
    this.wire = !this.wire;
    if (this.mesh) (this.mesh.material as THREE_NS.MeshLambertMaterial).wireframe = this.wire;
    this.queueDraw();
  }

  private patchLabel(meshId: string, labelId: string, patch: Partial<MeshLabel>): void {
    this.ctx.store.mutate((p) => {
      const l = p.meshes?.find((m) => m.id === meshId)?.labels.find((x) => x.id === labelId);
      if (l) Object.assign(l, patch);
    });
  }

  private deleteLabel(meshId: string, labelId: string): void {
    this.ctx.store.mutate((p) => {
      const m = p.meshes?.find((x) => x.id === meshId);
      if (m) m.labels = m.labels.filter((l) => l.id !== labelId);
    });
    if (this.activeLabelId === labelId) { this.activeLabelId = null; this.selected.clear(); }
    this.paintSig = ''; this.render();
  }

  private removeMesh(m: MeshEntry): void {
    if (m.labels.length && !confirm(`Remove "${m.name}" and its ${m.labels.length} labeled object(s) from this project? You can undo this.`)) return;
    this.ctx.store.mutate((p) => { p.meshes = (p.meshes ?? []).filter((x) => x.id !== m.id); });
    this.runtimes.delete(m.id);
    if (this.activeMeshId === m.id) this.selectMesh(this.meshes()[0]?.id ?? null);
  }

  private assign(): void {
    const m = this.activeMesh();
    if (!m) return;
    if (!this.selected.size) { this.ctx.toast('Select some faces first (click the model).'); return; }
    const cls = this.ctx.store.getActiveClass();
    if (!cls) { this.ctx.toast('Create a class first.'); return; }
    const faces = new Set(this.selected);
    const id = newAnnotationId();
    let objectId = 0;
    this.ctx.store.mutate((p) => {
      const t = p.meshes?.find((x) => x.id === m.id);
      if (!t) return false;
      // A face can have only one label: take these faces away from older ones.
      t.labels = t.labels
        .map((l) => ({ ...l, ranges: subtractFaces(l.ranges, faces) }))
        .filter((l) => l.ranges.length > 0);
      objectId = t.labels.reduce((mx, l) => Math.max(mx, l.objectId), 0) + 1;
      t.labels.push({ id, objectId, classId: cls.id, ranges: facesToRanges(faces) });
    });
    this.selected.clear();
    this.activeLabelId = id;
    this.ctx.toast(`Labeled ${faces.size.toLocaleString()} faces as ${cls.name} #${objectId}.`);
    this.paintSig = ''; this.render();
  }

  // ---------------------------------------------------------------- keyboard

  handleKey(e: KeyboardEvent): boolean {
    if (isTypingTarget(e.target)) return false;
    const m = this.activeMesh();
    switch (e.key) {
      case 'f': case 'F': this.setPick('face'); return true;
      case 'r': case 'R': this.setPick('region'); return true;
      case 'o': case 'O': this.setPick('part'); return true;
      case 'v': case 'V': this.resetView(); return true;
      case 'w': case 'W': this.toggleWire(); return true;
      case 'Enter': this.assign(); return true;
      case 'Escape': this.clearSelection(); return true;
      case 'Delete': case 'Backspace':
        e.preventDefault();
        if (m && this.activeLabelId) this.deleteLabel(m.id, this.activeLabelId);
        return true;
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
      scene.background = new T.Color(0x2a2e35);
      scene.add(new T.AmbientLight(0xffffff, 0.75));
      const sun = new T.DirectionalLight(0xffffff, 1.4);
      sun.position.set(3, 5, 4);
      scene.add(sun);
      const camera = new T.PerspectiveCamera(45, 1, 0.01, 1000);
      camera.add(new T.PointLight(0xffffff, 0.0)); // placeholder so camera lights can be added later without API change
      const controls = new OrbitControls(camera, this.canvas);
      controls.addEventListener('change', () => this.queueDraw());
      this.T = T; this.renderer = renderer; this.scene = scene; this.camera = camera; this.controls = controls;
      this.resize();
      this.render();
    } catch (e) {
      this.initStarted = false;
      this.ctx.toast(`3D view is unavailable: ${e instanceof Error ? e.message : 'WebGL could not start.'}`);
    }
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

  private resetView(): void {
    const { T, mesh, camera, controls } = this;
    if (!T || !mesh || !camera || !controls) return;
    mesh.geometry.computeBoundingBox();
    const box = mesh.geometry.boundingBox!;
    const center = box.getCenter(new T.Vector3());
    const radius = (box.getSize(new T.Vector3()).length() / 2) || 1;
    // Distance at which the bounding sphere fits both vertically and horizontally.
    const vHalf = (camera.fov * Math.PI) / 360;
    const hHalf = Math.atan(Math.tan(vHalf) * camera.aspect);
    const dist = (radius / Math.sin(Math.min(vHalf, hHalf))) * 1.1;
    camera.near = dist / 1000; camera.far = dist * 20; camera.updateProjectionMatrix();
    camera.position.copy(center).add(new T.Vector3(0.6, 0.45, 1).normalize().multiplyScalar(dist));
    controls.target.copy(center);
    controls.update();
    this.queueDraw();
  }

  /** Make the three.js mesh match the active model (rebuilds geometry only when the model changes). */
  private syncMesh(): void {
    const { T, scene } = this;
    if (!T || !scene) return;
    const id = this.activeMeshId;
    const rt = id ? this.runtimes.get(id) : undefined;
    if (this.shownMeshId !== (rt ? id : null)) {
      if (this.mesh) {
        scene.remove(this.mesh);
        this.mesh.geometry.dispose();
        (this.mesh.material as THREE_NS.Material).dispose();
        this.mesh = null;
      }
      this.shownMeshId = null;
      if (rt && id) {
        const g = new T.BufferGeometry();
        const n = rt.data.faceCount;
        g.setAttribute('position', new T.BufferAttribute(rt.data.positions, 3));
        const nor = new Float32Array(n * 9);
        for (let f = 0; f < n; f++) for (let k = 0; k < 3; k++) {
          nor[f * 9 + k * 3] = rt.normals[f * 3]; nor[f * 9 + k * 3 + 1] = rt.normals[f * 3 + 1]; nor[f * 9 + k * 3 + 2] = rt.normals[f * 3 + 2];
        }
        g.setAttribute('normal', new T.BufferAttribute(nor, 3));
        g.setAttribute('color', new T.BufferAttribute(new Float32Array(n * 9), 3));
        const mat = new T.MeshLambertMaterial({ vertexColors: true, side: T.DoubleSide, wireframe: this.wire });
        this.mesh = new T.Mesh(g, mat);
        scene.add(this.mesh);
        this.shownMeshId = id;
        this.paintSig = '';
        this.resetView();
      }
    }
  }

  private paint(): void {
    const m = this.activeMesh(), mesh = this.mesh, rt = m ? this.runtimes.get(m.id) : undefined;
    if (!m || !mesh || !rt) return;
    const classes = this.ctx.store.getProject().classes;
    const sig = JSON.stringify([m.id, m.labels.map((l) => [l.id, l.classId, l.hidden, l.ranges.length, rangesCount(l.ranges)]), classes.map((c) => [c.id, c.color]), this.selected.size, this.activeLabelId]) + [...this.selected].slice(0, 50).join(',');
    if (sig === this.paintSig) return;
    this.paintSig = sig;
    const n = rt.data.faceCount;
    const lof = new Int32Array(n).fill(-1);
    m.labels.forEach((l, i) => { if (!l.hidden) for (const [s, e] of l.ranges) lof.fill(i, s, e); });
    const colorOf = new Map(classes.map((c) => [c.id, hexRgb(c.color)]));
    const attr = mesh.geometry.getAttribute('color') as THREE_NS.BufferAttribute;
    const arr = attr.array as Float32Array;
    for (let f = 0; f < n; f++) {
      const li = lof[f];
      const c = this.selected.has(f) ? SELECT : li >= 0 ? (colorOf.get(m.labels[li].classId) ?? BASE) : BASE;
      for (let k = 0; k < 3; k++) { arr[f * 9 + k * 3] = c[0]; arr[f * 9 + k * 3 + 1] = c[1]; arr[f * 9 + k * 3 + 2] = c[2]; }
    }
    attr.needsUpdate = true;
    this.queueDraw();
  }

  private onUp(e: PointerEvent): void {
    const d = this.down; this.down = null;
    if (!d || e.button !== 0 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return; // it was an orbit drag
    const { T, mesh, camera } = this;
    const m = this.activeMesh(), rt = m ? this.runtimes.get(m.id) : undefined;
    if (!T || !mesh || !camera || !m || !rt) return;
    const r = this.canvas.getBoundingClientRect();
    const ndc = new T.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = new T.Raycaster();
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObject(mesh, false)[0];
    if (!hit || hit.faceIndex === undefined || hit.faceIndex === null) {
      if (!e.shiftKey) this.clearSelection();
      return;
    }
    const f = hit.faceIndex;
    let faces: number[];
    if (this.pickMode === 'face') faces = [f];
    else {
      rt.adj ??= buildAdjacency(rt.data.positions);
      faces = growRegion(rt.adj, rt.normals, f, this.pickMode === 'part' ? 180 : this.angle);
    }
    // The pick mode always does what its button says; select an existing object from the list on the right.
    if (!e.shiftKey) { this.selected.clear(); this.activeLabelId = null; }
    for (const g of faces) this.selected.add(g);
    this.sig = ''; this.paintSig = '';
    this.render();
  }

  // ---------------------------------------------------------------- panels

  render(): void {
    const { store } = this.ctx;
    const meshes = this.meshes();
    if (!this.activeMeshId || !meshes.some((m) => m.id === this.activeMeshId)) this.activeMeshId = meshes[0]?.id ?? null;
    const m = this.activeMesh();
    const rt = m ? this.runtimes.get(m.id) : undefined;
    // Load a model that has a source file in memory (e.g. restored from autosave) but no runtime yet.
    if (m && !rt && getSourceFile(m.id)) void this.loadFromCache(m);

    for (const [p, b] of this.pickBtns) { b.classList.toggle('active', p === this.pickMode); b.setAttribute('aria-pressed', String(p === this.pickMode)); }
    this.angleInput.disabled = this.pickMode !== 'region';
    this.empty.style.display = meshes.length ? 'none' : 'flex';
    this.canvas.style.display = meshes.length ? '' : 'none';
    this.notice.textContent = m && !rt
      ? `"${m.name}" is not loaded. Add the model file again (Add model) to relink it; its ${m.labels.length} saved object(s) are kept.`
      : m ? 'Drag to orbit, right-drag to pan, wheel to zoom. Click to select; Shift+click adds.' : '';

    this.syncMesh();
    this.paint();
    this.renderPanels(meshes, m);
    void store;
  }

  private async loadFromCache(m: MeshEntry): Promise<void> {
    const f = getSourceFile(m.id);
    if (!f || this.runtimes.has(m.id)) return;
    try {
      const data = await loadMeshFile(f as File);
      if (data.faceCount !== m.faceCount) { this.ctx.toast(`${m.name}: stored file does not match the saved labels.`); return; }
      this.runtimes.set(m.id, this.makeRuntime(data));
      this.render();
    } catch { /* leave as "not loaded" */ }
  }

  private renderPanels(meshes: MeshEntry[], m: MeshEntry | null): void {
    const { store } = this.ctx;
    const classes = store.getProject().classes;
    const sig = JSON.stringify([this.activeMeshId, this.activeLabelId, this.selected.size, [...this.runtimes.keys()],
      meshes.map((x) => [x.id, x.name, x.faceCount, x.labels]), classes.map((c) => [c.id, c.name, c.color])]);
    if (sig === this.sig) return;
    this.sig = sig;

    clear(this.meshList);
    if (!meshes.length) this.meshList.appendChild(h('p', { class: 'hint' }, 'No models yet.'));
    for (const x of meshes) {
      this.meshList.appendChild(h('div', {
        class: 'row image-row' + (x.id === this.activeMeshId ? ' active' : ''), role: 'listitem', tabindex: 0,
        onclick: () => this.selectMesh(x.id),
        onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') this.selectMesh(x.id); },
      },
        h('div', { class: 'thumb' + (this.runtimes.has(x.id) ? '' : ' missing'), title: x.format.toUpperCase() }, x.format.toUpperCase()),
        h('div', { class: 'grow' },
          h('div', { class: 'name', title: x.name }, x.name),
          h('div', { class: 'sub' }, `${x.faceCount.toLocaleString()} faces · ${x.labels.length} object${x.labels.length === 1 ? '' : 's'}${this.runtimes.has(x.id) ? '' : ' · not loaded'}`)),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Remove ${x.name}`, title: 'Remove from project',
          onclick: (e: Event) => { e.stopPropagation(); this.removeMesh(x); } }, '×')));
    }

    this.selInfo.textContent = this.selected.size
      ? `${this.selected.size.toLocaleString()} face${this.selected.size === 1 ? '' : 's'} selected. Pick a class on the right, then press Enter to label them.`
      : 'Click the model to select faces. Face = one triangle, Region = a smooth surface (angle limit), Part = a whole connected piece.';

    clear(this.labelList);
    const labels = m?.labels ?? [];
    if (!labels.length) this.labelList.appendChild(h('p', { class: 'hint' }, m ? 'Nothing labeled yet.' : 'Add a model to start.'));
    for (const l of labels) {
      const cls = classes.find((c) => c.id === l.classId);
      this.labelList.appendChild(h('div', {
        class: 'row ann-row' + (l.id === this.activeLabelId ? ' active' : '') + (l.hidden ? ' dim' : ''), role: 'listitem',
        onclick: () => {
          this.activeLabelId = l.id; this.selected = new Set(rangesToFaces(l.ranges)); this.sig = ''; this.paintSig = ''; this.render();
        },
      },
        h('span', { class: 'dot', style: `background:${cls?.color ?? '#f0f'}` }),
        h('div', { class: 'grow' },
          h('div', { class: 'name' }, cls?.name ?? 'unknown class'),
          h('div', { class: 'sub' }, `#${l.objectId} · ${rangesCount(l.ranges).toLocaleString()} faces`)),
        h('button', { class: 'icon-btn' + (l.hidden ? ' on' : ''), type: 'button', 'aria-pressed': String(!!l.hidden),
          onclick: (e: Event) => { e.stopPropagation(); this.patchLabel(m!.id, l.id, { hidden: !l.hidden }); } }, l.hidden ? 'Show' : 'Hide'),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Delete labeled object',
          onclick: (e: Event) => { e.stopPropagation(); this.deleteLabel(m!.id, l.id); } }, '×')));
    }
    if (m && labels.length) this.labelList.appendChild(h('p', { class: 'hint' }, 'Select an object, then click another class on the right to change its class. Delete removes it.'));
  }
}

function hexRgb(hex: string): number[] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
