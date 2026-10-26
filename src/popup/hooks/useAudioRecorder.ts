import { useState, useRef, useCallback, useEffect } from 'react';
import { getRecording, StoredRecording } from '../utils/storageManager';

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
  setAudioBlob: (blob: Blob | null) => void;
  setIsRecording: (recording: boolean) => void;
  setDuration: (duration: number) => void;
}

interface TimerState {
  startTime: number;
  pausedAt: number | null;
  pausedTotal: number;
}

// Recorded time excludes paused intervals
function elapsedSeconds(timer: TimerState): number {
  const now = timer.pausedAt ?? Date.now();
  return Math.max(0, (now - timer.startTime - timer.pausedTotal) / 1000);
}

export function useAudioRecorder(): UseAudioRecorderReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [duration, setDuration] = useState(0);

  const timerRef = useRef<TimerState>({ startTime: 0, pausedAt: null, pausedTotal: 0 });
  const durationIntervalRef = useRef<number | null>(null);

  const stopTimer = useCallback(() => {
    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current);
      durationIntervalRef.current = null;
    }
  }, []);

  const startTimer = useCallback((timer: TimerState) => {
    timerRef.current = timer;
    setDuration(elapsedSeconds(timer));
    // Clear any existing interval first to prevent duplicates when popup reopens
    stopTimer();
    // 100ms = 10 updates/sec for smooth display
    durationIntervalRef.current = window.setInterval(() => {
      setDuration(elapsedSeconds(timerRef.current));
    }, 100);
  }, [stopTimer]);

  useEffect(() => stopTimer, [stopTimer]);

  // Restore state when the popup is reopened during a recording
  const checkRecordingState = useCallback(async () => {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'getRecordingState' });
      if (response.success && response.isRecording) {
        setIsRecording(true);
        setIsPaused(!!response.isPaused);
        startTimer({
          startTime: response.startTime || Date.now(),
          pausedAt: response.pausedAt || null,
          pausedTotal: response.pausedTotal || 0
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
    startTimer({ startTime: Date.now(), pausedAt: null, pausedTotal: 0 });
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

  const pauseRecording = useCallback(async () => {
    if (!isRecording || isPaused) return;
    const response = await chrome.runtime.sendMessage({ action: 'pauseRecording' });
    if (!response?.success) throw new Error(response?.error || 'Failed to pause recording');
    stopTimer();
    timerRef.current = { ...timerRef.current, pausedAt: response.pausedAt, pausedTotal: response.pausedTotal };
    setDuration(elapsedSeconds(timerRef.current));
    setIsPaused(true);
  }, [isRecording, isPaused, stopTimer]);

  const resumeRecording = useCallback(async () => {
    if (!isRecording || !isPaused) return;
    const response = await chrome.runtime.sendMessage({ action: 'resumeRecording' });
    if (!response?.success) throw new Error(response?.error || 'Failed to resume recording');
    startTimer({ ...timerRef.current, pausedAt: null, pausedTotal: response.pausedTotal });
    setIsPaused(false);
  }, [isRecording, isPaused, startTimer]);

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
    setAudioBlob,
    setIsRecording,
    setDuration
  };
}
