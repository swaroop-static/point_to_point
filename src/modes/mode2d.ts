import type { Annotation, ImageEntry, Point2D, ToolName } from '../core/types';
import { simplifyClosed, simplifyOpen } from '../core/geometry';
import { addImageFiles } from '../io/imageImport';
import { downloadCoco } from '../io/coco';
import { exportYolo, type YoloMode } from '../io/yolo';
import { getSourceFile } from '../io/images';
import { makeZip } from '../io/zip';
import { downloadBytes, pickFiles, safeName, stamp } from '../io/download';
import { Image2DWorkspace, isTypingTarget } from '../workspaces/image2d/workspace';
import { clear, h } from '../ui/dom';
import type { ExportItem, ModeContext, ModeController } from '../ui/mode';

const TOOLS: { name: ToolName; label: string; key: string }[] = [
  { name: 'select', label: 'Select', key: 'V' },
  { name: 'box', label: 'Box', key: 'B' },
  { name: 'polygon', label: 'Polygon', key: 'P' },
  { name: 'polyline', label: 'Polyline', key: 'Y' },
  { name: 'keypoint', label: 'Keypoint', key: 'K' },
];

/** The 2D editor: boxes, polygons, polylines, keypoints on images. */
export class Mode2D implements ModeController {
  readonly id = '2d' as const;
  readonly label = '2D image';
  readonly toolbar: HTMLElement;
  readonly stage: HTMLElement;
  readonly rightPanel: HTMLElement;
  readonly leftPanel = null;

  private workspace: Image2DWorkspace;
  private toolBtns = new Map<ToolName, HTMLButtonElement>();
  private empty: HTMLElement;
  private annList: HTMLElement;
  private props: HTMLElement;
  private annSig = '';
  private simplifyTol = 2;

  constructor(private ctx: ModeContext) {
    const { store } = ctx;

    const toolGroup = h('div', { class: 'btn-group', role: 'group', 'aria-label': 'Tools' });
    for (const t of TOOLS) {
      const b = h('button', {
        class: 'btn tool', type: 'button', title: `${t.label} (${t.key})`,
        onclick: () => this.setTool(t.name),
      }, t.label);
      this.toolBtns.set(t.name, b);
      toolGroup.appendChild(b);
    }
    const zoomGroup = h('div', { class: 'btn-group' },
      h('button', { class: 'btn', type: 'button', title: 'Zoom out (-)', 'aria-label': 'Zoom out', onclick: () => this.workspace.zoomBy(0.8) }, '−'),
      h('button', { class: 'btn', type: 'button', title: 'Zoom in (+)', 'aria-label': 'Zoom in', onclick: () => this.workspace.zoomBy(1.25) }, '+'),
      h('button', { class: 'btn', type: 'button', title: 'Actual size (1:1)', onclick: () => this.workspace.resetZoom() }, '1:1'),
      h('button', { class: 'btn', type: 'button', title: 'Fit image to screen (F)', onclick: () => this.workspace.fit() }, 'Fit'),
    );
    this.toolbar = h('div', { class: 'mode-toolbar' }, toolGroup, zoomGroup);

    this.empty = h('div', { class: 'empty' },
      h('h1', {}, 'Drop images to start'),
      h('p', {}, 'JPEG, PNG or WebP. Files stay on your computer; nothing is uploaded.'),
      h('button', { class: 'btn primary', type: 'button', onclick: () => void this.pick() }, 'Choose images'),
    );
    this.stage = h('div', { class: 'stage' }, this.empty);

    this.annList = h('div', { class: 'list', role: 'list' });
    this.props = h('div', { class: 'props' });
    this.rightPanel = h('div', {},
      h('div', { class: 'panel-head' }, h('h2', {}, 'Annotations')),
      this.annList,
      this.props,
    );

    this.workspace = new Image2DWorkspace(this.stage, store, {
      onStatus: (s) => {
        ctx.setCursorText(s.cursor ? `x ${Math.round(s.cursor.x)}, y ${Math.round(s.cursor.y)}` : '');
        ctx.setZoomText(`${Math.round(s.scale * 100)}%`);
      },
      onNotice: (m) => ctx.toast(m),
    });
  }

  activate(): void { this.workspace.fit(); this.render(); }
  deactivate(): void { this.workspace.cancelDraft(); this.workspace.setPreview(null); }

  private async pick(): Promise<void> {
    const files = await pickFiles('image/jpeg,image/png,image/webp', true);
    if (files.length) await this.handleFiles(files);
  }

  async handleFiles(files: File[]): Promise<void> {
    await addImageFiles(this.ctx.store, files, (m) => this.ctx.toast(m));
  }

  onClassSelected(classId: string): void {
    const a = this.ctx.store.getSelectedAnnotation();
    if (a && !a.locked && a.classId !== classId) this.patchAnnotation(a.id, { classId });
  }

  exportItems(): ExportItem[] {
    return [
      { label: 'COCO JSON', run: () => this.exportCoco() },
      { label: 'YOLO detection (.zip)', run: () => this.exportYoloZip('detect') },
      { label: 'YOLO segmentation (.zip)', run: () => this.exportYoloZip('segment') },
    ];
  }

  statusLeft(): string {
    const img = this.ctx.store.getActiveImage();
    return img ? `${img.name} · ${img.width}×${img.height}px` : 'No image';
  }

  statusCount(): string {
    const img = this.ctx.store.getActiveImage();
    const total = this.ctx.store.getProject().images.reduce((n, i) => n + i.annotations.length, 0);
    return img ? `${img.annotations.length} on this image · ${total} total` : `${total} total`;
  }

  // ---------------------------------------------------------------- actions

  private setTool(t: ToolName): void {
    this.workspace.cancelDraft();
    this.ctx.store.setUI({ activeTool: t });
  }

  private patchAnnotation(annId: string, patch: Partial<Pick<Annotation, 'classId' | 'hidden' | 'locked'>>): void {
    const { store } = this.ctx;
    const imgId = store.getUI().activeImageId;
    store.mutate((p) => {
      const a = p.images.find((i) => i.id === imgId)?.annotations.find((x) => x.id === annId);
      if (a) Object.assign(a, patch);
    });
  }

  private toggleSelected(field: 'hidden' | 'locked'): void {
    const a = this.ctx.store.getSelectedAnnotation();
    if (a) this.patchAnnotation(a.id, field === 'hidden' ? { hidden: !a.hidden } : { locked: !a.locked });
  }

  private exportCoco(): void {
    const proj = this.ctx.store.getProject();
    if (!proj.images.length) { this.ctx.toast('Add at least one image before exporting.'); return; }
    const res = downloadCoco(proj);
    const n = res.dataset.annotations.length;
    this.ctx.toast(`COCO exported: ${n} annotation${n === 1 ? '' : 's'} across ${res.dataset.images.length} image(s).`);
    for (const w of res.warnings.slice(0, 3)) this.ctx.toast(`Export note: ${w}`);
  }

  private async exportYoloZip(mode: YoloMode): Promise<void> {
    const proj = this.ctx.store.getProject();
    if (!proj.images.length) { this.ctx.toast('Add at least one image before exporting.'); return; }
    this.ctx.toast('Building YOLO archive...');
    try {
      const res = await exportYolo(proj, mode, async (img) => {
        const f = getSourceFile(img.id);
        return f ? new Uint8Array(await f.arrayBuffer()) : null;
      });
      const zip = makeZip(res.entries);
      downloadBytes(`${safeName(proj.name)}_yolo-${mode}_${stamp()}.zip`, zip, 'application/zip');
      this.ctx.toast(`YOLO ${mode} exported: ${res.labelCount} label${res.labelCount === 1 ? '' : 's'} in ${proj.images.length} image(s).`);
      for (const w of res.warnings.slice(0, 3)) this.ctx.toast(`Export note: ${w}`);
    } catch (e) {
      this.ctx.toast(e instanceof Error ? e.message : 'YOLO export failed.');
    }
  }

  // ---------------------------------------------------------------- keyboard

  handleKey(e: KeyboardEvent): boolean {
    if (isTypingTarget(e.target)) return false;
    const { store } = this.ctx;
    switch (e.key) {
      case 'v': case 'V': this.setTool('select'); return true;
      case 'b': case 'B': this.setTool('box'); return true;
      case 'p': case 'P': this.setTool('polygon'); return true;
      case 'y': case 'Y': this.setTool('polyline'); return true;
      case 'k': case 'K': this.setTool('keypoint'); return true;
      case 'f': case 'F': this.workspace.fit(); return true;
      case '+': case '=': this.workspace.zoomBy(1.25); return true;
      case '-': case '_': this.workspace.zoomBy(0.8); return true;
      case 'Enter': this.workspace.finishDraft(); return true;
      case 'Escape':
        this.workspace.cancelDraft();
        this.workspace.setPreview(null);
        store.setUI({ selectedAnnotationId: null });
        return true;
      case 'Delete': case 'Backspace':
        e.preventDefault();
        this.workspace.deleteSelection();
        return true;
      case 'h': case 'H': this.toggleSelected('hidden'); return true;
      case 'l': case 'L': this.toggleSelected('locked'); return true;
      default: return false;
    }
  }

  // ---------------------------------------------------------------- rendering

  render(): void {
    const { store } = this.ctx;
    const ui = store.getUI();
    for (const [name, btn] of this.toolBtns) {
      btn.classList.toggle('active', name === ui.activeTool);
      btn.setAttribute('aria-pressed', String(name === ui.activeTool));
    }
    this.empty.style.display = store.getProject().images.length ? 'none' : 'flex';
    this.renderAnnotations(store.getActiveImage(), ui.selectedAnnotationId);
  }

  private renderAnnotations(img: ImageEntry | null, selectedId: string | null): void {
    const { store } = this.ctx;
    const classes = store.getProject().classes;
    const anns = img?.annotations ?? [];
    const sel = store.getSelectedAnnotation();
    const sig = JSON.stringify([
      selectedId, classes.map((c) => [c.id, c.name, c.color]),
      anns.map((a) => [a.id, a.classId, a.geom.kind, 'points' in a.geom ? a.geom.points.length : 0, a.hidden, a.locked]),
      sel ? 1 : 0,
    ]);
    if (sig === this.annSig) return;
    this.annSig = sig;
    this.workspace.setPreview(null);
    const list = this.annList;
    clear(list);
    if (!anns.length) {
      list.appendChild(h('p', { class: 'hint' }, img ? 'Nothing drawn yet. Pick a tool (B, P, Y or K) and draw.' : 'Add an image to start.'));
    }
    anns.forEach((a, idx) => {
      const cls = classes.find((c) => c.id === a.classId);
      list.appendChild(h('div', {
        class: 'row ann-row' + (a.id === selectedId ? ' active' : '') + (a.hidden ? ' dim' : ''), role: 'listitem',
        onclick: () => store.setUI({ selectedAnnotationId: a.id }),
      },
        h('span', { class: 'dot', style: `background:${cls?.color ?? '#f0f'}` }),
        h('div', { class: 'grow' },
          h('div', { class: 'name' }, `${cls?.name ?? 'unknown class'}`),
          h('div', { class: 'sub' }, `#${idx + 1} · ${describe(a)}`),
        ),
        h('button', {
          class: 'icon-btn' + (a.hidden ? ' on' : ''), type: 'button', title: a.hidden ? 'Show (H)' : 'Hide (H)',
          'aria-label': a.hidden ? 'Show annotation' : 'Hide annotation', 'aria-pressed': String(!!a.hidden),
          onclick: (e: Event) => { e.stopPropagation(); this.patchAnnotation(a.id, { hidden: !a.hidden }); },
        }, a.hidden ? 'Show' : 'Hide'),
        h('button', {
          class: 'icon-btn' + (a.locked ? ' on' : ''), type: 'button', title: a.locked ? 'Unlock (L)' : 'Lock (L)',
          'aria-label': a.locked ? 'Unlock annotation' : 'Lock annotation', 'aria-pressed': String(!!a.locked),
          onclick: (e: Event) => { e.stopPropagation(); this.patchAnnotation(a.id, { locked: !a.locked }); },
        }, a.locked ? 'Unlock' : 'Lock'),
        h('button', {
          class: 'icon-btn', type: 'button', title: 'Delete (Del)', 'aria-label': 'Delete annotation',
          onclick: (e: Event) => {
            e.stopPropagation();
            if (a.locked) { this.ctx.toast('This annotation is locked. Unlock it to delete.'); return; }
            this.workspace.deleteAnnotation(a.id);
          },
        }, '×'),
      ));
    });
    this.renderProps(sel);
  }

  private renderProps(sel: Annotation | null): void {
    const { store } = this.ctx;
    const classes = store.getProject().classes;
    const box = this.props;
    clear(box);
    if (!sel) return;
    const select = h('select', {
      class: 'select', 'aria-label': 'Class of selected annotation', disabled: !!sel.locked,
      onchange: (e: Event) => this.patchAnnotation(sel.id, { classId: (e.target as HTMLSelectElement).value }),
    });
    for (const c of classes) {
      const o = h('option', { value: c.id }, c.name);
      if (c.id === sel.classId) o.selected = true;
      select.appendChild(o);
    }
    box.appendChild(h('label', { class: 'field' }, h('span', {}, 'Class of selected annotation'), select));

    const g = sel.geom;
    if (g.kind === 'polygon' || g.kind === 'polyline') {
      const noun = g.kind === 'polygon' ? 'vertex' : 'point';
      const nounPl = g.kind === 'polygon' ? 'vertices' : 'points';
      box.appendChild(h('p', { class: 'hint' },
        `Drag a ${noun} to move it. Click an edge to add one. Double-click a ${noun} to remove it. Alt+drag an edge to move it. Hold Shift to snap.`));

      const result = h('span', { class: 'sub' });
      const apply = h('button', { class: 'btn small primary', type: 'button', disabled: !!sel.locked }, 'Simplify');
      const preview = h('button', { class: 'btn small', type: 'button' }, 'Preview');
      const slider = h('input', {
        type: 'range', min: 0.5, max: 20, step: 0.5, value: this.simplifyTol, 'aria-label': 'Simplification tolerance in image pixels',
      }) as HTMLInputElement;
      const compute = (): Point2D[] => {
        const cur = store.getSelectedAnnotation();
        if (!cur || (cur.geom.kind !== 'polygon' && cur.geom.kind !== 'polyline')) return [];
        return cur.geom.kind === 'polygon' ? simplifyClosed(cur.geom.points, this.simplifyTol) : simplifyOpen(cur.geom.points, this.simplifyTol);
      };
      const refresh = (): void => {
        const cur = store.getSelectedAnnotation();
        const before = cur && 'points' in cur.geom ? cur.geom.points.length : 0;
        const after = compute().length;
        result.textContent = `${this.simplifyTol} px tolerance: ${before} → ${after} ${nounPl}`;
        apply.disabled = !!sel.locked || after >= before;
      };
      slider.addEventListener('input', () => {
        this.simplifyTol = Number(slider.value);
        refresh();
        this.workspace.setPreview({ annId: sel.id, points: compute(), closed: g.kind === 'polygon' });
      });
      preview.addEventListener('click', () => {
        this.workspace.setPreview({ annId: sel.id, points: compute(), closed: g.kind === 'polygon' });
      });
      apply.addEventListener('click', () => {
        const pts = compute();
        const imgId = store.getUI().activeImageId;
        const before = g.points.length;
        store.mutate((p) => {
          const a = p.images.find((i) => i.id === imgId)?.annotations.find((x) => x.id === sel.id);
          if (a && (a.geom.kind === 'polygon' || a.geom.kind === 'polyline')) a.geom.points = pts;
        });
        this.workspace.setPreview(null);
        this.ctx.toast(`Simplified ${before} → ${pts.length} ${nounPl}. Press Ctrl+Z to undo.`);
      });
      refresh();
      box.appendChild(h('div', { class: 'simplify' },
        h('div', { class: 'field' }, h('span', {}, 'Simplify outline (Ramer–Douglas–Peucker)'), slider),
        result,
        h('div', { class: 'btn-row' }, preview, apply),
      ));
    }
  }
}

function describe(a: Annotation): string {
  const g = a.geom;
  switch (g.kind) {
    case 'box': return 'box';
    case 'keypoint': return 'keypoint';
    case 'polygon': return `polygon, ${g.points.length} vertices`;
    case 'polyline': return `polyline, ${g.points.length} points`;
  }
}
