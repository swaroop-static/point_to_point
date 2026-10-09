# Keyboard and mouse reference

Shortcuts are ignored while you are typing in a text field.

## Tools

| Key | Action |
|---|---|
| V | Select |
| B | Box |
| P | Polygon |
| Y | Polyline |
| K | Keypoint |
| M | AI click (optional; needs a model, see [ai-assist.md](ai-assist.md)) |
| 1 to 9 | Make class 1-9 active (also re-classes the selected, unlocked annotation) |

## AI click (2D, after enabling a model)

| Input | Action |
|---|---|
| Left-click | Include this object |
| Right-click, or Shift/Alt+click | Exclude |
| Enter | Accept the previewed polygon |
| Esc | Discard |
| Backspace | Remove the last click |

## 3D photo workspace

| Key | Action |
|---|---|
| V / C | Select / add cuboid |
| Drag cuboid | Move |
| Q / E | Rotate 5 degrees |
| W / S | Depth closer / farther |
| H / L / Delete | Hide / lock / delete |
| F, + / - | Fit, zoom |

## 3D model workspace

| Input | Action |
|---|---|
| F / R / O | Select by Face / smooth Region / connected Part |
| Click, Shift+click | Select, add to selection |
| Enter | Label the selection with the active class |
| Esc | Clear selection |
| Delete | Delete the selected labeled object |
| V / W | Reset view / wireframe |
| Drag, right-drag, wheel | Orbit, pan, zoom |

## 3D cloud workspace

| Input | Action |
|---|---|
| V / C | Select / add cuboid (click a point) |
| Drag a cuboid | Move on the horizontal plane |
| Q / E | Yaw -5 / +5 degrees |
| H / L / Delete | Hide / lock / delete the cuboid |
| Shift + drag | Select points inside the rectangle (adds; no occlusion) |
| Enter | Label the selected points with the active class |
| Esc | Clear selection, deselect cuboid |
| T / F / S / R | Top / Front / Side / Reset view |
| Drag, right-drag, wheel | Orbit, pan, zoom |

## Drawing

| Input | Action |
|---|---|
| Box: drag | Draw a box (ignored if smaller than 3 screen pixels) |
| Polygon / polyline: click | Add a point |
| Polygon: click first vertex, Enter, or double-click | Close (needs 3+ vertices) |
| Polyline: Enter or double-click | Finish (needs 2+ points) |
| Keypoint: click | Place a point |
| Right-click | Remove the last point of the unfinished polygon/polyline |
| Shift (while drawing or dragging) | Snap to nearby vertices and horizontal/vertical alignment |
| Esc | Cancel an unfinished shape, clear the preview, deselect |

## Editing (Select tool)

| Input | Action |
|---|---|
| Click a shape or its border | Select (a first click never edits) |
| Drag a selected shape | Move (stays inside the image) |
| Drag a vertex of the selected polygon/polyline | Move it |
| Click an edge of the selected polygon/polyline | Insert a vertex there, then drag to place it |
| Alt + drag an edge of the selected shape | Move that edge (both end points) |
| Double-click a vertex, or hover it + Delete | Delete vertex (polygon keeps 3, polyline keeps 2) |
| Drag a handle of the selected box | Resize |
| Delete / Backspace | Delete selected annotation |
| H / L | Hide / lock selected annotation |
| Simplify slider + Simplify button (right panel) | Reduce vertices; Preview shows the result as a dashed outline; Ctrl+Z undoes |

## View

| Input | Action |
|---|---|
| Mouse wheel | Zoom at cursor |
| Drag empty area, middle mouse, or Space + drag | Pan |
| F | Fit image |
| + / - | Zoom in / out |
| [ / ] | Previous / next image |

## Project

| Key | Action |
|---|---|
| Ctrl+Z | Undo |
| Ctrl+Y or Ctrl+Shift+Z | Redo |
| Ctrl+S | Download project file |

The **File** menu has New, Open, Save and Import COCO. The **Export** menu has COCO and the two YOLO formats.
