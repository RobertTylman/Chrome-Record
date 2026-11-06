import React, { useState, useEffect } from 'react';
import { exportAudio } from '../utils/audioConverter';
import { DownloadIcon, PlayIcon, TrashIcon } from './icons';
import { downloadAudio } from '../utils/audioUtils';
import { exportFilename, getExportOptions, openExportTab, shouldExportInTab } from '../utils/exportUtils';
import { formatBytes, formatSeconds, logError, logEvent } from '../utils/diagnostics';
import { getAllRecordingsMetadata, getRecording, deleteRecording, RecordingMetadata, StoredRecording } from '../utils/storageManager';

type Recording = RecordingMetadata;

interface RecentRecordingsProps {
  onSelectRecording: (recording: StoredRecording) => void;
  onDeleteRecording?: (id: string) => void;
  onError?: (message: string) => void;
}

export const RecentRecordings: React.FC<RecentRecordingsProps> = ({ onSelectRecording, onDeleteRecording, onError }) => {
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [loading, setLoading] = useState(true);
  const [fileSizes, setFileSizes] = useState<{ [id: string]: number }>({});

  useEffect(() => {
    // Only load recordings when component is actually mounted and visible
    // Defer initial load slightly to not block popup opening
    const loadTimer = setTimeout(() => {
      loadRecordings();
    }, 50);

    // Listen for preference changes to reload recordings
    const listener = (changes: { [key: string]: chrome.storage.StorageChange }) => {
      if (changes.preferences && changes.preferences.newValue) {
        // Format preference changed, reload recordings to get updated format
        loadRecordings();
      }
    };
    chrome.storage.onChanged.addListener(listener);

    return () => {
      clearTimeout(loadTimer);
      chrome.storage.onChanged.removeListener(listener);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // loadRecordings is stable, no need to include it

  const loadRecordings = async () => {
    setLoading(true);
    try {
      // Metadata only; audio is loaded on demand
      const metadataList = await getAllRecordingsMetadata();
      setRecordings(metadataList);
      const sizes: { [id: string]: number } = {};
      for (const meta of metadataList) {
        if (meta.size) sizes[meta.id] = meta.size;
      }
      setFileSizes(sizes);
    } catch (error) {
      logError('My Recordings: load list', error);
      setRecordings([]);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteRecording(id);
      // Remove from local state
      setRecordings(recordings.filter(r => r.id !== id));

      if (onDeleteRecording) {
        onDeleteRecording(id);
      }
    } catch (error) {
      logError('My Recordings: delete', error);
      onError?.('Could not delete the recording.');
    }
  };

  const handleDownload = async (recording: Recording) => {
    // Long exports run in their own tab so closing the popup doesn't cancel them
    if (shouldExportInTab(recording.duration)) {
      openExportTab({ ids: [recording.id] });
      return;
    }
    try {
      const fullRecording = await getRecording(recording.id);
      if (!fullRecording) {
        console.error('Recording not found');
        return;
      }
      // Always use current format preference (not the stored format)
      const options = await getExportOptions();
      const exportStarted = performance.now();
      const blob = await exportAudio(fullRecording.audio, { ...options, duration: recording.duration });
      downloadAudio(blob, exportFilename(recording.name, options.format));
      logEvent('Download', `${options.format.toUpperCase()} from My Recordings: ${formatSeconds(recording.duration)} -> ${formatBytes(blob.size)} in ${Math.round(performance.now() - exportStarted)} ms`);
    } catch (error: any) {
      logError('My Recordings: download', error);
      onError?.(`Download failed: ${error?.message || 'Unknown error'}`);
    }
  };

  const handleDownloadAll = () => {
    if (recordings.length === 0) return;
    openExportTab({ ids: recordings.map(r => r.id), all: true });
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString(undefined, {
      month: 'numeric',
      day: 'numeric',
      year: '2-digit',
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };


  if (loading) {
    return (
      <div className="recent-recordings">
        <div className="loading-container">
          <div className="loading-spinner"></div>
          <p className="loading-text">Loading recordings...</p>
        </div>
      </div>
    );
  }

  if (recordings.length === 0) {
    return (
      <div className="recent-recordings">
        <p className="empty-state">No recent recordings</p>
      </div>
    );
  }

  return (
    <>
    <div className="recent-recordings">
      <div className="recordings-list">
        {recordings.map((recording, index) => (
          // The newest recording is marked with a thin bar on its left edge
          <div key={recording.id} className={`recording-item${index === 0 ? ' is-latest' : ''}`}>
            <div className="recording-info" onClick={async () => {
              // Load full recording from IndexedDB when selected
              try {
                const fullRecording = await getRecording(recording.id);
                if (fullRecording) {
                  onSelectRecording(fullRecording);
                }
              } catch (error) {
                logError('My Recordings: open recording', error);
              }
            }}>
              <div className="recording-name-row">
                <span className="recording-name">{recording.name.replace(/\.[^/.]+$/, '')}</span>
              </div>
              <div className="recording-date-row">
                <span className="recording-date-secondary">{formatDate(recording.timestamp)}</span>
                <span className="recording-channel">{(recording.channelMode || 'stereo') === 'mono' ? 'Mono' : 'Stereo'}</span>
              </div>
            </div>
            <div className="recording-actions">
              <button
                className="action-button has-tooltip tooltip-below"
                onClick={async (e) => {
                  e.stopPropagation();
                  // Load full recording from IndexedDB when selected
                  try {
                    const fullRecording = await getRecording(recording.id);
                    if (fullRecording) {
                      onSelectRecording(fullRecording);
                    }
                  } catch (error) {
                    logError('My Recordings: open recording', error);
                  }
                }}
                aria-label="Play"
                data-tooltip="Play"
              >
                <PlayIcon size={16} />
              </button>
              <button
                className="action-button has-tooltip tooltip-below"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDownload(recording);
                }}
                aria-label="Download"
                data-tooltip="Download"
              >
                <DownloadIcon size={17} />
              </button>
              <button
                className="action-button delete-button has-tooltip tooltip-below"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDelete(recording.id);
                }}
                aria-label="Delete"
                data-tooltip="Delete"
              >
                <TrashIcon size={17} />
              </button>
            </div>
            <div className="recording-meta-right">
              <div className="recording-file-size">{formatFileSize(fileSizes[recording.id] || 0)}</div>
              <div className="recording-duration">{formatTime(recording.duration)}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
    <div className="popup-footer">
      <button
        className="download-all-button"
        onClick={handleDownloadAll}
        disabled={recordings.length === 0}
        title="Download all recordings"
      >
        <DownloadIcon size={14} />
        Download all ({recordings.length})
      </button>
    </div>
    </>
  );
};
