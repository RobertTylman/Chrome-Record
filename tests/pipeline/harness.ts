// In-browser test harness for the recording and export pipeline.
// Records a synthetic stereo tone (L 440 Hz at 0.5, R 660 Hz at 0.25) through MediaRecorder and the
// peak worklet exactly as the offscreen document does, then exercises storage, recovery and every
// export path. Results are collected on window.__results for tests/pipeline.spec.ts to assert on.
import {
  appendRecordingChunk, finalizeRecordingSession, getRecording, recoverInterruptedRecordings,
  getAllRecordingsMetadata, PEAKS_PER_SECOND, StoredRecording
} from '../../src/popup/utils/storageManager';
import { exportAudio, computeWaveformPeaks } from '../../src/popup/utils/audioConverter';
import { parseWebm } from '../../src/popup/utils/webm';
import { WavWriter, readWavInfo } from '../../src/popup/utils/wav';

type Result = { name: string; ok: boolean; error?: string; [key: string]: any };
const results: Result[] = [];
(window as any).__results = results;

async function check(name: string, fn: () => Promise<Record<string, any>>) {
  const start = performance.now();
  try {
    const detail = await fn();
    results.push({ ...detail, name, ok: true, ms: Math.round(performance.now() - start) });
  } catch (e: any) {
    results.push({ name, ok: false, error: String(e?.stack || e) });
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// pause: [pauseAt, resumeAt] in seconds. finalize=false leaves chunks behind, like a crash.
async function record(sessionId: string, stopAt: number, pause?: [number, number], finalize = true) {
  const ctx = new AudioContext();
  const merger = ctx.createChannelMerger(2);
  const left = ctx.createOscillator(); left.frequency.value = 440;
  const right = ctx.createOscillator(); right.frequency.value = 660;
  const leftGain = ctx.createGain(); leftGain.gain.value = 0.5;
  const rightGain = ctx.createGain(); rightGain.gain.value = 0.25;
  left.connect(leftGain).connect(merger, 0, 0);
  right.connect(rightGain).connect(merger, 0, 1);
  const dest = ctx.createMediaStreamDestination();
  dest.channelCount = 2;
  merger.connect(dest);

  await ctx.audioWorklet.addModule('/peak-worklet.js');
  const peakNode = new AudioWorkletNode(ctx, 'peak-meter', {
    numberOfInputs: 1, numberOfOutputs: 1,
    processorOptions: { windowSize: Math.round(ctx.sampleRate / PEAKS_PER_SECOND) }
  });
  const pendingMax: number[] = [];
  const pendingAvg: number[] = [];
  peakNode.port.onmessage = (e) => {
    pendingMax.push(Math.round(e.data.max * 255));
    pendingAvg.push(Math.round(e.data.avg * 255));
  };
  merger.connect(peakNode);
  const mute = ctx.createGain(); mute.gain.value = 0;
  peakNode.connect(mute).connect(ctx.destination);

  left.start(); right.start();
  const recorder = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 128000 });
  let seq = 0;
  let chain = Promise.resolve();
  recorder.ondataavailable = (e) => {
    const chunk = {
      sessionId, seq: seq++, audio: e.data,
      peakMax: Uint8Array.from(pendingMax.splice(0)), peakAvg: Uint8Array.from(pendingAvg.splice(0))
    };
    chain = chain.then(() => appendRecordingChunk(chunk));
  };
  recorder.start(1000);
  const t0 = performance.now();
  if (pause) {
    await sleep(pause[0] * 1000);
    recorder.pause(); peakNode.port.postMessage('pause');
    await sleep((pause[1] - pause[0]) * 1000);
    recorder.resume(); peakNode.port.postMessage('resume');
  }
  await sleep(stopAt * 1000 - (performance.now() - t0));
  await new Promise<void>(res => { recorder.onstop = () => res(); recorder.stop(); });
  await chain;
  await ctx.close();
  if (!finalize) return null;
  return finalizeRecordingSession(sessionId, { name: 'harness', channelMode: 'stereo' });
}

function zeroCrossingFrequency(data: Float32Array, rate: number): number {
  const from = Math.floor(data.length * 0.2), to = Math.floor(data.length * 0.8);
  let crossings = 0;
  for (let i = from + 1; i < to; i++) if ((data[i - 1] < 0) !== (data[i] < 0)) crossings++;
  return Math.round(crossings / 2 / ((to - from) / rate));
}

async function decode(blob: Blob) {
  const ctx = new OfflineAudioContext(2, 1, 48000);
  const buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
  const freqs = Array.from({ length: buffer.numberOfChannels }, (_, c) => zeroCrossingFrequency(buffer.getChannelData(c), buffer.sampleRate));
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  }
  return { duration: +buffer.duration.toFixed(3), channels: buffer.numberOfChannels, freqs, peak: +peak.toFixed(3) };
}

async function magic(blob: Blob) {
  return String.fromCharCode(...new Uint8Array(await blob.slice(0, 4).arrayBuffer()));
}

export const EXPORT_CASES: [string, Record<string, any>][] = [
  ['wav-16-44100-stereo', { format: 'wav', sampleRate: 44100, channels: 2, bitDepth: 16 }],
  ['wav-24-48000-mono', { format: 'wav', sampleRate: 48000, channels: 1, bitDepth: 24 }],
  ['wav-32-96000-stereo', { format: 'wav', sampleRate: 96000, channels: 2, bitDepth: 32 }],
  ['wav-normalize', { format: 'wav', sampleRate: 44100, channels: 2, bitDepth: 16, normalize: true }],
  ['wav-trim', { format: 'wav', sampleRate: 44100, channels: 2, bitDepth: 16, start: 1, end: 3 }],
  ['mp3-44100-stereo', { format: 'mp3', sampleRate: 44100, channels: 2 }],
  ['mp3-96000-mono', { format: 'mp3', sampleRate: 96000, channels: 1 }],
  ['ogg-remux', { format: 'ogg', sampleRate: 44100, channels: 2 }],
  ['ogg-mono', { format: 'ogg', channels: 1 }],
  ['ogg-trim', { format: 'ogg', channels: 2, start: 1, end: 3 }],
  ['webm-passthrough', { format: 'webm', sampleRate: 44100, channels: 2 }],
  ['webm-mono', { format: 'webm', channels: 1 }],
  ['webm-trim', { format: 'webm', channels: 2, start: 1, end: 3 }]
];

async function main() {
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase('AudioRecorderDB');
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });

  let saved: StoredRecording | null = null;
  await check('record', async () => {
    // 7 s of wall time with a 2 s pause: 5 s of audio
    const meta = await record('1000', 7, [2, 4]);
    saved = await getRecording(meta!.id);
    return { duration: meta!.duration, size: meta!.size, peaks: saved!.peaks?.max.length, listed: (await getAllRecordingsMetadata()).length };
  });
  const recording = saved as StoredRecording | null;
  if (!recording) {
    (window as any).__done = true;
    return;
  }
  const duration = recording.metadata.duration;

  await check('parse-webm', async () => {
    const track = parseWebm(await recording.audio.arrayBuffer());
    const last = track.frames[track.frames.length - 1];
    return { codec: track.codecId, channels: track.channels, frames: track.frames.length, lastTimestamp: last.timestampUs / 1e6, hasOpusHead: !!track.codecPrivate };
  });

  await check('original-decodes', async () => decode(recording.audio));

  await check('seek', async () => {
    const audio = new Audio(URL.createObjectURL(recording.audio));
    await new Promise((resolve, reject) => { audio.onloadedmetadata = resolve; audio.onerror = reject; });
    audio.currentTime = 3;
    await new Promise(resolve => { audio.onseeked = resolve; setTimeout(resolve, 5000); });
    return { currentTime: audio.currentTime };
  });

  await check('computed-peaks', async () => {
    const peaks = await computeWaveformPeaks(recording.audio);
    return { computed: peaks.max.length, recorded: recording.peaks!.max.length };
  });

  let wav: Blob | null = null;
  for (const [name, options] of EXPORT_CASES) {
    await check(`export:${name}`, async () => {
      let progress = 0;
      const out = await exportAudio(recording.audio, { ...options, format: options.format, duration, onProgress: (f) => { progress = f; } });
      if (name === 'wav-16-44100-stereo') wav = out;
      return { magic: await magic(out), size: out.size, progress, passthrough: out === recording.audio || out.size === recording.audio.size, ...(await decode(out)) };
    });
  }

  await check('legacy-wav-to-mp3', async () => {
    const out = await exportAudio(wav!, { format: 'mp3', sampleRate: 44100, channels: 2, duration });
    return { magic: await magic(out), ...(await decode(out)) };
  });

  await check('legacy-wav-to-wav-22050-mono', async () => {
    const out = await exportAudio(wav!, { format: 'wav', sampleRate: 22050, channels: 1, bitDepth: 16, duration });
    return { magic: await magic(out), ...(await decode(out)) };
  });

  await check('rf64-header', async () => {
    const writer = new WavWriter(48000, 2, 16);
    writer.write([new Float32Array(48000).fill(0.1), new Float32Array(48000).fill(-0.1)]);
    (writer as any).dataSize = 5_000_000_000; // pretend the data exceeds 4 GB
    const blob = writer.finish();
    const view = new DataView(await blob.slice(0, 80).arrayBuffer());
    const info = await readWavInfo(blob);
    return {
      magic: await magic(blob),
      ds64DataSize: view.getUint32(28, true) + view.getUint32(32, true) * 2 ** 32,
      dataOffset: info.dataOffset,
      sampleRate: info.sampleRate,
      channels: info.channels
    };
  });

  await check('recovery', async () => {
    await record('2000', 3, undefined, false);
    const recovered = await recoverInterruptedRecordings();
    const secondRun = await recoverInterruptedRecordings();
    const restored = recovered[0] && await getRecording(recovered[0].id);
    return { recovered: recovered.length, secondRun: secondRun.length, recoveredName: recovered[0]?.name, recordedDuration: recovered[0]?.duration, ...(restored ? await decode(restored.audio) : {}) };
  });

  await check('recovery-skips-active', async () => {
    await record('3000', 2, undefined, false);
    return { recovered: (await recoverInterruptedRecordings('3000')).length };
  });

  (window as any).__done = true;
}

main();
