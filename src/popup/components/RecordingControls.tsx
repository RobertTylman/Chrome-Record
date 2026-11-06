import React from 'react';
import { formatZoom } from '../utils/zoom';
import { LoopIcon, MarkerIcon, PauseIcon, PlayIcon, SkipBackIcon, ZoomInIcon, ZoomOutIcon } from './icons';

interface TransportControlsProps {
  onPlay: () => void;
  onPause: () => void;
  onLoop: () => void;
  onReset: () => void;
  isPlaying: boolean;
  isLooping: boolean;
  isRecording?: boolean;
  leading?: React.ReactNode; // shown at the left end of the row (zoom controls)
  trailing?: React.ReactNode; // shown at the right end of the row (marker button)
}

// Transport row like a recorder's: back to start, play/pause, loop. Play sits in the exact
// center column so it lines up with the record button below. Every button has a tooltip.
export const TransportControls: React.FC<TransportControlsProps> = React.memo(({
  onPlay,
  onPause,
  onLoop,
  onReset,
  isPlaying,
  isLooping,
  isRecording = false,
  leading,
  trailing
}) => {
  const playLabel = isRecording
    ? (isPlaying ? 'Pause recording' : 'Resume recording')
    : (isPlaying ? 'Pause' : 'Play');

  return (
    <div className="transport-controls">
      <div className="transport-left">
        {leading}
        <button
          className="control-button transport-side start has-tooltip"
          onClick={onReset}
          aria-label="Back to start"
          data-tooltip="Back to start"
          disabled={isRecording}
        >
          <SkipBackIcon size={22} />
        </button>
      </div>

      <button
        className={`control-button play-button has-tooltip ${isPlaying ? 'playing' : ''}`}
        onClick={isPlaying ? onPause : onPlay}
        aria-label={playLabel}
        data-tooltip={playLabel}
      >
        {isPlaying ? (
          <PauseIcon />
        ) : (
          <PlayIcon />
        )}
      </button>

      <div className="transport-right">
        <button
          className={`control-button transport-side end has-tooltip ${isLooping ? 'active' : ''}`}
          onClick={onLoop}
          aria-label="Loop"
          aria-pressed={isLooping}
          data-tooltip={isLooping ? 'Loop: on' : 'Loop: off'}
          disabled={isRecording}
        >
          <LoopIcon size={22} />
        </button>
        {trailing}
      </div>
    </div>
  );
});

interface ZoomControlsProps {
  onZoomIn: () => void;
  onZoomOut: () => void;
  zoom: number;
  canZoomIn?: boolean;
  disabled?: boolean;
}

// Compact zoom controls (shown at the left of the transport row)
export const ZoomControls: React.FC<ZoomControlsProps> = React.memo(({ onZoomIn, onZoomOut, zoom, canZoomIn = true, disabled = false }) => (
  <div className="zoom-controls">
    <button
      className="control-button small has-tooltip tooltip-start"
      onClick={onZoomOut}
      aria-label="Zoom out"
      data-tooltip="Zoom out"
      disabled={disabled || zoom <= 1}
    >
      <ZoomOutIcon />
    </button>

    <span className="zoom-level" aria-label="Zoom level">{formatZoom(zoom)}</span>

    <button
      className="control-button small has-tooltip"
      onClick={onZoomIn}
      aria-label="Zoom in"
      data-tooltip="Zoom in"
      disabled={disabled || !canZoomIn}
    >
      <ZoomInIcon />
    </button>
  </div>
));

interface MarkerButtonProps {
  onAddMarker: () => void;
  count: number;
  disabled?: boolean;
}

// Adds a marker at the current recording time, or at the playhead after recording
export const MarkerButton: React.FC<MarkerButtonProps> = React.memo(({ onAddMarker, count, disabled = false }) => (
  <button
    className="control-button small marker-button has-tooltip tooltip-end"
    onClick={onAddMarker}
    aria-label="Add marker"
    data-tooltip={count > 0 ? `Add marker (M) · ${count} so far` : 'Add marker (M)'}
    disabled={disabled}
  >
    <MarkerIcon />
    {count > 0 && <span className="marker-count">{count}</span>}
  </button>
));
