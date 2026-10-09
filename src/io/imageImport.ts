import type { ImageEntry } from '../core/types';
import type { Store } from '../core/store';
import { decodeImage, hasBitmap, isSupportedImage, loadImageFile, registerBitmap, setSourceFile } from './images';

/**
 * Add image files to the project (shared by the image-based workspaces).
 * A file whose name matches an existing "not loaded" image is RELINKED to it
 * instead of added, but only if the dimensions match; a same-named file with
 * different dimensions is refused so annotations are never attached to the
 * wrong picture.
 */
export async function addImageFiles(store: Store, files: File[], toast: (m: string) => void): Promise<void> {
  const fresh: ImageEntry[] = [];
  let relinked = 0;
  const problems: string[] = [];
  for (const file of files) {
    if (!isSupportedImage(file)) { problems.push(`${file.name}: unsupported type`); continue; }
    const existing = store.getProject().images.find((i) => i.name === file.name);
    try {
      if (existing && !hasBitmap(existing.id)) {
        const bm = await decodeImage(file);
        if (bm.width !== existing.width || bm.height !== existing.height) {
          problems.push(`${file.name}: size ${bm.width}x${bm.height} differs from the saved ${existing.width}x${existing.height}, not relinked`);
          bm.close();
          continue;
        }
        registerBitmap(existing.id, bm);
        setSourceFile(existing.id, file);
        relinked += 1;
      } else if (existing || fresh.some((f) => f.name === file.name)) {
        problems.push(`${file.name}: already in this project`);
      } else {
        fresh.push((await loadImageFile(file)).entry);
      }
    } catch (e) {
      problems.push(e instanceof Error ? e.message : `${file.name}: failed to load`);
    }
  }
  if (fresh.length) {
    store.mutate((p) => { p.images.push(...fresh); });
    store.setUI({ activeImageId: fresh[0].id, selectedAnnotationId: null });
  } else if (relinked) {
    store.setUI({});
  }
  const parts: string[] = [];
  if (fresh.length) parts.push(`Added ${fresh.length} image${fresh.length === 1 ? '' : 's'}`);
  if (relinked) parts.push(`relinked ${relinked}`);
  if (parts.length) toast(parts.join(', ') + '.');
  for (const p of problems.slice(0, 4)) toast(p);
  if (problems.length > 4) toast(`${problems.length - 4} more files had problems.`);
}
