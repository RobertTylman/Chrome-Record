import { useState, useRef, useCallback, useEffect } from 'react';
import { DEFAULT_AUDIO_FORMAT, getMimeTypeForFormat, isFormatSupported } from '../utils/formatUtils';
import { getTempData, deleteTempData } from '../utils/storageManager';

interface UseAudioRecorderReturn {
  isRecording: boolean;
  isPaused: boolean;
  audioBlob: Blob | null;
  duration: number;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<Blob | null>;
  pauseRecording: () => void;
  resumeRecording: () => void;
  getAudioStream: () => MediaStream | null;
  checkRecordingState: () => Promise<void>;
  setAudioBlob: (blob: Blob | null) => void;
  setIsRecording: (recording: boolean) => void;
  setDuration: (duration: number) => void;
}

export function useAudioRecorder(): UseAudioRecorderReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [duration, setDuration] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startTimeRef = useRef<number>(0);
  const durationIntervalRef = useRef<number | null>(null);

  // Check recording state on mount (in case popup was closed and reopened)
  useEffect(() => {
    checkRecordingState();
  }, []);

  const checkRecordingState = useCallback(async () => {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'getRecordingState' });
      if (response.success && response.isRecording) {
        setIsRecording(true);

        // Get the recording start time from storage to calculate accurate duration
        chrome.storage.local.get(['recordingStartTime', 'recordingStreamId'], (result) => {
          if (result.recordingStartTime) {
            const elapsed = (Date.now() - result.recordingStartTime) / 1000;
            setDuration(elapsed);
            startTimeRef.current = Date.now() - elapsed * 1000;
          } else {
            // Fallback: start from now
            startTimeRef.current = Date.now();
            setDuration(0);
            chrome.storage.local.set({ recordingStartTime: Date.now() });
          }

          // Clear any existing interval first to prevent duplicates when popup reopens
          if (durationIntervalRef.current) {
            clearInterval(durationIntervalRef.current);
          }

          // Start duration timer for background recording (100ms = 10 updates/sec for smooth display)
          durationIntervalRef.current = window.setInterval(() => {
            const elapsed = (Date.now() - startTimeRef.current) / 1000;
            setDuration(elapsed);
          }, 100);

          // If we have a streamId, try to reconnect to the stream for visualization
          if (result.recordingStreamId) {
            // Don't try to reconnect - just let it record in background
            // The stream is already being recorded in background worker
          }
        });

        // Don't fetch the partial recording data while still recording!
        // 1. It causes massive lag (fetching/decoding growing blob)
        // 2. It's unnecessary (we only show live waveform)
        // 3. It causes "Unable to decode" errors due to race conditions
        // We only fetch the full blob when recording eventually STOPS.
      } else {
        // Not recording - clear any stale state
        chrome.storage.local.remove(['recordingStreamId', 'recordingTabId', 'recordingStartTime']);
      }
    } catch (error) {
      console.error('Error checking recording state:', error);
    }
  }, []);

  const startRecording = useCallback(async () => {
    try {
      // Get format preference
      const prefsResult = await chrome.storage.local.get(['preferences']);
      const format = prefsResult.preferences?.format || DEFAULT_AUDIO_FORMAT;
      const mimeType = getMimeTypeForFormat(format);

      // Check if there's a previous stream that needs cleanup
      const hadPreviousStream = !!streamRef.current;

      // Clean up any previous recording
      if (hadPreviousStream) {
        streamRef.current!.getTracks().forEach((track: MediaStreamTrack) => track.stop());
        streamRef.current = null;
      }

      // Stop any active recording in background and clear all streams
      try {
        await chrome.runtime.sendMessage({ action: 'clearRecording' });
      } catch (error) {
        console.warn('Error clearing previous recording:', error);
      }

      // Only wait for stream release if there was a previous recording
      // Reduced from 400ms to 50ms for faster startup
      if (hadPreviousStream) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      // Clear any previous recording state from storage
      await chrome.storage.local.remove(['recordingStreamId', 'recordingTabId', 'recordingStartTime', 'recordingChunks']);

      // Get current active tab
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab.id) {
        throw new Error('No active tab found');
      }

      // Request background script to automatically capture from current tab
      const response = await chrome.runtime.sendMessage({
        action: 'startCapture',
        tabId: tab.id
      });

      if (!response.success) {
        throw new Error(response.error || 'Failed to start capture');
      }

      // Get streamId from background response
      const streamId = response.streamId;
      const method = response.method || 'tab'; // 'desktop' or 'tab'

      if (!streamId) {
        throw new Error('No stream ID received from background');
      }

      // Send streamId to background to start recording there (Offscreen)
      const bgResponse = await chrome.runtime.sendMessage({
        action: 'startRecordingWithStream',
        streamId: streamId
      });

      if (bgResponse.success) {
        // Background (Offscreen) recording started successfully.
        // We do NOT acquire the stream locally to avoid "NotReadableError" or stream stealing.
        // The Popup will use the remote waveform bridge (listenForRemoteUpdates) to visualize audio.
        streamRef.current = null;
        setAudioBlob(null);

        // Store start time for persistence
        const startTime = Date.now();
        startTimeRef.current = startTime;
        setDuration(0);
        chrome.storage.local.set({ recordingStartTime: startTime });

        // Start duration timer (100ms = 10 updates/sec for smooth display)
        durationIntervalRef.current = window.setInterval(() => {
          const elapsed = (Date.now() - startTimeRef.current) / 1000;
          setDuration(elapsed);
        }, 100);

        setIsRecording(true);
        setIsPaused(false);
      } else {
        // Background recording failed, fallback to local Popup recording
        console.warn('Background recording failed, falling back to local:', bgResponse.error);

        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              // @ts-ignore
              mandatory: {
                chromeMediaSource: method === 'desktop' ? 'desktop' : 'tab',
                chromeMediaSourceId: streamId
              }
            } as any,
            video: false
          });

          streamRef.current = stream;

          // Playback workaround for tab capture (if needed)
          if (method === 'tab') {
            const tempCtx = new AudioContext();
            const src = tempCtx.createMediaStreamSource(stream);
            src.connect(tempCtx.destination);
            (window as any).__recordingAudioContext = tempCtx;
          }

          const recorder = new MediaRecorder(stream, { mimeType });
          chunksRef.current = [];
          recorder.ondataavailable = async (event) => {
            if (event.data.size > 0) {
              chunksRef.current.push(event.data);
              // Send chunks to background for persistence
              const arrayBuffer = await event.data.arrayBuffer();
              chrome.runtime.sendMessage({
                action: 'addRecordingChunk',
                chunk: Array.from(new Uint8Array(arrayBuffer))
              });
            }
          };

          recorder.onstop = () => {
            const blob = new Blob(chunksRef.current, { type: mimeType });
            setAudioBlob(blob);
          };

          mediaRecorderRef.current = recorder;
          recorder.start(100);

          const startTime = Date.now();
          startTimeRef.current = startTime;
          setDuration(0);
          setAudioBlob(null);
          chrome.storage.local.set({ recordingStartTime: startTime });

          durationIntervalRef.current = window.setInterval(() => {
            const elapsed = (Date.now() - startTimeRef.current) / 1000;
            setDuration(elapsed);
          }, 100);

          setIsRecording(true);
          setIsPaused(false);
        } catch (localError) {
          console.error('Local recording fallback also failed:', localError);
          throw localError;
        }
      }
    } catch (error) {
      console.error('Error starting recording:', error);
      throw error;
    }
  }, []);

  const stopRecording = useCallback(async (): Promise<Blob | null> => {
    if (isRecording) {
      // Stop duration timer immediately so UI stats freeze
      if (durationIntervalRef.current) {
        clearInterval(durationIntervalRef.current);
        durationIntervalRef.current = null;
      }

      // Stop local recorder if it exists
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        const recorder = mediaRecorderRef.current;
        await new Promise<void>((resolve) => {
          const originalOnStop = recorder.onstop;
          recorder.onstop = (event: Event) => {
            if (originalOnStop) {
              originalOnStop.call(recorder, event);
            }
            resolve();
          };
          recorder.stop();
        });
        mediaRecorderRef.current = null;
      }

      // Stop recording in background
      const response = await chrome.runtime.sendMessage({ action: 'stopCapture' });

      let finalBlob: Blob | null = null;

      // Check IndexedDB first (new robust path)
      try {
        const tempBlob = await getTempData('temp_recording_blob');
        if (tempBlob && tempBlob.size > 0) {
          console.log('Got recording blob from IndexedDB, size:', tempBlob.size);
          finalBlob = tempBlob;

          // Cleanup temp data
          await deleteTempData('temp_recording_blob');
          setAudioBlob(finalBlob);
        }
      } catch (error) {
        console.error('Error reading from IndexedDB:', error);
      }

      // Fallback: Check storage directly for chunks (legacy path, retained just in case)
      if (!finalBlob) {
        const storageResult = await chrome.storage.local.get(['recordingChunks', 'preferences']);

        if (storageResult.recordingChunks && storageResult.recordingChunks.length > 0) {
          console.log('Reading recording chunks directly from storage (fallback):', storageResult.recordingChunks.length);
          // ... legacy reconstruction logic ...
          const format = storageResult.preferences?.format || DEFAULT_AUDIO_FORMAT;
          let mimeType = 'audio/webm';
          if (format === 'ogg') mimeType = 'audio/ogg';

          const chunks = storageResult.recordingChunks;
          const blobs = chunks.map((chunk: number[]) => new Blob([new Uint8Array(chunk)], { type: mimeType }));
          finalBlob = new Blob(blobs, { type: mimeType });

          chrome.storage.local.remove(['recordingChunks']);
          setAudioBlob(finalBlob);
        }
      }

      if (!finalBlob && response && response.success && response.audioBlob && response.audioBlob.length > 0) {
        // Fallback to IPC payload if storage failed but response has it (legacy path)
        const audioArray = new Uint8Array(response.audioBlob);
        finalBlob = new Blob([audioArray], { type: 'audio/webm' });
        console.log('Got blob from background response, size:', finalBlob.size);
        setAudioBlob(finalBlob);
      } else if (chunksRef.current.length > 0) {
        // If no background blob, use local chunks
        finalBlob = new Blob(chunksRef.current, { type: 'audio/webm' });
        console.log('Got blob from local chunks, size:', finalBlob.size);
        setAudioBlob(finalBlob);
      } else {
        console.warn('No audio blob available after stopping recording');
      }

      // Clear chunks after creating blob
      chunksRef.current = [];

      if (streamRef.current) {
        // Clean up waveform analysis if it exists
        if ((streamRef.current as any).__waveformCleanup) {
          (streamRef.current as any).__waveformCleanup();
        }

        const tracks = streamRef.current.getTracks();
        tracks.forEach((track: MediaStreamTrack) => {
          track.stop();
          console.log('Stopped track in stopRecording:', track.id, 'readyState:', track.readyState);
        });
        streamRef.current = null;
        // Wait longer for tracks to fully stop - critical for tabCapture API
        await new Promise(resolve => setTimeout(resolve, 300));
      }


      // Clean up audio context
      if ((window as any).__recordingAudioContext) {
        try {
          await (window as any).__recordingAudioContext.close();
        } catch (e) {
          // Ignore errors
        }
        delete (window as any).__recordingAudioContext;
      }

      // Clear recording start time and streamId from storage
      chrome.storage.local.remove(['recordingStartTime', 'recordingStreamId', 'recordingTabId']);

      setIsRecording(false);
      setIsPaused(false);

      // Return the blob so it can be used immediately
      return finalBlob;
    }
    return null;
  }, [isRecording]);

  const pauseRecording = useCallback(() => {
    // Pausing is handled by background worker
    if (isRecording && !isPaused) {
      setIsPaused(true);
      if (durationIntervalRef.current) {
        clearInterval(durationIntervalRef.current);
        durationIntervalRef.current = null;
      }
    }
  }, [isRecording, isPaused]);

  const resumeRecording = useCallback(() => {
    if (isRecording && isPaused) {
      setIsPaused(false);
      startTimeRef.current = Date.now() - duration * 1000;
      durationIntervalRef.current = window.setInterval(() => {
        const elapsed = (Date.now() - startTimeRef.current) / 1000;
        setDuration(elapsed);
      }, 100);
    }
  }, [isRecording, isPaused, duration]);

  const getAudioStream = useCallback(() => {
    return streamRef.current;
  }, []);

  return {
    isRecording,
    isPaused,
    audioBlob,
    duration,
    startRecording,
    stopRecording,
    pauseRecording,
    resumeRecording,
    getAudioStream,
    checkRecordingState,
    setAudioBlob,
    setIsRecording,
    setDuration
  };
}
