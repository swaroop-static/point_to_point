/**
 * Core domain types.
 *
 * Coordinate convention: every annotation geometry field is in ORIGINAL IMAGE
 * PIXELS, not screen pixels or canvas pixels. The viewport is the only place
 * that does screen<->image transforms. This way, zoom/pan can never corrupt
 * saved geometry and the same project JSON renders identically at any zoom.
 */

export type ClassId = string;
export type AnnotationId = string;
export type ImageId = string;

export interface Point2D {
  x: number;
  y: number;
}

export interface BoxGeom {
  /** Image-pixel coordinates. x,y is the top-left corner, w/h are extents. */
  kind: 'box';
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PolygonGeom {
  kind: 'polygon';
  /** Image-pixel coordinates. Open list of vertices; the polygon is implicitly
   *  closed between the last and first point for rendering + hit testing. */
  points: Point2D[];
}

export interface PolylineGeom {
  kind: 'polyline';
  /** Image-pixel coordinates. Open path, at least 2 points. Never closed. */
  points: Point2D[];
}

export interface KeypointGeom {
  kind: 'keypoint';
  /** Image-pixel coordinates of a single point. */
  x: number;
  y: number;
}

export type Geom = BoxGeom | PolygonGeom | PolylineGeom | KeypointGeom;

export interface Annotation {
  id: AnnotationId;
  classId: ClassId;
  geom: Geom;
  /** Hidden annotations are not drawn and not hit-tested. Still exported. */
  hidden?: boolean;
  /** Locked annotations are rendered dimmed and not editable. Still exported. */
  locked?: boolean;
  /** Freeform label text (optional). */
  note?: string;
}

export interface ClassDef {
  id: ClassId;
  name: string;
  /** 6-char hex color, e.g. "#E58A3C". Never allowed to be empty. */
  color: string;
}

export interface ImageEntry {
  id: ImageId;
  name: string;
  /** Original image pixel width. */
  width: number;
  /** Original image pixel height. */
  height: number;
  /** Annotations are stored flat per image for cheap lookup. Order is draw order. */
  annotations: Annotation[];
  /** Pinhole camera used by the 3D-photo workspace. Absent until first needed. */
  camera?: CameraModel;
  /** 3D cuboids placed on this photo (separate from the 2D annotations above). */
  cuboids?: PhotoCuboid[];
}

export interface Vec3 { x: number; y: number; z: number }

/**
 * Pinhole camera, intrinsics in image pixels. Camera frame is OpenCV-style:
 * +x right, +y down, +z forward (into the scene). `calibrated` is true ONLY
 * when the user states the numbers come from a real calibration; otherwise
 * the camera is an assumption (a guessed field of view) and every 3D size
 * and distance derived from it is relative, not metric.
 */
export interface CameraModel {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  calibrated: boolean;
}

/**
 * A 3D box in the camera frame. `center` is the geometric center. `size` is
 * along the box's own axes: width = local x, height = local y, length = local
 * z (the "front" of the box faces +z when rotationY = 0). `rotationY` is a
 * right-handed rotation about the camera's +y axis, in radians.
 */
export interface PhotoCuboid {
  id: AnnotationId;
  /** Persistent object id (integer >= 1), unique within an image. */
  objectId: number;
  classId: ClassId;
  center: Vec3;
  size: { length: number; width: number; height: number };
  rotationY: number;
  hidden?: boolean;
  locked?: boolean;
  note?: string;
}

/** One labeled object on a mesh: a set of faces (half-open [start, end) ranges) with a class. */
export interface MeshLabel {
  id: string;
  /** Persistent object id (integer >= 1), unique within the mesh. */
  objectId: number;
  classId: ClassId;
  /** Sorted, non-overlapping face ranges. A face belongs to at most one label. */
  ranges: [number, number][];
  hidden?: boolean;
}

/**
 * A 3D model and its face labels. The model itself is never stored in the
 * project (like images); it relinks by file name and `faceCount` must match.
 * Face i is the i-th triangle of the model in the order documented in docs/mesh-annotation.md.
 */
export interface MeshEntry {
  id: string;
  name: string;
  format: 'glb' | 'gltf' | 'obj' | 'ply';
  faceCount: number;
  labels: MeshLabel[];
}

/** A 3D box in a point cloud: center, size and yaw about the cloud's up axis (see src/cloud/geom.ts). */
export interface Cuboid3D {
  id: string;
  /** Persistent object id (integer >= 1), unique within the cloud. */
  objectId: number;
  classId: ClassId;
  center: Vec3;
  /** length along local a, width along local b, height along the up axis. All > 0. */
  size: { length: number; width: number; height: number };
  /** Radians, from +a toward +b. */
  yaw: number;
  hidden?: boolean;
  locked?: boolean;
}

/** Points given a semantic class, as sorted non-overlapping half-open index ranges. A point is in at most one label. */
export interface PointLabel {
  id: string;
  classId: ClassId;
  ranges: [number, number][];
}

/**
 * A point cloud and its annotations. The points are never stored in the
 * project; the file relinks by name and `pointCount` must match.
 */
export interface CloudEntry {
  id: string;
  name: string;
  format: 'ply' | 'pcd';
  pointCount: number;
  /** Which axis points up: cuboid yaw is a rotation about it. */
  upAxis: 'y' | 'z';
  cuboids: Cuboid3D[];
  pointLabels: PointLabel[];
}

/**
 * Versioned project JSON. Every exported file carries `formatVersion` so
 * future releases can migrate older projects safely.
 */
export interface Project {
  /** 2 since the 3D workspaces were added. Version 1 files are migrated on load. */
  formatVersion: 2;
  app: 'annotate-anything';
  /** Project display name. */
  name: string;
  /** ISO-8601 timestamp this project JSON was last serialized at. */
  savedAt: string;
  classes: ClassDef[];
  images: ImageEntry[];
  /** 3D models with face labels (mesh workspace). Optional; absent in older files. */
  meshes?: MeshEntry[];
  /** Point clouds with cuboids and point labels (point-cloud workspace). Optional. */
  clouds?: CloudEntry[];
}

/** Transient (non-persisted) viewport state for the 2D workspace. */
export interface Viewport {
  /** Scale factor: 1 = 100%, 2 = 200%. */
  scale: number;
  /** Translation in CANVAS pixels. Added after scaling the image. */
  tx: number;
  ty: number;
}

/** What was found at a given cursor position in image space. */
export type HitResult =
  | { kind: 'none' }
  | { kind: 'vertex'; annId: AnnotationId; vertexIndex: number }
  | { kind: 'edge-midpoint'; annId: AnnotationId; edgeIndex: number; at: Point2D }
  | { kind: 'box-handle'; annId: AnnotationId; handle: BoxHandle }
  | { kind: 'annotation'; annId: AnnotationId };

export type BoxHandle =
  | 'nw' | 'n' | 'ne'
  | 'w'  |      'e'
  | 'sw' | 's' | 'se';

export type ToolName = 'select' | 'box' | 'polygon' | 'polyline' | 'keypoint' | 'sam';
