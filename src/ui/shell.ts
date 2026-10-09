import type { ImageEntry } from '../core/types';
import type { Store } from '../core/store';
import { newClassId } from '../core/ids';
import { parseProjectJson } from '../core/validate';
import { getBitmap, getSourceFile, hasBitmap, registerBitmap, setSourceFile } from '../io/images';
import { downloadProject, pickAndLoadProject } from '../io/project';
import { importCoco } from '../io/cocoImport';
import { clearSession, loadSession, saveSession } from '../io/autosave';
import { pickFiles, pickTextFile } from '../io/download';
import { isTypingTarget } from '../workspaces/image2d/workspace';
import { Mode2D } from '../modes/mode2d';
import { ModePhoto3D } from '../modes/modePhoto3d';
import { clear, h } from './dom';
import type { ModeContext, ModeController, ModeId } from './mode';

const PALETTE = ['#E58A3C', '#4A90B8', '#6BAF6B', '#C0504D', '#8E6BBF', '#D4B13E', '#3FB5A8', '#D16BA5'];
const AUTOSAVE_DELAY_MS = 1500;

/**
 * Application chrome: top bar, project file actions, shared class list,
 * shared image list, status bar, toasts, autosave and recovery. Everything
 * specific to a kind of annotation lives in a ModeController.
 */
export class Shell {
  private modes: ModeController[] = [];
  private mode!: ModeController;
  private els!: {
    modeSwitch: HTMLElement;
    modeBtns: Map<ModeId, HTMLButtonElement>;
    modeToolbar: HTMLElement;
    exportMenuList: HTMLElement;
    undo: HTMLButtonElement;
    redo: HTMLButtonElement;
    projectName: HTMLInputElement;
    leftHost: HTMLElement;
    imagesPanel: HTMLElement;
    imageList: HTMLElement;
    classList: HTMLElement;
    rightModeHost: HTMLElement;
    main: HTMLElement;
    toasts: HTMLElement;
    sbImage: HTMLElement;
    sbCursor: HTMLElement;
    sbZoom: HTMLElement;
    sbCount: HTMLElement;
    sbDirty: HTMLElement;
  };
  private sigs = { images: '', classes: '' };
  private thumbs = new Map<string, string>();
  private renderQueued = false;
  private autosaveTimer: number | undefined;
  private autosavedRevision = 0;
  private autosaveFailedOnce = false;

  constructor(private root: HTMLElement, private store: Store) {
    this.buildLayout();
    const ctx: ModeContext = {
      store,
      toast: (m) => this.toast(m),
      setCursorText: (s) => { this.els.sbCursor.textContent = s; },
      setZoomText: (s) => { this.els.sbZoom.textContent = s; },
    };
    this.registerMode(new Mode2D(ctx));
    this.registerMode(new ModePhoto3D(ctx));
    this.setMode('2d');

    store.subscribe(() => { this.scheduleRender(); this.scheduleAutosave(); });
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('beforeunload', (e) => {
      if (this.store.isDirty()) { e.preventDefault(); e.returnValue = ''; }
    });
    this.render();
    void this.offerRestore();
  }

  /** Add a workspace. Called once per mode at startup. */
  registerMode(m: ModeController): void {
    this.modes.push(m);
    m.stage.style.display = 'none';
    this.els.main.appendChild(m.stage);
    const btn = h('button', {
      class: 'btn', type: 'button', onclick: () => this.setMode(m.id),
    }, m.label);
    this.els.modeBtns.set(m.id, btn);
    this.els.modeSwitch.appendChild(btn);
    this.els.modeSwitch.style.display = this.modes.length > 1 ? 'inline-flex' : 'none';
  }

  private setMode(id: ModeId): void {
    const next = this.modes.find((m) => m.id === id);
    if (!next || next === this.mode) return;
    if (this.mode) { this.mode.deactivate(); this.mode.stage.style.display = 'none'; }
    this.mode = next;
    next.stage.style.display = '';
    clear(this.els.modeToolbar); this.els.modeToolbar.appendChild(next.toolbar);
    clear(this.els.rightModeHost); this.els.rightModeHost.appendChild(next.rightPanel);
    clear(this.els.leftHost); this.els.leftHost.appendChild(next.leftPanel ?? this.els.imagesPanel);
    clear(this.els.exportMenuList);
    for (const item of next.exportItems()) {
      this.els.exportMenuList.appendChild(h('button', {
        type: 'button',
        onclick: (e: Event) => { closeMenu(e); void Promise.resolve(item.run()); },
      }, item.label));
    }
    for (const [mid, btn] of this.els.modeBtns) {
      btn.classList.toggle('active', mid === id);
      btn.setAttribute('aria-pressed', String(mid === id));
    }
    next.activate();
    this.scheduleRender();
  }

  // ---------------------------------------------------------------- layout

  private buildLayout(): void {
    const undo = h('button', { class: 'btn', type: 'button', title: 'Undo (Ctrl+Z)', onclick: () => this.store.undo() }, 'Undo');
    const redo = h('button', { class: 'btn', type: 'button', title: 'Redo (Ctrl+Y)', onclick: () => this.store.redo() }, 'Redo');

    const projectName = h('input', {
      class: 'project-name', type: 'text', 'aria-label': 'Project name', maxlength: 80,
      onchange: (e: Event) => {
        const v = (e.target as HTMLInputElement).value.trim() || 'Untitled project';
        this.store.mutate((p) => { p.name = v; });
      },
    });

    const modeSwitch = h('div', { class: 'btn-group mode-switch', role: 'group', 'aria-label': 'Workspace' });
    modeSwitch.style.display = 'none';
    const modeToolbar = h('div', { class: 'mode-slot' });

    const fileMenu = h('details', { class: 'menu' },
      h('summary', { class: 'btn' }, 'File'),
      h('div', { class: 'menu-list' },
        ...([
          ['New project', () => this.newProject()],
          ['Open project...', () => void this.openProject()],
          ['Save project (Ctrl+S)', () => this.saveProject()],
          ['Import COCO JSON...', () => void this.importCocoFile()],
        ] as [string, () => void][]).map(([text, fn]) =>
          h('button', { type: 'button', onclick: (e: Event) => { closeMenu(e); fn(); } }, text)),
      ),
    );
    const exportMenuList = h('div', { class: 'menu-list' });
    const exportMenu = h('details', { class: 'menu' }, h('summary', { class: 'btn primary' }, 'Export'), exportMenuList);
    document.addEventListener('click', (e) => {
      for (const d of document.querySelectorAll('details.menu[open]')) if (!d.contains(e.target as Node)) d.removeAttribute('open');
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') for (const d of document.querySelectorAll('details.menu[open]')) d.removeAttribute('open');
    });

    const topbar = h('header', { class: 'topbar' },
      h('div', { class: 'brand' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }), 'Annotate Anything'),
      projectName,
      modeSwitch,
      modeToolbar,
      h('div', { class: 'btn-group' }, undo, redo),
      h('div', { class: 'spacer' }),
      fileMenu,
      exportMenu,
    );

    const imageList = h('div', { class: 'list', role: 'list' });
    const imagesPanel = h('div', { class: 'images-panel' },
      h('div', { class: 'panel-head' },
        h('h2', {}, 'Images'),
        h('button', { class: 'btn small', type: 'button', onclick: () => void this.pickForMode() }, 'Add images'),
      ),
      imageList,
    );
    const leftHost = h('aside', { class: 'sidebar left', 'aria-label': 'Assets' });

    const classList = h('div', { class: 'list', role: 'list' });
    const rightModeHost = h('div', {});
    const right = h('aside', { class: 'sidebar right', 'aria-label': 'Classes and annotations' },
      h('div', { class: 'panel-head' },
        h('h2', {}, 'Classes'),
        h('button', { class: 'btn small', type: 'button', onclick: () => this.addClass() }, 'Add class'),
      ),
      classList,
      rightModeHost,
    );

    const main = h('main', { class: 'main' });

    const sb = {
      sbImage: h('span', {}), sbCursor: h('span', {}), sbZoom: h('span', {}),
      sbCount: h('span', {}), sbDirty: h('span', { class: 'dirty' }),
    };
    const status = h('footer', { class: 'statusbar', role: 'status', 'aria-live': 'polite' },
      sb.sbImage, sb.sbCursor, sb.sbZoom, sb.sbCount, h('span', { class: 'spacer' }), sb.sbDirty);

    const toasts = h('div', { class: 'toasts', 'aria-live': 'polite' });
    const app = h('div', { class: 'app' }, topbar, leftHost, main, right, status);
    this.root.appendChild(app);
    this.root.appendChild(toasts);

    main.addEventListener('dragover', (e) => { e.preventDefault(); main.classList.add('dragging'); });
    main.addEventListener('dragleave', () => main.classList.remove('dragging'));
    main.addEventListener('drop', (e) => {
      e.preventDefault();
      main.classList.remove('dragging');
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) void this.mode.handleFiles(files);
    });

    this.els = {
      modeSwitch, modeBtns: new Map(), modeToolbar, exportMenuList, undo, redo, projectName,
      leftHost, imagesPanel, imageList, classList, rightModeHost, main, toasts, ...sb,
    };
  }

  private async pickForMode(): Promise<void> {
    const files = await pickFiles('image/jpeg,image/png,image/webp', true);
    if (files.length) await this.mode.handleFiles(files);
  }

  // ---------------------------------------------------------------- actions

  private removeImage(img: ImageEntry): void {
    if (img.annotations.length && !confirm(`Remove "${img.name}" and its ${img.annotations.length} annotation(s) from this project? You can undo this.`)) return;
    this.store.mutate((p) => { p.images = p.images.filter((i) => i.id !== img.id); });
    const ui = this.store.getUI();
    if (ui.activeImageId === img.id) {
      this.store.setUI({ activeImageId: this.store.getProject().images[0]?.id ?? null, selectedAnnotationId: null });
    }
  }

  private addClass(): void {
    const proj = this.store.getProject();
    const color = PALETTE[proj.classes.length % PALETTE.length];
    const id = newClassId();
    let n = proj.classes.length + 1;
    while (proj.classes.some((c) => c.name.toLowerCase() === `class ${n}`)) n += 1;
    this.store.mutate((p) => { p.classes.push({ id, name: `class ${n}`, color }); });
    this.store.setUI({ activeClassId: id });
  }

  private deleteClass(classId: string): void {
    const proj = this.store.getProject();
    if (proj.classes.length <= 1) { this.toast('Keep at least one class.'); return; }
    const used = countClassUse(proj, classId);
    if (used > 0) {
      this.toast(`This class is used by ${used} annotation${used === 1 ? '' : 's'}. Reassign or delete them first.`);
      return;
    }
    this.store.mutate((p) => { p.classes = p.classes.filter((c) => c.id !== classId); });
    if (this.store.getUI().activeClassId === classId) {
      this.store.setUI({ activeClassId: this.store.getProject().classes[0]?.id ?? null });
    }
  }

  private renameClass(classId: string, input: HTMLInputElement): void {
    const name = input.value.trim();
    const proj = this.store.getProject();
    const cur = proj.classes.find((c) => c.id === classId);
    if (!cur) return;
    if (!name) { input.value = cur.name; this.toast('A class needs a name.'); return; }
    if (proj.classes.some((c) => c.id !== classId && c.name.toLowerCase() === name.toLowerCase())) {
      input.value = cur.name;
      this.toast(`A class named "${name}" already exists.`);
      return;
    }
    if (name === cur.name) return;
    input.blur();
    this.store.mutate((p) => { const c = p.classes.find((x) => x.id === classId); if (c) c.name = name; });
  }

  private selectClass(classId: string): void {
    this.store.setUI({ activeClassId: classId });
    this.mode.onClassSelected(classId);
  }

  private newProject(): void {
    if (this.store.isDirty() && !confirm('Discard unsaved changes and start a new project?')) return;
    this.store.newProject();
    void clearSession().catch(() => undefined);
  }

  private async openProject(): Promise<void> {
    if (this.store.isDirty() && !confirm('Discard unsaved changes and open another project?')) return;
    try {
      const proj = await pickAndLoadProject();
      if (!proj) return;
      this.store.loadProject(proj);
      const missing = proj.images.filter((i) => !hasBitmap(i.id)).length;
      this.toast(missing
        ? `Project loaded. Add the ${missing} image file${missing === 1 ? '' : 's'} again; they relink by file name.`
        : 'Project loaded.');
    } catch (e) {
      this.toast(e instanceof Error ? e.message : 'Could not open project.');
    }
  }

  private async importCocoFile(): Promise<void> {
    if (this.store.isDirty() && !confirm('Discard unsaved changes and start a new project from a COCO file?')) return;
    try {
      const f = await pickTextFile('.json,application/json');
      if (!f) return;
      const { project, warnings } = importCoco(f.text, f.name.replace(/\.json$/i, ''));
      this.store.loadProject(project);
      const n = project.images.reduce((s, i) => s + i.annotations.length, 0);
      this.toast(`COCO imported: ${project.images.length} image(s), ${n} annotation(s). Add the image files to relink them by file name.`);
      for (const w of warnings.slice(0, 3)) this.toast(`Import note: ${w}`);
    } catch (e) {
      this.toast(e instanceof Error ? e.message : 'Could not import COCO file.');
    }
  }

  private saveProject(): void {
    downloadProject(this.store.getProject());
    this.store.markSaved();
    this.toast('Project file downloaded.');
  }

  // ---------------------------------------------------------------- autosave

  private scheduleAutosave(): void {
    if (this.store.getRevision() === this.autosavedRevision) return;
    window.clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => void this.autosaveNow(), AUTOSAVE_DELAY_MS);
  }

  private async autosaveNow(): Promise<void> {
    const rev = this.store.getRevision();
    try {
      await saveSession(this.store.getProject(), (id) => getSourceFile(id));
      this.autosavedRevision = rev;
    } catch (e) {
      if (!this.autosaveFailedOnce) {
        this.autosaveFailedOnce = true;
        this.toast(`Autosave is unavailable (${e instanceof Error ? e.message : 'storage error'}). Use Save project to keep your work.`);
      }
    }
  }

  private async offerRestore(): Promise<void> {
    try {
      const session = await loadSession();
      if (!session) return;
      const project = parseProjectJson(session.projectJson);
      const annCount = project.images.reduce((n, i) => n + i.annotations.length, 0);
      if (!project.images.length && !annCount) return;
      const ok = confirm(`Restore your previous session "${project.name}" (${project.images.length} image(s), ${annCount} annotation(s))? It was autosaved in this browser.`);
      if (!ok) { await clearSession(); return; }
      this.store.loadProject(project);
      for (const img of project.images) {
        const blob = session.files.get(img.id);
        if (!blob) continue;
        try {
          const bm = await createImageBitmap(blob);
          registerBitmap(img.id, bm);
          setSourceFile(img.id, blob);
        } catch { /* leave as "not loaded"; the user can re-add the file */ }
      }
      this.store.touch();
      this.toast('Session restored. Use Save project to keep a copy as a file.');
    } catch {
      // No IndexedDB, or a damaged session: start fresh silently.
    }
  }

  // ---------------------------------------------------------------- keyboard

  private onKey(e: KeyboardEvent): void {
    if (isTypingTarget(e.target)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod) {
      const lk = e.key.toLowerCase();
      if (lk === 'z' && !e.shiftKey) { e.preventDefault(); this.store.undo(); }
      else if (lk === 'y' || (lk === 'z' && e.shiftKey)) { e.preventDefault(); this.store.redo(); }
      else if (lk === 's') { e.preventDefault(); this.saveProject(); }
      return;
    }
    if (this.mode.handleKey(e)) return;
    switch (e.key) {
      case '[': this.stepImage(-1); break;
      case ']': this.stepImage(1); break;
      default:
        if (/^[1-9]$/.test(e.key)) {
          const cls = this.store.getProject().classes[Number(e.key) - 1];
          if (cls) this.selectClass(cls.id);
        }
    }
  }

  private stepImage(dir: number): void {
    const imgs = this.store.getProject().images;
    if (!imgs.length || this.mode.leftPanel) return;
    const i = imgs.findIndex((x) => x.id === this.store.getUI().activeImageId);
    const next = imgs[(i + dir + imgs.length) % imgs.length];
    this.store.setUI({ activeImageId: next.id, selectedAnnotationId: null });
  }

  // ---------------------------------------------------------------- rendering

  private scheduleRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => { this.renderQueued = false; this.render(); });
  }

  private render(): void {
    const ui = this.store.getUI();
    const proj = this.store.getProject();
    this.els.undo.disabled = !this.store.history.canUndo();
    this.els.redo.disabled = !this.store.history.canRedo();
    if (document.activeElement !== this.els.projectName) this.els.projectName.value = proj.name;

    this.renderImages(proj.images, ui.activeImageId);
    this.renderClasses(ui.activeClassId);
    this.mode.render();
    this.els.sbImage.textContent = this.mode.statusLeft();
    this.els.sbCount.textContent = this.mode.statusCount();
    this.els.sbDirty.textContent = this.store.isDirty() ? 'Unsaved changes' : '';
  }

  private renderImages(images: ImageEntry[], activeId: string | null): void {
    const sig = JSON.stringify([activeId, images.map((i) => [i.id, i.name, i.width, i.height, i.annotations.length, hasBitmap(i.id)])]);
    if (sig === this.sigs.images) return;
    this.sigs.images = sig;
    const list = this.els.imageList;
    clear(list);
    if (!images.length) {
      list.appendChild(h('p', { class: 'hint' }, 'No images yet.'));
      return;
    }
    for (const im of images) {
      const thumb = this.thumbFor(im);
      list.appendChild(h('div', {
        class: 'row image-row' + (im.id === activeId ? ' active' : ''), role: 'listitem',
        tabindex: 0,
        onclick: () => this.store.setUI({ activeImageId: im.id, selectedAnnotationId: null }),
        onkeydown: (e: KeyboardEvent) => {
          if (e.key === 'Enter') this.store.setUI({ activeImageId: im.id, selectedAnnotationId: null });
        },
      },
        thumb ? h('img', { class: 'thumb', src: thumb, alt: '' }) : h('div', { class: 'thumb missing', title: 'Image file not loaded' }, '?'),
        h('div', { class: 'grow' },
          h('div', { class: 'name', title: im.name }, im.name),
          h('div', { class: 'sub' }, `${im.width}×${im.height} · ${im.annotations.length} annotation${im.annotations.length === 1 ? '' : 's'}${thumb ? '' : ' · not loaded'}`),
        ),
        h('button', {
          class: 'icon-btn', type: 'button', title: 'Remove from project', 'aria-label': `Remove ${im.name}`,
          onclick: (e: Event) => { e.stopPropagation(); this.removeImage(im); },
        }, '×'),
      ));
    }
  }

  private thumbFor(im: ImageEntry): string | null {
    const cached = this.thumbs.get(im.id);
    if (cached) return cached;
    const bm = getBitmap(im.id);
    if (!bm) return null;
    const c = document.createElement('canvas');
    const s = Math.min(1, 96 / Math.max(bm.width, bm.height));
    c.width = Math.max(1, Math.round(bm.width * s));
    c.height = Math.max(1, Math.round(bm.height * s));
    c.getContext('2d')?.drawImage(bm, 0, 0, c.width, c.height);
    const url = c.toDataURL('image/jpeg', 0.7);
    this.thumbs.set(im.id, url);
    return url;
  }

  private renderClasses(activeClassId: string | null): void {
    const classes = this.store.getProject().classes;
    const counts = classCounts(this.store.getProject(), this.store.getUI().activeImageId);
    const sig = JSON.stringify([activeClassId, classes, [...counts]]);
    if (sig === this.sigs.classes) return;
    // Don't rebuild the list under a name field the user is typing in.
    const focused = document.activeElement;
    if (focused instanceof HTMLInputElement && focused.type === 'text' && this.els.classList.contains(focused)) return;
    this.sigs.classes = sig;
    const list = this.els.classList;
    clear(list);
    classes.forEach((c, i) => {
      const nameInput = h('input', {
        class: 'class-name', type: 'text', value: c.name, maxlength: 60, 'aria-label': `Class ${i + 1} name`,
        onchange: (e: Event) => this.renameClass(c.id, e.target as HTMLInputElement),
        onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); },
      });
      list.appendChild(h('div', {
        class: 'row class-row' + (c.id === activeClassId ? ' active' : ''), role: 'listitem',
        onclick: (e: Event) => { if ((e.target as HTMLElement).tagName !== 'INPUT') this.selectClass(c.id); },
      },
        h('input', {
          class: 'swatch', type: 'color', value: c.color, 'aria-label': `Color for ${c.name}`,
          onchange: (e: Event) => {
            const v = (e.target as HTMLInputElement).value;
            this.store.mutate((p) => { const x = p.classes.find((k) => k.id === c.id); if (x) x.color = v; });
          },
        }),
        nameInput,
        h('span', { class: 'count', title: 'Annotations on the current image or asset' }, String(counts.get(c.id) ?? 0)),
        i < 9 ? h('kbd', { title: `Press ${i + 1} to select` }, String(i + 1)) : null,
        h('button', {
          class: 'icon-btn', type: 'button', title: 'Delete class', 'aria-label': `Delete class ${c.name}`,
          onclick: (e: Event) => { e.stopPropagation(); this.deleteClass(c.id); },
        }, '×'),
      ));
    });
  }

  // ---------------------------------------------------------------- toasts

  toast(msg: string): void {
    const t = h('div', { class: 'toast' }, msg);
    this.els.toasts.appendChild(t);
    setTimeout(() => t.remove(), 5000);
  }
}

/** Per-class counts for the badge in the class list (current image's 2D annotations). */
function classCounts(project: import('../core/types').Project, activeImageId: string | null): Map<string, number> {
  const counts = new Map<string, number>();
  const img = project.images.find((i) => i.id === activeImageId);
  for (const a of img?.annotations ?? []) counts.set(a.classId, (counts.get(a.classId) ?? 0) + 1);
  for (const c of img?.cuboids ?? []) counts.set(c.classId, (counts.get(c.classId) ?? 0) + 1);
  return counts;
}

/** How many annotations of any kind use this class (blocks deleting a class that is still in use). */
function countClassUse(project: import('../core/types').Project, classId: string): number {
  let n = 0;
  for (const im of project.images) {
    n += im.annotations.filter((a) => a.classId === classId).length;
    n += (im.cuboids ?? []).filter((c) => c.classId === classId).length;
  }
  return n;
}

function closeMenu(e: Event): void {
  const d = (e.target as HTMLElement).closest('details');
  if (d) d.removeAttribute('open');
}
