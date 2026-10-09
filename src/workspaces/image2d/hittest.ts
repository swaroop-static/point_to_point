import type { Annotation, BoxGeom, BoxHandle, HitResult, ImageEntry, Point2D, Viewport } from '../../core/types';

/**
 * Hit testing in image space.
 *
 * Pick order (first hit wins) is designed so direct editing beats selection:
 *
 *   1. Vertex of the SELECTED polygon (easiest to grab even at tight zoom).
 *   2. Box resize handle of the SELECTED box.
 *   3. Edge midpoint of the SELECTED polygon (click-to-insert).
 *   4. Any vertex / handle on any other annotation (if clicked near one).
 *   5. The interior of any annotation (click-to-select / drag-to-move).
 *   6. Nothing — a drag here means "pan" (handled by caller).
 *
 * Thresholds are expressed in CANVAS pixels so they stay stable as the user
 * zooms. The caller passes `vp.scale` so we convert the "near" radius to
 * image-space pixels at the current zoom level.
 */

export const VERTEX_HIT_PX = 8;   // halo around a vertex marker
export const EDGE_HIT_PX   = 6;   // perpendicular distance to an edge
export const HANDLE_HIT_PX = 10;  // halo around a box resize handle

export function hitTest(
  img: ImageEntry,
  cursorImg: Point2D,
  vp: Viewport,
  selectedAnnId: string | null,
): HitResult {
  const inv = 1 / vp.scale;
  const vTol = VERTEX_HIT_PX * inv;
  const eTol = EDGE_HIT_PX   * inv;
  const hTol = HANDLE_HIT_PX * inv;

  // Pass 1: prioritise the selected annotation's own grab targets so a
  //         user editing a polygon doesn't accidentally snap to a nearby
  //         different annotation.
  const sel = selectedAnnId ? img.annotations.find((a) => a.id === selectedAnnId) ?? null : null;
  if (sel && !sel.hidden && !sel.locked) {
    const r = hitAnnotationHandles(sel, cursorImg, vTol, eTol, hTol);
    if (r.kind !== 'none') return r;
  }

  // Pass 2: select by interior or border. Handles of UNSELECTED shapes are
  // deliberately not grabbable: the first click on any shape only selects it,
  // so a click on a border can never insert a vertex or start a resize by
  // accident. Topmost (last drawn) annotation wins.
  for (let i = img.annotations.length - 1; i >= 0; i--) {
    const a = img.annotations[i];
    if (a.hidden) continue;
    if (hitInterior(a, cursorImg, eTol, vTol)) return { kind: 'annotation', annId: a.id };
  }

  return { kind: 'none' };
}

function hitAnnotationHandles(
  a: Annotation, c: Point2D, vTol: number, eTol: number, hTol: number,
): HitResult {
  if (a.geom.kind === 'keypoint') return { kind: 'none' };
  if (a.geom.kind === 'polygon' || a.geom.kind === 'polyline') {
    const pts = a.geom.points;
    const closed = a.geom.kind === 'polygon';
    for (let i = 0; i < pts.length; i++) {
      if (dist2(pts[i], c) <= vTol * vTol) {
        return { kind: 'vertex', annId: a.id, vertexIndex: i };
      }
    }
    const edgeCount = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < edgeCount; i++) {
      const p1 = pts[i], p2 = pts[(i + 1) % pts.length];
      if (perpendicularDist(c, p1, p2) <= eTol) {
        // Only count the hit if the foot of the perpendicular lies on the
        // segment, not just its infinite line.
        const foot = segmentFoot(c, p1, p2);
        if (foot) return { kind: 'edge-midpoint', annId: a.id, edgeIndex: i, at: foot };
      }
    }
  } else {
    for (const h of ALL_BOX_HANDLES) {
      const p = boxHandlePoint(a.geom, h);
      if (dist2(p, c) <= hTol * hTol) return { kind: 'box-handle', annId: a.id, handle: h };
    }
  }
  return { kind: 'none' };
}

function hitInterior(a: Annotation, c: Point2D, eTol: number, vTol: number): boolean {
  const g = a.geom;
  if (g.kind === 'box') {
    const x1 = Math.min(g.x, g.x + g.w), x2 = Math.max(g.x, g.x + g.w);
    const y1 = Math.min(g.y, g.y + g.h), y2 = Math.max(g.y, g.y + g.h);
    return c.x >= x1 && c.x <= x2 && c.y >= y1 && c.y <= y2;
  }
  if (g.kind === 'keypoint') return dist2({ x: g.x, y: g.y }, c) <= (vTol * 1.5) ** 2;
  if (g.kind === 'polyline') {
    for (let i = 0; i < g.points.length - 1; i++) {
      if (perpendicularDist(c, g.points[i], g.points[i + 1]) <= eTol) return true;
    }
    return false;
  }
  if (pointInPolygon(c, g.points)) return true;
  for (let i = 0; i < g.points.length; i++) {
    if (perpendicularDist(c, g.points[i], g.points[(i + 1) % g.points.length]) <= eTol) return true;
  }
  return false;
}

/** Ray-casting point-in-polygon. */
export function pointInPolygon(p: Point2D, pts: Point2D[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y;
    const xj = pts[j].x, yj = pts[j].y;
    const intersect = ((yi > p.y) !== (yj > p.y)) &&
      (p.x < ((xj - xi) * (p.y - yi)) / (yj - yi + 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

export const ALL_BOX_HANDLES: BoxHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export function boxHandlePoint(b: BoxGeom, h: BoxHandle): Point2D {
  // Normalise: handle positions always refer to the drawn (axis-aligned) rect,
  // even if the user dragged with a negative width/height.
  const x1 = Math.min(b.x, b.x + b.w), x2 = Math.max(b.x, b.x + b.w);
  const y1 = Math.min(b.y, b.y + b.h), y2 = Math.max(b.y, b.y + b.h);
  const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
  switch (h) {
    case 'nw': return { x: x1, y: y1 };
    case 'n':  return { x: cx, y: y1 };
    case 'ne': return { x: x2, y: y1 };
    case 'e':  return { x: x2, y: cy };
    case 'se': return { x: x2, y: y2 };
    case 's':  return { x: cx, y: y2 };
    case 'sw': return { x: x1, y: y2 };
    case 'w':  return { x: x1, y: cy };
  }
}

function dist2(a: Point2D, b: Point2D): number {
  const dx = a.x - b.x, dy = a.y - b.y;
  return dx * dx + dy * dy;
}
function perpendicularDist(p: Point2D, a: Point2D, b: Point2D): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.sqrt(dist2(p, a));
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  const fx = a.x + t * dx, fy = a.y + t * dy;
  return Math.hypot(p.x - fx, p.y - fy);
}
function segmentFoot(p: Point2D, a: Point2D, b: Point2D): Point2D | null {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return null;
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  if (t < 0.05 || t > 0.95) return null;  // reject hits too close to endpoints — those are the vertex pick's job
  return { x: a.x + t * dx, y: a.y + t * dy };
}
