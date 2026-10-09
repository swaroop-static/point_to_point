import type { ImageEntry, ImageId } from '../core/types';
import { newImageId } from '../core/ids';

/**
 * Image loading.
 *
 * - User's images stay in the browser. Never uploaded, never sent anywhere.
 * - We hold ONE ImageBitmap per image, keyed by ImageId, in a module-level
 *   cache so switching back to a previously-viewed image is instant.
 * - ImageEntry (persistent) stores only dimensions + metadata. The raw pixels
 *   live only in the cache — they vanish on page reload, which is correct
 *   behavior for a privacy-conscious tool.
 */

const bitmapCache = new Map<ImageId, ImageBitmap>();
/** Original files, kept in memory so YOLO export and autosave can include the real image bytes. */
const fileCache = new Map<ImageId, File | Blob>();

export function setSourceFile(id: ImageId, file: File | Blob): void { fileCache.set(id, file); }
export function getSourceFile(id: ImageId): File | Blob | null { return fileCache.get(id) ?? null; }

const SUPPORTED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

export interface LoadedImage {
  entry: ImageEntry;
  bitmap: ImageBitmap;
}

export function isSupportedImage(file: File): boolean {
  // Trust the MIME type OR the extension — some browsers leave type empty
  // for drag-dropped files.
  if (file.type && SUPPORTED_MIME.has(file.type)) return true;
  const n = file.name.toLowerCase();
  return n.endsWith('.jpg') || n.endsWith('.jpeg') || n.endsWith('.png') || n.endsWith('.webp');
}

/**
 * Load a File into memory and register it. Rejects unsupported types up front.
 * Caller is responsible for adding the returned entry to the project.
 */
export async function decodeImage(file: File): Promise<ImageBitmap> {
  if (!isSupportedImage(file)) {
    throw new Error(`Unsupported image type: ${file.name} (expected JPEG, PNG, or WebP).`);
  }
  // createImageBitmap hands back fully-decoded pixels without a DOM Image.
  // Corrupt or truncated files surface as a DOMException, which we translate.
  try {
    return await createImageBitmap(file);
  } catch {
    throw new Error(`Could not decode ${file.name}: the file may be corrupt or an unsupported variant.`);
  }
}

export async function loadImageFile(file: File): Promise<LoadedImage> {
  const bitmap = await decodeImage(file);
  const entry: ImageEntry = {
    id: newImageId(),
    name: file.name,
    width: bitmap.width,
    height: bitmap.height,
    annotations: [],
  };
  bitmapCache.set(entry.id, bitmap);
  fileCache.set(entry.id, file);
  return { entry, bitmap };
}

/** Attach decoded pixels to an existing entry (used when relinking a reopened project). */
export function registerBitmap(id: ImageId, bitmap: ImageBitmap): void {
  const old = bitmapCache.get(id);
  if (old) { try { old.close(); } catch { /* harmless */ } }
  bitmapCache.set(id, bitmap);
}

export function getBitmap(id: ImageId): ImageBitmap | null {
  return bitmapCache.get(id) ?? null;
}

/**
 * Called when the user removes an image from the project. Frees the decoded
 * bitmap. Safe to call on an unknown id.
 */
export function dropBitmap(id: ImageId): void {
  const bm = bitmapCache.get(id);
  if (bm) {
    try { bm.close(); } catch { /* older browsers may not have close() — harmless */ }
    bitmapCache.delete(id);
  }
}

/** True if we currently have decoded pixels for this image id. */
export function hasBitmap(id: ImageId): boolean {
  return bitmapCache.has(id);
}
