// Diagnostics for bug reports: a rolling log of recent errors and key events, plus a snapshot of the
// environment, capabilities, recording state and storage.
// Never includes audio, recording names, tab titles or page content (names often come from tab titles).
import {
  getAllRecordingsMetadata,
  getPendingRecoverySummary,
  getStorageUsage,
  LIVE_LEVELS_PER_SECOND,
  MAX_RECORDING_SECONDS,
  PEAKS_PER_SECOND
} from './storageManager';

const LOG_KEY = 'diagnosticsLog';
const MAX_ENTRIES = 50;
const MAX_MESSAGE_LENGTH = 500;

export type DiagnosticLevel = 'error' | 'info';

export interface DiagnosticEntry {
  time: string;
  context: string;
  message: string;
  level?: DiagnosticLevel; // absent on entries written before levels existed (errors)
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.slice(0, MAX_MESSAGE_LENGTH);
}

// Append to the log. Must run where chrome.storage is available (popup, export tab, background).
export async function appendDiagnostic(context: string, message: string, level: DiagnosticLevel = 'error'): Promise<void> {
  const result = await chrome.storage.local.get([LOG_KEY]);
  const entries: DiagnosticEntry[] = result[LOG_KEY] || [];
  entries.push({ time: new Date().toISOString(), context, message: message.slice(0, MAX_MESSAGE_LENGTH), level });
  await chrome.storage.local.set({ [LOG_KEY]: entries.slice(-MAX_ENTRIES) });
}

function record(context: string, message: string, level: DiagnosticLevel) {
  try {
    if (chrome.storage?.local) {
      appendDiagnostic(context, message, level).catch(() => { });
    } else {
      // The offscreen document has no chrome.storage; the background writes for it
      chrome.runtime.sendMessage({ action: 'logDiagnostic', context, message, level }).catch(() => { });
    }
  } catch {
    // Diagnostics must never break the caller
  }
}

// Log an error to the console and the diagnostics log
export function logError(context: string, error: unknown): void {
  console.error(`${context}:`, error);
  record(context, errorMessage(error), 'error');
}

// Log a notable event (recording started/saved, export finished...). Keep messages free of names.
export function logEvent(context: string, message: string): void {
  record(context, message, 'info');
}

// Record uncaught errors from a page
export function installErrorCapture(page: string): void {
  window.addEventListener('error', (event) => logError(`${page}: uncaught error`, event.error || event.message));
  window.addEventListener('unhandledrejection', (event) => logError(`${page}: unhandled rejection`, event.reason));
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function formatSeconds(seconds: number): string {
  if (!(seconds >= 0)) return 'unknown';
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `${seconds.toFixed(1)}s`;
  const rest = seconds % 60;
  return rest < 0.05 ? `${minutes}m` : `${minutes}m ${rest.toFixed(1)}s`;
}

// Run one section; a failure is reported in the section instead of aborting the report
async function section(lines: string[], title: string, fill: (add: (label: string, value: unknown) => void) => Promise<void> | void) {
  lines.push('', `[${title}]`);
  const add = (label: string, value: unknown) => lines.push(`${label}: ${value}`);
  try {
    await fill(add);
  } catch (error) {
    add('unavailable', errorMessage(error));
  }
}

async function supported(check: () => Promise<boolean> | boolean): Promise<string> {
  try {
    return (await check()) ? 'yes' : 'no';
  } catch (error) {
    return `no (${errorMessage(error)})`;
  }
}

// Plain-text summary for pasting into a bug report
export async function buildDiagnosticsReport(): Promise<string> {
  const now = new Date();
  const lines: string[] = [
    '--- Chrome Recorder diagnostics ---',
    'Contains no audio, recording names, tab titles or page content.',
    `Generated: ${now.toISOString()} (UTC offset ${-now.getTimezoneOffset() / 60}h)`
  ];

  await section(lines, 'Extension', (add) => {
    const manifest = chrome.runtime.getManifest();
    add('Version', manifest.version);
    add('Minimum Chrome', manifest.minimum_chrome_version || 'none');
    add('Recording limit', formatSeconds(MAX_RECORDING_SECONDS));
    add('Waveform resolution', `${PEAKS_PER_SECOND}/s stored, ${LIVE_LEVELS_PER_SECOND}/s live`);
  });

  await section(lines, 'Browser and OS', async (add) => {
    add('User agent', navigator.userAgent);
    const uaData = (navigator as any).userAgentData;
    if (uaData) {
      const details = await uaData.getHighEntropyValues(['platformVersion', 'architecture', 'bitness', 'fullVersionList', 'model']);
      const chromeVersion = (details.fullVersionList || []).find((b: any) => /Chrom/.test(b.brand) && !/Not/.test(b.brand));
      add('Chrome', chromeVersion ? `${chromeVersion.brand} ${chromeVersion.version}` : 'unknown');
      add('Platform', `${uaData.platform} ${details.platformVersion || ''}`.trim());
      add('Architecture', `${details.architecture || 'unknown'} ${details.bitness ? `${details.bitness}-bit` : ''}`.trim());
      if (details.model) add('Device model', details.model);
    }
    add('Language', navigator.language);
  });

  await section(lines, 'Device', async (add) => {
    add('Memory', (navigator as any).deviceMemory ? `${(navigator as any).deviceMemory} GB (approximate)` : 'unknown');
    add('CPU cores', navigator.hardwareConcurrency || 'unknown');
    add('Screen scale', window.devicePixelRatio);
    const context = new AudioContext();
    add('Audio output sample rate', `${context.sampleRate} Hz`);
    await context.close();
  });

  await section(lines, 'Capabilities', async (add) => {
    add('MediaRecorder Opus/WebM', await supported(() => MediaRecorder.isTypeSupported('audio/webm;codecs=opus')));
    add('AudioWorklet', await supported(() => typeof AudioWorkletNode !== 'undefined'));
    add('WebCodecs decode (Opus)', await supported(async () =>
      typeof AudioDecoder !== 'undefined' && !!(await AudioDecoder.isConfigSupported({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2 })).supported));
    add('WebCodecs encode (Opus)', await supported(async () =>
      typeof AudioEncoder !== 'undefined' && !!(await AudioEncoder.isConfigSupported({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 })).supported));
    add('Web Locks', await supported(() => !!(navigator as any).locks));
    add('Persistent storage', await supported(async () => !!navigator.storage?.persisted && await navigator.storage.persisted()));
  });

  await section(lines, 'Recording state', async (add) => {
    const state = await chrome.runtime.sendMessage({ action: 'getRecordingState' });
    add('Recording now', state?.isRecording ? (state.isPaused ? 'yes (paused)' : 'yes') : 'no');
    if (state?.isRecording && state.startTime) {
      const pausedMs = (state.pausedTotal || 0) + (state.pausedAt ? Date.now() - state.pausedAt : 0);
      add('Recorded so far', formatSeconds((Date.now() - state.startTime - pausedMs) / 1000));
    }
    const pending = await getPendingRecoverySummary();
    add('Interrupted recordings awaiting recovery', `${pending.sessions} (${pending.chunks} chunks, ${formatBytes(pending.bytes)})`);
    add('Legacy v1.0.5 temp recording', pending.legacyTempBytes ? formatBytes(pending.legacyTempBytes) : 'none');
    const { autoSavedRecordingId, autoSavedReason } = await chrome.storage.local.get(['autoSavedRecordingId', 'autoSavedReason']);
    add('Auto-saved recording not yet opened', autoSavedRecordingId ? `yes (${autoSavedReason || 'unknown reason'})` : 'no');
  });

  await section(lines, 'Recordings and storage', async (add) => {
    const recordings = await getAllRecordingsMetadata();
    const totalSize = recordings.reduce((sum, r) => sum + (r.size || 0), 0);
    const durations = recordings.map(r => r.duration || 0);
    const formats: Record<string, number> = {};
    for (const r of recordings) formats[r.format || 'unknown'] = (formats[r.format || 'unknown'] || 0) + 1;
    add('Recordings', `${recordings.length} (${formatBytes(totalSize)})`);
    add('Stored formats', Object.entries(formats).map(([f, n]) => `${f}: ${n}`).join(', ') || 'none');
    add('Longest', formatSeconds(Math.max(0, ...durations)));
    add('Total length', formatSeconds(durations.reduce((a, b) => a + b, 0)));
    const { used, quota } = await getStorageUsage();
    add('Storage', `${formatBytes(used)} used of ${formatBytes(quota)}`);
  });

  await section(lines, 'Settings', async (add) => {
    const { preferences, theme } = await chrome.storage.local.get(['preferences', 'theme']);
    add('Preferences', JSON.stringify(preferences || {}));
    add('Theme', theme || 'dark');
  });

  await section(lines, 'Recent activity (oldest first)', async (add) => {
    const result = await chrome.storage.local.get([LOG_KEY]);
    const entries: DiagnosticEntry[] = result[LOG_KEY] || [];
    if (entries.length === 0) {
      add('Entries', 'none');
      return;
    }
    const errors = entries.filter(e => (e.level || 'error') === 'error').length;
    add('Entries', `${entries.length} (${errors} errors)`);
    for (const entry of entries) {
      lines.push(`  ${entry.time} ${(entry.level || 'error') === 'error' ? 'ERROR' : 'info '} [${entry.context}] ${entry.message}`);
    }
  });

  return lines.join('\n');
}
