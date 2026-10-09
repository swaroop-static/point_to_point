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
import { AiController } from '../ai/runtime';
import { SamClickTool } from '../ai/samTool';
import { SAM_MODELS, modelById } from '../ai/models';

const TOOLS: { name: ToolName; label: string; key: string }[] = [
  { name: 'select', label: 'Select', key: 'V' },
  { name: 'box', label: 'Box', key: 'B' },
  { name: 'polygon', label: 'Polygon', key: 'P' },
  { name: 'polyline', label: 'Polyline', key: 'Y' },
  { name: 'keypoint', label: 'Keypoint', key: 'K' },
  { name: 'sam', label: 'AI click', key: 'M' },
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
  private ai = new AiController();
  private samTool!: SamClickTool;
  private aiPanel: HTMLElement;
  private aiSig = '';
  private aiModelId = SAM_MODELS[0].id;
  private aiCached = new Map<string, boolean>();

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
    this.aiPanel = h('div', { class: 'ai-panel' });
    this.rightPanel = h('div', {},
      h('div', { class: 'panel-head' }, h('h2', {}, 'Annotations')),
      this.annList,
      this.props,
      this.aiPanel,
    );

    this.workspace = new Image2DWorkspace(this.stage, store, {
      onStatus: (s) => {
        ctx.setCursorText(s.cursor ? `x ${Math.round(s.cursor.x)}, y ${Math.round(s.cursor.y)}` : '');
        ctx.setZoomText(`${Math.round(s.scale * 100)}%`);
      },
      onNotice: (m) => ctx.toast(m),
    });
    this.samTool = new SamClickTool(store, this.ai, {
      repaint: () => this.workspace.repaint(),
      notice: (m) => ctx.toast(m),
      changed: () => { this.aiSig = ''; this.renderAi(); },
    });
    this.workspace.setExternalTool(this.samTool);
    this.ai.subscribe(() => { this.aiSig = ''; this.renderAi(); });
    this.renderAi();
  }

  activate(): void { this.workspace.fit(); this.render(); }
  deactivate(): void { this.workspace.cancelDraft(); this.workspace.setPreview(null); this.samTool.clear(); }

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

  classCounts(): Map<string, number> {
    const out = new Map<string, number>();
    for (const a of this.ctx.store.getActiveImage()?.annotations ?? []) out.set(a.classId, (out.get(a.classId) ?? 0) + 1);
    return out;
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
    if (t !== 'sam') this.samTool.clear();
    this.ctx.store.setUI({ activeTool: t });
    if (t === 'sam' && !this.ai.ready) {
      this.ctx.toast('AI click needs a model. Open "AI assist" in the right panel to enable one (optional, runs on your device).');
      this.aiPanel.querySelector('details')?.setAttribute('open', '');
    }
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
    if (store.getUI().activeTool === 'sam' && this.samTool.hasPending) {
      if (e.key === 'Enter') { this.samTool.accept(); return true; }
      if (e.key === 'Escape') { this.samTool.clear(); return true; }
      if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); this.samTool.undoLast(); return true; }
    }
    switch (e.key) {
      case 'v': case 'V': this.setTool('select'); return true;
      case 'b': case 'B': this.setTool('box'); return true;
      case 'p': case 'P': this.setTool('polygon'); return true;
      case 'y': case 'Y': this.setTool('polyline'); return true;
      case 'k': case 'K': this.setTool('keypoint'); return true;
      case 'm': case 'M': this.setTool('sam'); return true;
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

  private lastImageId: string | null = null;

  render(): void {
    const { store } = this.ctx;
    const ui = store.getUI();
    if (ui.activeImageId !== this.lastImageId) {
      this.lastImageId = ui.activeImageId;
      if (this.samTool.hasPending) this.samTool.clear();
    }
    for (const [name, btn] of this.toolBtns) {
      btn.classList.toggle('active', name === ui.activeTool);
      btn.setAttribute('aria-pressed', String(name === ui.activeTool));
    }
    this.empty.style.display = store.getProject().images.length ? 'none' : 'flex';
    this.renderAnnotations(store.getActiveImage(), ui.selectedAnnotationId);
  }

  // ---------------------------------------------------------------- AI assist (optional)

  private async refreshCached(): Promise<void> {
    for (const m of SAM_MODELS) this.aiCached.set(m.id, await this.ai.isCached(m));
    this.aiSig = '';
    this.renderAi();
  }

  private async pickOwnModel(): Promise<void> {
    const spec = modelById(this.aiModelId);
    if (!spec) return;
    const files = await pickFiles('.onnx', true);
    if (!files.length) return;
    const enc = files.find((f) => /encoder/i.test(f.name));
    const dec = files.find((f) => /decoder/i.test(f.name));
    if (!enc || !dec) { this.ctx.toast('Pick both files at once: one with "encoder" and one with "decoder" in its name.'); return; }
    await this.ai.enableFromFiles(spec, enc, dec);
  }

  private renderAi(): void {
    const st = this.ai.state;
    const sig = JSON.stringify([st, this.aiModelId, [...this.aiCached], this.samTool?.points.length, this.samTool?.busy]);
    if (sig === this.aiSig) return;
    this.aiSig = sig;
    const wasOpen = this.aiPanel.querySelector('details')?.hasAttribute('open') ?? false;
    const box = this.aiPanel;
    clear(box);
    if (!this.aiCached.size) void this.refreshCached();

    const body = h('div', { class: 'ai-body' });
    body.appendChild(h('p', { class: 'hint' },
      'Optional. Click an object and get a polygon. It runs on this device in WebAssembly; your images are never uploaded. ' +
      'Enabling a model downloads one file set from huggingface.co once and keeps it in this browser. Manual tools never need it.'));

    if (st.kind === 'ready') {
      const t = this.samTool;
      body.appendChild(h('p', { class: 'ai-status ok' }, `Ready: ${st.model}`));
      body.appendChild(h('p', { class: 'hint' },
        'Press M, then click an object. Left-click includes, right-click (or Shift+click) excludes. Enter accepts, Esc discards, Backspace removes the last click. The first click on each image takes a few seconds while the image is analyzed.'));
      body.appendChild(h('div', { class: 'btn-row' },
        h('button', { class: 'btn small primary', type: 'button', disabled: t.busy || !t.hasPending, onclick: () => t.accept() }, 'Accept polygon'),
        h('button', { class: 'btn small', type: 'button', disabled: !t.hasPending, onclick: () => t.clear() }, 'Discard'),
        h('button', { class: 'btn small', type: 'button', onclick: () => this.ai.disable() }, 'Turn off'),
      ));
      if (t.busy) body.appendChild(h('p', { class: 'ai-status' }, 'Working...'));
    } else {
      const list = h('div', { class: 'ai-models', role: 'radiogroup', 'aria-label': 'AI model' });
      for (const m of SAM_MODELS) {
        const total = Math.round((m.encoder.sizeMB + m.decoder.sizeMB) * 10) / 10;
        const cached = this.aiCached.get(m.id);
        list.appendChild(h('label', { class: 'ai-model' },
          h('input', { type: 'radio', name: 'ai-model', value: m.id, checked: m.id === this.aiModelId ? true : undefined, disabled: st.kind === 'working' ? true : undefined,
            onchange: () => { this.aiModelId = m.id; this.aiSig = ''; this.renderAi(); } }),
          h('span', {},
            h('strong', {}, `${m.label} · ${total} MB${cached ? ' · downloaded' : ''}`),
            h('span', { class: 'sub' }, m.blurb),
            h('span', { class: 'sub' }, `License: ${m.license}`))));
      }
      body.appendChild(list);
      const spec = modelById(this.aiModelId)!;
      const total = Math.round((spec.encoder.sizeMB + spec.decoder.sizeMB) * 10) / 10;
      const cached = !!this.aiCached.get(spec.id);
      body.appendChild(h('div', { class: 'btn-row' },
        h('button', { class: 'btn small primary', type: 'button', disabled: st.kind === 'working' ? true : undefined,
          onclick: () => { void this.ai.enable(spec).then(() => this.refreshCached()); } },
          cached ? 'Enable (already downloaded)' : `Download ${total} MB and enable`),
        h('button', { class: 'btn small', type: 'button', disabled: st.kind === 'working' ? true : undefined, onclick: () => void this.pickOwnModel() }, 'Use my own .onnx files'),
      ));
      if (cached) body.appendChild(h('div', { class: 'btn-row' },
        h('button', { class: 'btn small', type: 'button', onclick: () => { void this.ai.removeCached(spec).then(() => this.refreshCached()); } }, 'Delete downloaded copy')));
      body.appendChild(h('p', { class: 'hint' }, `Source: ${spec.source}`));
      if (st.kind === 'working') {
        body.appendChild(h('p', { class: 'ai-status' }, st.message));
        if (st.progress !== undefined) {
          body.appendChild(h('progress', { max: 1, value: st.progress, 'aria-label': 'Download progress' }));
        }
      }
      if (st.kind === 'error') body.appendChild(h('p', { class: 'ai-status err', role: 'alert' }, st.message));
    }

    const d = h('details', { class: 'ai-details' }, h('summary', {}, 'AI assist (optional)'), body);
    if (wasOpen || st.kind !== 'off') d.setAttribute('open', '');
    box.appendChild(d);
  }

  private renderAnnotations(img: ImageEntry | null, selectedId: string | null): void {
    const { store } = this.ctx;
    const classes = store.getProject().classes;
    const anns = img?.annotations ?? [];
    const sel = store.getSelectedAnnotation();
    const sig = JSON.stringify([
      img?.id, selectedId, classes.map((c) => [c.id, c.name, c.color]),
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
