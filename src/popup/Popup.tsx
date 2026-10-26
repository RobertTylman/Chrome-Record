import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { useAudioRecorder } from './hooks/useAudioRecorder';
import { useWaveform } from './hooks/useWaveform';
import { formatTime, formatDate, downloadAudio } from './utils/audioUtils';
import { DEFAULT_AUDIO_FORMAT, getFileExtension } from './utils/formatUtils';
import { exportAudio } from './utils/audioConverter';
import { exportFilename, getExportOptions, openExportTab, shouldExportInTab } from './utils/exportUtils';
import {
  migrateFromChromeStorage,
  updateRecordingName,
  updateRecordingPeaks,
  deleteRecording,
  getRecording,
  recoverInterruptedRecordings,
  MAX_RECORDING_SECONDS,
  StoredRecording,
  WaveformPeaks
} from './utils/storageManager';

import { Waveform } from './components/Waveform';
import { AudioInfo } from './components/AudioInfo';
import { RecordingControls } from './components/RecordingControls';
import { RecordButton } from './components/RecordButton';
import { RecentRecordings } from './components/RecentRecordings';
import { Preferences } from './components/Preferences';
import './styles/popup.css';

// Show a countdown during the last minutes before the recording length limit
const LIMIT_WARNING_SECONDS = 10 * 60;

const Popup: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'recording' | 'recent' | 'preferences'>('recording');
  const [recordingName, setRecordingName] = useState<string>('');
  const [recordingTimestamp, setRecordingTimestamp] = useState<Date>(new Date());
  const [currentRecordingId, setCurrentRecordingId] = useState<string | null>(null);
  const [currentRecordingChannelMode, setCurrentRecordingChannelMode] = useState<'mono' | 'stereo' | undefined>(undefined);
  const [zoom, setZoom] = useState(1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLooping, setIsLooping] = useState(false);
  const [currentPlayTime, setCurrentPlayTime] = useState(0);
  const [startTime, setStartTime] = useState(0);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [loadedAudioDuration, setLoadedAudioDuration] = useState(0);
  const [theme, setTheme] = useState<'light' | 'dark' | 'midnight' | 'forest' | 'rainbow'>('light');
  const [preferences, setPreferences] = useState<{
    format?: string;
    sampleRate?: string;
    channelMode?: string;
    useTabTitle?: boolean;
  }>({});

  const [isExporting, setIsExporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Peaks and duration of the loaded recording, read when its audio is analyzed
  const currentPeaksRef = useRef<WaveformPeaks | undefined>(undefined);
  const knownDurationRef = useRef(0);
  const currentRecordingIdRef = useRef<string | null>(null);
  currentRecordingIdRef.current = currentRecordingId;
  const playIntervalRef = useRef<number | null>(null);
  const playheadAnimationFrameRef = useRef<number | null>(null);

  const {
    isRecording,
    isPaused,
    audioBlob,
    duration: recordingDuration,
    startRecording,
    stopRecording,
    pauseRecording,
    resumeRecording,
    checkRecordingState,
    setAudioBlob,
    setIsRecording,
    setDuration: setRecordingDuration
  } = useAudioRecorder();

  const {
    waveformData,
    analyzeAudio,
    clearWaveform,
    listenForRemoteUpdates,
    liveWaveformDataRef
  } = useWaveform();

  // Load a saved recording into the editor
  const loadRecording = useCallback((recording: StoredRecording) => {
    if (audioRef.current) {
      audioRef.current.pause();
      if (audioRef.current.src && audioRef.current.src.startsWith('blob:')) {
        URL.revokeObjectURL(audioRef.current.src);
      }
      audioRef.current.src = '';
    }
    setIsPlaying(false);
    setCurrentPlayTime(0);

    const { metadata } = recording;
    currentPeaksRef.current = recording.peaks;
    knownDurationRef.current = metadata.duration || 0;
    if (metadata.duration) {
      setRecordingDuration(metadata.duration);
      setLoadedAudioDuration(metadata.duration);
    }
    setRecordingName(metadata.name.replace(/\.[^/.]+$/, ''));
    setRecordingTimestamp(new Date(metadata.timestamp));
    setCurrentRecordingId(metadata.id);
    setCurrentRecordingChannelMode((metadata.channelMode as 'mono' | 'stereo') || 'stereo');
    setAudioBlob(recording.audio);
  }, [setAudioBlob, setRecordingDuration]);

  // Save recordings interrupted by a crash, update or closed popup, and open the newest one
  const recoverInterrupted = useCallback(async () => {
    try {
      const state = await chrome.runtime.sendMessage({ action: 'getRecordingState' });
      if (state?.isRecording) return;
      const recovered = await recoverInterruptedRecordings(state?.sessionId);
      if (recovered.length > 0) {
        const newest = await getRecording(recovered[recovered.length - 1].id);
        if (newest) loadRecording(newest);
      }
    } catch (error) {
      console.error('Error recovering interrupted recordings:', error);
    }
  }, [loadRecording]);

  // Open a recording that was stopped and saved at the length limit
  const loadAutoSaved = useCallback(async () => {
    try {
      const { autoSavedRecordingId } = await chrome.storage.local.get(['autoSavedRecordingId']);
      if (!autoSavedRecordingId) return false;
      await chrome.storage.local.remove(['autoSavedRecordingId']);
      const recording = await getRecording(autoSavedRecordingId);
      if (!recording) return false;
      loadRecording(recording);
      setNotice(`Recording stopped at the ${MAX_RECORDING_SECONDS / 60}-minute limit and was saved.`);
      return true;
    } catch (error) {
      console.error('Error loading auto-saved recording:', error);
      return false;
    }
  }, [loadRecording]);

  useEffect(() => {
    const listener = (message: any) => {
      if (message.action !== 'recordingLimitReached') return;
      if (message.error) {
        setNotice(`Recording reached the ${MAX_RECORDING_SECONDS / 60}-minute limit but could not be saved: ${message.error}. It will be recovered the next time you open the extension.`);
        return;
      }
      // The background stores the id before closing the recorder; give it a moment
      setTimeout(loadAutoSaved, 300);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [loadAutoSaved]);

  useEffect(() => {
    chrome.storage.local.get(['migratedToIndexedDB', 'isLightMode', 'theme', 'preferences'], async (result) => {
      let initialTheme: 'dark' | 'light' | 'midnight' | 'forest' | 'rainbow' = 'dark';
      if (result.theme) {
        initialTheme = result.theme;
      } else if (result.isLightMode) {
        initialTheme = 'light';
      }

      setTheme(initialTheme);
      document.body.className = '';
      if (initialTheme !== 'dark') {
        document.body.classList.add(`${initialTheme}-mode`);
      }

      if (result.preferences) {
        setPreferences(result.preferences);
      }

      checkRecordingState();
      recoverInterrupted().then(loadAutoSaved);

      if (!result.migratedToIndexedDB) {
        setTimeout(async () => {
          try {
            const count = await migrateFromChromeStorage();
            if (count > 0) {
              console.log(`Migrated ${count} recordings to IndexedDB`);
            }
            chrome.storage.local.set({ migratedToIndexedDB: true });
          } catch (error) {
            console.error('Migration error:', error);
          }
        }, 100);
      }
    });

    chrome.storage.session.get(['currentRecordingState'], (sessionResult) => {
      if (sessionResult.currentRecordingState) {
        const savedState = sessionResult.currentRecordingState;
        if (savedState.recordingName) setRecordingName(savedState.recordingName);
        if (savedState.recordingTimestamp) setRecordingTimestamp(new Date(savedState.recordingTimestamp));
        if (savedState.currentRecordingId) setCurrentRecordingId(savedState.currentRecordingId);
        if (savedState.currentRecordingChannelMode) setCurrentRecordingChannelMode(savedState.currentRecordingChannelMode);
        if (savedState.trimStart !== undefined) setTrimStart(savedState.trimStart);
        if (savedState.trimEnd !== undefined && savedState.trimEnd > 0) setTrimEnd(savedState.trimEnd);
        if (savedState.loadedAudioDuration !== undefined && savedState.loadedAudioDuration > 0) setLoadedAudioDuration(savedState.loadedAudioDuration);
      }
    });

    const listener = (changes: { [key: string]: chrome.storage.StorageChange }) => {
      if (changes.preferences) {
        setPreferences(changes.preferences.newValue || {});
      }
      if (changes.theme) {
        const newTheme = changes.theme.newValue || 'dark';
        setTheme(newTheme);
        document.body.className = '';
        if (newTheme !== 'dark') {
          document.body.classList.add(`${newTheme}-mode`);
        }
      }
    };
    chrome.storage.onChanged.addListener(listener);

    return () => {
      chrome.storage.onChanged.removeListener(listener);
    };
  }, [checkRecordingState, recoverInterrupted, loadAutoSaved]);

  useEffect(() => {
    if (recordingName || currentRecordingId) {
      chrome.storage.session.set({
        currentRecordingState: {
          recordingName,
          recordingTimestamp: recordingTimestamp.toISOString(),
          currentRecordingId,
          currentRecordingChannelMode,
          trimStart: isRecording ? 0 : trimStart,
          trimEnd: isRecording ? 0 : trimEnd,
          loadedAudioDuration: isRecording ? 0 : loadedAudioDuration
        }
      });
    }
  }, [recordingName, recordingTimestamp, currentRecordingId, currentRecordingChannelMode, trimStart, trimEnd, isRecording, loadedAudioDuration]);

  useEffect(() => {
    const reloadRecording = async () => {
      if (currentRecordingId && !audioBlob && !isRecording) {
        try {
          const fullRecording = await getRecording(currentRecordingId);
          if (fullRecording) {
            currentPeaksRef.current = fullRecording.peaks;
            knownDurationRef.current = fullRecording.metadata.duration || 0;
            setAudioBlob(fullRecording.audio);
            if (loadedAudioDuration === 0 && fullRecording.metadata.duration) {
              setLoadedAudioDuration(fullRecording.metadata.duration);
            }
          }
        } catch (error) {
          console.error('Error reloading recording:', error);
        }
      }
    };
    reloadRecording();
  }, [currentRecordingId, audioBlob, isRecording, loadedAudioDuration, setAudioBlob]);

  useEffect(() => {
    if (isRecording) {
      const now = new Date();
      setRecordingTimestamp(now);
      if (!preferences.useTabTitle || !recordingName) {
        setRecordingName(`recording ${formatDate(now)}`);
      }
      setStartTime(0);
      setCurrentPlayTime(0);
    }
  }, [isRecording]);

  useEffect(() => {
    if (isRecording) {
      const cleanup = listenForRemoteUpdates();
      return cleanup;
    } else {
      clearWaveform();
    }
  }, [isRecording, clearWaveform, listenForRemoteUpdates]);

  useEffect(() => {
    let cancelled = false;
    if (audioBlob && !isRecording) {
      clearWaveform();
      const timeoutId = setTimeout(async () => {
        if (cancelled) return;
        try {
          const recordingId = currentRecordingIdRef.current;
          const computedPeaks = await analyzeAudio(audioBlob, currentPeaksRef.current);
          if (cancelled) return;
          // Older recordings have no stored peaks; keep the computed ones for next time
          if (computedPeaks && recordingId) {
            currentPeaksRef.current = computedPeaks;
            if (!knownDurationRef.current) knownDurationRef.current = computedPeaks.max.length / computedPeaks.rate;
            updateRecordingPeaks(recordingId, computedPeaks).catch(e => console.error('Error saving peaks:', e));
          }

          const audioUrl = URL.createObjectURL(audioBlob);
          if (audioRef.current && audioRef.current.src) {
            const oldUrl = audioRef.current.src;
            if (oldUrl.startsWith('blob:')) URL.revokeObjectURL(oldUrl);
          }

          const audio = new Audio(audioUrl);
          audioRef.current = audio;

          audio.addEventListener('loadedmetadata', () => {
            const audioDuration = audio.duration;
            // MediaRecorder WebM files have no duration header; use the recorded duration
            const finalDuration = (audioDuration && isFinite(audioDuration)) ? audioDuration : (knownDurationRef.current || recordingDuration);
            setLoadedAudioDuration(finalDuration || 0);
            setCurrentPlayTime(audio.currentTime || 0);
            setTrimStart(0);
            setTrimEnd(finalDuration || 0);
          });

          audio.addEventListener('ended', () => {
            setIsPlaying(false);
            setCurrentPlayTime(0);
          });

          audio.addEventListener('error', (e) => console.error('Audio playback error:', e));
          audio.load();
          setCurrentPlayTime(0);
          setStartTime(0);
          setTrimStart(0);
        } catch (error) {
          if (!cancelled) console.error('Error analyzing audio:', error);
        }
      }, 100);
      return () => {
        cancelled = true;
        clearTimeout(timeoutId);
      };
    }
  }, [audioBlob, isRecording, analyzeAudio, clearWaveform]);

  const getTabTitle = async (): Promise<string | null> => {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs.length > 0 && tabs[0].title) return tabs[0].title;
      return null;
    } catch (error) {
      console.error('Error getting tab title:', error);
      return null;
    }
  };

  const handleRecordClick = async () => {
    if (isRecording) {
      try {
        // The offscreen document saves the recording itself; nothing is decoded here
        const saved = await stopRecording({
          name: recordingName || `recording ${formatDate(new Date())}`,
          channelMode: preferences.channelMode || 'stereo'
        });
        if (saved) loadRecording(saved);
        // The length limit may have stopped it just before the click
        else await loadAutoSaved();
      } catch (error: any) {
        console.error('Error saving recording:', error);
        const errorMessage = error?.message || 'Unknown error occurred';
        if (errorMessage.toLowerCase().includes('quota')) {
          alert('Recording could not be saved: browser storage is full. Delete some recordings, then reopen the extension to recover it.');
        } else {
          alert(`Recording could not be saved: ${errorMessage}. The audio is kept and will be recovered the next time you open the extension.`);
        }
      }
    } else {
      if (audioRef.current) {
        audioRef.current.pause();
        if (audioRef.current.src && audioRef.current.src.startsWith('blob:')) {
          URL.revokeObjectURL(audioRef.current.src);
        }
        audioRef.current.src = '';
      }
      clearWaveform();
      setAudioBlob(null);
      setIsPlaying(false);
      setCurrentPlayTime(0);
      setStartTime(0);
      setTrimStart(0);
      setTrimEnd(0);
      setCurrentRecordingChannelMode(undefined);
      setNotice(null);

      let name = `recording ${formatDate(new Date())}`;
      if (preferences.useTabTitle) {
        const tabTitle = await getTabTitle();
        const cleanedTitle = tabTitle?.replace(/[<>:"/\\|?*]/g, '_').trim();
        if (cleanedTitle) name = cleanedTitle;
      }
      setRecordingName(name);

      try {
        await startRecording({ name, channelMode: preferences.channelMode || 'stereo' });
      } catch (error: any) {
        console.error('Failed to start recording:', error);
        alert(`Recording failed: ${error?.message || 'Unknown error'}`);
      }
    }
  };

  useEffect(() => {
    if (isPlaying && audioRef.current) {
      const updatePlayhead = () => {
        if (audioRef.current && isPlaying) {
          const currentTime = audioRef.current.currentTime;
          const duration = audioRef.current.duration;
          const effectiveEnd = (trimEnd > 0 && trimEnd < duration) ? trimEnd : duration;
          const effectiveStart = trimStart > 0 ? trimStart : 0;

          if (currentTime >= effectiveEnd) {
            if (isLooping) {
              audioRef.current.currentTime = effectiveStart;
              setCurrentPlayTime(effectiveStart);
            } else {
              audioRef.current.pause();
              audioRef.current.currentTime = effectiveStart;
              setIsPlaying(false);
              setCurrentPlayTime(effectiveStart);
              return;
            }
          } else {
            setCurrentPlayTime(currentTime);
          }
          playheadAnimationFrameRef.current = requestAnimationFrame(updatePlayhead);
        }
      };
      playheadAnimationFrameRef.current = requestAnimationFrame(updatePlayhead);
      return () => {
        if (playheadAnimationFrameRef.current) cancelAnimationFrame(playheadAnimationFrameRef.current);
      };
    }
  }, [isPlaying, isLooping, trimStart, trimEnd]);

  const handlePlay = async () => {
    if (audioRef.current) {
      try {
        if (isPlaying) {
          audioRef.current.pause();
          setIsPlaying(false);
        } else {
          if (audioRef.current.readyState < 2) audioRef.current.load();
          const effectiveStart = trimStart > 0 ? trimStart : 0;
          const effectiveEnd = (trimEnd > 0 && trimEnd < (audioRef.current.duration || 0)) ? trimEnd : (audioRef.current.duration || 0);

          if (audioRef.current.currentTime < effectiveStart || audioRef.current.currentTime >= effectiveEnd) {
            audioRef.current.currentTime = effectiveStart;
          }
          await audioRef.current.play();
          setIsPlaying(true);
          const isTrimmed = trimStart > 0 || (trimEnd > 0 && trimEnd < audioRef.current.duration);
          audioRef.current.loop = isLooping && !isTrimmed;
        }
      } catch (error) {
        console.error('Playback error:', error);
      }
    }
  };

  const handleLoop = () => {
    setIsLooping(!isLooping);
    if (audioRef.current) {
      const isTrimmed = trimStart > 0 || (trimEnd > 0 && trimEnd < audioRef.current.duration);
      audioRef.current.loop = !isLooping && !isTrimmed;
    }
  };

  const handleReset = () => {
    if (audioRef.current) {
      const effectiveStart = trimStart > 0 ? trimStart : 0;
      audioRef.current.currentTime = effectiveStart;
      setCurrentPlayTime(effectiveStart);
    }
  };

  const handleWaveformSeek = (time: number) => {
    if (audioRef.current && !isRecording) {
      audioRef.current.currentTime = time;
      setCurrentPlayTime(time);
    }
  };

  const [lightVariant, setLightVariant] = useState(0);
  const handleTitleMouseEnter = () => {
    if (theme === 'light') {
      const variants = [0, 1, 2];
      const otherVariants = variants.filter(v => v !== lightVariant);
      const nextVariant = otherVariants[Math.floor(Math.random() * otherVariants.length)];
      setLightVariant(nextVariant);
    }
  };

  const handleZoomIn = useCallback(() => setZoom(z => Math.min(z * 2, 8)), []);
  const handleZoomOut = useCallback(() => setZoom(z => Math.max(z / 2, 1)), []);
  const handleZoomChange = useCallback((multiplier: number) => setZoom(z => Math.max(1, Math.min(10, z * multiplier))), []);

  const handleTrimChange = (start: number, end: number) => {
    setTrimStart(start);
    setTrimEnd(end);
    if (audioRef.current) {
      if (audioRef.current.currentTime < start) {
        audioRef.current.currentTime = start;
        setCurrentPlayTime(start);
      } else if (audioRef.current.currentTime > end) {
        audioRef.current.currentTime = start;
        setCurrentPlayTime(start);
      }
    }
  };

  const handleDownload = async () => {
    if (!audioBlob || isExporting) return;
    const duration = totalDuration;
    const start = trimStart > 0 ? trimStart : undefined;
    const end = trimEnd > 0 && trimEnd < duration ? trimEnd : undefined;

    // Long exports run in their own tab so closing the popup doesn't cancel them
    if (currentRecordingId && shouldExportInTab(duration)) {
      openExportTab({ ids: [currentRecordingId], start, end });
      return;
    }

    setIsExporting(true);
    try {
      const options = await getExportOptions();
      const blob = await exportAudio(audioBlob, { ...options, start, end, duration });
      downloadAudio(blob, exportFilename(recordingName, options.format));
    } catch (error: any) {
      console.error('Error downloading recording:', error);
      alert(`Download failed: ${error?.message || 'Unknown error'}`);
    } finally {
      setIsExporting(false);
    }
  };

  const handleRecordingPauseToggle = async () => {
    try {
      if (isPaused) await resumeRecording();
      else await pauseRecording();
    } catch (error: any) {
      console.error('Error toggling pause:', error);
      alert(`Could not ${isPaused ? 'resume' : 'pause'} recording: ${error?.message || 'Unknown error'}`);
    }
  };

  // Clear the editor without touching storage
  const resetEditor = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      if (audioRef.current.src?.startsWith('blob:')) URL.revokeObjectURL(audioRef.current.src);
      audioRef.current = null;
    }
    setIsPlaying(false);
    setIsLooping(false);
    setCurrentPlayTime(0);
    setTrimStart(0);
    setTrimEnd(0);
    setZoom(1);
    clearWaveform();
    setRecordingName('');
    setAudioBlob(null);
    setRecordingDuration(0);
    setLoadedAudioDuration(0);
    setCurrentRecordingId(null);
    setCurrentRecordingChannelMode(undefined);
    currentPeaksRef.current = undefined;
    knownDurationRef.current = 0;
    chrome.storage.session.remove(['currentRecordingState']);
  };

  const handleDelete = async () => {
    if (isRecording) return;
    const idToDelete = currentRecordingId;
    resetEditor();
    if (idToDelete) {
      try { await deleteRecording(idToDelete); } catch (e) { console.error('Error deleting recording:', e); }
    }
  };

  // A recording was deleted from the list; only clear the editor if it was the open one
  const handleRecordingDeleted = (id: string) => {
    if (id === currentRecordingId) resetEditor();
  };

  const handleThemeToggle = () => {
    const themes: ('light' | 'dark' | 'midnight' | 'forest' | 'rainbow')[] = ['light', 'dark', 'midnight', 'forest', 'rainbow'];
    const nextTheme = themes[(themes.indexOf(theme) + 1) % themes.length];
    setTheme(nextTheme);
    document.body.className = '';
    if (nextTheme !== 'dark') document.body.classList.add(`${nextTheme}-mode`);
    chrome.storage.local.set({ theme: nextTheme });
  };

  const totalDuration = loadedAudioDuration > 0 ? loadedAudioDuration : (isRecording ? recordingDuration : (recordingDuration || 0));
  const effectiveStart = trimStart > 0 ? trimStart : 0;
  const effectiveEnd = (trimEnd > 0 && trimEnd < totalDuration) ? trimEnd : totalDuration;
  const isTrimmedValue = trimStart > 0 || (trimEnd > 0 && trimEnd < totalDuration);
  const displayDuration = isRecording ? recordingDuration : (isTrimmedValue ? effectiveEnd - effectiveStart : totalDuration);
  const displayTime = isRecording ? recordingDuration : (isTrimmedValue ? Math.max(0, currentPlayTime - effectiveStart) : currentPlayTime);
  const displayStartTime = isRecording ? 0 : effectiveStart;
  const remainingRecordingSeconds = Math.max(0, MAX_RECORDING_SECONDS - recordingDuration);

  const getThemeColor = () => {
    switch (theme) {
      case 'light': return '#3b82f6';
      case 'midnight': return '#38bdf8';
      case 'forest': return '#fbbf24';
      case 'rainbow': return '#4ade80';
      default: return '#4ade80';
    }
  };

  return (
    <div className={`popup-container ${theme !== 'dark' ? `${theme}-mode` : ''}`} style={{ position: 'relative' }}>
      <header className="header">
        <h1 className={`app-title ${theme === 'light' ? `variant-${lightVariant}` : ''}`} aria-label="Chrome Recorder" onMouseEnter={handleTitleMouseEnter}>
          {"Chrome Recorder".split("").map((char, i) => (
            <span key={i} style={{ "--index": i } as React.CSSProperties}>{char === " " ? "\u00A0" : char}</span>
          ))}
        </h1>
        <div className="header-actions">
          <button className="icon-button" title={`Current Theme: ${theme.charAt(0).toUpperCase() + theme.slice(1)}`} onClick={handleThemeToggle}>
            {theme === 'light' ? (
              <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" clipRule="evenodd" /></svg>
            ) : theme === 'midnight' ? (
              <svg width="20" height="20" viewBox="0 0 512 512" fill="currentColor"><path d="M471,79.483c-12.212-6.551-22.696-15.974-30.534-27.339l-13.796-20l-13.797,20c-7.839,11.365-18.33,20.788-30.542,27.339c-12.212,6.56-26.11,10.271-41,10.28c-14.89-0.009-28.78-3.72-41-10.28c-12.204-6.551-22.694-15.974-30.534-27.339l-13.796-20l-13.797,20c-7.839,11.365-18.33,20.788-30.533,27.339c-12.22,6.56-26.11,10.271-41,10.28c-14.89-0.009-28.788-3.72-41-10.28c-12.212-6.551-22.703-15.974-30.543-27.339l-13.796-20l-13.796,20C63.694,63.509,53.212,72.932,41,79.483c-12.212,6.56-26.11,10.271-41,10.28v33.517c20.509,0.009,39.94-5.161,56.864-14.263c10.534-5.66,20.119-12.839,28.466-21.236c8.356,8.398,17.932,15.576,28.466,21.236c16.932,9.102,36.356,14.272,56.873,14.263c20.508,0.009,39.932-5.161,56.864-14.263c10.534-5.66,20.119-12.839,28.466-21.236c8.347,8.398,17.932,15.576,28.466,21.236c16.932,9.102,36.355,14.272,56.864,14.263c20.517,0.009,39.94-5.161,56.873-14.263c10.534-5.66,20.11-12.839,28.466-21.236c8.347,8.398,17.932,15.576,28.466,21.236c16.924,9.102,36.355,14.272,56.864,14.263V89.763C497.11,89.754,483.212,86.043,471,79.483z" /><path d="M440.466,230.432l-13.796-20l-13.797,20c-7.839,11.365-18.33,20.78-30.542,27.339c-12.212,6.56-26.11,10.271-41,10.271s-28.78-3.712-41-10.271c-12.204-6.559-22.694-15.974-30.534-27.339l-13.796-20l-13.797,20c-7.839,11.365-18.33,20.78-30.533,27.339c-12.22,6.56-26.11,10.271-41,10.271c-14.89,0-28.788-3.712-41-10.271c-12.212-6.559-22.703-15.974-30.543-27.339l-13.796-20l-13.796,20c-7.84,11.365-18.322,20.78-30.534,27.339c-12.212,6.56-26.11,10.271-41,10.271v33.526c20.509,0,39.94-5.17,56.864-14.263c10.534-5.66,20.119-12.838,28.466-21.245c8.356,8.407,17.932,15.585,28.466,21.245c16.932,9.094,36.356,14.263,56.873,14.263c20.508,0,39.932-5.17,56.864-14.263c10.534-5.66,20.119-12.838,28.466-21.245c8.347,8.407,17.932,15.585,28.466,21.245c16.932,9.094,36.355,14.263,56.864,14.263c20.517,0,39.94-5.17,56.873-14.263c10.534-5.66,20.11-12.838,28.466-21.245c8.347,8.407,17.932,15.585,28.466,21.245c16.924,9.094,36.355,14.263,56.864,14.263v-33.526c-14.89,0-28.788-3.712-41-10.271C458.788,251.212,448.304,241.797,440.466,230.432z" /><path d="M440.466,408.721l-13.796-20l-13.797,20c-7.839,11.364-18.33,20.78-30.542,27.338c-12.212,6.56-26.11,10.271-41,10.271s-28.78-3.712-41-10.271c-12.204-6.559-22.694-15.974-30.534-27.338l-13.796-20l-13.797,20c-7.839,11.364-18.33,20.78-30.533,27.338c-12.22,6.56-26.11,10.271-41,10.271c-14.89,0-28.788-3.712-41-10.271c-12.212-6.559-22.703-15.974-30.543-27.338l-13.796-20l-13.796,20C63.694,420.085,53.212,429.5,41,436.059c-12.212,6.56-26.11,10.271-41,10.271v33.526c20.509,0,39.94-5.17,56.864-14.271c10.534-5.662,20.119-12.83,28.466-21.238c8.356,8.407,17.932,15.576,28.466,21.238c16.932,9.101,36.356,14.271,56.873,14.271c20.508,0,39.932-5.17,56.864-14.271c10.534-5.662,20.119-12.83,28.466-21.238c8.347,8.407,17.932,15.576,28.466,21.238c16.932,9.101,36.355,14.271,56.864,14.271c20.517,0,39.94-5.17,56.873-14.271c10.534-5.662,20.11-12.83,28.466-21.238c8.347,8.407,17.932,15.576,28.466,21.238c16.924,9.101,36.355,14.271,56.864,14.271V446.33c-14.89,0-28.788-3.712-41-10.271C458.788,429.5,448.304,420.085,440.466,408.721z" /></svg>
            ) : theme === 'forest' ? (
              <svg width="20" height="20" viewBox="0 0 512 512" fill="currentColor"><path d="M465.771,234.587c0-26.914-10.749-51.289-28.142-69.166c0.629-4.688,1.075-9.437,1.075-14.301c0-54.151-40.625-98.726-93.05-105.14C319.308,17.754,281.874,0,240.206,0C160.476,0,95.853,64.624,95.853,144.361c0,0.422,0.062,0.821,0.062,1.236c-29.975,20.27-49.686,54.58-49.686,93.494c0,53.346,37.08,97.937,86.842,109.667c10.089,24.69,34.318,42.106,62.636,42.106c10.557,0,20.508-2.486,29.407-6.798V512h77.528v-83.988l30.236-51.657c30.95-2.256,57.097-21.766,68.743-49.033C439.087,313.128,465.771,277.022,465.771,234.587z M260.615,342.229c0.66,0.928,1.343,1.826,2.041,2.724l-3.43,1.396C259.725,344.984,260.208,343.625,260.615,342.229z M284.874,405.402v-40.579c7.181,4.366,15.076,7.642,23.492,9.622L284.874,405.402z" /></svg>
            ) : theme === 'rainbow' ? (
              <svg width="20" height="20" viewBox="0 0 256 256" fill="currentColor"><path d="M256,172v8a12,12,0,0,1-24,0v-8a104,104,0,0,0-208,0v8a12,12,0,0,1-24,0v-8a128,128,0,0,1,256,0ZM128,140a36.04061,36.04061,0,0,0-36,36v4a12,12,0,0,0,24,0v-4a12,12,0,0,1,24,0v4a12,12,0,0,0,24,0v-4A36.04061,36.04061,0,0,0,128,140Zm0-48a84.0953,84.0953,0,0,0-84,84v4a12,12,0,0,0,24,0v-4a60,60,0,0,1,120,0v4a12,12,0,0,0,24,0v-4A84.0953,84.0953,0,0,0,128,92Z" /></svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" /></svg>
            )}
          </button>
        </div>
      </header>

      <nav className="tabs">
        <button className={`tab ${activeTab === 'recording' ? 'active' : ''}`} onClick={() => setActiveTab('recording')}>
          Recording {isRecording && <span className="recording-indicator"></span>}
        </button>
        <button className={`tab ${activeTab === 'recent' ? 'active' : ''}`} onClick={() => setActiveTab('recent')}>My Recordings</button>
        <button className={`tab ${activeTab === 'preferences' ? 'active' : ''}`} onClick={() => setActiveTab('preferences')}>Settings</button>
      </nav>

      {activeTab === 'recording' && (
        <div className="recording-content">
          {recordingName && (
            <AudioInfo
              recordingName={recordingName}
              timestamp={recordingTimestamp}
              onDownload={audioBlob && !isExporting ? handleDownload : undefined}
              onDelete={audioBlob ? handleDelete : undefined}
              onNameChange={async (newName) => {
                setRecordingName(newName);
                if (currentRecordingId) {
                  try {
                    const format = preferences.format || DEFAULT_AUDIO_FORMAT;
                    const updatedName = newName.endsWith(`.${getFileExtension(format)}`) ? newName : `${newName}.${getFileExtension(format)}`;
                    await updateRecordingName(currentRecordingId, updatedName);
                  } catch (e) { }
                }
              }}
            />
          )}

          <div className="waveform-container">
            <Waveform
              data={waveformData?.data || null}
              height={110}
              zoom={zoom}
              currentTime={isRecording ? recordingDuration : currentPlayTime}
              duration={isRecording ? recordingDuration : totalDuration}
              onSeek={handleWaveformSeek}
              isRecording={isRecording}
              channelMode={currentRecordingChannelMode || (preferences.channelMode as 'mono' | 'stereo' | undefined)}
              barColor={getThemeColor()}
              backgroundColor={theme === 'light' ? '#f5f5f5' : theme === 'midnight' ? '#1e293b' : theme === 'forest' ? '#064e3b' : theme === 'rainbow' ? '#1a1a1a' : '#1f1f1f'}
              theme={theme}
              trimStart={trimStart}
              trimEnd={trimEnd}
              onTrimChange={handleTrimChange}
              liveDataRef={liveWaveformDataRef}
              onZoomChange={handleZoomChange}
            />
          </div>

          {!isRecording && audioBlob && (
            <div className="playback-info">
              <span className="playback-hint">Click to Seek • Scroll to Pan & Zoom</span>
            </div>
          )}

          <div className="time-indicators">
            <span className="time-label">time {formatTime(displayTime)}</span>
            <span className="time-label">start {formatTime(displayStartTime)}</span>
            <span className="time-label">length {formatTime(displayDuration)}</span>
          </div>

          {isRecording && remainingRecordingSeconds <= LIMIT_WARNING_SECONDS && (
            <div className="recording-notice">
              auto-stops in {formatTime(remainingRecordingSeconds)} ({MAX_RECORDING_SECONDS / 60}-minute limit)
            </div>
          )}
          {!isRecording && notice && (
            <div className="recording-notice">{notice}</div>
          )}

          <RecordingControls
            onZoomIn={handleZoomIn}
            onZoomOut={handleZoomOut}
            onPlay={isRecording ? handleRecordingPauseToggle : handlePlay}
            onPause={isRecording ? handleRecordingPauseToggle : handlePlay}
            onLoop={handleLoop}
            onReset={handleReset}
            isPlaying={isRecording ? !isPaused : isPlaying}
            isLooping={isLooping}
            isRecording={isRecording}
            zoom={zoom}
          />

          <div className="record-button-container">
            <RecordButton isRecording={isRecording} onClick={handleRecordClick} />
          </div>
        </div>
      )}

      {activeTab === 'recent' && (
        <div className="recent-recordings-wrapper">
          <RecentRecordings
            onSelectRecording={(recording) => {
              loadRecording(recording);
              setActiveTab('recording');
            }}
            onDeleteRecording={handleRecordingDeleted}
          />
        </div>
      )}

      {activeTab === 'preferences' && (
        <div className="preferences-wrapper">
          <Preferences />
        </div>
      )}

      {activeTab !== 'recent' && (
        <>
          <button className="bug-report-button" onClick={() => window.open('https://docs.google.com/forms/d/e/1FAIpQLSd79vPaXs_-SwoEScobWGNgQu3aRSkc7i0IpTmNQpxuKxVrRg/viewform', '_blank')} title="Submit a bug report">
            Report a bug 🐞
          </button>
          <button className="buy-coffee-button" onClick={() => window.open('https://buymeacoffee.com/TheUglyAlpaca', '_blank')} title="Support the developer">
            Buy me a coffee ☕
          </button>
        </>
      )}
    </div>
  );
};

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<Popup />);
}

export default Popup;
