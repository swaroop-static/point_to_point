import type { Store } from '../core/store';

export type ModeId = '2d' | 'photo3d' | 'mesh' | 'cloud';

/** What the shell gives each mode. Modes never touch shell internals directly. */
export interface ModeContext {
  store: Store;
  toast(msg: string): void;
  setCursorText(s: string): void;
  setZoomText(s: string): void;
}

export interface ExportItem {
  label: string;
  run(): void | Promise<void>;
}

/**
 * A workspace. The shell owns the chrome (top bar, class list, file menu,
 * autosave, toasts); a mode owns its stage, tool buttons, side panels and the
 * keys that mean something only inside it. Modes keep their geometry separate:
 * 2D shapes, photo cuboids, meshes and point clouds each have their own data
 * in the project, their own validation and their own exporters.
 */
export interface ModeController {
  readonly id: ModeId;
  readonly label: string;
  /** Tool buttons shown in the top bar while active. */
  readonly toolbar: HTMLElement;
  /** Main view, shown inside the stage area while active. */
  readonly stage: HTMLElement;
  /** Mode-specific part of the right panel (below the shared class list). */
  readonly rightPanel: HTMLElement;
  /** Replaces the shared image list in the left panel (mesh / point cloud). */
  readonly leftPanel: HTMLElement | null;
  activate(): void;
  deactivate(): void;
  /** Called on every store change while active. Must be cheap when nothing relevant changed. */
  render(): void;
  /** Return true if the key was handled. */
  handleKey(e: KeyboardEvent): boolean;
  /** Files dropped on the stage or picked via the add button. */
  handleFiles(files: File[]): Promise<void>;
  /** Called when the user picks a class in the shared class list. */
  onClassSelected(classId: string): void;
  exportItems(): ExportItem[];
  statusLeft(): string;
  statusCount(): string;
}
