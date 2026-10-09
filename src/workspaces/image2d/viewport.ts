import type { Point2D, Viewport } from '../../core/types';

/**
 * Viewport math.
 *
 * The 2D workspace renders the image at scale `scale` with top-left offset
 * `(tx, ty)` in canvas pixels. Image pixel (ix, iy) is drawn at canvas pixel:
 *
 *     cx = ix * scale + tx
 *     cy = iy * scale + ty
 *
 * All annotation geometry stays in IMAGE pixels; this module is the only
 * place that bridges to/from canvas pixels. Hit testing, drawing of overlays,
 * and tool input all go through here.
 */

export function makeInitialViewport(): Viewport {
  return { scale: 1, tx: 0, ty: 0 };
}

export function imageToCanvas(vp: Viewport, p: Point2D): Point2D {
  return { x: p.x * vp.scale + vp.tx, y: p.y * vp.scale + vp.ty };
}

export function canvasToImage(vp: Viewport, p: Point2D): Point2D {
  return { x: (p.x - vp.tx) / vp.scale, y: (p.y - vp.ty) / vp.scale };
}

/**
 * Fit an image of (imgW, imgH) into a canvas of (canvasW, canvasH),
 * centered, with a small margin. Returns the viewport that achieves this.
 */
export function fitViewport(
  imgW: number, imgH: number, canvasW: number, canvasH: number, margin = 24,
): Viewport {
  const availW = Math.max(1, canvasW - margin * 2);
  const availH = Math.max(1, canvasH - margin * 2);
  const scale = Math.min(availW / imgW, availH / imgH);
  const tx = (canvasW - imgW * scale) / 2;
  const ty = (canvasH - imgH * scale) / 2;
  return { scale, tx, ty };
}

/**
 * Zoom around a canvas-space anchor point (where the mouse is). After the
 * zoom, the image pixel that was under the anchor is still under the anchor.
 */
export function zoomAt(vp: Viewport, anchorCanvas: Point2D, factor: number, minScale = 0.05, maxScale = 40): Viewport {
  const newScale = clamp(vp.scale * factor, minScale, maxScale);
  if (newScale === vp.scale) return vp;
  // Keep the image point under the anchor stationary:
  //   anchor_canvas = img * oldScale + oldTx
  //   anchor_canvas = img * newScale + newTx   =>   newTx = anchor - img * newScale
  const imgAtAnchor = canvasToImage(vp, anchorCanvas);
  const tx = anchorCanvas.x - imgAtAnchor.x * newScale;
  const ty = anchorCanvas.y - imgAtAnchor.y * newScale;
  return { scale: newScale, tx, ty };
}

export function pan(vp: Viewport, dx: number, dy: number): Viewport {
  return { scale: vp.scale, tx: vp.tx + dx, ty: vp.ty + dy };
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
