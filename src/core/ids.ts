/**
 * Stable ID generation.
 *
 * - A short monotonic counter + a 4-char session nonce keeps IDs unique within
 *   a project and across concurrent copies of the app, without the length
 *   overhead of a full UUIDv4.
 * - Class/annotation/image IDs are OPAQUE strings everywhere in the codebase;
 *   never parse them.
 * - Prefix tells you what kind of thing it is at a glance (debug only).
 */

const SESSION_NONCE = Math.random().toString(36).slice(2, 6);

let counter = 0;

function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_${SESSION_NONCE}_${counter.toString(36)}`;
}

export const newClassId      = () => nextId('cls');
export const newAnnotationId = () => nextId('ann');
export const newImageId      = () => nextId('img');
