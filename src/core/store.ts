import type {
  Annotation, AnnotationId, ClassDef, ClassId, ImageEntry, ImageId, Project, ToolName,
} from './types';
import { newClassId } from './ids';
import { History } from './history';

/**
 * Single source of truth for the whole app.
 *
 * - Project is the persisted state (serialized to JSON on save/export).
 * - UI state (selection, active tool, active image) is kept here too, in a
 *   separate `ui` field, but NOT serialized — so switching to a different
 *   project file never carries over a stale selection pointing at an ID that
 *   doesn't exist anymore.
 *
 * All mutations go through `mutate()` which:
 *   1. Pushes a snapshot onto the history stack (for undo).
 *   2. Applies the caller's mutation.
 *   3. Notifies subscribers.
 *
 * The snapshot is `structuredClone(project)` — small enough to copy for the
 * target project sizes (dozens of images, hundreds of annotations). If future
 * projects outgrow this, swap to inverse-operation commands without changing
 * any caller.
 */

export interface UIState {
  activeTool: ToolName;
  activeImageId: ImageId | null;
  activeClassId: ClassId | null;
  selectedAnnotationId: AnnotationId | null;
}

export interface AppState {
  project: Project;
  ui: UIState;
}

type Listener = () => void;

function emptyProject(): Project {
  // Seed with two useful default classes so a brand-new user can start
  // drawing immediately without first opening the class manager.
  const defaultClasses: ClassDef[] = [
    { id: newClassId(), name: 'object',     color: '#E58A3C' },
    { id: newClassId(), name: 'background', color: '#4A90B8' },
  ];
  return {
    formatVersion: 2,
    app: 'annotate-anything',
    name: 'Untitled project',
    savedAt: new Date().toISOString(),
    classes: defaultClasses,
    images: [],
  };
}

export class Store {
  private state: AppState;
  private listeners = new Set<Listener>();
  readonly history: History<Project>;
  private gestureSnap: Project | null = null;
  private revision = 0;
  private savedRevision = 0;

  constructor(initial?: Project) {
    const project = initial ?? emptyProject();
    this.state = {
      project,
      ui: {
        activeTool: 'select',
        activeImageId: project.images[0]?.id ?? null,
        activeClassId: project.classes[0]?.id ?? null,
        selectedAnnotationId: null,
      },
    };
    this.history = new History<Project>(
      () => structuredClone(this.state.project),
      (snap) => {
        this.state.project = snap;
        this.revision += 1;
        this.repairUIAfterRestore();
        this.notify();
      },
    );
  }

  // -- reads --

  get(): AppState { return this.state; }
  getProject(): Project { return this.state.project; }
  getUI(): UIState { return this.state.ui; }

  getActiveImage(): ImageEntry | null {
    const id = this.state.ui.activeImageId;
    if (!id) return null;
    return this.state.project.images.find((i) => i.id === id) ?? null;
  }

  getActiveClass(): ClassDef | null {
    const id = this.state.ui.activeClassId;
    if (!id) return null;
    return this.state.project.classes.find((c) => c.id === id) ?? null;
  }

  getClassById(id: ClassId): ClassDef | null {
    return this.state.project.classes.find((c) => c.id === id) ?? null;
  }

  getSelectedAnnotation(): Annotation | null {
    const img = this.getActiveImage();
    const id = this.state.ui.selectedAnnotationId;
    if (!img || !id) return null;
    return img.annotations.find((a) => a.id === id) ?? null;
  }

  // -- subscribe --

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  // -- mutations --

  /**
   * Perform a mutation on the project. The function may freely mutate the
   * passed-in draft; a snapshot of the pre-state has already been pushed to
   * the history stack. Return `false` from `mutator` to cancel (no snapshot
   * is recorded).
   */
  mutate(mutator: (project: Project) => void | boolean): void {
    const snap = structuredClone(this.state.project);
    const result = mutator(this.state.project);
    if (result === false) {
      // Caller cancelled — restore from the pre-snapshot and don't record.
      this.state.project = snap;
      return;
    }
    this.history.push(snap);
    this.revision += 1;
    this.state.project.savedAt = new Date().toISOString();
    this.notify();
  }

  /**
   * Gesture API for continuous interactions (dragging a vertex, drawing a box).
   * `beginGesture` snapshots once; `liveMutate` changes state without touching
   * history; `endGesture(true)` records ONE undo step for the whole drag,
   * `endGesture(false)` rolls the project back to the pre-drag snapshot.
   */
  beginGesture(): void {
    this.gestureSnap = structuredClone(this.state.project);
  }

  liveMutate(mutator: (project: Project) => void): void {
    mutator(this.state.project);
    this.notify();
  }

  endGesture(commit: boolean): void {
    const snap = this.gestureSnap;
    this.gestureSnap = null;
    if (!snap) return;
    if (commit) {
      this.history.push(snap);
      this.revision += 1;
      this.state.project.savedAt = new Date().toISOString();
    } else {
      this.state.project = snap;
      this.repairUIAfterRestore();
    }
    this.notify();
  }

  isDirty(): boolean { return this.revision !== this.savedRevision; }
  getRevision(): number { return this.revision; }
  /** Mark the project as having unsaved changes without altering it (e.g. after restoring an autosave). */
  touch(): void { this.revision += 1; this.notify(); }
  markSaved(): void { this.savedRevision = this.revision; this.notify(); }

  /** UI-only state change — never recorded in history. */
  setUI(patch: Partial<UIState>): void {
    this.state.ui = { ...this.state.ui, ...patch };
    this.notify();
  }

  /**
   * Replace the whole project (e.g. when the user loads a project file).
   * Resets history and UI selection.
   */
  loadProject(project: Project): void {
    this.state.project = project;
    this.state.ui = {
      activeTool: 'select',
      activeImageId: project.images[0]?.id ?? null,
      activeClassId: project.classes[0]?.id ?? null,
      selectedAnnotationId: null,
    };
    this.history.clear();
    this.revision = 0;
    this.savedRevision = 0;
    this.notify();
  }

  newProject(): void { this.loadProject(emptyProject()); }

  undo(): void { this.history.undo(); }
  redo(): void { this.history.redo(); }

  // -- helpers for consumers --

  private repairUIAfterRestore(): void {
    // After an undo/redo, the active image / selection may point at an entity
    // that no longer exists. Snap to the first valid thing.
    const ui = this.state.ui;
    const proj = this.state.project;
    if (ui.activeImageId && !proj.images.some((i) => i.id === ui.activeImageId)) {
      ui.activeImageId = proj.images[0]?.id ?? null;
    }
    if (ui.activeClassId && !proj.classes.some((c) => c.id === ui.activeClassId)) {
      ui.activeClassId = proj.classes[0]?.id ?? null;
    }
    const img = this.getActiveImage();
    if (ui.selectedAnnotationId && (!img
      || (!img.annotations.some((a) => a.id === ui.selectedAnnotationId)
        && !(img.cuboids ?? []).some((c) => c.id === ui.selectedAnnotationId)))) {
      ui.selectedAnnotationId = null;
    }
  }
}
