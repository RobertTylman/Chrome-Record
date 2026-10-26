import { appendRecordingChunk, finalizeRecordingSession, MAX_RECORDING_SECONDS, PEAKS_PER_SECOND, RecordingMetadata } from '../popup/utils/storageManager';

// Offscreen document: owns the MediaRecorder and persists audio to IndexedDB every second,
// so a recording survives a service worker restart, popup crash or browser crash.

const CHUNK_INTERVAL_MS = 1000;
const AUDIO_BITS_PER_SECOND = 128000;

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
  waveformInterval: number;
  details: RecordingDetails;
  peakCount: number;
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

// Stop and save when the recording reaches MAX_RECORDING_SECONDS, then tell the background and popup
async function stopAtLimit(current: RecordingSession) {
  if (current.stopping) return;
  try {
    const recording = await stopRecording(current.details);
    chrome.runtime.sendMessage({ action: 'recordingLimitReached', recording }).catch(() => { });
  } catch (error: any) {
    console.error('Failed to save recording at length limit:', error);
    chrome.runtime.sendMessage({ action: 'recordingLimitReached', error: error?.message || String(error) }).catch(() => { });
  }
}

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
    current.limitTimer = window.setTimeout(() => stopAtLimit(current), remainingMs);
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
      processorOptions: { windowSize: Math.round(audioCtx.sampleRate / PEAKS_PER_SECOND) }
    });
    source.connect(peakNode);
    // Output is silent; connecting it keeps the node processing
    peakNode.connect(audioCtx.destination);
  } catch (error) {
    console.error('Peak meter unavailable, waveform will be computed after recording:', error);
  }

  const recorder = new MediaRecorder(media, {
    mimeType: 'audio/webm;codecs=opus',
    audioBitsPerSecond: AUDIO_BITS_PER_SECOND
  });

  // Live waveform for the popup
  const waveformInterval = window.setInterval(() => {
    if (recorder.state === 'recording') {
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(dataArray);
      chrome.runtime.sendMessage({
        action: 'waveformUpdate',
        data: Array.from(dataArray)
      }).catch(() => { /* popup closed */ });
    }
  }, 16); // ~60 FPS

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
    waveformInterval,
    details,
    peakCount: 0,
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
      pendingMax.push(toByte(event.data.max));
      pendingAvg.push(toByte(event.data.avg));
      if (++current.peakCount >= maxPeaks) stopAtLimit(current);
    };
  } else {
    updateFallbackLimit(current, false);
  }

  // Chunks are written in order through a single promise chain
  recorder.ondataavailable = (event) => {
    const chunk = {
      sessionId: current.id,
      seq: current.seq++,
      audio: event.data,
      peakMax: Uint8Array.from(current.pendingMax.splice(0)),
      peakAvg: Uint8Array.from(current.pendingAvg.splice(0))
    };
    current.writeChain = current.writeChain
      .then(() => appendRecordingChunk(chunk))
      .catch((error) => {
        console.error('Failed to persist recording chunk:', error);
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

  clearInterval(current.waveformInterval);
  current.media.getTracks().forEach((t) => t.stop());
  current.audioCtx.close().catch(() => { });

  if (current.writeError) {
    console.error('Some chunks failed to save; saving what was stored');
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
