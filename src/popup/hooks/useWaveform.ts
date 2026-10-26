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

  const listenForRemoteUpdates = useCallback(() => {
    // Reusable buffer to prevent GC pressure
    let updateBuffer: Uint8Array | null = null;
    // Notify subscribers that new data is available (can be used to trigger a draw if loop is separate)
    // For now, we rely on the consumer (Waveform) polling the ref in rAF loop

    const listener = (message: any) => {
      if (message.action === 'waveformUpdate' && message.data) {
        const data = message.data;

        // Initialize or resize buffer if needed
        if (!updateBuffer || updateBuffer.length !== data.length) {
          updateBuffer = new Uint8Array(data.length);
        }

        // Copy data to reusable buffer
        for (let i = 0; i < data.length; i++) {
          updateBuffer[i] = data[i];
        }

        // Update the REF, not state - avoids React render cycle
        liveWaveformDataRef.current = updateBuffer;
      }
    };

    chrome.runtime.onMessage.addListener(listener);

    // Return cleanup function
    return () => {
      chrome.runtime.onMessage.removeListener(listener);
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

