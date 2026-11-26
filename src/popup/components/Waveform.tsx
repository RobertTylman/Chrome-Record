import React, { useEffect, useRef, useState, useCallback } from 'react';
import { formatTime } from '../utils/audioUtils';
import { LiveWaveform } from '../hooks/useWaveform';
import { LIVE_LEVELS_PER_SECOND } from '../utils/storageManager';

const EDGE_PADDING = 3; // px left free above and below the loudest point
const MIN_HALF_HEIGHT = 0.75; // silence still shows as a hairline
const POINT_SPACING = 1; // px between outline points in the saved view
const LIVE_WINDOW_SECONDS = 5; // recent audio shown while recording
const LIVE_LEVEL_MS = 1000 / LIVE_LEVELS_PER_SECOND;
// Width of a trim handle (match .trim-handle in popup.css). The waveform is inset by this much on
// each side so a handle at the very start or end fits beside it rather than covering audio.
const TRIM_HANDLE_WIDTH = 8;
// Alt while dragging a handle moves it this much slower, for fine trimming
const FINE_DRAG_FACTOR = 0.1;
// Loudness below this (out of 255, about -16 dB) is not scaled up to fill the box,
// so near-silence stays small instead of turning into amplified noise
const MIN_NORMALIZE_PEAK = 40;
// Opacity at the outer (peak) edge; it rises smoothly to solid at the average-loudness core
const OUTER_EDGE_ALPHA = 0.3;
// More bands on taller canvases so the steps stay invisible
const gradientBands = (height: number) => Math.round(Math.min(48, Math.max(10, height / 32)));
// While recording, the scale assumes peaks of at least this level (out of 255, about -4 dB) and only
// grows if the recording gets louder, so the waveform keeps a steady size
const LIVE_SCALE_FLOOR = 160;

function withAlpha(color: string, alpha: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match) return color;
  const n = parseInt(match[1], 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// Pixels per level unit, so that `peak` reaches the top and bottom of the box
function normalizedScale(peak: number, height: number): number {
  return (height / 2 - EDGE_PADDING) / Math.max(peak, MIN_NORMALIZE_PEAK);
}

const peakCache = new WeakMap<Uint8Array, number>();
function loudest(data: Uint8Array): number {
  let peak = peakCache.get(data);
  if (peak === undefined) {
    peak = 0;
    for (let i = 0; i < data.length; i++) if (data[i] > peak) peak = data[i];
    peakCache.set(data, peak);
  }
  return peak;
}

// Mirrored, smoothly curved outline through (x, value) points
function fillEnvelope(ctx: CanvasRenderingContext2D, xs: number[], values: number[], height: number, scale: number, fillStyle: string) {
  const count = xs.length;
  if (count === 0) return;
  const mid = height / 2;
  const h = values.map(v => Math.max(MIN_HALF_HEIGHT, v * scale));
  const last = count - 1;

  ctx.beginPath();
  ctx.moveTo(xs[0], mid - h[0]);
  for (let i = 1; i < count; i++) {
    ctx.quadraticCurveTo(xs[i - 1], mid - h[i - 1], (xs[i - 1] + xs[i]) / 2, mid - (h[i - 1] + h[i]) / 2);
  }
  ctx.lineTo(xs[last], mid - h[last]);
  ctx.lineTo(xs[last], mid + h[last]);
  for (let i = last - 1; i >= 0; i--) {
    ctx.quadraticCurveTo(xs[i + 1], mid + h[i + 1], (xs[i + 1] + xs[i]) / 2, mid + (h[i + 1] + h[i]) / 2);
  }
  ctx.lineTo(xs[0], mid + h[0]);
  ctx.closePath();
  ctx.fillStyle = fillStyle;
  ctx.fill();
}

// Peaks fade into a solid core of average loudness. Bands between the two outlines follow the
// waveform's shape; each band's opacity is chosen so the stacked result ramps evenly from
// OUTER_EDGE_ALPHA at the peaks to fully solid at the core.
function drawLayers(ctx: CanvasRenderingContext2D, xs: number[], peaks: number[], averages: number[] | null, height: number, scale: number, color: string) {
  if (!averages) {
    fillEnvelope(ctx, xs, peaks, height, scale, color);
    return;
  }
  const bands = gradientBands(height);
  let coveredAlpha = 0; // opacity already painted by the bands outside this one
  for (let band = bands; band >= 0; band--) {
    const t = band / bands; // 1 = peak outline, 0 = average outline
    const targetAlpha = 1 - t * (1 - OUTER_EDGE_ALPHA);
    const alpha = coveredAlpha >= 1 ? 1 : 1 - (1 - targetAlpha) / (1 - coveredAlpha);
    const values = peaks.map((peak, i) => averages[i] + (peak - averages[i]) * t);
    fillEnvelope(ctx, xs, values, height, scale, withAlpha(color, Math.min(1, Math.max(0, alpha))));
    coveredAlpha = targetAlpha;
  }
}

// Value of `data` over [t0, t1) in data-index units. Zoomed out (many points per pixel) it is the
// max or mean of the range; zoomed in past the data's resolution it follows a smooth
// (Catmull-Rom) curve through the points, so the outline has no corners or blocks.
function sampleRange(data: Uint8Array, t0: number, t1: number, mode: 'max' | 'mean'): number {
  if (t1 - t0 >= 1) {
    const from = Math.max(0, Math.floor(t0));
    const to = Math.min(data.length, Math.ceil(t1));
    let max = 0;
    let sum = 0;
    for (let j = from; j < to; j++) {
      if (data[j] > max) max = data[j];
      sum += data[j];
    }
    return mode === 'max' ? max : (to > from ? sum / (to - from) : 0);
  }
  // Each data point covers [i, i + 1); curve through the point centers
  const at = (i: number) => data[Math.max(0, Math.min(data.length - 1, i))];
  const position = (t0 + t1) / 2 - 0.5;
  const i = Math.floor(position);
  const t = position - i;
  const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
  const value = 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (3 * p1 - p0 - 3 * p2 + p3) * t * t * t);
  return Math.max(0, Math.min(255, value));
}

// Saved waveform for data[start, start + length), normalized so the recording's loudest point
// reaches the edges of the box (the same scale at every zoom level)
function drawSavedWaveform(ctx: CanvasRenderingContext2D, data: Uint8Array, avgData: Uint8Array | null, start: number, length: number, width: number, height: number, color: string) {
  if (data.length === 0 || length <= 0) return;
  const perPixel = length / width;
  const averages = avgData && avgData.length === data.length ? avgData : null;
  const xs: number[] = [];
  const peaks: number[] = [];
  const means: number[] = [];

  for (let x = 0; x <= width + POINT_SPACING; x += POINT_SPACING) {
    const t0 = start + (x - POINT_SPACING / 2) * perPixel;
    const t1 = start + (x + POINT_SPACING / 2) * perPixel;
    xs.push(Math.min(x, width));
    peaks.push(sampleRange(data, t0, t1, 'max'));
    if (averages) means.push(sampleRange(averages, t0, t1, 'mean'));
  }
  drawLayers(ctx, xs, peaks, averages ? means : null, height, normalizedScale(loudest(data), height), color);
}

interface WaveformProps {
  data: Uint8Array | null; // peak level per stored window
  avgData?: Uint8Array | null; // average level per stored window
  width?: number;
  height?: number;
  barColor?: string;
  backgroundColor?: string;
  zoom?: number;
  currentTime?: number;
  duration?: number;
  onSeek?: (time: number) => void;
  isRecording?: boolean;
  trimStart?: number;
  trimEnd?: number;
  onTrimChange?: (start: number, end: number) => void;
  liveDataRef?: React.MutableRefObject<LiveWaveform | null>;
  onZoomChange?: (multiplier: number) => void;
}

export const Waveform: React.FC<WaveformProps> = ({
  data,
  avgData = null,
  width = 600,
  height = 200,
  barColor = '#ff9500',
  backgroundColor = '#2a2a2a',
  zoom = 1,
  currentTime = 0,
  duration = 0,
  onSeek,
  isRecording = false,
  trimStart = 0,
  trimEnd = 0,
  onTrimChange,
  liveDataRef,
  onZoomChange
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // The area the waveform is drawn in; times map to positions across it
  const trackRef = useRef<HTMLDivElement>(null);
  // The handle being dragged: where the cut is, and how far from it the pointer grabbed the handle
  const dragRef = useRef<{ time: number; grabOffsetPx: number; lastX: number; fine: boolean } | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const lastPositionRef = useRef<number>(-1);

  // Scroll offset as a ratio of duration (0 to 1 - 1/zoom)
  const [scrollOffset, setScrollOffset] = useState(0);

  // Drag states
  const [draggingHandle, setDraggingHandle] = useState<'start' | 'end' | null>(null);
  const [hoveredHandle, setHoveredHandle] = useState<'start' | 'end' | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef<{ x: number; scrollOffset: number } | null>(null);

  // Clamp scroll offset when zoom changes
  useEffect(() => {
    const maxOffset = Math.max(0, 1 - 1 / zoom);
    if (scrollOffset > maxOffset) {
      setScrollOffset(maxOffset);
    }
  }, [zoom, scrollOffset]);

  // Reset scroll when zoom returns to 1
  useEffect(() => {
    if (zoom === 1) {
      setScrollOffset(0);
    }
  }, [zoom]);

  // Calculate visible time range
  const getVisibleRange = useCallback(() => {
    const visibleDuration = duration / zoom;
    const startTime = scrollOffset * duration;
    const endTime = startTime + visibleDuration;
    return { startTime, endTime, visibleDuration };
  }, [duration, zoom, scrollOffset]);

  // Convert screen X position to time
  const getTimeFromX = useCallback((clientX: number): number => {
    if (!trackRef.current || !duration) return 0;
    const rect = trackRef.current.getBoundingClientRect();
    const x = clientX - rect.left;
    const percentage = Math.max(0, Math.min(1, x / rect.width));
    const { startTime, visibleDuration } = getVisibleRange();
    return startTime + percentage * visibleDuration;
  }, [duration, getVisibleRange]);

  // Convert time to screen X percentage (relative to container)
  const getXPercentFromTime = useCallback((time: number): number => {
    const { startTime, visibleDuration } = getVisibleRange();
    if (visibleDuration <= 0) return 0;
    return ((time - startTime) / visibleDuration) * 100;
  }, [getVisibleRange]);

  // Draw waveform
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Set canvas size
    canvas.width = width;
    canvas.height = height;

    // Clear canvas
    ctx.fillStyle = backgroundColor;
    ctx.fillRect(0, 0, width, height);

    // Calculate which portion of data to show
    const { startTime, endTime } = getVisibleRange();
    const startRatio = duration > 0 ? startTime / duration : 0;
    const endRatio = duration > 0 ? endTime / duration : 1;

    const dataStartIndex = Math.floor(startRatio * data.length);
    const dataEndIndex = Math.ceil(endRatio * data.length);
    const visibleDataLength = dataEndIndex - dataStartIndex;

    if (visibleDataLength <= 0) return;

    drawSavedWaveform(ctx, data, avgData, dataStartIndex, visibleDataLength, width, height, barColor);
  }, [data, width, height, barColor, backgroundColor, zoom, scrollOffset, duration, getVisibleRange]);

  // Smooth playback position indicator with cached waveform for performance
  // Cache the rendered waveform to avoid redrawing all bars every frame
  const cachedWaveformRef = useRef<{
    imageData: ImageData | null;
    dataHash: string;
    zoom: number;
    scrollOffset: number;
    width: number;
    height: number;
    barColor: string;
    backgroundColor: string;
  }>({ imageData: null, dataHash: '', zoom: 1, scrollOffset: 0, width: 0, height: 0, barColor: '', backgroundColor: '' });
  // =====================================================
  // RECORDING ANIMATION LOOP (separate from playback logic)
  // This runs independently when isRecording is true
  // =====================================================
  useEffect(() => {
    if (!isRecording) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let isActive = true;

    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;

    // Scrolling loudness: newest audio enters on the right, older audio fades out on the left
    const visibleLevels = LIVE_LEVELS_PER_SECOND * LIVE_WINDOW_SECONDS;
    const levelWidth = width / visibleLevels;
    const fade = ctx.createLinearGradient(0, 0, width * 0.2, 0);
    fade.addColorStop(0, withAlpha(backgroundColor, 1));
    fade.addColorStop(1, withAlpha(backgroundColor, 0));
    // Scale from the loudest level of the whole recording: it never shrinks, and grows smoothly
    let displayPeak = 0;

    const drawFrame = () => {
      if (!isActive) return;

      ctx.fillStyle = backgroundColor;
      ctx.fillRect(0, 0, width, height);

      // Faint center line so the not-yet-filled part of the view doesn't look empty
      ctx.fillStyle = withAlpha(barColor, 0.25);
      ctx.fillRect(0, Math.floor(height / 2), width, 1);

      const live = liveDataRef?.current;
      if (live && live.levels.length > 0) {
        // Glide toward the newest level between updates so the scroll is continuous
        const progress = Math.min(1, (performance.now() - live.receivedAt) / LIVE_LEVEL_MS);
        const newest = live.total - 1 + progress;
        const first = live.total - live.levels.length;
        const xs: number[] = [];
        const peaks: number[] = [];
        const averages: number[] = [];
        for (let k = Math.max(0, live.levels.length - visibleLevels - 2); k < live.levels.length; k++) {
          xs.push(width - (newest - (first + k)) * levelWidth);
          peaks.push(live.levels[k]);
          averages.push(live.avgLevels[k] ?? 0);
        }
        const targetPeak = Math.max(LIVE_SCALE_FLOOR, live.loudest || 0);
        if (displayPeak === 0) displayPeak = targetPeak; // e.g. popup reopened mid-recording
        else if (targetPeak > displayPeak) displayPeak += (targetPeak - displayPeak) * 0.15;
        drawLayers(ctx, xs, peaks, averages, height, normalizedScale(displayPeak, height), barColor);
        ctx.fillStyle = fade;
        ctx.fillRect(0, 0, width * 0.2, height);
      }

      // Continue loop
      animationFrameRef.current = requestAnimationFrame(drawFrame);
    };

    // Start the loop
    drawFrame();

    return () => {
      isActive = false;
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [isRecording, liveDataRef, width, height, barColor, backgroundColor]);

  // =====================================================
  // PLAYBACK RENDERING (uses data prop, zoom, scroll, etc.)
  // This effect is ONLY for when NOT recording
  // =====================================================
  useEffect(() => {
    // Skip during recording - handled by the effect above
    if (isRecording) return;

    if (duration <= 0 || !data) {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Generate a simple hash of the data for cache invalidation
    const dataHash = data.length.toString() + '_' + (data[0] || 0) + '_' + (data[Math.floor(data.length / 2)] || 0);

    const { startTime, endTime, visibleDuration } = getVisibleRange();
    const startRatio = startTime / duration;
    const endRatio = endTime / duration;
    const dataStartIndex = Math.floor(startRatio * data.length);
    const dataEndIndex = Math.ceil(endRatio * data.length);
    const visibleDataLength = dataEndIndex - dataStartIndex;

    // Check if we need to redraw the waveform (data or view changed)
    const cache = cachedWaveformRef.current;
    const needsRedraw =
      cache.dataHash !== dataHash ||
      cache.zoom !== zoom ||
      cache.scrollOffset !== scrollOffset ||
      cache.width !== width ||
      cache.height !== height ||
      cache.barColor !== barColor ||
      cache.backgroundColor !== backgroundColor ||
      !cache.imageData;

    // PLAYBACK / STATIC Logic (uses existing zoom/scroll logic)
    if (needsRedraw && visibleDataLength > 0) {
      ctx.fillStyle = backgroundColor;
      ctx.fillRect(0, 0, width, height);

      drawSavedWaveform(ctx, data, avgData, dataStartIndex, visibleDataLength, width, height, barColor);

      // Cache the result for playback performance
      cache.imageData = ctx.getImageData(0, 0, width, height);
      cache.dataHash = dataHash;
      cache.zoom = zoom;
      cache.scrollOffset = scrollOffset;
      cache.width = width;
      cache.height = height;
      cache.barColor = barColor;
      cache.backgroundColor = backgroundColor;
    } else if (cache.imageData) {
      ctx.putImageData(cache.imageData, 0, 0);
    }

    // Only run continuous animation loop during playback (for playhead)
    let isActive = true;

    const drawPlayhead = () => {
      if (!isActive || !canvas || !ctx) return;

      // Restore cached waveform
      if (cache.imageData) {
        ctx.putImageData(cache.imageData, 0, 0);
      }

      // Draw playhead if in visible range
      const { startTime: st, endTime: et, visibleDuration: vd } = getVisibleRange();
      if (currentTime >= st && currentTime <= et) {
        const playheadX = ((currentTime - st) / vd) * width;
        ctx.strokeStyle = '#888';
        ctx.lineWidth = 2;
        ctx.beginPath();
        const lineX = Math.floor(playheadX) + 0.5;
        ctx.moveTo(lineX, 0);
        ctx.lineTo(lineX, height);
        ctx.stroke();
        lastPositionRef.current = lineX;
      }

      if (isActive && duration > 0) {
        animationFrameRef.current = requestAnimationFrame(drawPlayhead);
      }
    };

    animationFrameRef.current = requestAnimationFrame(drawPlayhead);

    return () => {
      isActive = false;
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [currentTime, duration, width, height, data, zoom, scrollOffset, backgroundColor, barColor, getVisibleRange, isRecording]);

  // Handle click for seeking
  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!onSeek || !duration || isRecording || draggingHandle || isPanning) return;
    const seekTime = getTimeFromX(e.clientX);
    onSeek(Math.max(0, Math.min(seekTime, duration)));
  };

  // Handle mouse down for trim handles
  // The cut point stays exactly where it was relative to the pointer, so the handle's tip (not the
  // pointer) marks the cut and nothing jumps when the handle is grabbed
  const handleTrimMouseDown = (e: React.MouseEvent, handle: 'start' | 'end') => {
    e.stopPropagation();
    e.preventDefault();
    const time = handle === 'start' ? trimStart : (trimEnd > 0 && trimEnd < duration ? trimEnd : duration);
    dragRef.current = { time, grabOffsetPx: e.clientX - clientXOfTime(time), lastX: e.clientX, fine: e.altKey };
    setDraggingHandle(handle);
  };

  // Screen x of a time in the current view (not clamped to the view)
  const clientXOfTime = (time: number): number => {
    const rect = trackRef.current?.getBoundingClientRect();
    const { startTime, visibleDuration } = getVisibleRange();
    if (!rect || visibleDuration <= 0) return 0;
    return rect.left + ((time - startTime) / visibleDuration) * rect.width;
  };

  // Arrow keys nudge a focused handle by 0.1 s (1 s with Shift, 0.01 s with Alt), with the same
  // limits as dragging
  const handleTrimKeyDown = (e: React.KeyboardEvent, handle: 'start' | 'end') => {
    if (!onTrimChange || !duration || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    e.stopPropagation();
    const step = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1 : e.altKey ? 0.01 : 0.1);
    const end = trimEnd > 0 && trimEnd < duration ? trimEnd : duration;
    if (handle === 'start') {
      onTrimChange(Math.max(0, Math.min(trimStart + step, end - 0.1)), end);
    } else {
      onTrimChange(trimStart, Math.min(duration, Math.max(end + step, trimStart + 0.1)));
    }
  };

  // Handle mouse down for panning
  const handlePanMouseDown = (e: React.MouseEvent) => {
    if (draggingHandle || zoom <= 1) return;
    // Only start panning on left click and not on handles
    if (e.button !== 0) return;
    setIsPanning(true);
    panStartRef.current = { x: e.clientX, scrollOffset };
  };

  // Handle trim dragging
  useEffect(() => {
    if (!draggingHandle) return;

    const handleMouseMove = (e: MouseEvent) => {
      const drag = dragRef.current;
      const rect = trackRef.current?.getBoundingClientRect();
      if (!onTrimChange || !duration || !drag || !rect) return;
      const { startTime, visibleDuration } = getVisibleRange();
      const secondsPerPx = visibleDuration / rect.width;
      if (e.altKey) {
        // Fine: move by a tenth of the pointer's movement
        drag.time += (e.clientX - drag.lastX) * secondsPerPx * FINE_DRAG_FACTOR;
        drag.fine = true;
      } else {
        // Coming out of fine mode, keep the cut where it is and follow the pointer from here
        if (drag.fine) {
          drag.grabOffsetPx = e.clientX - (rect.left + (drag.time - startTime) / secondsPerPx);
          drag.fine = false;
        }
        drag.time = startTime + (e.clientX - drag.grabOffsetPx - rect.left) * secondsPerPx;
      }
      drag.lastX = e.clientX;
      const time = drag.time;
      if (draggingHandle === 'start') {
        const maxStart = trimEnd > 0 ? trimEnd - 0.1 : duration - 0.1;
        onTrimChange(Math.max(0, Math.min(time, maxStart)), trimEnd || duration);
      } else {
        const minEnd = trimStart + 0.1;
        onTrimChange(trimStart, Math.min(duration, Math.max(time, minEnd)));
      }
    };

    const handleMouseUp = () => {
      dragRef.current = null;
      setDraggingHandle(null);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [draggingHandle, duration, onTrimChange, trimStart, trimEnd, getVisibleRange]);

  // Handle panning
  useEffect(() => {
    if (!isPanning) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!panStartRef.current || !trackRef.current) return;
      const rect = trackRef.current.getBoundingClientRect();
      const deltaX = e.clientX - panStartRef.current.x;
      const deltaRatio = deltaX / rect.width / zoom;
      const newOffset = panStartRef.current.scrollOffset - deltaRatio;
      const maxOffset = Math.max(0, 1 - 1 / zoom);
      setScrollOffset(Math.max(0, Math.min(maxOffset, newOffset)));
    };

    const handleMouseUp = () => {
      setIsPanning(false);
      panStartRef.current = null;
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isPanning, zoom]);

  // Handle wheel for scrolling and zooming
  const handleWheel = useCallback((e: WheelEvent) => {
    const isPinch = e.ctrlKey;
    const isVerticalDominant = Math.abs(e.deltaY) > Math.abs(e.deltaX);
    const isHorizontalDominant = Math.abs(e.deltaX) >= Math.abs(e.deltaY);

    // Zoom Handling (Pinch OR Vertical Scroll)
    if (isPinch || isVerticalDominant) {
      e.preventDefault();

      // Calculate multiplier based on deltaY
      // Using a small factor (1.0015) for fine-grained continuous control
      const multiplier = Math.pow(1.0015, -e.deltaY);
      onZoomChange?.(multiplier);
      return;
    }

    // Scroll/Pan Handling (Horizontal Dominant)
    if (isHorizontalDominant && zoom > 1) {
      e.preventDefault();
      const delta = e.deltaX !== 0 ? e.deltaX : e.deltaY;
      const scrollAmount = (delta / 500) / zoom;
      const maxOffset = Math.max(0, 1 - 1 / zoom);
      setScrollOffset(prev => Math.max(0, Math.min(maxOffset, prev + scrollAmount)));
    }
  }, [zoom, onZoomChange]);

  // React's onWheel is passive, so preventDefault() there can't stop the page from scrolling
  // while zooming; listen directly with passive: false instead
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  // Calculate handle positions
  const safeDuration = (duration > 0 && isFinite(duration)) ? duration : 0;

  // During recording, always lock handles at edges (can't trim while recording)
  // After recording, lock at end if trimEnd is 0 or at/beyond duration
  const isAtEnd = isRecording || trimEnd <= 0 || trimEnd >= duration;
  const isAtStart = isRecording || trimStart <= 0;

  const startHandlePercent = isAtStart ? 0 : (safeDuration > 0 ? getXPercentFromTime(trimStart) : 0);
  const endHandlePercent = isAtEnd ? 100 : (safeDuration > 0 ? getXPercentFromTime(trimEnd) : 100);


  // Check if handles are in visible range
  const { startTime: visibleStart, endTime: visibleEnd } = getVisibleRange();
  const isStartHandleVisible = trimStart >= visibleStart && trimStart <= visibleEnd;
  const effectiveTrimEnd = isAtEnd ? duration : trimEnd;
  const isEndHandleVisible = effectiveTrimEnd >= visibleStart && effectiveTrimEnd <= visibleEnd;

  // Calculate dim overlay positions (for visible portion)
  const trimStartPercent = isAtStart ? 0 : (safeDuration > 0 ? Math.max(0, getXPercentFromTime(trimStart)) : 0);
  const trimEndPercent = isAtEnd ? 100 : (safeDuration > 0 ? Math.min(100, getXPercentFromTime(trimEnd)) : 100);

  // The selection in seconds, and where its edges fall in the view (clamped when zoomed past them)
  const selectionStart = isAtStart ? 0 : trimStart;
  const selectionEnd = isAtEnd ? safeDuration : trimEnd;
  const rawFrameLeft = safeDuration > 0 ? getXPercentFromTime(selectionStart) : 0;
  const rawFrameRight = safeDuration > 0 ? getXPercentFromTime(selectionEnd) : 100;
  const frameVisible = rawFrameRight > 0 && rawFrameLeft < 100;
  const frameLeft = Math.max(0, Math.min(100, rawFrameLeft));
  const frameRight = Math.max(0, Math.min(100, rawFrameRight));
  const activeHandle = draggingHandle || hoveredHandle;

  return (
    <div
      ref={containerRef}
      onClick={handleClick}
      onMouseDown={handlePanMouseDown}
      style={{
        width: '100%',
        height: '100%',
        cursor: isPanning ? 'grabbing' : (zoom > 1 ? 'grab' : (onSeek && !isRecording && duration > 0 ? 'pointer' : 'default')),
        position: 'relative',
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        userSelect: 'none',
        // Fills the inset beside the waveform where the handles sit at the very start and end
        backgroundColor
      }}
    >
      <div
        ref={trackRef}
        className="waveform-track"
        style={{ position: 'absolute', top: 0, bottom: 0, left: TRIM_HANDLE_WIDTH, right: TRIM_HANDLE_WIDTH }}
      >
        <canvas
          ref={canvasRef}
          width={width}
          height={height}
          style={{
            width: '100%',
            height: '100%',
            display: 'block'
          }}
        />

        {/* Trim: the parts outside the selection are shaded and a frame runs along the top and bottom
            of the selection. Each handle sits just outside the selection, so its inner edge is
            exactly the cut and the kept audio starts right at its tip. */}
        {!isRecording && onTrimChange && safeDuration > 0 && frameVisible && (
          <>
            {frameLeft > 0 && <div className="trim-shade" style={{ left: -TRIM_HANDLE_WIDTH, width: `calc(${frameLeft}% + ${TRIM_HANDLE_WIDTH}px)` }} />}
            {frameRight < 100 && <div className="trim-shade" style={{ left: `${frameRight}%`, right: -TRIM_HANDLE_WIDTH }} />}
            <div className="trim-frame" style={{ left: `${frameLeft}%`, width: `${frameRight - frameLeft}%` }} />

            {isStartHandleVisible && (
              <div
                className={`trim-handle start${draggingHandle === 'start' ? ' active' : ''}`}
                style={{ left: `${startHandlePercent}%` }}
                onMouseDown={(e) => handleTrimMouseDown(e, 'start')}
                onClick={(e) => e.stopPropagation()}
                onMouseEnter={() => setHoveredHandle('start')}
                onMouseLeave={() => setHoveredHandle(null)}
                onFocus={() => setHoveredHandle('start')}
                onBlur={() => setHoveredHandle(null)}
                onKeyDown={(e) => handleTrimKeyDown(e, 'start')}
                role="slider"
                tabIndex={0}
                aria-label="Trim start"
                aria-valuemin={0}
                aria-valuemax={safeDuration}
                aria-valuenow={selectionStart}
                aria-valuetext={formatTime(selectionStart)}
                title="Drag to trim the start (hold Alt for fine control) · arrow keys nudge"
              >
                <span className="trim-grip" />
              </div>
            )}

            {isEndHandleVisible && (
              <div
                className={`trim-handle end${draggingHandle === 'end' ? ' active' : ''}`}
                style={{ left: `${endHandlePercent}%` }}
                onMouseDown={(e) => handleTrimMouseDown(e, 'end')}
                onClick={(e) => e.stopPropagation()}
                onMouseEnter={() => setHoveredHandle('end')}
                onMouseLeave={() => setHoveredHandle(null)}
                onFocus={() => setHoveredHandle('end')}
                onBlur={() => setHoveredHandle(null)}
                onKeyDown={(e) => handleTrimKeyDown(e, 'end')}
                role="slider"
                tabIndex={0}
                aria-label="Trim end"
                aria-valuemin={0}
                aria-valuemax={safeDuration}
                aria-valuenow={selectionEnd}
                aria-valuetext={formatTime(selectionEnd)}
                title="Drag to trim the end (hold Alt for fine control) · arrow keys nudge"
              >
                <span className="trim-grip" />
              </div>
            )}

            {/* Time of the handle being dragged or pointed at, just inside the selection */}
            {activeHandle === 'start' && isStartHandleVisible && (
              <div className="trim-time start" style={{ left: `${startHandlePercent}%` }}>{formatTime(selectionStart)}</div>
            )}
            {activeHandle === 'end' && isEndHandleVisible && (
              <div className="trim-time end" style={{ left: `${endHandlePercent}%` }}>{formatTime(selectionEnd)}</div>
            )}
          </>
        )}
      </div>
    </div>
  );
};
