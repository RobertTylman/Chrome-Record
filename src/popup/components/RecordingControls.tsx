import React from 'react';
import { formatZoom } from '../utils/zoom';

interface TransportControlsProps {
  onPlay: () => void;
  onPause: () => void;
  onLoop: () => void;
  onReset: () => void;
  isPlaying: boolean;
  isLooping: boolean;
  isRecording?: boolean;
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
  isRecording = false
}) => {
  const playLabel = isRecording
    ? (isPlaying ? 'Pause recording' : 'Resume recording')
    : (isPlaying ? 'Pause' : 'Play');

  return (
    <div className="transport-controls">
      <button
        className="control-button transport-side start has-tooltip"
        onClick={onReset}
        aria-label="Back to start"
        data-tooltip="Back to start"
        disabled={isRecording}
      >
        <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor">
          <rect x="3.5" y="4" width="2" height="12" rx="1" />
          <path d="M16 4.9v10.2a.9.9 0 01-1.4.75L7.4 10.75a.9.9 0 010-1.5l7.2-5.1a.9.9 0 011.4.75z" />
        </svg>
      </button>

      <button
        className={`control-button play-button has-tooltip ${isPlaying ? 'playing' : ''}`}
        onClick={isPlaying ? onPause : onPlay}
        aria-label={playLabel}
        data-tooltip={playLabel}
      >
        {isPlaying ? (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="4.5" width="4" height="15" rx="1.2" />
            <rect x="14" y="4.5" width="4" height="15" rx="1.2" />
          </svg>
        ) : (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5.6v12.8a1 1 0 001.5.86l10.2-6.4a1 1 0 000-1.72L9.5 4.74A1 1 0 008 5.6z" />
          </svg>
        )}
      </button>

      <button
        className={`control-button transport-side end has-tooltip ${isLooping ? 'active' : ''}`}
        onClick={onLoop}
        aria-label="Loop"
        aria-pressed={isLooping}
        data-tooltip={isLooping ? 'Loop: on' : 'Loop: off'}
        disabled={isRecording}
      >
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 9V8a3 3 0 013-3h9M13.5 2.5L16 5l-2.5 2.5" />
          <path d="M16 11v1a3 3 0 01-3 3H4M6.5 17.5L4 15l2.5-2.5" />
        </svg>
      </button>
    </div>
  );
});

interface ZoomControlsProps {
  onZoomIn: () => void;
  onZoomOut: () => void;
  zoom: number;
  canZoomIn?: boolean;
}

// Compact zoom controls for the row under the waveform
export const ZoomControls: React.FC<ZoomControlsProps> = React.memo(({ onZoomIn, onZoomOut, zoom, canZoomIn = true }) => (
  <div className="zoom-controls">
    <button
      className="control-button small has-tooltip"
      onClick={onZoomOut}
      aria-label="Zoom out"
      data-tooltip="Zoom out"
      disabled={zoom <= 1}
    >
      <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
        <circle cx="10" cy="10" r="7.5" />
        <line x1="6.5" y1="10" x2="13.5" y2="10" />
      </svg>
    </button>

    <span className="zoom-level" aria-label="Zoom level">{formatZoom(zoom)}</span>

    <button
      className="control-button small has-tooltip tooltip-end"
      onClick={onZoomIn}
      aria-label="Zoom in"
      data-tooltip="Zoom in"
      disabled={!canZoomIn}
    >
      <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
        <circle cx="10" cy="10" r="7.5" />
        <line x1="6.5" y1="10" x2="13.5" y2="10" />
        <line x1="10" y1="6.5" x2="10" y2="13.5" />
      </svg>
    </button>
  </div>
));
