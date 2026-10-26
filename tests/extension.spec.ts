import fs from 'fs';
import { test, expect } from './fixtures';

// Exercises the built extension (dist/). Recording itself needs a user-invoked tabCapture,
// which automation cannot trigger, so it is covered by the pipeline harness instead.

test('popup opens without errors and installs default settings', async ({ context, extensionId }) => {
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.getByRole('button', { name: 'Start Recording' })).toBeVisible();

  const preferences = await page.evaluate(async () => (await chrome.storage.local.get(['preferences'])).preferences);
  expect(preferences).toMatchObject({ format: 'wav', sampleRate: '44100', channelMode: 'stereo', bitDepth: '16' });

  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByText(/0 recordings, 0\.0 MB/)).toBeVisible();
  expect(errors).toEqual([]);
});

test('interrupted recording is recovered on open and exports from the export tab', async ({ context, extensionId }) => {
  const page = await context.newPage();
  const popupUrl = `chrome-extension://${extensionId}/popup.html`;
  await page.goto(popupUrl);
  await expect(page.getByRole('button', { name: 'Start Recording' })).toBeVisible();

  // Leave 3 s of chunks behind in the chunk store, as a crash mid-recording would
  await page.evaluate(async () => {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const dest = ctx.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();
    const recorder = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus' });
    const blobs: Blob[] = [];
    recorder.ondataavailable = (e) => blobs.push(e.data);
    recorder.start(1000);
    await new Promise(r => setTimeout(r, 3000));
    await new Promise<void>(r => { recorder.onstop = () => r(); recorder.stop(); });
    await ctx.close();

    const db: IDBDatabase = await new Promise((resolve, reject) => {
      const request = indexedDB.open('AudioRecorderDB');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction(['chunks'], 'readwrite');
    blobs.forEach((audio, seq) => tx.objectStore('chunks').put({
      sessionId: '1700000000000', seq, audio,
      peakMax: new Uint8Array(20).fill(100), peakAvg: new Uint8Array(20).fill(50)
    }));
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = reject; });
    db.close();
  });

  await page.reload();
  await expect(page.getByText(/^recovered recording/)).toBeVisible({ timeout: 10_000 });

  const recordings = await page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((resolve) => {
      const request = indexedDB.open('AudioRecorderDB');
      request.onsuccess = () => resolve(request.result);
    });
    const tx = db.transaction(['metadata', 'chunks'], 'readonly');
    const get = (store: string) => new Promise<any[]>((resolve) => {
      const request = tx.objectStore(store).getAll();
      request.onsuccess = () => resolve(request.result);
    });
    return { metadata: await get('metadata'), chunks: await get('chunks') };
  });
  expect(recordings.chunks).toHaveLength(0);
  expect(recordings.metadata).toHaveLength(1);
  const [recording] = recordings.metadata;
  expect(recording.format).toBe('webm');
  expect(recording.duration).toBeGreaterThan(0);

  // Export tab downloads a WAV (the default format)
  const exportPage = await context.newPage();
  const downloadPromise = exportPage.waitForEvent('download');
  await exportPage.goto(`chrome-extension://${extensionId}/export.html?ids=${recording.id}`);
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^recovered recording.*\.wav$/);
  const file = await download.path();
  const header = fs.readFileSync(file!).subarray(0, 12);
  expect(header.subarray(0, 4).toString()).toBe('RIFF');
  expect(header.subarray(8, 12).toString()).toBe('WAVE');
  await expect(exportPage.getByRole('heading', { name: 'Download started' })).toBeVisible();
});

test('bug report copies diagnostics without recording content', async ({ context, extensionId }) => {
  const page = await context.newPage();
  // Capture what the popup copies (automation can't grant clipboard access to extension pages)
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async (text: string) => { (window as any).__copied = text; } }
    });
  });
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.getByRole('button', { name: /Report a bug/ }).click();
  await expect(page.getByText(/Diagnostics copied to your clipboard/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open bug form' })).toBeVisible();

  const report: string = await page.evaluate(() => (window as any).__copied);
  expect(report).toContain('Extension version: 1.0.6');
  expect(report).toContain('Recordings: 0');
  expect(report).toMatch(/Recent errors:/);
});
