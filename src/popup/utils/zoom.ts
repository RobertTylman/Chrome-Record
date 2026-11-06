// Waveform zoom limits

// Zoomed all the way in, the view spans about this many seconds
const MIN_VISIBLE_SECONDS = 0.1;
const MIN_MAX_ZOOM = 16;
const MAX_ZOOM_CAP = 4096;

// Longer recordings can zoom further, down to MIN_VISIBLE_SECONDS across the view
export function maxZoomFor(duration: number): number {
  if (!(duration > 0)) return MIN_MAX_ZOOM;
  return Math.max(MIN_MAX_ZOOM, Math.min(MAX_ZOOM_CAP, duration / MIN_VISIBLE_SECONDS));
}

export function formatZoom(zoom: number): string {
  if (zoom < 10) return `${Math.round(zoom * 10) / 10}×`;
  return `${Math.round(zoom)}×`;
}
