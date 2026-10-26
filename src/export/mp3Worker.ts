// Web Worker that runs lamejs MP3 encoding off the page's main thread.
// Messages in:  { type: 'init', channels, sampleRate } | { type: 'encode', left, right? } | { type: 'flush' }
// Messages out: { type: 'encoded', data } for each encode/flush, { type: 'error', message }
import { Mp3BlockEncoder } from '../popup/utils/mp3';

let encoder: Mp3BlockEncoder | null = null;
const scope = self as unknown as { postMessage: (message: any, transfer?: Transferable[]) => void };

self.onmessage = (event: MessageEvent) => {
  const message = event.data;
  try {
    if (message.type === 'init') {
      encoder = new Mp3BlockEncoder(message.channels, message.sampleRate);
      return;
    }
    if (!encoder) throw new Error('MP3 encoder not initialized');

    const data = message.type === 'flush' ? encoder.flush() : encoder.encode(message.left, message.right);
    // Copy out of lamejs's reused output buffer, then transfer
    const copy = data.slice();
    scope.postMessage({ type: 'encoded', data: copy }, [copy.buffer]);
  } catch (error: any) {
    scope.postMessage({ type: 'error', message: error?.message || String(error) });
  }
};
