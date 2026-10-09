import { describe, expect, it } from 'vitest';
import { Store } from '../src/core/store';
import { parseProjectJson } from '../src/core/validate';
import { exportCoco } from '../src/io/coco';
import type { Project } from '../src/core/types';
import { canvasToImage, fitViewport, imageToCanvas, zoomAt } from '../src/workspaces/image2d/viewport';
import { hitTest, pointInPolygon } from '../src/workspaces/image2d/hittest';

function sampleProject(): Project {
  return {
    formatVersion: 2, app: 'annotate-anything', name: 'sample', savedAt: '2026-01-01T00:00:00.000Z',
    classes: [
      { id: 'c1', name: 'cat', color: '#ff0000' },
      { id: 'c2', name: 'dog', color: '#00ff00' },
    ],
    images: [
      {
        id: 'i1', name: 'a.jpg', width: 200, height: 100,
        annotations: [
          { id: 'a1', classId: 'c1', geom: { kind: 'box', x: 10, y: 20, w: 50, h: 30 } },
          { id: 'a2', classId: 'c2', geom: { kind: 'polygon', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }] } },
        ],
      },
      { id: 'i2', name: 'empty.png', width: 64, height: 64, annotations: [] },
    ],
  };
}

describe('project JSON', () => {
  it('round-trips without changing geometry, ids, classes or image links', () => {
    const p = sampleProject();
    expect(parseProjectJson(JSON.stringify(p))).toEqual(p);
  });
  it('rejects invalid JSON, wrong app tag, unknown version, unknown classId, tiny polygon', () => {
    expect(() => parseProjectJson('{nope')).toThrow(/valid JSON/);
    expect(() => parseProjectJson(JSON.stringify({ ...sampleProject(), app: 'x' }))).toThrow(/Not an Annotate Anything/);
    expect(() => parseProjectJson(JSON.stringify({ ...sampleProject(), formatVersion: 3 }))).toThrow(/Unsupported/);
    const bad = sampleProject();
    bad.images[0].annotations[0].classId = 'ghost';
    expect(() => parseProjectJson(JSON.stringify(bad))).toThrow(/unknown classId/);
    const tiny = sampleProject();
    tiny.images[0].annotations[1].geom = { kind: 'polygon', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] };
    expect(() => parseProjectJson(JSON.stringify(tiny))).toThrow(/fewer than 3/);
  });
});

describe('COCO export', () => {
  it('produces consistent boxes, polygon segmentation, areas and 1-based ids', () => {
    const { dataset, warnings } = exportCoco(sampleProject());
    expect(warnings).toEqual([]);
    expect(dataset.categories.map((c) => [c.id, c.name])).toEqual([[1, 'cat'], [2, 'dog']]);
    expect(dataset.images).toHaveLength(2);
    expect(dataset.images[1]).toMatchObject({ id: 2, file_name: 'empty.png', width: 64, height: 64 });
    const [box, poly] = dataset.annotations;
    expect(box).toMatchObject({ image_id: 1, category_id: 1, bbox: [10, 20, 50, 30], area: 1500, iscrowd: 0 });
    expect(box.segmentation).toBeUndefined();
    expect(poly).toMatchObject({ image_id: 1, category_id: 2, bbox: [0, 0, 100, 50], area: 5000 });
    expect(poly.segmentation).toEqual([[0, 0, 100, 0, 100, 50, 0, 50]]);
  });
  it('normalizes negative-size boxes and clamps to image bounds', () => {
    const p = sampleProject();
    p.images[0].annotations = [{ id: 'n', classId: 'c1', geom: { kind: 'box', x: 150, y: 80, w: -300, h: -200 } }];
    const { dataset } = exportCoco(p);
    expect(dataset.annotations[0].bbox).toEqual([0, 0, 150, 80]);
  });
  it('skips degenerate geometry with a warning and never emits NaN', () => {
    const p = sampleProject();
    p.images[0].annotations = [
      { id: 'z', classId: 'c1', geom: { kind: 'box', x: 5, y: 5, w: 0, h: 10 } },
      { id: 'q', classId: 'c1', geom: { kind: 'polygon', points: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }] } },
    ];
    const { dataset, warnings } = exportCoco(p);
    expect(dataset.annotations).toHaveLength(0);
    expect(warnings.length).toBe(2);
    expect(JSON.stringify(dataset)).not.toMatch(/NaN|Infinity|null/);
  });
});

describe('viewport', () => {
  it('canvas<->image transforms are inverses', () => {
    const vp = { scale: 2.5, tx: 40, ty: -12 };
    const p = { x: 33.3, y: 71.9 };
    const back = canvasToImage(vp, imageToCanvas(vp, p));
    expect(back.x).toBeCloseTo(p.x, 9);
    expect(back.y).toBeCloseTo(p.y, 9);
  });
  it('zoomAt keeps the image point under the cursor fixed', () => {
    const vp = fitViewport(400, 300, 800, 600);
    const anchor = { x: 321, y: 187 };
    const before = canvasToImage(vp, anchor);
    const after = canvasToImage(zoomAt(vp, anchor, 1.7), anchor);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });
});

describe('hit testing', () => {
  const img = sampleProject().images[0];
  const vp = { scale: 1, tx: 0, ty: 0 };
  it('point in polygon', () => {
    const sq = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    expect(pointInPolygon({ x: 5, y: 5 }, sq)).toBe(true);
    expect(pointInPolygon({ x: 15, y: 5 }, sq)).toBe(false);
  });
  it('picks a vertex of the selected polygon within tolerance, edge midpoint on an edge, interior otherwise', () => {
    expect(hitTest(img, { x: 101, y: 1 }, vp, 'a2')).toMatchObject({ kind: 'vertex', annId: 'a2', vertexIndex: 1 });
    expect(hitTest(img, { x: 50, y: 1 }, vp, 'a2')).toMatchObject({ kind: 'edge-midpoint', edgeIndex: 0 });
    expect(hitTest(img, { x: 80, y: 40 }, vp, null)).toMatchObject({ kind: 'annotation', annId: 'a2' });
    // A box's resize handle is grabbable only while that box is selected.
    expect(hitTest(img, { x: 60, y: 38 }, vp, 'a1')).toMatchObject({ kind: 'box-handle', annId: 'a1', handle: 'e' });
    expect(hitTest(img, { x: 60, y: 38 }, vp, null).kind).toBe('annotation');
    // Clicking the border of an UNSELECTED polygon selects it; it must not insert a vertex.
    expect(hitTest(img, { x: 50, y: 0 }, vp, null)).toMatchObject({ kind: 'annotation', annId: 'a2' });
    expect(hitTest(img, { x: 190, y: 90 }, vp, null)).toEqual({ kind: 'none' });
  });
  it('vertex tolerance is constant in screen pixels across zoom', () => {
    const zoomed = { scale: 10, tx: 0, ty: 0 };
    // 0.5 image px = 5 screen px: inside the 8px halo at 10x zoom.
    expect(hitTest(img, { x: 100.5, y: 0 }, zoomed, 'a2').kind).toBe('vertex');
    // 2 image px = 20 screen px: outside the halo.
    expect(hitTest(img, { x: 102, y: 0 }, zoomed, 'a2').kind).not.toBe('vertex');
  });
});

describe('store undo/redo and gestures', () => {
  function storeWithImage(): Store {
    return new Store(sampleProject());
  }
  it('undo and redo restore geometry and metadata', () => {
    const s = storeWithImage();
    s.mutate((p) => { p.images[0].annotations[0].classId = 'c2'; });
    s.mutate((p) => { p.images[0].annotations.pop(); });
    expect(s.getProject().images[0].annotations).toHaveLength(1);
    s.undo();
    expect(s.getProject().images[0].annotations).toHaveLength(2);
    expect(s.getProject().images[0].annotations[0].classId).toBe('c2');
    s.undo();
    expect(s.getProject().images[0].annotations[0].classId).toBe('c1');
    s.redo();
    expect(s.getProject().images[0].annotations[0].classId).toBe('c2');
  });
  it('a whole drag gesture is a single undo step', () => {
    const s = storeWithImage();
    s.beginGesture();
    for (let i = 1; i <= 20; i++) {
      s.liveMutate((p) => { const g = p.images[0].annotations[0].geom; if (g.kind === 'box') g.x = 10 + i; });
    }
    s.endGesture(true);
    expect((s.getProject().images[0].annotations[0].geom as { x: number }).x).toBe(30);
    s.undo();
    expect((s.getProject().images[0].annotations[0].geom as { x: number }).x).toBe(10);
    expect(s.history.canUndo()).toBe(false);
  });
  it('a cancelled gesture rolls back and records nothing', () => {
    const s = storeWithImage();
    s.beginGesture();
    s.liveMutate((p) => { p.images[0].annotations = []; });
    s.endGesture(false);
    expect(s.getProject().images[0].annotations).toHaveLength(2);
    expect(s.history.canUndo()).toBe(false);
  });
  it('tracks unsaved changes', () => {
    const s = storeWithImage();
    expect(s.isDirty()).toBe(false);
    s.mutate((p) => { p.name = 'x'; });
    expect(s.isDirty()).toBe(true);
    s.markSaved();
    expect(s.isDirty()).toBe(false);
  });
});
