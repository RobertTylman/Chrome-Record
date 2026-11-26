import React from 'react';
import { formatZoom } from '../utils/zoom';
import { LoopIcon, PauseIcon, PlayIcon, SkipBackIcon, ZoomInIcon, ZoomOutIcon } from './icons';

interface TransportControlsProps {
  onPlay: () => void;
  onPause: () => void;
  onLoop: () => void;
  onReset: () => void;
  isPlaying: boolean;
  isLooping: boolean;
  isRecording?: boolean;
  leading?: React.ReactNode; // shown at the left end of the row (zoom controls)
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
  leading
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
