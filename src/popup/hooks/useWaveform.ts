import { useState, useRef, useCallback, useEffect } from 'react';
import { computeWaveformPeaks } from '../utils/audioConverter';
import { WaveformPeaks } from '../utils/storageManager';

interface WaveformData {
  data: Uint8Array;
  sampleRate: number;
  duration: number;
}

interface UseWaveformReturn {
  waveformData: WaveformData | null;
  liveWaveformDataRef: React.MutableRefObject<Uint8Array | null>;
  analyzeAudio: (audioBlob: Blob, peaks?: WaveformPeaks) => Promise<WaveformPeaks | null>;
  clearWaveform: () => void;
  listenForRemoteUpdates: () => () => void;
}

const WAVEFORM_BARS = 1000;

// Reduce stored peaks to a fixed number of bars: (average + max) / 2 per bar
function peaksToBars(peaks: WaveformPeaks): Uint8Array {
  const bars = new Uint8Array(WAVEFORM_BARS);
  const count = peaks.max.length;
  if (count === 0) return bars;

  for (let i = 0; i < WAVEFORM_BARS; i++) {
    const start = Math.floor(i * count / WAVEFORM_BARS);
    const end = Math.max(start + 1, Math.floor((i + 1) * count / WAVEFORM_BARS));
    let max = 0;
    let sum = 0;
    for (let j = start; j < end; j++) {
      if (peaks.max[j] > max) max = peaks.max[j];
      sum += peaks.avg[j];
    }
    bars[i] = Math.floor((sum / (end - start) + max) / 2);
  }
  return bars;
}

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
        data: peaksToBars(resolvedPeaks),
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

  const liveWaveformDataRef = useRef<Uint8Array | null>(null);

  // Live waveform from the offscreen recorder, streamed over a port only while the popup shows it
  const listenForRemoteUpdates = useCallback(() => {
    // Reusable buffer to prevent GC pressure
    let updateBuffer: Uint8Array | null = null;
    let port: chrome.runtime.Port | null = null;
    let retryTimer: number | null = null;
    let active = true;

    const connect = () => {
      port = chrome.runtime.connect({ name: 'waveform' });
      port.onMessage.addListener((message: { data: number[] }) => {
        const data = message.data;
        if (!updateBuffer || updateBuffer.length !== data.length) {
          updateBuffer = new Uint8Array(data.length);
        }
        updateBuffer.set(data);
        // Update the REF, not state - avoids React render cycle; Waveform polls it in its rAF loop
        liveWaveformDataRef.current = updateBuffer;
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

