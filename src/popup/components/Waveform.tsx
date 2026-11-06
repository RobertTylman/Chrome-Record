import React, { useEffect, useRef, useState, useCallback } from 'react';
import { LiveWaveform } from '../hooks/useWaveform';
import { LIVE_LEVELS_PER_SECOND } from '../utils/storageManager';

const EDGE_PADDING = 3; // px left free above and below the loudest point
const MIN_HALF_HEIGHT = 0.75; // silence still shows as a hairline
const POINT_SPACING = 1; // px between outline points in the saved view
const LIVE_WINDOW_SECONDS = 5; // recent audio shown while recording
const LIVE_LEVEL_MS = 1000 / LIVE_LEVELS_PER_SECOND;
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
  channelMode?: 'mono' | 'stereo';
  theme?: 'dark' | 'light' | 'midnight' | 'forest' | 'rainbow';
  trimStart?: number;
  trimEnd?: number;
  onTrimChange?: (start: number, end: number) => void;
  liveDataRef?: React.MutableRefObject<LiveWaveform | null>;
  markers?: number[]; // seconds
  onMarkerClick?: (time: number) => void;
  onMarkerRemove?: (index: number) => void;
  onZoomChange?: (multiplier: number) => void;
}

// Theme-specific trim handle colors
const trimHandleColors = {
  dark: { start: '#00d4ff', startText: '#000', end: '#ff6b00', endText: '#fff' },
  light: { start: '#0077b6', startText: '#fff', end: '#d62828', endText: '#fff' },
  midnight: { start: '#a78bfa', startText: '#000', end: '#f472b6', endText: '#000' },
  forest: { start: '#34d399', startText: '#000', end: '#fbbf24', endText: '#000' },
  rainbow: { start: '#c0c0c0', startText: '#000', end: '#c0c0c0', endText: '#000' }
};

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
  channelMode,
  theme = 'dark',
  trimStart = 0,
  trimEnd = 0,
  onTrimChange,
  liveDataRef,
  markers = [],
  onMarkerClick,
  onMarkerRemove,
  onZoomChange
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const animationFrameRef = useRef<number | null>(null);
  const lastPositionRef = useRef<number>(-1);

  // Scroll offset as a ratio of duration (0 to 1 - 1/zoom)
  const [scrollOffset, setScrollOffset] = useState(0);

  // Drag states
  const [draggingHandle, setDraggingHandle] = useState<'start' | 'end' | null>(null);
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
    if (!containerRef.current || !duration) return 0;
    const rect = containerRef.current.getBoundingClientRect();
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

        // Markers scroll with the audio: a line with a small flag at the top
        ctx.fillStyle = theme === 'light' ? 'rgba(0, 0, 0, 0.55)' : 'rgba(255, 255, 255, 0.8)';
        for (const marker of live.markers || []) {
          const x = width - (newest - marker * LIVE_LEVELS_PER_SECOND) * levelWidth;
          if (x < 0 || x > width) continue;
          ctx.fillRect(Math.round(x), 0, 1, height);
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x + 6, 0);
          ctx.lineTo(x, 7);
          ctx.closePath();
          ctx.fill();
        }
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
  }, [isRecording, liveDataRef, width, height, barColor, backgroundColor, theme]);

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
  const handleTrimMouseDown = (e: React.MouseEvent, handle: 'start' | 'end') => {
    e.stopPropagation();
    e.preventDefault();
    setDraggingHandle(handle);
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
      if (!onTrimChange || !duration) return;
      const time = getTimeFromX(e.clientX);
      if (draggingHandle === 'start') {
        const maxStart = trimEnd > 0 ? trimEnd - 0.1 : duration - 0.1;
        onTrimChange(Math.max(0, Math.min(time, maxStart)), trimEnd || duration);
      } else {
        const minEnd = trimStart + 0.1;
        onTrimChange(trimStart, Math.min(duration, Math.max(time, minEnd)));
      }
    };

    const handleMouseUp = () => {
      setDraggingHandle(null);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [draggingHandle, duration, onTrimChange, trimStart, trimEnd, getTimeFromX]);

  // Handle panning
  useEffect(() => {
    if (!isPanning) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!panStartRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
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
        userSelect: 'none'
      }}
    >

      {channelMode && (
        <div className="waveform-channel-indicator">
          {channelMode.toUpperCase()}
        </div>
      )}
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

      {/* Markers: click the number to jump there, double-click to remove */}
      {!isRecording && safeDuration > 0 && markers.map((time, index) => {
        const percent = getXPercentFromTime(time);
        if (percent < 0 || percent > 100) return null;
        const minutes = Math.floor(time / 60);
        const seconds = (time % 60).toFixed(2).padStart(5, '0');
        return (
          <div key={`${index}-${time}`} className={`waveform-marker${theme === 'light' ? ' light' : ''}`} style={{ left: `${percent}%` }}>
            <button
              className="waveform-marker-label"
              title={`Marker ${index + 1} · ${minutes}:${seconds}\nClick to jump · double-click to remove`}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onMarkerClick?.(time); }}
              onDoubleClick={(e) => { e.stopPropagation(); onMarkerRemove?.(index); }}
            >
              {index + 1}
            </button>
          </div>
        );
      })}

      {/* Dimming Overlays */}
      {trimStart > 0 && trimStartPercent > 0 && (
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          height: '100%',
          width: `${Math.max(0, trimStartPercent)}%`,
          backgroundColor: 'rgba(0, 0, 0, 0.6)',
          pointerEvents: 'none'
        }} />
      )}

      {trimEnd > 0 && trimEnd < duration && trimEndPercent < 100 && (
        <div style={{
          position: 'absolute',
          top: 0,
          left: `${Math.min(100, trimEndPercent)}%`,
          height: '100%',
          right: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.6)',
          pointerEvents: 'none'
        }} />
      )}

      {/* Drag Handles */}
      {!isRecording && onTrimChange && duration > 0 && (
        <>
          {/* Start Handle */}
          {isStartHandleVisible && (
            <div
              onMouseDown={(e) => handleTrimMouseDown(e, 'start')}
              style={{
                position: 'absolute',
                top: 0,
                height: '100%',
                left: `${startHandlePercent}%`,
                width: '16px',
                marginLeft: '-8px',
                cursor: 'ew-resize',
                zIndex: 10,
                display: 'flex',
                justifyContent: 'center'
              }}
            >
              <div style={{
                width: '3px',
                height: '100%',
                backgroundColor: trimHandleColors[theme].start,
                boxShadow: `0 0 8px ${trimHandleColors[theme].start}80, 0 0 2px rgba(0,0,0,0.8)`
              }} />
              <div style={{
                position: 'absolute',
                top: '0',
                width: '16px',
                height: '20px',
                backgroundColor: trimHandleColors[theme].start,
                borderRadius: '0 0 4px 4px',
                boxShadow: '0 2px 6px rgba(0,0,0,0.5)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}>
                <span style={{ fontSize: '10px', color: trimHandleColors[theme].startText, fontWeight: 'bold' }}>◀</span>
              </div>
              <div style={{
                position: 'absolute',
                bottom: '0',
                width: '16px',
                height: '20px',
                backgroundColor: trimHandleColors[theme].start,
                borderRadius: '4px 4px 0 0',
                boxShadow: '0 -2px 6px rgba(0,0,0,0.5)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}>
                <span style={{ fontSize: '10px', color: trimHandleColors[theme].startText, fontWeight: 'bold' }}>◀</span>
              </div>
            </div>
          )}

          {/* End Handle */}
          {isEndHandleVisible && (
            <div
              onMouseDown={(e) => handleTrimMouseDown(e, 'end')}
              style={{
                position: 'absolute',
                top: 0,
                height: '100%',
                left: `${endHandlePercent}%`,
                width: '16px',
                marginLeft: '-8px',
                cursor: 'ew-resize',
                zIndex: 10,
                display: 'flex',
                justifyContent: 'center'
              }}
            >
              <div style={{
                width: '3px',
                height: '100%',
                backgroundColor: trimHandleColors[theme].end,
                boxShadow: `0 0 8px ${trimHandleColors[theme].end}80, 0 0 2px rgba(0,0,0,0.8)`
              }} />
              <div style={{
                position: 'absolute',
                top: '0',
                width: '16px',
                height: '20px',
                backgroundColor: trimHandleColors[theme].end,
                borderRadius: '0 0 4px 4px',
                boxShadow: '0 2px 6px rgba(0,0,0,0.5)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}>
                <span style={{ fontSize: '10px', color: trimHandleColors[theme].endText, fontWeight: 'bold' }}>▶</span>
              </div>
              <div style={{
                position: 'absolute',
                bottom: '0',
                width: '16px',
                height: '20px',
                backgroundColor: trimHandleColors[theme].end,
                borderRadius: '4px 4px 0 0',
                boxShadow: '0 -2px 6px rgba(0,0,0,0.5)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}>
                <span style={{ fontSize: '10px', color: trimHandleColors[theme].endText, fontWeight: 'bold' }}>▶</span>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};
