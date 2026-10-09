/** Browser download / file-pick helpers shared by the exporters. */

export function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

export function safeName(name: string): string {
  return (name || 'project').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60);
}

export function downloadBytes(filename: string, data: Uint8Array, mime: string): void {
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Open a file picker and resolve with the chosen files (empty if cancelled). */
export function pickFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.position = 'fixed';
    input.style.left = '-10000px';
    input.onchange = () => { const f = Array.from(input.files ?? []); input.remove(); resolve(f); };
    input.addEventListener('cancel', () => { input.remove(); resolve([]); });
    document.body.appendChild(input);
    input.click();
  });
}

/** Open a file picker and resolve with the chosen file's text, or null if cancelled. */
export function pickTextFile(accept: string): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.position = 'fixed';
    input.style.left = '-10000px';
    input.onchange = async () => {
      const f = input.files?.[0];
      input.remove();
      if (!f) { resolve(null); return; }
      try { resolve({ name: f.name, text: await f.text() }); } catch (e) { reject(e); }
    };
    document.body.appendChild(input);
    input.click();
  });
}
