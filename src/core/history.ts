/**
 * Snapshot-based undo/redo.
 *
 * - On every mutation, the Store pushes a snapshot of the PRE-state here.
 * - `undo()` restores the top snapshot and moves it onto the redo stack.
 * - A new mutation after an undo clears the redo stack (standard behavior —
 *   no "redo tree", which would surprise most users).
 *
 * Capacity: the oldest snapshot drops once the undo stack exceeds `limit`.
 * Memory impact: for the target project size, a snapshot is a few KB each —
 * 200 snapshots is well under 1 MB. If snapshots start eating memory, swap
 * to command/inverse-command without changing any caller.
 */
export class History<T> {
  private undoStack: T[] = [];
  private redoStack: T[] = [];
  private readonly limit: number;
  private readonly getCurrent: () => T;
  private readonly restore: (snap: T) => void;

  constructor(
    getCurrent: () => T,
    restore: (snap: T) => void,
    limit = 200,
  ) {
    this.getCurrent = getCurrent;
    this.restore = restore;
    this.limit = limit;
  }

  push(snap: T): void {
    this.undoStack.push(snap);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }

  canUndo(): boolean { return this.undoStack.length > 0; }
  canRedo(): boolean { return this.redoStack.length > 0; }

  undo(): void {
    const snap = this.undoStack.pop();
    if (!snap) return;
    this.redoStack.push(this.getCurrent());
    this.restore(snap);
  }

  redo(): void {
    const snap = this.redoStack.pop();
    if (!snap) return;
    this.undoStack.push(this.getCurrent());
    this.restore(snap);
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
