import React, { useState, useEffect } from 'react';
import JSZip from 'jszip';
import { convertAudioFormat } from '../utils/audioConverter';
import { DEFAULT_AUDIO_FORMAT, getFileExtension } from '../utils/formatUtils';
import { getAllRecordingsMetadata, getRecording, deleteRecording, RecordingMetadata } from '../utils/storageManager';

interface Recording extends RecordingMetadata {
  audioData: number[]; // For compatibility with existing code
}

interface RecentRecordingsProps {
  onSelectRecording: (recording: Recording) => void;
  onDeleteRecording?: () => void;
}

export const RecentRecordings: React.FC<RecentRecordingsProps> = ({ onSelectRecording, onDeleteRecording }) => {
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [loading, setLoading] = useState(true);
  const [fileSizes, setFileSizes] = useState<{ [id: string]: number }>({});
  const [isDownloadingAll, setIsDownloadingAll] = useState(false);

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
      // Load metadata from IndexedDB (fast, doesn't load audio data)
      const metadataList = await getAllRecordingsMetadata();

      // Convert to Recording format for compatibility
      const recordings: Recording[] = metadataList.map(meta => ({
        ...meta,
        audioData: [] // Audio data loaded on demand
      }));

      setRecordings(recordings);
      setLoading(false); // Show UI immediately

      // Load file sizes asynchronously in background (non-blocking, batched)
      // Use requestIdleCallback if available, otherwise setTimeout
      const loadSizes = () => {
        const sizes: { [id: string]: number } = {};
        let index = 0;
        const batchSize = 5; // Process 5 at a time

        const processBatch = async () => {
          const batch = recordings.slice(index, index + batchSize);
          if (batch.length === 0) {
            setFileSizes(sizes);
            return;
          }

          await Promise.all(batch.map(async (recording) => {
            try {
              const fullRecording = await getRecording(recording.id);
              if (fullRecording) {
                sizes[recording.id] = fullRecording.audioData.byteLength;
              }
            } catch (error) {
              console.error(`Error getting size for ${recording.id}:`, error);
            }
          }));

          index += batchSize;
          // Update UI incrementally
          setFileSizes({ ...sizes });

          // Process next batch
          if (index < recordings.length) {
            setTimeout(processBatch, 50); // Small delay to not block UI
          } else {
            setFileSizes(sizes);
          }
        };

        processBatch();
      };

      // Defer file size loading
      if ('requestIdleCallback' in window) {
        requestIdleCallback(loadSizes, { timeout: 1000 });
      } else {
        setTimeout(loadSizes, 100);
      }
    } catch (error) {
      console.error('Error loading recordings:', error);
      setRecordings([]);
      setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteRecording(id);
      // Remove from local state
      setRecordings(recordings.filter(r => r.id !== id));

      // Reset extension state when deleting
      if (onDeleteRecording) {
        onDeleteRecording();
      }
    } catch (error) {
      console.error('Error deleting recording:', error);
    }
  };

  const handleDownload = async (recording: Recording) => {
    try {
      // Load full recording from IndexedDB
      const fullRecording = await getRecording(recording.id);
      if (!fullRecording) {
        console.error('Recording not found');
        return;
      }

      // Always use current format preference (not the stored format)
      // This ensures all downloads use the current format setting
      const result = await chrome.storage.local.get(['preferences']);
      const format = result.preferences?.format || DEFAULT_AUDIO_FORMAT;
      const sampleRate = result.preferences?.sampleRate ? parseInt(result.preferences.sampleRate) : undefined;
      const channelMode = result.preferences?.channelMode || undefined;
      const targetChannels = channelMode === 'mono' ? 1 : channelMode === 'stereo' ? 2 : undefined;

      // Convert ArrayBuffer to Blob
      const originalBlob = new Blob([fullRecording.audioData], { type: 'audio/webm' });

      // Convert audio to the target format with sample rate and channel mode
      const convertedBlob = await convertAudioFormat(originalBlob, format, sampleRate, targetChannels);

      // Get file extension based on current format preference
      const extension = getFileExtension(format);

      // Update filename with correct extension
      let filename = recording.name;
      // Remove any existing extension
      const nameWithoutExt = filename.replace(/\.[^/.]+$/, '');
      filename = `${nameWithoutExt}.${extension}`;

      const url = URL.createObjectURL(convertedBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Error downloading recording:', error);
    }
  };

  const handleDownloadAll = async () => {
    if (recordings.length === 0 || isDownloadingAll) return;

    setIsDownloadingAll(true);
    try {
      const zip = new JSZip();

      // Get current format preferences
      const result = await chrome.storage.local.get(['preferences']);
      const format = result.preferences?.format || DEFAULT_AUDIO_FORMAT;
      const sampleRate = result.preferences?.sampleRate ? parseInt(result.preferences.sampleRate) : undefined;
      const channelMode = result.preferences?.channelMode || undefined;
      const targetChannels = channelMode === 'mono' ? 1 : channelMode === 'stereo' ? 2 : undefined;
      const extension = getFileExtension(format);

      // Track used filenames to handle duplicates
      const usedFilenames = new Set<string>();

      // Process each recording and add to zip
      for (const recording of recordings) {
        try {
          const fullRecording = await getRecording(recording.id);
          if (!fullRecording) continue;

          // Convert ArrayBuffer to Blob
          const originalBlob = new Blob([fullRecording.audioData], { type: 'audio/webm' });

          // Convert audio to the target format
          const convertedBlob = await convertAudioFormat(originalBlob, format, sampleRate, targetChannels);

          // Get filename and sanitize to prevent subdirectories (remove / and \ characters)
          const nameWithoutExt = recording.name.replace(/\.[^/.]+$/, '');
          const sanitizedName = nameWithoutExt.replace(/[\/\\]/g, '_');

          // Handle duplicate filenames by adding a counter
          let filename = `${sanitizedName}.${extension}`;
          let counter = 1;
          while (usedFilenames.has(filename.toLowerCase())) {
            filename = `${sanitizedName} (${counter}).${extension}`;
            counter++;
          }
          usedFilenames.add(filename.toLowerCase());

          // Add to zip
          const arrayBuffer = await convertedBlob.arrayBuffer();
          zip.file(filename, arrayBuffer);
        } catch (error) {
          console.error(`Error processing recording ${recording.name}:`, error);
        }
      }

      // Generate zip file and download
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `chrome-recorder-${new Date().toISOString().split('T')[0]}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Error downloading all recordings:', error);
    } finally {
      setIsDownloadingAll(false);
    }
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
    <div className="recent-recordings">
      <div className="recordings-list">
        {recordings.map((recording, index) => (
          <div key={recording.id} className="recording-item">
            {index === 0 && (
              <div className="recording-status-dot"></div>
            )}
            <div className="recording-info" onClick={async () => {
              // Load full recording from IndexedDB when selected
              try {
                const fullRecording = await getRecording(recording.id);
                if (fullRecording) {
                  // Convert ArrayBuffer to number array for compatibility
                  const audioArray = new Uint8Array(fullRecording.audioData);
                  const recordingWithAudio: Recording = {
                    ...recording,
                    audioData: Array.from(audioArray)
                  };
                  onSelectRecording(recordingWithAudio);
                }
              } catch (error) {
                console.error('Error loading recording:', error);
              }
            }}>
              <div className="recording-name-row">
                <span className="recording-name">{recording.name.replace(/\.[^/.]+$/, '')}</span>
              </div>
              <div className="recording-date-row">
                <span className="recording-date-secondary">{formatDate(recording.timestamp)}</span>
                <span className="recording-channel-icon">
                  {(recording.channelMode || 'stereo') === 'mono' ? (
                    <svg width="20" height="20" viewBox="0 0 256 256" fill="currentColor">
                      <path d="M127 210c-44.735 0-81-36.265-81-81s36.265-81 81-81 81 36.265 81 81-36.265 81-81 81zm1-21c34.794 0 63-27.087 63-60.5S162.794 68 128 68s-63 27.087-63 60.5S93.206 189 128 189z" fillRule="evenodd" />
                    </svg>
                  ) : (
                    <svg width="20" height="20" viewBox="0 0 256 256" fill="currentColor">
                      <path d="M128.802 95.03c-9.229-9.369-22.39-15.228-37-15.228-27.92 0-50.555 21.402-50.555 47.803 0 26.4 22.634 47.802 50.555 47.802 14.711 0 27.954-5.94 37.193-15.423-12.232-16.88-14.177-19.888-14.177-32.38 0-12.016 5.924-18.458 14.19-31.142 6.753 13.293 13.629 19.445 13.629 31.538 0 12.802-6.03 20.525-13.402 32.614 9.206 9.115 22.185 14.793 36.567 14.793 27.922 0 50.556-21.401 50.556-47.802 0-26.4-22.634-47.803-50.556-47.803-14.608 0-27.77 5.86-37 15.228zM128 75.374C138.501 68.202 151.252 64 165 64c35.899 0 65 28.654 65 64 0 35.346-29.101 64-65 64-13.748 0-26.499-4.202-37-11.374C117.499 187.798 104.748 192 91 192c-35.899 0-65-28.654-65-64 0-35.346 29.101-64 65-64 13.748 0 26.499 4.202 37 11.374z" fillRule="evenodd" />
                    </svg>
                  )}
                </span>
              </div>
            </div>
            <div className="recording-actions">
              <button
                className="action-button"
                onClick={async (e) => {
                  e.stopPropagation();
                  // Load full recording from IndexedDB when selected
                  try {
                    const fullRecording = await getRecording(recording.id);
                    if (fullRecording) {
                      // Convert ArrayBuffer to number array for compatibility
                      const audioArray = new Uint8Array(fullRecording.audioData);
                      const recordingWithAudio: Recording = {
                        ...recording,
                        audioData: Array.from(audioArray)
                      };
                      onSelectRecording(recordingWithAudio);
                    }
                  } catch (error) {
                    console.error('Error loading recording:', error);
                  }
                }}
                title="Play"
              >
                <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z" />
                </svg>
              </button>
              <button
                className="action-button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDownload(recording);
                }}
                title="Download"
              >
                <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M10 2a1 1 0 011 1v8.586l2.293-2.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 111.414-1.414L9 11.586V3a1 1 0 011-1z" />
                  <path d="M3 15a1 1 0 011 1h12a1 1 0 110 2H4a1 1 0 01-1-1z" />
                </svg>
              </button>
              <button
                className="action-button delete-button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDelete(recording.id);
                }}
                title="Delete"
              >
                <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
              </button>
            </div>
            <div className="recording-meta-right">
              <div className="recording-file-size">{formatFileSize(fileSizes[recording.id] || 0)}</div>
              <div className="recording-duration">{formatTime(recording.duration)}</div>
            </div>
          </div>
        ))}
      </div>
      <button
        className="download-all-button"
        onClick={handleDownloadAll}
        disabled={isDownloadingAll || recordings.length === 0}
        title="Download all recordings"
      >
        {isDownloadingAll ? (
          <>
            <div className="download-spinner"></div>
            Downloading...
          </>
        ) : (
          <>
            <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
              <path d="M10 2a1 1 0 011 1v8.586l2.293-2.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 111.414-1.414L9 11.586V3a1 1 0 011-1z" />
              <path d="M3 15a1 1 0 011 1h12a1 1 0 110 2H4a1 1 0 01-1-1z" />
            </svg>
            Download All ({recordings.length})
          </>
        )}
      </button>
    </div>
  );
};
