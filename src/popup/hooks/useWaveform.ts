import { useState, useRef, useCallback, useEffect } from 'react';
import { computeWaveformPeaks } from '../utils/audioConverter';
import { WaveformPeaks } from '../utils/storageManager';

interface WaveformData {
  data: Uint8Array;
  sampleRate: number;
  duration: number;
}

// Recent loudness levels while recording (LIVE_LEVELS_PER_SECOND), newest last
export interface LiveWaveform {
  levels: number[];
  total: number; // levels produced since the recording started
  receivedAt: number; // performance.now() when `total` last increased, for smooth scrolling
}

interface UseWaveformReturn {
  waveformData: WaveformData | null;
  liveWaveformDataRef: React.MutableRefObject<LiveWaveform | null>;
  analyzeAudio: (audioBlob: Blob, peaks?: WaveformPeaks) => Promise<WaveformPeaks | null>;
  clearWaveform: () => void;
  listenForRemoteUpdates: () => () => void;
}

// One value per stored peak window, (average + max) / 2, at full resolution so zooming shows detail
function peaksToLevels(peaks: WaveformPeaks): Uint8Array {
  const levels = new Uint8Array(peaks.max.length);
  for (let i = 0; i < levels.length; i++) levels[i] = (peaks.max[i] + peaks.avg[i]) >> 1;
  return levels;
}

// Live levels kept in the popup: a little more than the visible window
const LIVE_LEVELS_KEPT = 600;

export function useWaveform(): UseWaveformReturn {
  const [waveformData, setWaveformData] = useState<WaveformData | null>(null);
  const analysisIdRef = useRef(0);

  useEffect(() => () => {
    analysisIdRef.current++;
  }, []);

  // Uses peaks recorded live when available. Otherwise (older or recovered recordings) computes
  // them by streaming through the file, and returns them so the caller can store them.
  const analyzeAudio = useCallback(async (audioBlob: Blob, peaks?: WaveformPeaks): Promise<WaveformPeaks | null> => {
    const analysisId = ++analysisIdRef.current;
    try {
      const resolvedPeaks = peaks && peaks.max.length > 0 ? peaks : await computeWaveformPeaks(audioBlob);
      if (analysisId !== analysisIdRef.current) return null;

      setWaveformData({
        data: peaksToLevels(resolvedPeaks),
        sampleRate: resolvedPeaks.rate,
        duration: resolvedPeaks.max.length / resolvedPeaks.rate
      });
      return resolvedPeaks === peaks ? null : resolvedPeaks;
    } catch (error) {
      console.error('Error analyzing audio:', error);
      return null;
    }
  }, []);

  const clearWaveform = useCallback(() => {
    analysisIdRef.current++;
    // Clear waveform data immediately
    setWaveformData(null);
  }, []);

  const liveWaveformDataRef = useRef<LiveWaveform | null>(null);

  // Live waveform from the offscreen recorder, streamed over a port only while the popup shows it
  const listenForRemoteUpdates = useCallback(() => {
    let port: chrome.runtime.Port | null = null;
    let retryTimer: number | null = null;
    let active = true;

    const connect = () => {
      port = chrome.runtime.connect({ name: 'waveform' });
      port.onMessage.addListener((message: { levels: number[]; total: number }) => {
        // Update the REF, not state - avoids React render cycle; Waveform polls it in its rAF loop
        const live = liveWaveformDataRef.current;
        if (!live || message.levels.length !== message.total - live.total) {
          // First message, or a fresh history after reconnecting
          liveWaveformDataRef.current = { levels: message.levels.slice(-LIVE_LEVELS_KEPT), total: message.total, receivedAt: performance.now() };
          return;
        }
        live.levels.push(...message.levels);
        if (live.levels.length > LIVE_LEVELS_KEPT) live.levels.splice(0, live.levels.length - LIVE_LEVELS_KEPT);
        live.total = message.total;
        live.receivedAt = performance.now();
      });
      // The recorder may still be starting; reconnect while recording
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        port = null;
        if (active) retryTimer = window.setTimeout(connect, 500);
      });
    };
    connect();

    return () => {
      active = false;
      if (retryTimer) clearTimeout(retryTimer);
      port?.disconnect();
      liveWaveformDataRef.current = null;
    };
  }, []);

  return {
    waveformData,
    liveWaveformDataRef, // Expose the ref
    analyzeAudio,
    clearWaveform,
    listenForRemoteUpdates
  };
}

