import React from 'react';

interface RecordingControlsProps {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onPlay: () => void;
  onPause: () => void;
  onLoop: () => void;
  onReset: () => void;
  isPlaying: boolean;
  isLooping: boolean;
  isRecording?: boolean;
  zoom: number;
}

export const RecordingControls: React.FC<RecordingControlsProps> = React.memo(({
  onZoomIn,
  onZoomOut,
  onPlay,
  onPause,
  onLoop,
  onReset,
  isPlaying,
  isLooping,
  isRecording = false,
  zoom
}) => {
  return (
    <div className="recording-controls">
      <div className="zoom-group">
        <button
          className="control-button"
          onClick={onZoomOut}
          title="Zoom Out"
          disabled={isRecording}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
            <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="2" fill="none" />
            <line x1="6" y1="10" x2="14" y2="10" stroke="currentColor" strokeWidth="2" />
          </svg>
        </button>

        <span className="zoom-level">{Math.round(zoom * 100)}%</span>

        <button
          className="control-button"
          onClick={onZoomIn}
          title="Zoom In"
          disabled={isRecording}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
            <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="2" fill="none" />
            <line x1="10" y1="6" x2="10" y2="14" stroke="currentColor" strokeWidth="2" />
            <line x1="6" y1="10" x2="14" y2="10" stroke="currentColor" strokeWidth="2" />
          </svg>
        </button>
      </div>

      <button
        className={`control-button play-button ${isPlaying ? 'playing' : ''}`}
        onClick={isPlaying ? onPause : onPlay}
        title={isRecording ? (isPlaying ? 'Pause recording' : 'Resume recording') : (isPlaying ? 'Pause' : 'Play')}
      >
        {isPlaying ? (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="4" width="4" height="16" />
            <rect x="14" y="4" width="4" height="16" />
          </svg>
        ) : (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
      </button>

      <div className="playback-group">
        <button
          className="control-button"
          onClick={onReset}
          title="Return to Start"
          disabled={isRecording}
        >
          <svg width="20" height="20" viewBox="0 0 52 52" fill="currentColor">
            <path d="M21.5,40.6,7.9,27.1a1.57,1.57,0,0,1,0-2.2L21.5,11.4a1.57,1.57,0,0,1,2.2,0l2.2,2.2a1.57,1.57,0,0,1,0,2.2l-9.4,9.1a1.57,1.57,0,0,0,0,2.2l9.3,9.1a1.57,1.57,0,0,1,0,2.2l-2.2,2.2A1.66,1.66,0,0,1,21.5,40.6Z" />
            <path d="M39.6,40.6,25.8,27.1a1.57,1.57,0,0,1,0-2.2L39.6,11.4a1.57,1.57,0,0,1,2.2,0L44,13.6a1.57,1.57,0,0,1,0,2.2l-9.4,9.1a1.57,1.57,0,0,0,0,2.2l9.3,9.1a1.57,1.57,0,0,1,0,2.2l-2.2,2.2A1.66,1.66,0,0,1,39.6,40.6Z" />
          </svg>
        </button>

        <button
          className={`control-button ${isLooping ? 'active' : ''}`}
          onClick={onLoop}
          title="Loop"
          disabled={isRecording}
        >
          <svg width="20" height="20" viewBox="0 0 256 256" fill="currentColor">
            <path d="M24.849 72.002a8 8 0 0 1 8.027-7.983l189.787.462c4.42.01 8.004 3.61 8.004 8.026v111.986c0 4.422-3.587 8.04-8.008 8.08l-42.661.39A4.04 4.04 0 0 0 176 197v22.002c0 2.208-1.39 2.878-3.115 1.488l-35.31-28.463c-5.157-4.156-5.11-10.846.099-14.935l35.174-27.616c1.74-1.367 3.152-.685 3.152 1.534v21.482a4 4 0 0 0 3.992 4.009h30.683a4.02 4.02 0 0 0 4.013-3.991l.437-83.012a7.98 7.98 0 0 0-7.952-8.02l-158.807-.454c-4.415-.013-8.008 3.56-8.025 7.975l-.31 79.504a7.962 7.962 0 0 0 7.967 7.998H108a4.003 4.003 0 0 1 3.999 3.994v8.512a3.968 3.968 0 0 1-4.001 3.971l-75.502-.431c-4.417-.026-7.987-3.634-7.974-8.048l.326-112.496z" fillRule="evenodd" />
          </svg>
        </button>
      </div>

    </div>
  );
});

