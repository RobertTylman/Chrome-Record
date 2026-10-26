import fs from 'fs';
import http from 'http';
import { AddressInfo } from 'net';
import path from 'path';
import { test, expect, DIST } from './fixtures';

// The harness is served from 127.0.0.1, a secure context, so WebCodecs and AudioWorklet are available
const FILES: Record<string, string> = {
  '/harness.js': path.resolve(__dirname, '.build/harness.js'),
  '/peak-worklet.js': path.join(DIST, 'peak-worklet.js'),
  '/mp3-worker.js': path.join(DIST, 'mp3-worker.js')
};
const INDEX_HTML = '<!doctype html><meta charset="utf-8"><script src="/harness.js"></script>';

let server: http.Server;

type Result = { name: string; ok: boolean; error?: string; [key: string]: any };

// Expected output of each export case (see EXPORT_CASES in pipeline/harness.ts)
const EXPECTED: Record<string, { magic: string; channels: number; trimmed?: boolean; passthrough?: boolean; normalized?: boolean }> = {
  'wav-16-44100-stereo': { magic: 'RIFF', channels: 2 },
  'wav-24-48000-mono': { magic: 'RIFF', channels: 1 },
  'wav-32-96000-stereo': { magic: 'RIFF', channels: 2 },
  'wav-normalize': { magic: 'RIFF', channels: 2, normalized: true },
  'wav-trim': { magic: 'RIFF', channels: 2, trimmed: true },
  'mp3-44100-stereo': { magic: 'ID3', channels: 2 },
  'mp3-96000-mono': { magic: 'ID3', channels: 1 },
  'ogg-remux': { magic: 'OggS', channels: 2 },
  'ogg-mono': { magic: 'OggS', channels: 1 },
  'ogg-trim': { magic: 'OggS', channels: 2, trimmed: true },
  'webm-passthrough': { magic: '\x1aE\xdf\xa3', channels: 2, passthrough: true },
  'webm-mono': { magic: '\x1aE\xdf\xa3', channels: 1 },
  'webm-trim': { magic: '\x1aE\xdf\xa3', channels: 2, trimmed: true }
};

let results: Result[] = [];
const result = (name: string) => {
  const r = results.find(x => x.name === name);
  expect(r, `harness check "${name}" did not run`).toBeTruthy();
  expect(r!.ok, `${name}: ${r!.error}`).toBe(true);
  return r!;
};

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ context }) => {
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(INDEX_HTML);
    } else if (FILES[pathname]) {
      res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(fs.readFileSync(FILES[pathname]));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => (window as any).__done === true, null, { timeout: 110_000 });
  results = await page.evaluate(() => (window as any).__results);
  if (process.env.DUMP_HARNESS) console.log(JSON.stringify(results.map(r => ({ ...r, error: r.error?.slice(0, 300) })), null, 1));
});

test.afterAll(() => {
  server?.close();
});

test('records with pause excluded from duration', () => {
  const r = result('record');
  expect(r.duration).toBeGreaterThan(4.6);
  expect(r.duration).toBeLessThan(5.4);
  expect(r.peaks).toBe(Math.round(r.duration * 20));
  expect(r.listed).toBe(1);
});

test('saved WebM parses and decodes', () => {
  const parsed = result('parse-webm');
  expect(parsed.codec).toBe('A_OPUS');
  expect(parsed.channels).toBe(2);
  expect(parsed.hasOpusHead).toBe(true);
  const decoded = result('original-decodes');
  expect(decoded.channels).toBe(2);
  expect(decoded.freqs[0]).toBeGreaterThan(430);
  expect(decoded.freqs[0]).toBeLessThan(450);
  expect(decoded.freqs[1]).toBeGreaterThan(645);
  expect(decoded.freqs[1]).toBeLessThan(675);
});

test('saved WebM is seekable', () => {
  expect(Math.abs(result('seek').currentTime - 3)).toBeLessThan(0.1);
});

test('peaks computed from the file match recorded peaks', () => {
  const r = result('computed-peaks');
  expect(Math.abs(r.computed - r.recorded)).toBeLessThanOrEqual(3);
});

for (const [name, expected] of Object.entries(EXPECTED)) {
  test(`export ${name}`, () => {
    const duration = result('record').duration;
    const r = result(`export:${name}`);
    expect(r.magic.startsWith(expected.magic) || (expected.magic === 'ID3' && r.magic.charCodeAt(0) === 0xff)).toBe(true);
    expect(r.channels).toBe(expected.channels);
    expect(r.progress).toBe(1);
    const expectedDuration = expected.trimmed ? 2 : duration;
    expect(Math.abs(r.duration - expectedDuration)).toBeLessThan(0.15);
    if (expected.passthrough) expect(r.passthrough).toBe(true);
    if (expected.channels === 2) {
      expect(Math.abs(r.freqs[0] - 440)).toBeLessThan(12);
      expect(Math.abs(r.freqs[1] - 660)).toBeLessThan(15);
    }
    if (expected.normalized) expect(r.peak).toBeGreaterThan(0.9);
    else expect(r.peak).toBeLessThan(0.6);
  });
}

test('legacy WAV recordings still export', () => {
  const duration = result('record').duration;
  for (const name of ['legacy-wav-to-mp3', 'legacy-wav-to-wav-22050-mono']) {
    const r = result(name);
    expect(Math.abs(r.duration - duration)).toBeLessThan(0.15);
  }
  expect(result('legacy-wav-to-wav-22050-mono').channels).toBe(1);
});

test('WAV over 4 GB is written as RF64', () => {
  const r = result('rf64-header');
  expect(r.magic).toBe('RF64');
  expect(r.ds64DataSize).toBe(5_000_000_000);
  expect(r.dataOffset).toBe(80);
  expect(r.sampleRate).toBe(48000);
  expect(r.channels).toBe(2);
});

test('interrupted recordings are recovered once', () => {
  const r = result('recovery');
  expect(r.recovered).toBe(1);
  expect(r.secondRun).toBe(0);
  expect(r.recoveredName).toMatch(/^recovered recording/);
  expect(Math.abs(r.recordedDuration - 3)).toBeLessThan(0.4);
  expect(Math.abs(r.duration - r.recordedDuration)).toBeLessThan(0.15);
});

test('recovery leaves the active recording alone', () => {
  expect(result('recovery-skips-active').recovered).toBe(0);
});
