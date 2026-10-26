// Background service worker: obtains the tab capture stream id and coordinates the offscreen
// document that records. Audio never passes through here — the offscreen document writes it
// straight to IndexedDB, so a service worker restart cannot lose a recording.

const DEFAULT_PREFERENCES = {
  format: 'wav',
  sampleRate: '44100',
  channelMode: 'stereo',
  bitDepth: '16',
  normalize: false,
  useTabTitle: false
};

// Recording state kept in storage so it survives service worker restarts and popup reopen
const RECORDING_STATE_KEYS = [
  'recordingStreamId',
  'recordingTabId',
  'recordingStartTime',
  'recordingSessionId',
  'recordingPausedAt',
  'recordingPausedTotal'
];

interface Message {
  action: string;
  streamId?: string;
  tabId?: number;
  details?: { name?: string; channelMode?: string };
  recording?: { id: string };
}

// Persist defaults so the Settings screen and the download logic always agree
chrome.runtime.onInstalled.addListener(async () => {
  const { preferences } = await chrome.storage.local.get(['preferences']);
  await chrome.storage.local.set({ preferences: { ...DEFAULT_PREFERENCES, ...(preferences || {}) } });
});

chrome.runtime.onMessage.addListener((message: Message, sender: chrome.runtime.MessageSender, sendResponse: (response: any) => void) => {
  if (message.action === 'startCapture') {
    (async () => {
      let tabId = message.tabId || sender.tab?.id;
      if (!tabId) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        tabId = tab?.id;
      }
      if (!tabId) throw new Error('No active tab found');
      const streamId = await captureTabAudio(tabId);
      return { success: true, streamId, method: 'tab' };
    })()
      .then(sendResponse)
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true; // Keep channel open for async response
  }

  if (message.action === 'startRecordingWithStream') {
    if (message.streamId) {
      startRecordingFromStreamId(message.streamId, message.details || {})
        .then(() => sendResponse({ success: true }))
        .catch((error) => sendResponse({ success: false, error: error.message }));
    } else {
      sendResponse({ success: false, error: 'Stream ID required' });
    }
    return true;
  }

  if (message.action === 'stopCapture' || message.action === 'clearRecording') {
    // clearRecording also saves rather than discards: an offscreen document that is still
    // around holds a real recording (e.g. after a service worker restart)
    stopAndSave(message.details || {})
      .then((recording) => sendResponse({ success: true, recording }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.action === 'pauseRecording' || message.action === 'resumeRecording') {
    setPaused(message.action === 'pauseRecording')
      .then((state) => sendResponse({ success: true, ...state }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  // The offscreen document stopped and saved a recording that reached the length limit
  if (message.action === 'recordingLimitReached') {
    (async () => {
      if (message.recording?.id) {
        // The popup may be closed; it loads this recording the next time it opens
        await chrome.storage.local.set({ autoSavedRecordingId: message.recording.id });
      }
      await chrome.offscreen.closeDocument().catch(() => { });
      await chrome.storage.local.remove(RECORDING_STATE_KEYS);
    })();
    return;
  }

  if (message.action === 'getRecordingState') {
    (async () => {
      const recording = await hasOffscreenDocument();
      const state = await chrome.storage.local.get(RECORDING_STATE_KEYS);
      sendResponse({
        success: true,
        isRecording: recording,
        hasRecording: recording,
        isPaused: recording && !!state.recordingPausedAt,
        startTime: state.recordingStartTime,
        pausedAt: state.recordingPausedAt || null,
        pausedTotal: state.recordingPausedTotal || 0,
        sessionId: state.recordingSessionId
      });
    })();
    return true;
  }
});

// Get a stream id for the tab (no picker, without muting)
function getMediaStreamId(tabId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId: string | undefined) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!streamId) {
        reject(new Error('Failed to get media stream ID'));
      } else {
        resolve(streamId);
      }
    });
  });
}

// Chrome needs a moment to release a previous capture of the same tab; retry on "active stream" errors
async function captureTabAudio(tabId: number): Promise<string> {
  const maxRetries = 3;
  const retryDelay = 200;

  for (let attempt = 0; ; attempt++) {
    try {
      const streamId = await getMediaStreamId(tabId);
      await chrome.storage.local.set({ recordingStreamId: streamId, recordingTabId: tabId });
      return streamId;
    } catch (error: any) {
      const errorMsg: string = error?.message || '';
      const isActiveStream = errorMsg.includes('active stream') || errorMsg.includes('Cannot capture');
      if (!isActiveStream || attempt >= maxRetries) throw error;
      console.log(`Retry ${attempt + 1}/${maxRetries} for tab capture after active stream error`);
      await new Promise(resolve => setTimeout(resolve, retryDelay * (attempt + 1)));
    }
  }
}

// Offscreen handling
let creatingOffscreenDocument: Promise<void> | null = null;

async function hasOffscreenDocument(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT]
  });
  return contexts.length > 0;
}

async function setupOffscreenDocument(path: string) {
  if (await hasOffscreenDocument()) return;

  if (creatingOffscreenDocument) {
    await creatingOffscreenDocument;
  } else {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: path,
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: 'Recording from chrome.tabCapture API'
    });
    try {
      await creatingOffscreenDocument;
    } finally {
      creatingOffscreenDocument = null;
    }
  }
}

function sendToOffscreen(type: string, extra: Record<string, unknown> = {}): Promise<any> {
  return chrome.runtime.sendMessage({ type, target: 'offscreen', ...extra });
}

async function startRecordingFromStreamId(streamId: string, details: { name?: string; channelMode?: string }): Promise<void> {
  await setupOffscreenDocument('offscreen.html');

  // Wait a bit for offscreen to be ready
  await new Promise(resolve => setTimeout(resolve, 50));

  // The session id is the start time; chunks are stored under it until the recording is saved
  const sessionId = Date.now().toString();
  const response = await sendToOffscreen('START_RECORDING', { streamId, sessionId, details });
  if (!response?.success) {
    await chrome.offscreen.closeDocument().catch(() => { });
    throw new Error(response?.error || 'Failed to start offscreen recording');
  }

  await chrome.storage.local.set({
    recordingStartTime: Number(sessionId),
    recordingSessionId: sessionId,
    recordingPausedAt: null,
    recordingPausedTotal: 0
  });
}

async function stopAndSave(details: { name?: string; channelMode?: string }) {
  if (!(await hasOffscreenDocument())) {
    await chrome.storage.local.remove(RECORDING_STATE_KEYS);
    return null;
  }

  try {
    // Resolves after the offscreen document has saved the recording to IndexedDB
    const response = await sendToOffscreen('STOP_RECORDING', { details });
    if (!response?.success) {
      throw new Error(response?.error || 'Failed to save recording');
    }
    return response.recording;
  } finally {
    await chrome.offscreen.closeDocument().catch(() => { });
    await chrome.storage.local.remove(RECORDING_STATE_KEYS);
  }
}

async function setPaused(pause: boolean) {
  if (!(await hasOffscreenDocument())) throw new Error('Not recording');

  const state = await chrome.storage.local.get(['recordingPausedAt', 'recordingPausedTotal']);
  const now = Date.now();

  if (pause && !state.recordingPausedAt) {
    await sendToOffscreen('PAUSE_RECORDING');
    await chrome.storage.local.set({ recordingPausedAt: now });
  } else if (!pause && state.recordingPausedAt) {
    await sendToOffscreen('RESUME_RECORDING');
    await chrome.storage.local.set({
      recordingPausedAt: null,
      recordingPausedTotal: (state.recordingPausedTotal || 0) + (now - state.recordingPausedAt)
    });
  }

  const updated = await chrome.storage.local.get(['recordingPausedAt', 'recordingPausedTotal']);
  return { pausedAt: updated.recordingPausedAt || null, pausedTotal: updated.recordingPausedTotal || 0 };
}
