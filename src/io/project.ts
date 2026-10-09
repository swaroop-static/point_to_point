import type { Project } from '../core/types';
import { parseProjectJson } from '../core/validate';

/**
 * Project JSON save/load. See docs/project-format.md for the schema.
 *
 * - `downloadProject` serializes the whole project (classes + images + their
 *   annotations) to a `.aa.json` file and hands it to the browser's download
 *   mechanism. User's actual image pixels are NEVER embedded — only
 *   dimensions, filename, and the geometry.
 * - `pickAndLoadProject` opens a file picker and returns a validated
 *   Project object. Images referenced by the project will still need to be
 *   re-dragged in by the user — this is a documented tradeoff of a
 *   fully-privacy-conscious tool with no server-side storage.
 */

export function downloadProject(project: Project): void {
  const now = new Date().toISOString();
  const out: Project = { ...project, savedAt: now };
  const json = JSON.stringify(out, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedFilename(project.name);
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking in a microtask gives Chrome time to actually start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function suggestedFilename(projectName: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safe = (projectName || 'project').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60);
  return `${safe}_${stamp}.aa.json`;
}

/**
 * Open the browser's file picker. Resolves with the loaded project, or null
 * if the user cancelled. Throws on parse/schema errors so the caller can show
 * a specific message in a toast.
 */
export function pickAndLoadProject(): Promise<Project | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) { resolve(null); return; }
      try {
        const text = await file.text();
        resolve(parseProjectJson(text));
      } catch (e) {
        reject(e instanceof Error ? e : new Error('Project load failed.'));
      }
    };
    // Firefox needs the input in the DOM in some versions for change to fire.
    input.style.position = 'fixed';
    input.style.left = '-10000px';
    document.body.appendChild(input);
    input.click();
    setTimeout(() => input.remove(), 0);
  });
}
