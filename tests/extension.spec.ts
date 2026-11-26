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
  await expect(page.getByText(/Diagnostics copied/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open form' })).toBeVisible();

  const report: string = await page.evaluate(() => (window as any).__copied);
  expect(report).toContain('Version: 1.0.6');
  for (const heading of ['[Browser and OS]', '[Device]', '[Capabilities]', '[Recording state]', '[Recordings and storage]', '[Settings]', '[Recent activity (oldest first)]']) {
    expect(report).toContain(heading);
  }
  expect(report).toContain('Recordings: 0');
  expect(report).toContain('MediaRecorder Opus/WebM: yes');
  expect(report).not.toMatch(/unavailable:/);
});

test('trim handles stay inside the waveform and nudge with the arrow keys', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.getByRole('button', { name: 'Start Recording' })).toBeVisible();

  // An interrupted 3 s recording, recovered and opened when the popup reloads
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
    const db: IDBDatabase = await new Promise((resolve) => {
      const request = indexedDB.open('AudioRecorderDB');
      request.onsuccess = () => resolve(request.result);
    });
    const tx = db.transaction(['chunks'], 'readwrite');
    blobs.forEach((audio, seq) => tx.objectStore('chunks').put({
      sessionId: '1700000002000', seq, audio, peakRate: 100,
      peakMax: new Uint8Array(100).fill(120), peakAvg: new Uint8Array(100).fill(60)
    }));
    await new Promise((resolve) => { tx.oncomplete = resolve; });
    db.close();
  });

  await page.reload();
  await expect(page.getByText(/^recovered recording/)).toBeVisible({ timeout: 10_000 });

  // At the very start and end, both handles are fully visible rather than half clipped, and sit
  // outside the waveform so they don't cover any audio
  const view = (await page.locator('.waveform-container').boundingBox())!;
  const track = (await page.locator('.waveform-track').boundingBox())!;
  const start = page.getByRole('slider', { name: 'Trim start' });
  const end = page.getByRole('slider', { name: 'Trim end' });
  for (const handle of [start, end]) {
    const box = (await handle.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(6);
    expect(box.x).toBeGreaterThanOrEqual(view.x);
    expect(box.x + box.width).toBeLessThanOrEqual(view.x + view.width);
  }
  expect(Math.abs((await start.boundingBox())!.x + (await start.boundingBox())!.width - track.x)).toBeLessThan(1);
  expect(Math.abs((await end.boundingBox())!.x - (track.x + track.width))).toBeLessThan(1);

  // Dragging: the cut stays at the handle's tip wherever the handle was grabbed, so moving the
  // pointer 60 px moves the cut exactly 60 px
  const duration = Number(await start.getAttribute('aria-valuemax'));
  const secondsPerPx = duration / track.width;
  const grab = (await start.boundingBox())!;
  await page.mouse.move(grab.x + 2, grab.y + grab.height / 2);
  await page.mouse.down();
  await page.mouse.move(grab.x + 2 + 60, grab.y + grab.height / 2, { steps: 6 });
  await page.mouse.up();
  const afterDrag = Number(await start.getAttribute('aria-valuenow'));
  expect(Math.abs(afterDrag - 60 * secondsPerPx)).toBeLessThan(secondsPerPx);
  const tip = (await start.boundingBox())!;
  expect(Math.abs(tip.x + tip.width - (track.x + afterDrag / secondsPerPx))).toBeLessThan(1);

  // Holding Alt moves it a tenth as far: 50 px of pointer movement is 5 px of cut
  const fineGrab = (await start.boundingBox())!;
  await page.mouse.move(fineGrab.x + 4, fineGrab.y + fineGrab.height / 2);
  await page.mouse.down();
  await page.keyboard.down('Alt');
  await page.mouse.move(fineGrab.x + 4 + 50, fineGrab.y + fineGrab.height / 2, { steps: 5 });
  await page.keyboard.up('Alt');
  await page.mouse.up();
  const afterFine = Number(await start.getAttribute('aria-valuenow'));
  expect(Math.abs(afterFine - afterDrag - 5 * secondsPerPx)).toBeLessThan(secondsPerPx / 2);

  // Back to the start for the keyboard checks
  await start.focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowLeft');
  await expect(start).toHaveAttribute('aria-valuenow', '0');

  // Shift+Right moves the start 1 s; Left moves the end back 0.1 s
  await start.focus();
  await page.keyboard.press('Shift+ArrowRight');
  await expect(start).toHaveAttribute('aria-valuenow', '1');
  await expect(page.locator('.time-readout-side').first()).toContainText('00:01.00');
  await end.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.trim-time.end')).toBeVisible();
  const endValue = Number(await end.getAttribute('aria-valuenow'));
  expect(endValue).toBeGreaterThan(2.5);
  expect(endValue).toBeLessThan(3.05);
});

test('theme button cycles to the Vintage theme', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => chrome.storage.local.set({ theme: 'rainbow' }));
  await page.reload();
  await page.getByTitle('Current Theme: Rainbow').click();
  await expect(page.locator('body')).toHaveClass(/vintage-mode/);
  await expect(page.getByTitle('Current Theme: Vintage')).toBeVisible();
  expect(await page.evaluate(async () => (await chrome.storage.local.get(['theme'])).theme)).toBe('vintage');
  // Wraps back around to the first theme
  await page.getByTitle('Current Theme: Vintage').click();
  await expect(page.locator('body')).toHaveClass(/light-mode/);
});
