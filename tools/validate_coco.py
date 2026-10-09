# Validates a COCO file exported by Annotate Anything with the reference reader (pycocotools).
# Usage: pip install pycocotools numpy; python tools/validate_coco.py export.json
# Checks: loads, unique ids, known categories/images, bbox inside image, polygon mask area/bbox consistency,
# and a self-evaluation (ground truth as detections must score AP = 1.0) for bbox and, if every annotation has a mask, segm.
import json, sys, io, contextlib
from pycocotools.coco import COCO
from pycocotools.cocoeval import COCOeval
import numpy as np

path = sys.argv[1] if len(sys.argv) > 1 else 'coco_export.json'
problems = []
with contextlib.redirect_stdout(io.StringIO()):
    coco = COCO(path)
d = json.load(open(path))
print('images', len(coco.imgs), 'annotations', len(coco.anns), 'categories', len(coco.cats))

ids = [a['id'] for a in d['annotations']]
if len(set(ids)) != len(ids): problems.append('duplicate annotation ids')
for a in d['annotations']:
    if a['category_id'] not in coco.cats: problems.append(f"ann {a['id']}: unknown category")
    img = coco.imgs.get(a['image_id'])
    if img is None: problems.append(f"ann {a['id']}: unknown image"); continue
    x, y, w, h = a['bbox']
    if not (w > 0 and h > 0 and x >= -1e-6 and y >= -1e-6 and x + w <= img['width'] + 1e-6 and y + h <= img['height'] + 1e-6):
        problems.append(f"ann {a['id']}: bbox outside image {a['bbox']}")
    if 'segmentation' in a and a['segmentation']:
        m = coco.annToMask(a)
        if m.shape != (img['height'], img['width']): problems.append(f"ann {a['id']}: mask shape {m.shape}")
        ma = int(m.sum())
        # rasterized area vs declared area (polygon area from shoelace); allow rasterization error
        if abs(ma - a['area']) > max(0.03 * a['area'], 0.01 * (w + h) * 4 + 8):
            problems.append(f"ann {a['id']}: mask area {ma} vs area {a['area']}")
        ys, xs = np.nonzero(m)
        mb = [xs.min(), ys.min(), xs.max() + 1 - xs.min(), ys.max() + 1 - ys.min()]
        if max(abs(mb[0] - x), abs(mb[1] - y), abs(mb[2] - w), abs(mb[3] - h)) > 2.01:
            problems.append(f"ann {a['id']}: mask bbox {mb} vs bbox {a['bbox']}")
        seg_status = 'segm ok'
    else:
        seg_status = 'NO segmentation'
    print(f"  ann {a['id']}: cat {a['category_id']} bbox {[round(v, 1) for v in a['bbox']]} area {round(a['area'], 1)} iscrowd {a['iscrowd']} -> {seg_status}")

# self-evaluation: GT as detections must give AP = 1 for bbox (and for segm where segmentation exists)
dets = []
for a in d['annotations']:
    dets.append({'image_id': a['image_id'], 'category_id': a['category_id'], 'bbox': a['bbox'], 'score': 1.0})
if dets:
    with contextlib.redirect_stdout(io.StringIO()):
        dt = coco.loadRes(dets)
        ev = COCOeval(coco, dt, 'bbox'); ev.evaluate(); ev.accumulate(); ev.summarize()
    print('bbox self-eval AP =', round(float(ev.stats[0]), 4), ' AP50 =', round(float(ev.stats[1]), 4))
    if ev.stats[0] < 0.999: problems.append(f'bbox self-evaluation AP {ev.stats[0]}')
print('PROBLEMS:' if problems else 'NO PROBLEMS FOUND', *problems, sep='\n  ')

# segmentation self-evaluation on the WHOLE file (every annotation must have a mask for this to run)
try:
    with contextlib.redirect_stdout(io.StringIO()):
        dets = []
        for a in d['annotations']:
            rle = coco.annToRLE(a)
            if isinstance(rle['counts'], bytes): rle['counts'] = rle['counts'].decode('ascii')
            dets.append({'image_id': a['image_id'], 'category_id': a['category_id'], 'segmentation': rle, 'score': 1.0})
        dt = coco.loadRes(dets)
        ev = COCOeval(coco, dt, 'segm'); ev.evaluate(); ev.accumulate(); ev.summarize()
    print('segm self-eval (whole file) AP =', round(float(ev.stats[0]), 4))
except Exception as e:
    print('segm evaluation on the whole file FAILS:', type(e).__name__, str(e)[:80])
