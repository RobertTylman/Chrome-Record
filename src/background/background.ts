import { saveTempData } from '../popup/utils/storageManager';

// Background service worker for handling desktop audio capture

let isRecording = false;
let recordingChunks: Blob[] = [];
let mediaRecorder: MediaRecorder | null = null;
let currentStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let destinationNode: MediaStreamAudioDestinationNode | null = null;

interface Message {
  action: string;
  streamId?: string;
  tabId?: number;
  chunk?: number[];
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message: Message, sender: chrome.runtime.MessageSender, sendResponse: (response: any) => void) => {
  if (message.action === 'startCapture') {
    // Automatically capture from current Chrome window/tab without showing picker
    const tabId = message.tabId || sender.tab?.id;

    if (tabId) {
      // Get streamId and return it to popup - popup will get the stream
      captureTabAudio(tabId)
        .then(() => {
          chrome.storage.local.get(['recordingStreamId'], (result) => {
            sendResponse({ success: true, streamId: result.recordingStreamId, method: 'tab' });
          });
        })
        .catch((error) => {
          sendResponse({ success: false, error: error.message });
        });
    } else {
      // Fallback: get current active tab and capture
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0] && tabs[0].id) {
          captureTabAudio(tabs[0].id)
            .then(() => {
              chrome.storage.local.get(['recordingStreamId'], (result) => {
                sendResponse({ success: true, streamId: result.recordingStreamId, method: 'tab' });
              });
            })
            .catch((error) => {
              sendResponse({ success: false, error: error.message });
            });
        } else {
          sendResponse({ success: false, error: 'No active tab found' });
        }
      });
    }
    return true; // Keep channel open for async response
  }

  if (message.action === 'startRecordingWithStream') {
    // Popup sends us the streamId to start recording in background
    if (message.streamId) {
      startRecordingFromStreamId(message.streamId)
        .then(() => {
          sendResponse({ success: true });
        })
        .catch((error) => {
          sendResponse({ success: false, error: error.message });
        });
    } else {
      sendResponse({ success: false, error: 'Stream ID required' });
    }
    return true;
  }

  if (message.action === 'stopCapture') {
    handleStopCapture()
      .then(async (audioBlob) => {
        if (audioBlob) {
          const arrayBuffer = await audioBlob.arrayBuffer();
          sendResponse({ success: true, audioBlob: Array.from(new Uint8Array(arrayBuffer)) });
        } else {
          sendResponse({ success: true, audioBlob: null });
        }
      })
      .catch((error) => {
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  if (message.action === 'getRecordingState') {
    // Check state from storage and offscreen document
    (async () => {
      // Check if offscreen recording is active
      const contexts = await chrome.runtime.getContexts({
        contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT]
      });
      const hasOffscreen = contexts.length > 0;

      chrome.storage.local.get(['recordingStartTime'], (result) => {
        // If offscreen exists, we are definitely recording
        const isRecordingActive = hasOffscreen || (isRecording && !!result.recordingStartTime);

        sendResponse({
          success: true,
          isRecording: isRecordingActive,
          // We don't need to check chunks content here - it's expensive to load
          // Just rely on recordingChunks.length (in memory) or assume hasRecording if active
          hasRecording: recordingChunks.length > 0 || isRecordingActive
        });
      });
    })();
    return true;
  }

  if (message.action === 'getRecordingData') {
    if (recordingChunks.length > 0) {
      // Get format preference
      chrome.storage.local.get(['preferences'], (prefsResult) => {
        const format = prefsResult.preferences?.format || 'webm';
        let mimeType = 'audio/webm';

        if (format === 'ogg') {
          mimeType = 'audio/ogg';
        } else if (format === 'webm') {
          mimeType = 'audio/webm';
        }

        const blob = new Blob(recordingChunks, { type: mimeType });
        blob.arrayBuffer().then((arrayBuffer) => {
          sendResponse({
            success: true,
            audioBlob: Array.from(new Uint8Array(arrayBuffer)),
            hasData: true
          });
        });
      });
      return true; // Keep channel open for async response
    } else {
      sendResponse({ success: true, hasData: false });
      return true;
    }
  }

  if (message.action === 'clearRecording') {
    console.log('clearRecording called - cleaning up all resources');

    // Stop any active recording first
    if (mediaRecorder && isRecording) {
      if (mediaRecorder.state === 'recording' || mediaRecorder.state === 'paused') {
        try {
          mediaRecorder.stop();
          console.log('Stopped MediaRecorder in clearRecording');
        } catch (e) {
          console.warn('Error stopping MediaRecorder:', e);
        }
      }
      mediaRecorder = null;
      isRecording = false;
    }

    // Clean up stream - CRITICAL: must stop all tracks to release the tab capture
    if (currentStream) {
      const tracks = currentStream.getTracks();
      console.log(`Stopping ${tracks.length} tracks in clearRecording`);
      tracks.forEach((track: MediaStreamTrack) => {
        track.stop();
        console.log('Stopped track:', track.id, 'readyState:', track.readyState);
      });
      // Don't null immediately - let tracks fully stop
      setTimeout(() => {
        currentStream = null;
        console.log('Stream set to null in clearRecording');
      }, 100);
    } else {
      currentStream = null;
    }

    // Clean up audio context
    if (audioContext) {
      audioContext.close().catch(() => { });
      audioContext = null;
    }
    destinationNode = null;

    // Clear chunks and storage
    recordingChunks = [];
    chrome.storage.local.remove([
      'recordingStreamId',
      'recordingTabId',
      'recordingStartTime',
      'recordingChunks'
    ], () => {
      console.log('Storage cleared in clearRecording');
      sendResponse({ success: true });
    });

    return true;
  }

  if (message.action === 'addRecordingChunk') {
    // Add chunk from offscreen recorder - ONLY keep in memory
    // Storage writes were causing O(n²) slowdown: every 100ms we were
    // reading, converting, and rewriting ALL chunks. After 5 mins that's
    // 3000 chunks being processed on every single message.
    // Now we only write to storage when recording stops.
    if (message.chunk) {
      const blob = new Blob([new Uint8Array(message.chunk)], { type: 'audio/webm' });
      recordingChunks.push(blob);
    }
    sendResponse({ success: true });
    return true;
  }
});

// Automatically capture audio from a specific tab (no picker, without muting)
async function captureTabAudio(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    // First, ensure any existing stream is fully cleaned up
    // Chrome's tabCapture API requires that previous streams are fully released before capturing again

    // Wait longer to ensure any previous stream is fully released
    // This is critical to prevent "Cannot capture a tab with an active stream" errors
    const attemptCapture = () => {
      chrome.tabCapture.getMediaStreamId(
        { targetTabId: tabId },
        (streamId: string | undefined) => {
          if (chrome.runtime.lastError) {
            const errorMsg = chrome.runtime.lastError.message;
            // If error is about active stream, wait longer and retry multiple times
            if (errorMsg && (errorMsg.includes('active stream') || errorMsg.includes('Cannot capture'))) {
              // Retry with increasing delays
              let retryCount = 0;
              const maxRetries = 3;
              const retryDelay = 200; // Start with 200ms

              const retryCapture = () => {
                setTimeout(() => {
                  chrome.tabCapture.getMediaStreamId(
                    { targetTabId: tabId },
                    (retryStreamId: string | undefined) => {
                      if (chrome.runtime.lastError) {
                        const retryError = chrome.runtime.lastError.message;
                        if (retryError && (retryError.includes('active stream') || retryError.includes('Cannot capture')) && retryCount < maxRetries) {
                          retryCount++;
                          console.log(`Retry ${retryCount}/${maxRetries} for tab capture after active stream error`);
                          retryCapture();
                          return;
                        }
                        reject(new Error(retryError));
                        return;
                      }
                      if (!retryStreamId) {
                        reject(new Error('Failed to get media stream ID'));
                        return;
                      }
                      chrome.storage.local.set({
                        recordingStreamId: retryStreamId,
                        recordingTabId: tabId
                      });
                      resolve();
                    }
                  );
                }, retryDelay * (retryCount + 1)); // Increase delay with each retry
              };

              retryCapture();
              return;
            }
            reject(new Error(errorMsg));
            return;
          }

          if (!streamId) {
            reject(new Error('Failed to get media stream ID'));
            return;
          }

          // Store streamId - the popup will use it to get the stream
          chrome.storage.local.set({
            recordingStreamId: streamId,
            recordingTabId: tabId
          });

          resolve();
        }
      );
    };
    attemptCapture();
  });
}

// Offscreen handling
let creatingOffscreenDocument: Promise<void> | null = null;

async function setupOffscreenDocument(path: string) {
  // Check if offscreen document already exists
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT]
  });

  if (existingContexts.length > 0) {
    return;
  }

  // Create offscreen document
  if (creatingOffscreenDocument) {
    await creatingOffscreenDocument;
  } else {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: path,
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: 'Recording from chrome.tabCapture API'
    });
    await creatingOffscreenDocument;
    creatingOffscreenDocument = null;
  }
}

async function startRecordingFromStreamId(streamId: string): Promise<void> {
  await setupOffscreenDocument('offscreen.html');

  // Wait a bit for offscreen to be ready
  await new Promise(resolve => setTimeout(resolve, 50));

  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({
      type: 'START_RECORDING',
      target: 'offscreen',
      streamId: streamId
    }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response && response.success) {
        isRecording = true;
        chrome.storage.local.set({ recordingStartTime: Date.now() });
        resolve();
      } else {
        reject(new Error(response?.error || 'Failed to start offscreen recording'));
      }
    });
  });
}

async function handleStopCapture(): Promise<Blob | null> {
  // Check if we are recording via offscreen
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT]
  });

  if (existingContexts.length > 0) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: 'STOP_RECORDING',
        target: 'offscreen'
      }, async (response) => {
        // Wait for the last chunks to be processed
        await new Promise(r => setTimeout(r, 500));

        isRecording = false;

        // Close offscreen document
        chrome.offscreen.closeDocument();

        // Write chunks to IndexedDB (efficient for large files)
        if (recordingChunks.length > 0) {
          try {
            // Create a single blob from all chunks
            // We use 'audio/webm' as generic type, popup will handle specifics
            const fullBlob = new Blob(recordingChunks, { type: 'audio/webm' });

            // Save to IndexedDB which can handle large blobs efficiently
            // Bypasses the memory limit of serialization and chrome.storage
            await saveTempData('temp_recording_blob', fullBlob);
            console.log('Saved recording blob to IndexedDB, size:', fullBlob.size);
          } catch (error) {
            console.error('Error saving blob to IndexedDB:', error);
          }
        }

        // DON'T reconstruct blob here - let popup read from storage directly
        resolve(null);

        // Cleanup metadata but KEEP chunks for popup to read
        chrome.storage.local.remove([
          'recordingStreamId',
          'recordingTabId',
          'recordingStartTime'
        ]);
        recordingChunks = [];
      });
    });
  }

  // Fallback for non-offscreen recording (shouldn't happen with new logic but kept for safety)
  if (mediaRecorder && isRecording) {
    if (mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
    }
    return new Promise((resolve) => {
      // ... legacy logic ...
      resolve(null);
    });
  }

  return null;
}

function processStopCapture(resolve: (blob: Blob | null) => void, originalOnStop: ((this: MediaRecorder, ev: Event) => any) | null) {
  console.log('Processing stop capture, chunks count:', recordingChunks.length);

  // Get format preference for blob type
  chrome.storage.local.get(['preferences'], (prefsResult) => {
    const format = prefsResult.preferences?.format || 'webm';
    let mimeType = 'audio/webm';

    if (format === 'ogg') {
      mimeType = 'audio/ogg';
    } else if (format === 'webm') {
      mimeType = 'audio/webm';
    }

    // Ensure we have chunks
    if (recordingChunks.length === 0) {
      console.warn('No recording chunks available when stopping');
      resolve(null);
      return;
    }

    const blob = new Blob(recordingChunks, { type: mimeType });
    console.log('Created blob, size:', blob.size, 'from', recordingChunks.length, 'chunks');

    if (originalOnStop && mediaRecorder) {
      try {
        originalOnStop.call(mediaRecorder, new Event('stop'));
      } catch (e) {
        console.warn('Error calling original onstop:', e);
      }
    }

    isRecording = false;
    const chunksToReturn = [...recordingChunks]; // Copy before clearing
    recordingChunks = []; // Clear chunks after creating blob

    // Clean up stream completely - stop all tracks first
    if (currentStream) {
      const tracks = currentStream.getTracks();
      tracks.forEach((track: MediaStreamTrack) => {
        track.stop();
        console.log('Stopped track:', track.id, 'readyState:', track.readyState);
      });
      // Wait longer for tracks to fully stop before nulling
      // This ensures Chrome's tabCapture API fully releases the stream
      setTimeout(() => {
        currentStream = null;
        console.log('Stream cleaned up and set to null');
      }, 200); // Increased from 50ms to 200ms
    } else {
      currentStream = null;
    }

    if (audioContext) {
      audioContext.close().catch(() => {
        // Ignore errors on close
      });
      audioContext = null;
    }
    destinationNode = null;

    // Clear all recording-related storage
    chrome.storage.local.remove([
      'recordingStreamId',
      'recordingTabId',
      'recordingStartTime',
      'recordingChunks'
    ]);

    const recorderToNull = mediaRecorder;
    mediaRecorder = null;

    // Resolve with the blob - check for minimum size (at least 1KB to be valid)
    if (blob.size > 1024) {
      console.log('Resolving with blob, size:', blob.size);
      resolve(blob);
    } else if (blob.size > 0) {
      console.warn('Blob size is very small:', blob.size, 'but resolving anyway');
      resolve(blob);
    } else {
      console.warn('Blob size is 0, trying to use chunks directly');
      // If blob is empty, try to create from chunks copy
      if (chunksToReturn.length > 0) {
        const retryBlob = new Blob(chunksToReturn, { type: mimeType });
        console.log('Retry blob size:', retryBlob.size);
        if (retryBlob.size > 0) {
          resolve(retryBlob);
        } else {
          console.error('Retry blob is also empty');
          resolve(null);
        }
      } else {
        console.warn('No chunks available, resolving with null');
        resolve(null);
      }
    }
  });
}

// Handle popup close - continue recording in background
chrome.runtime.onConnect.addListener((port) => {
  port.onDisconnect.addListener(() => {
    // Popup closed, but recording continues in background
    console.log('Popup closed, recording continues in background');
  });
});

// Clean up on extension unload
chrome.runtime.onSuspend.addListener(() => {
  if (mediaRecorder && isRecording) {
    mediaRecorder.stop();
  }
  if (currentStream) {
    currentStream.getTracks().forEach((track: MediaStreamTrack) => {
      track.stop();
    });
  }
  if (audioContext) {
    audioContext.close();
  }
});

// Restore recording state on startup
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.get(['recordingChunks'], (result) => {
    if (result.recordingChunks && Array.isArray(result.recordingChunks)) {
      recordingChunks = result.recordingChunks.map((chunk: number[]) =>
        new Blob([new Uint8Array(chunk)], { type: 'audio/webm' })
      );
    }
  });
});
