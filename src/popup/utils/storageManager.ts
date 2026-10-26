// Storage Manager - IndexedDB storage shared by the popup, background and offscreen document.
//
// Stores:
// - recordings: full records (metadata + audio Blob + waveform peaks)
// - metadata:   metadata only, so listing recordings never loads audio into memory
// - chunks:     in-progress recording chunks, written by the offscreen document every second
//               so an interrupted recording can be recovered
// - temp_store: legacy (v1.0.5 and earlier) hand-off between background and popup

export interface RecordingMetadata {
  id: string;
  name: string;
  timestamp: string;
  duration: number;
  format?: string;
  channelMode?: string;
  size?: number;
  mimeType?: string;
}

// Waveform peaks sampled PEAKS_PER_SECOND times per second, scaled to 0-255
export interface WaveformPeaks {
  rate: number;
  max: Uint8Array;
  avg: Uint8Array;
}

export interface StoredRecording {
  metadata: RecordingMetadata;
  audio: Blob;
  peaks?: WaveformPeaks;
}

export interface RecordingChunk {
  sessionId: string;
  seq: number;
  audio: Blob;
  peakMax: Uint8Array;
  peakAvg: Uint8Array;
}

export const PEAKS_PER_SECOND = 20;

// Recordings stop and save automatically at this length (paused time doesn't count)
export const MAX_RECORDING_SECONDS = 60 * 60;

const DB_NAME = 'AudioRecorderDB';
const DB_VERSION = 3;
const STORE_NAME = 'recordings';
const METADATA_STORE_NAME = 'metadata';
const CHUNK_STORE_NAME = 'chunks';
const TEMP_STORE_NAME = 'temp_store';
const LEGACY_TEMP_BLOB_KEY = 'temp_recording_blob';

let dbPromise: Promise<IDBDatabase> | null = null;

function toMetadata(record: any): RecordingMetadata {
  const { id, name, timestamp, duration, format, channelMode, mimeType } = record;
  const size = record.size ?? record.audio?.size ?? record.audioData?.byteLength;
  return { id, name, timestamp, duration, format, channelMode, size, mimeType };
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Transaction aborted'));
  });
}

// Initialize IndexedDB
async function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      const transaction = (event.target as IDBOpenDBRequest).transaction!;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const objectStore = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        objectStore.createIndex('timestamp', 'timestamp', { unique: false });
      }
      if (!db.objectStoreNames.contains(TEMP_STORE_NAME)) {
        db.createObjectStore(TEMP_STORE_NAME);
      }
      if (!db.objectStoreNames.contains(CHUNK_STORE_NAME)) {
        db.createObjectStore(CHUNK_STORE_NAME, { keyPath: ['sessionId', 'seq'] });
      }
      if (!db.objectStoreNames.contains(METADATA_STORE_NAME)) {
        const metadataStore = db.createObjectStore(METADATA_STORE_NAME, { keyPath: 'id' });
        // Backfill metadata for recordings saved by earlier versions
        transaction.objectStore(STORE_NAME).openCursor().onsuccess = (e) => {
          const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
          if (cursor) {
            metadataStore.put(toMetadata(cursor.value));
            cursor.continue();
          }
        };
      }
    };
  });
  return dbPromise;
}

// Get temporary data
export async function getTempData(key: string): Promise<any> {
  const db = await openDB();
  const transaction = db.transaction([TEMP_STORE_NAME], 'readonly');
  return requestToPromise(transaction.objectStore(TEMP_STORE_NAME).get(key));
}

// Delete temporary data
export async function deleteTempData(key: string): Promise<void> {
  const db = await openDB();
  const transaction = db.transaction([TEMP_STORE_NAME], 'readwrite');
  transaction.objectStore(TEMP_STORE_NAME).delete(key);
  return transactionDone(transaction);
}

// Save recording (audio, peaks and metadata) to IndexedDB
export async function saveRecording(
  metadata: RecordingMetadata,
  audio: Blob,
  peaks?: WaveformPeaks
): Promise<RecordingMetadata> {
  const db = await openDB();
  const fullMetadata: RecordingMetadata = {
    ...metadata,
    size: audio.size,
    mimeType: metadata.mimeType || audio.type || undefined
  };
  const transaction = db.transaction([STORE_NAME, METADATA_STORE_NAME], 'readwrite');
  transaction.objectStore(STORE_NAME).put({ ...fullMetadata, audio, peaks });
  transaction.objectStore(METADATA_STORE_NAME).put(fullMetadata);
  await transactionDone(transaction);
  return fullMetadata;
}

// Get recording from IndexedDB
export async function getRecording(id: string): Promise<StoredRecording | null> {
  const db = await openDB();
  const transaction = db.transaction([STORE_NAME], 'readonly');
  const result = await requestToPromise(transaction.objectStore(STORE_NAME).get(id));
  if (!result) return null;

  const metadata = toMetadata(result);
  let audio: Blob;
  if (result.audio instanceof Blob) {
    audio = result.audio;
  } else {
    // Recordings saved by v1.0.5 and earlier hold an ArrayBuffer (WAV since v1.0.0)
    const legacyType = result.format === 'wav' ? 'audio/wav' : 'audio/webm';
    audio = new Blob([result.audioData], { type: legacyType });
  }
  return { metadata, audio, peaks: result.peaks };
}

// Get all recording metadata (without audio data for list view)
export async function getAllRecordingsMetadata(): Promise<RecordingMetadata[]> {
  const db = await openDB();
  const transaction = db.transaction([METADATA_STORE_NAME], 'readonly');
  const recordings: RecordingMetadata[] = await requestToPromise(transaction.objectStore(METADATA_STORE_NAME).getAll());
  // Sort by timestamp descending (most recent first)
  recordings.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return recordings;
}

// Delete recording from IndexedDB
export async function deleteRecording(id: string): Promise<void> {
  const db = await openDB();
  const transaction = db.transaction([STORE_NAME, METADATA_STORE_NAME], 'readwrite');
  transaction.objectStore(STORE_NAME).delete(id);
  transaction.objectStore(METADATA_STORE_NAME).delete(id);
  return transactionDone(transaction);
}

// Get storage usage estimate
export async function getStorageUsage(): Promise<{ used: number; quota: number }> {
  if ('storage' in navigator && 'estimate' in navigator.storage) {
    const estimate = await navigator.storage.estimate();
    return {
      used: estimate.usage || 0,
      quota: estimate.quota || 0
    };
  }
  return { used: 0, quota: 0 };
}

// Clear all recordings
export async function clearAllRecordings(): Promise<void> {
  const db = await openDB();
  const transaction = db.transaction([STORE_NAME, METADATA_STORE_NAME], 'readwrite');
  transaction.objectStore(STORE_NAME).clear();
  transaction.objectStore(METADATA_STORE_NAME).clear();
  return transactionDone(transaction);
}

// Update recording name
export async function updateRecordingName(id: string, newName: string): Promise<void> {
  const db = await openDB();
  const transaction = db.transaction([STORE_NAME, METADATA_STORE_NAME], 'readwrite');
  const store = transaction.objectStore(STORE_NAME);
  const metadataStore = transaction.objectStore(METADATA_STORE_NAME);

  const recording = await requestToPromise(store.get(id));
  if (!recording) {
    transaction.abort();
    throw new Error('Recording not found');
  }
  recording.name = newName;
  store.put(recording);
  metadataStore.put(toMetadata(recording));
  return transactionDone(transaction);
}

// Store waveform peaks computed after the fact (older or recovered recordings)
export async function updateRecordingPeaks(id: string, peaks: WaveformPeaks): Promise<void> {
  const db = await openDB();
  const transaction = db.transaction([STORE_NAME, METADATA_STORE_NAME], 'readwrite');
  const store = transaction.objectStore(STORE_NAME);
  const recording = await requestToPromise(store.get(id));
  if (!recording) {
    transaction.abort();
    return;
  }
  recording.peaks = peaks;
  if (!recording.duration) recording.duration = peaks.max.length / peaks.rate;
  store.put(recording);
  transaction.objectStore(METADATA_STORE_NAME).put(toMetadata(recording));
  return transactionDone(transaction);
}

// --- In-progress recording chunks ---

// Append one chunk of an in-progress recording
export async function appendRecordingChunk(chunk: RecordingChunk): Promise<void> {
  const db = await openDB();
  const transaction = db.transaction([CHUNK_STORE_NAME], 'readwrite');
  transaction.objectStore(CHUNK_STORE_NAME).put(chunk);
  return transactionDone(transaction);
}

function sessionRange(sessionId: string): IDBKeyRange {
  return IDBKeyRange.bound([sessionId, -Infinity], [sessionId, Infinity]);
}

// Assemble the chunks of a recording session into a saved recording, then delete the chunks.
// Returns null when the session has no audio.
export async function finalizeRecordingSession(
  sessionId: string,
  details: { name: string; channelMode?: string; timestamp?: string; fallbackDuration?: number }
): Promise<RecordingMetadata | null> {
  const db = await openDB();
  const readTransaction = db.transaction([CHUNK_STORE_NAME], 'readonly');
  // Keys are [sessionId, seq], so getAll returns the chunks in recording order
  const chunks: RecordingChunk[] = await requestToPromise(readTransaction.objectStore(CHUNK_STORE_NAME).getAll(sessionRange(sessionId)));

  const audioParts = chunks.map(c => c.audio).filter(a => a && a.size > 0);
  let metadata: RecordingMetadata | null = null;

  if (audioParts.length > 0) {
    const audio = new Blob(audioParts, { type: 'audio/webm' });
    const peakCount = chunks.reduce((sum, c) => sum + (c.peakMax?.length || 0), 0);
    const max = new Uint8Array(peakCount);
    const avg = new Uint8Array(peakCount);
    let offset = 0;
    for (const chunk of chunks) {
      if (!chunk.peakMax) continue;
      max.set(chunk.peakMax, offset);
      avg.set(chunk.peakAvg, offset);
      offset += chunk.peakMax.length;
    }

    const duration = peakCount > 0 ? peakCount / PEAKS_PER_SECOND : (details.fallbackDuration || 0);
    // Session ids are the recording start time in ms
    const startedAt = Number(sessionId);
    metadata = await saveRecording({
      id: sessionId,
      name: details.name,
      timestamp: details.timestamp || new Date(isFinite(startedAt) ? startedAt : Date.now()).toISOString(),
      duration,
      format: 'webm',
      channelMode: details.channelMode || 'stereo',
      mimeType: 'audio/webm'
    }, audio, peakCount > 0 ? { rate: PEAKS_PER_SECOND, max, avg } : undefined);
  }

  const deleteTransaction = db.transaction([CHUNK_STORE_NAME], 'readwrite');
  deleteTransaction.objectStore(CHUNK_STORE_NAME).delete(sessionRange(sessionId));
  await transactionDone(deleteTransaction);

  return metadata;
}

// List session ids that still have chunks in storage
async function listChunkSessions(): Promise<string[]> {
  const db = await openDB();
  const transaction = db.transaction([CHUNK_STORE_NAME], 'readonly');
  const store = transaction.objectStore(CHUNK_STORE_NAME);
  return new Promise((resolve, reject) => {
    const sessions: string[] = [];
    const request = store.openKeyCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(sessions);
        return;
      }
      const sessionId = (cursor.key as [string, number])[0];
      sessions.push(sessionId);
      cursor.continue([sessionId, Infinity]);
    };
    request.onerror = () => reject(request.error);
  });
}

// Save recordings that were interrupted (browser crash, extension update, popup closed during save)
// as "recovered" recordings. Call only when no recording is in progress, excluding the active session.
export async function recoverInterruptedRecordings(activeSessionId?: string): Promise<RecordingMetadata[]> {
  const recovered: RecordingMetadata[] = [];

  for (const sessionId of await listChunkSessions()) {
    if (sessionId === activeSessionId) continue;
    try {
      const startedAt = Number(sessionId);
      const label = new Date(isFinite(startedAt) ? startedAt : Date.now()).toLocaleString();
      const metadata = await finalizeRecordingSession(sessionId, { name: `recovered recording ${label}` });
      if (metadata) recovered.push(metadata);
    } catch (error) {
      console.error(`Failed to recover recording session ${sessionId}:`, error);
    }
  }

  // v1.0.5 and earlier stored the finished recording here before the popup converted it
  try {
    const legacyBlob = await getTempData(LEGACY_TEMP_BLOB_KEY);
    if (legacyBlob instanceof Blob && legacyBlob.size > 0) {
      const id = Date.now().toString();
      recovered.push(await saveRecording({
        id,
        name: `recovered recording ${new Date().toLocaleString()}`,
        timestamp: new Date().toISOString(),
        duration: 0,
        format: 'webm',
        channelMode: 'stereo',
        mimeType: 'audio/webm'
      }, new Blob([legacyBlob], { type: 'audio/webm' })));
    }
    if (legacyBlob) await deleteTempData(LEGACY_TEMP_BLOB_KEY);
  } catch (error) {
    console.error('Failed to recover legacy temp recording:', error);
  }

  return recovered;
}

// Migrate recordings from chrome.storage.local to IndexedDB
export async function migrateFromChromeStorage(): Promise<number> {
  const result = await chrome.storage.local.get(['savedRecordings']);
  const savedRecordings = result.savedRecordings || [];
  if (savedRecordings.length === 0) return 0;

  let migratedCount = 0;
  for (const recording of savedRecordings) {
    try {
      const audio = new Blob([new Uint8Array(recording.audioData)], { type: 'audio/webm' });
      await saveRecording({
        id: recording.id,
        name: recording.name,
        timestamp: recording.timestamp,
        duration: recording.duration,
        format: recording.format,
        channelMode: recording.channelMode
      }, audio);
      migratedCount++;
    } catch (error) {
      console.error(`Failed to migrate recording ${recording.id}:`, error);
    }
  }

  // Clear chrome.storage.local recordings after successful migration
  if (migratedCount > 0) {
    await chrome.storage.local.remove(['savedRecordings']);
  }
  return migratedCount;
}
