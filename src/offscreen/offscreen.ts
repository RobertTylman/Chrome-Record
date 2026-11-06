import { logError } from '../popup/utils/diagnostics';
import { appendRecordingChunk, finalizeRecordingSession, LIVE_LEVELS_PER_SECOND, MAX_RECORDING_SECONDS, PEAKS_PER_SECOND, RecordingMetadata } from '../popup/utils/storageManager';

// Offscreen document: owns the MediaRecorder and persists audio to IndexedDB every second,
// so a recording survives a service worker restart, popup crash or browser crash.

const CHUNK_INTERVAL_MS = 1000;
const AUDIO_BITS_PER_SECOND = 128000;

// Live waveform: recent loudness levels (LIVE_LEVELS_PER_SECOND), streamed to the popup
const LIVE_LEVELS_SENT = LIVE_LEVELS_PER_SECOND * 6; // enough history to fill the view when the popup opens
const LIVE_LEVELS_KEPT = LIVE_LEVELS_SENT * 2;
const LIVE_WAVEFORM_INTERVAL_MS = 16; // ~60 FPS

type AutoStopReason = 'limit' | 'ended';

interface RecordingDetails {
  name?: string;
  channelMode?: string;
}

interface RecordingSession {
  id: string;
  seq: number;
  startedAt: number;
  recorder: MediaRecorder;
  media: MediaStream;
  audioCtx: AudioContext;
  peakNode: AudioWorkletNode | null;
  pendingMax: number[];
  pendingAvg: number[];
  writeChain: Promise<void>;
  writeError: unknown;
  analyser: AnalyserNode;
  details: RecordingDetails;
  peakCount: number;
  // Recent levels (0-255) for the live waveform: peak and average per window, and how many
  // have been produced in total
  levels: number[];
  avgLevels: number[];
  loudestLevel: number; // loudest live level of the whole recording, for a stable display scale
  levelCount: number;
  stopping: Promise<RecordingMetadata | null> | null;
  // Fallback length limit when the peak meter is unavailable
  limitTimer: number | null;
  activeMs: number;
  resumedAt: number | null;
}

let session: RecordingSession | null = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return;

  if (message.type === 'START_RECORDING') {
    startRecording(message.streamId, message.sessionId, message.details || {})
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'STOP_RECORDING') {
    stopRecording(message.details || {})
      .then((recording) => sendResponse({ success: true, recording }))
      .catch((err) => sendResponse({ success: false, error: err?.message || String(err) }));
    return true;
  }

  if (message.type === 'PAUSE_RECORDING' || message.type === 'RESUME_RECORDING') {
    const pause = message.type === 'PAUSE_RECORDING';
    if (session && !session.stopping) {
      if (pause && session.recorder.state === 'recording') session.recorder.pause();
      if (!pause && session.recorder.state === 'paused') session.recorder.resume();
      session.peakNode?.port.postMessage(pause ? 'pause' : 'resume');
      updateFallbackLimit(session, pause);
    }
    sendResponse({ success: !!session });
  }
});

function toByte(value: number): number {
  return Math.min(255, Math.round(value * 255));
}

// Stop and save without the popup — at the length limit, or when the captured tab closes —
// then tell the background and popup
async function autoStop(current: RecordingSession, reason: AutoStopReason) {
  if (current.stopping) return;
  try {
    const recording = await stopRecording(current.details);
    chrome.runtime.sendMessage({ action: 'recordingAutoStopped', reason, recording }).catch(() => { });
  } catch (error: any) {
    logError(`Recorder: save after auto-stop (${reason})`, error);
    chrome.runtime.sendMessage({ action: 'recordingAutoStopped', reason, error: error?.message || String(error) }).catch(() => { });
  }
}

function pushLevel(current: RecordingSession, max: number, avg: number) {
  current.levels.push(max);
  current.avgLevels.push(avg);
  if (max > current.loudestLevel) current.loudestLevel = max;
  current.levelCount++;
  if (current.levels.length > LIVE_LEVELS_KEPT) {
    current.levels.splice(0, current.levels.length - LIVE_LEVELS_SENT);
    current.avgLevels.splice(0, current.avgLevels.length - LIVE_LEVELS_SENT);
  }
}

// The popup opens a port while it is showing a recording in progress
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'waveform') return;
  const samples = new Float32Array(2048);
  let lastSentCount = -1;
  const interval = window.setInterval(() => {
    if (!session || session.recorder.state !== 'recording') return;
    // Without the peak meter, measure the level here from the analyser instead
    if (!session.peakNode) {
      session.analyser.getFloatTimeDomainData(samples);
      let max = 0;
      let sum = 0;
      for (let i = 0; i < samples.length; i++) {
        const abs = Math.abs(samples[i]);
        max = Math.max(max, abs);
        sum += abs;
      }
      pushLevel(session, toByte(max), toByte(sum / samples.length));
    }
    if (session.levelCount === lastSentCount) return;
    // History on the first send, then only the levels produced since
    const fresh = lastSentCount < 0 ? LIVE_LEVELS_SENT : session.levelCount - lastSentCount;
    lastSentCount = session.levelCount;
    const count = Math.min(fresh, LIVE_LEVELS_SENT);
    port.postMessage({
      levels: session.levels.slice(-count),
      avgLevels: session.avgLevels.slice(-count),
      loudest: session.loudestLevel,
      total: session.levelCount
    });
  }, LIVE_WAVEFORM_INTERVAL_MS);
  port.onDisconnect.addListener(() => clearInterval(interval));
});

function updateFallbackLimit(current: RecordingSession, pause: boolean) {
  if (current.peakNode) return;
  const now = Date.now();
  if (pause && current.resumedAt !== null) {
    current.activeMs += now - current.resumedAt;
    current.resumedAt = null;
    if (current.limitTimer) clearTimeout(current.limitTimer);
    current.limitTimer = null;
  } else if (!pause && current.resumedAt === null) {
    current.resumedAt = now;
    const remainingMs = Math.max(0, MAX_RECORDING_SECONDS * 1000 - current.activeMs);
    current.limitTimer = window.setTimeout(() => autoStop(current, 'limit'), remainingMs);
  }
}

async function startRecording(streamId: string, sessionId: string, details: RecordingDetails) {
  if (session) {
    throw new Error('Called startRecording while already recording');
  }

  const media = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    } as any,
    video: false
  });

  // Continue to play the captured audio to the user.
  const audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(media);
  source.connect(audioCtx.destination);

  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.8;
  source.connect(analyser);

  const pendingMax: number[] = [];
  const pendingAvg: number[] = [];

  // Waveform peaks are measured on the audio thread so they stay sample-accurate for long recordings
  let peakNode: AudioWorkletNode | null = null;
  try {
    await audioCtx.audioWorklet.addModule(chrome.runtime.getURL('peak-worklet.js'));
    peakNode = new AudioWorkletNode(audioCtx, 'peak-meter', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      processorOptions: {
        windowSize: Math.round(audioCtx.sampleRate / PEAKS_PER_SECOND),
        liveWindowSize: Math.round(audioCtx.sampleRate / LIVE_LEVELS_PER_SECOND)
      }
    });
    source.connect(peakNode);
    // Output is silent; connecting it keeps the node processing
    peakNode.connect(audioCtx.destination);
  } catch (error) {
    logError('Recorder: peak meter unavailable, waveform will be computed after recording', error);
  }

  const recorder = new MediaRecorder(media, {
    mimeType: 'audio/webm;codecs=opus',
    audioBitsPerSecond: AUDIO_BITS_PER_SECOND
  });

  const current: RecordingSession = {
    id: sessionId,
    seq: 0,
    startedAt: Date.now(),
    recorder,
    media,
    audioCtx,
    peakNode,
    pendingMax,
    pendingAvg,
    writeChain: Promise.resolve(),
    writeError: null,
    analyser,
    details,
    peakCount: 0,
    levels: [],
    avgLevels: [],
    loudestLevel: 0,
    levelCount: 0,
    stopping: null,
    limitTimer: null,
    activeMs: 0,
    resumedAt: null
  };

  if (peakNode) {
    // Each peak window is 1/PEAKS_PER_SECOND s of recorded audio, so the count is an exact
    // clock that excludes paused time
    const maxPeaks = MAX_RECORDING_SECONDS * PEAKS_PER_SECOND;
    peakNode.port.onmessage = (event) => {
      const max = toByte(event.data.max);
      const avg = toByte(event.data.avg);
      if (event.data.live) {
        pushLevel(current, max, avg);
        return;
      }
      pendingMax.push(max);
      pendingAvg.push(avg);
      if (++current.peakCount >= maxPeaks) autoStop(current, 'limit');
    };
  } else {
    updateFallbackLimit(current, false);
  }

  // The stream ends when the captured tab is closed (or capture is otherwise revoked)
  media.getAudioTracks().forEach((track) => {
    track.addEventListener('ended', () => autoStop(current, 'ended'));
  });

  // Chunks are written in order through a single promise chain
  recorder.ondataavailable = (event) => {
    const chunk = {
      sessionId: current.id,
      seq: current.seq++,
      audio: event.data,
      peakMax: Uint8Array.from(current.pendingMax.splice(0)),
      peakAvg: Uint8Array.from(current.pendingAvg.splice(0)),
      peakRate: PEAKS_PER_SECOND
    };
    current.writeChain = current.writeChain
      .then(() => appendRecordingChunk(chunk))
      .catch((error) => {
        logError('Recorder: persist chunk', error);
        current.writeError = error;
      });
  };

  session = current;
  recorder.start(CHUNK_INTERVAL_MS);
}

// Safe to call more than once (manual stop racing the length limit); later calls share the result
function stopRecording(details: RecordingDetails): Promise<RecordingMetadata | null> {
  const current = session;
  if (!current) return Promise.resolve(null);
  if (!current.stopping) current.stopping = finishRecording(current, details);
  return current.stopping;
}

async function finishRecording(current: RecordingSession, details: RecordingDetails): Promise<RecordingMetadata | null> {
  if (current.limitTimer) clearTimeout(current.limitTimer);

  // dataavailable (the final chunk) fires before stop
  if (current.recorder.state !== 'inactive') {
    await new Promise<void>((resolve) => {
      current.recorder.onstop = () => resolve();
      current.recorder.stop();
    });
  }
  await current.writeChain;

  current.media.getTracks().forEach((t) => t.stop());
  current.audioCtx.close().catch(() => { });

  if (current.writeError) {
    logError('Recorder', 'Some chunks failed to save; saving what was stored');
  }

  try {
    return await finalizeRecordingSession(current.id, {
      name: details.name || current.details.name || `recording ${new Date(current.startedAt).toLocaleString()}`,
      channelMode: details.channelMode || current.details.channelMode,
      timestamp: new Date(current.startedAt).toISOString(),
      fallbackDuration: (Date.now() - current.startedAt) / 1000
    });
  } finally {
    if (session === current) session = null;
  }
}
