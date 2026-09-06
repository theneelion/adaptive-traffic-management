export interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export function computeMapBounds(map: {
  intersections: { x: number; y: number }[];
  approaches: {
    laneStartX: number;
    laneStartY: number;
    laneEndX: number;
    laneEndY: number;
    waypoints?: { x: number; y: number }[];
  }[];
  pedestrianNodes: { x: number; y: number }[];
}): Bounds {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const i of map.intersections) {
    xs.push(i.x);
    ys.push(i.y);
  }
  for (const a of map.approaches) {
    xs.push(a.laneStartX, a.laneEndX);
    ys.push(a.laneStartY, a.laneEndY);
    for (const w of a.waypoints ?? []) {
      xs.push(w.x);
      ys.push(w.y);
    }
  }
  for (const n of map.pedestrianNodes) {
    xs.push(n.x);
    ys.push(n.y);
  }
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

export interface CameraFit {
  zoom: number;
  centerX: number;
  centerY: number;
  minZoom: number;
  maxZoom: number;
}

// marginFraction: extra breathing room around the tightest bounding box, as a fraction of the
// fitted dimension — so the map's own edge geometry isn't flush against the viewport border.
export function computeCameraFit(bounds: Bounds, canvasWidth: number, canvasHeight: number, marginFraction = 0.1): CameraFit {
  const rawWidth = Math.max(bounds.maxX - bounds.minX, 1);
  const rawHeight = Math.max(bounds.maxY - bounds.minY, 1);
  const width = rawWidth * (1 + marginFraction);
  const height = rawHeight * (1 + marginFraction);
  const zoom = Math.min(canvasWidth / width, canvasHeight / height);
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  // minZoom = the initial full-map fit itself (can't zoom out further than "see everything");
  // maxZoom = a fixed multiple tighter, giving room to zoom in close enough to make out individual
  // cars/pedestrians/signal state at one intersection, not just a slightly-closer city overview.
  return { zoom, centerX, centerY, minZoom: zoom, maxZoom: zoom * 14 };
}
