import { useState, useRef, useCallback, useEffect } from 'react';
import { getRecording, StoredRecording } from '../utils/storageManager';
import { ClockState, clockSeconds, estimateSeconds, smoothClock } from '../utils/recordingClock';

interface UseAudioRecorderReturn {
  isRecording: boolean;
  isPaused: boolean;
  audioBlob: Blob | null;
  duration: number;
  startRecording: (details: { name?: string; channelMode?: string }) => Promise<void>;
  stopRecording: (details: { name?: string; channelMode?: string }) => Promise<StoredRecording | null>;
  pauseRecording: () => Promise<void>;
  resumeRecording: () => Promise<void>;
  checkRecordingState: () => Promise<void>;
  syncRecordedTime: (seconds: number, paused: boolean) => void;
  setAudioBlob: (blob: Blob | null) => void;
  setIsRecording: (recording: boolean) => void;
  setDuration: (duration: number) => void;
}

export function useAudioRecorder(): UseAudioRecorderReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [duration, setDuration] = useState(0);

  const clockRef = useRef<ClockState>({ seconds: 0, at: 0, paused: false, synced: false });
  const shownRef = useRef(0);
  const durationFrameRef = useRef<number | null>(null);

  const stopTimer = useCallback(() => {
    if (durationFrameRef.current !== null) {
      cancelAnimationFrame(durationFrameRef.current);
      durationFrameRef.current = null;
    }
  }, []);

  const showClock = useCallback(() => {
    shownRef.current = smoothClock(clockRef.current, shownRef.current);
    setDuration(shownRef.current);
  }, []);

  // Runs for the whole recording, paused or not, so corrections from the recorder always show
  const startTimer = useCallback((clock: ClockState) => {
    clockRef.current = clock;
    shownRef.current = clock.seconds;
    setDuration(clock.seconds);
    // Clear any existing loop first to prevent duplicates when popup reopens
    stopTimer();
    // Update every frame, like the playback clock, so the hundredths tick smoothly
    const tick = () => {
      showClock();
      durationFrameRef.current = requestAnimationFrame(tick);
    };
    durationFrameRef.current = requestAnimationFrame(tick);
  }, [stopTimer, showClock]);

  useEffect(() => stopTimer, [stopTimer]);

  const syncRecordedTime = useCallback((seconds: number, paused: boolean) => {
    const wasSynced = clockRef.current.synced;
    clockRef.current = { seconds, at: performance.now(), paused, synced: true };
    // The first report replaces the estimate outright, even if that moves the clock back
    if (!wasSynced) shownRef.current = seconds;
  }, []);

  // Restore state when the popup is reopened during a recording
  const checkRecordingState = useCallback(async () => {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'getRecordingState' });
      if (response.success && response.isRecording) {
        setIsRecording(true);
        setIsPaused(!!response.isPaused);
        startTimer({
          seconds: estimateSeconds(response.startTime || Date.now(), response.pausedAt || null, response.pausedTotal || 0),
          at: performance.now(),
          paused: !!response.isPaused,
          synced: false
        });
        // Don't fetch the partial recording while still recording; it is
        // assembled from IndexedDB only when recording stops.
      }
    } catch (error) {
      console.error('Error checking recording state:', error);
    }
  }, [startTimer]);

  useEffect(() => {
    checkRecordingState();
  }, [checkRecordingState]);

  // The offscreen document stopped the recording on its own (length limit, tab closed)
  useEffect(() => {
    const listener = (message: any) => {
      if (message.action !== 'recordingAutoStopped') return;
      stopTimer();
      setIsRecording(false);
      setIsPaused(false);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [stopTimer]);

  // details are used if the recording is stopped by the length limit rather than from the popup
  const startRecording = useCallback(async (details: { name?: string; channelMode?: string }) => {
    // Save anything still recording in the background (e.g. after a service worker restart)
    try {
      await chrome.runtime.sendMessage({ action: 'clearRecording' });
    } catch (error) {
      console.warn('Error clearing previous recording:', error);
    }

    // Get current active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      throw new Error('No active tab found');
    }

    // Request background script to automatically capture from current tab
    const response = await chrome.runtime.sendMessage({ action: 'startCapture', tabId: tab.id });
    if (!response.success) {
      throw new Error(response.error || 'Failed to start capture');
    }
    if (!response.streamId) {
      throw new Error('No stream ID received from background');
    }

    // Recording runs in the offscreen document so it continues when the popup closes.
    // The popup visualizes it through the remote waveform bridge (listenForRemoteUpdates).
    const bgResponse = await chrome.runtime.sendMessage({
      action: 'startRecordingWithStream',
      streamId: response.streamId,
      details
    });
    if (!bgResponse.success) {
      throw new Error(bgResponse.error || 'Failed to start recording');
    }

    setAudioBlob(null);
    startTimer({ seconds: 0, at: performance.now(), paused: false, synced: false });
    setIsRecording(true);
    setIsPaused(false);
  }, [startTimer]);

  const stopRecording = useCallback(async (details: { name?: string; channelMode?: string }): Promise<StoredRecording | null> => {
    if (!isRecording) return null;

    // Stop duration timer immediately so UI stats freeze
    stopTimer();

    try {
      // Resolves once the recording is saved in IndexedDB
      const response = await chrome.runtime.sendMessage({ action: 'stopCapture', details });
      if (!response?.success) {
        throw new Error(response?.error || 'Failed to save recording');
      }
      if (!response.recording) {
        console.warn('No audio was captured');
        return null;
      }

      const saved = await getRecording(response.recording.id);
      if (saved) setDuration(saved.metadata.duration);
      return saved;
    } finally {
      setIsRecording(false);
      setIsPaused(false);
    }
  }, [isRecording, stopTimer]);

  // Freeze or restart the local clock; the recorder's next report confirms the exact time
  const setClockPaused = useCallback((paused: boolean) => {
    const clock = clockRef.current;
    clockRef.current = { ...clock, seconds: clockSeconds(clock), at: performance.now(), paused };
  }, []);

  const pauseRecording = useCallback(async () => {
    if (!isRecording || isPaused) return;
    const response = await chrome.runtime.sendMessage({ action: 'pauseRecording' });
    if (!response?.success) throw new Error(response?.error || 'Failed to pause recording');
    setClockPaused(true);
    setIsPaused(true);
  }, [isRecording, isPaused, setClockPaused]);

  const resumeRecording = useCallback(async () => {
    if (!isRecording || !isPaused) return;
    const response = await chrome.runtime.sendMessage({ action: 'resumeRecording' });
    if (!response?.success) throw new Error(response?.error || 'Failed to resume recording');
    setClockPaused(false);
    setIsPaused(false);
  }, [isRecording, isPaused, setClockPaused]);

  return {
    isRecording,
    isPaused,
    audioBlob,
    duration,
    startRecording,
    stopRecording,
    pauseRecording,
    resumeRecording,
    checkRecordingState,
    syncRecordedTime,
    setAudioBlob,
    setIsRecording,
    setDuration
  };
}
