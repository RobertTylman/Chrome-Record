// Diagnostics for bug reports: a short rolling log of recent errors plus environment details.
// Holds no audio and no recording contents — only error messages, versions and settings.
import { getAllRecordingsMetadata, getStorageUsage } from './storageManager';

const LOG_KEY = 'diagnosticsLog';
const MAX_ENTRIES = 25;
const MAX_MESSAGE_LENGTH = 500;

export interface DiagnosticEntry {
  time: string;
  context: string;
  message: string;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_MESSAGE_LENGTH);
}

// Append to the log. Must run where chrome.storage is available (popup, export tab, background).
export async function appendDiagnostic(context: string, message: string): Promise<void> {
  const result = await chrome.storage.local.get([LOG_KEY]);
  const entries: DiagnosticEntry[] = result[LOG_KEY] || [];
  entries.push({ time: new Date().toISOString(), context, message: message.slice(0, MAX_MESSAGE_LENGTH) });
  await chrome.storage.local.set({ [LOG_KEY]: entries.slice(-MAX_ENTRIES) });
}

// Log an error to the console and the diagnostics log. The offscreen document has no
// chrome.storage, so it forwards entries to the background.
export function logError(context: string, error: unknown): void {
  console.error(`${context}:`, error);
  const message = errorMessage(error);
  try {
    if (chrome.storage?.local) {
      appendDiagnostic(context, message).catch(() => { });
    } else {
      chrome.runtime.sendMessage({ action: 'logDiagnostic', context, message }).catch(() => { });
    }
  } catch {
    // Diagnostics must never break the caller
  }
}

// Record uncaught errors from a page
export function installErrorCapture(page: string): void {
  window.addEventListener('error', (event) => logError(`${page}: uncaught error`, event.error || event.message));
  window.addEventListener('unhandledrejection', (event) => logError(`${page}: unhandled rejection`, event.reason));
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Plain-text summary for pasting into a bug report
export async function buildDiagnosticsReport(): Promise<string> {
  const lines: string[] = ['--- Chrome Recorder diagnostics ---'];
  lines.push(`Extension version: ${chrome.runtime.getManifest().version}`);
  lines.push(`Browser: ${navigator.userAgent}`);
  const platform = (navigator as any).userAgentData?.platform;
  if (platform) lines.push(`Platform: ${platform}`);

  try {
    const { preferences } = await chrome.storage.local.get(['preferences']);
    lines.push(`Settings: ${JSON.stringify(preferences || {})}`);
  } catch { /* ignore */ }

  try {
    const recordings = await getAllRecordingsMetadata();
    const totalSize = recordings.reduce((sum, r) => sum + (r.size || 0), 0);
    const longest = recordings.reduce((max, r) => Math.max(max, r.duration || 0), 0);
    lines.push(`Recordings: ${recordings.length} (${formatBytes(totalSize)}, longest ${Math.round(longest / 60)} min)`);
    const { used, quota } = await getStorageUsage();
    lines.push(`Storage: ${formatBytes(used)} used of ${formatBytes(quota)}`);
  } catch (error) {
    lines.push(`Recordings: unavailable (${errorMessage(error)})`);
  }

  try {
    const result = await chrome.storage.local.get([LOG_KEY]);
    const entries: DiagnosticEntry[] = result[LOG_KEY] || [];
    lines.push(entries.length ? 'Recent errors:' : 'Recent errors: none');
    for (const entry of entries.slice(-10)) {
      lines.push(`  ${entry.time} [${entry.context}] ${entry.message}`);
    }
  } catch { /* ignore */ }

  return lines.join('\n');
}
