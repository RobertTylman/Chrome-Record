// Audio export: streams audio through decode -> trim -> channels -> gain -> resample -> encode
// in small blocks, so memory use does not grow with recording length.
//
// Sources: WebM/Opus (decoded with WebCodecs), WAV (read in slices), anything else (decodeAudioData).
// Outputs: WAV (RIFF, or RF64 above 4 GB), MP3 (lamejs), OGG and WebM (Opus; remuxed without
// re-encoding when no edits are requested).
// @ts-ignore - lamejs lacks type definitions
import * as lamejs_base from 'lamejs';
import { parseWebm, isWebm, WebmAudioTrack, WebmOpusMuxer } from './webm';
import { OggOpusMuxer, buildOpusHead, opusHeadPreSkip, opusPacketSamples } from './ogg';
import { WavWriter, isWav, readWavInfo, readWavBlocks } from './wav';
import { PEAKS_PER_SECOND, WaveformPeaks } from './storageManager';

// Fix for lamejs scope issues - it expects these to be global
// @ts-ignore
const g = (typeof window !== 'undefined' ? window : global) as any;
if (typeof window !== 'undefined') {
  try {
    if (!g.MPEGMode) g.MPEGMode = require('lamejs/src/js/MPEGMode.js');
    if (!g.Lame) g.Lame = require('lamejs/src/js/Lame.js');
    if (!g.BitStream) g.BitStream = require('lamejs/src/js/BitStream.js');
    if (!g.LameGlobalFlags) g.LameGlobalFlags = require('lamejs/src/js/LameGlobalFlags.js');
    if (!g.LameInternalFlags) g.LameInternalFlags = require('lamejs/src/js/LameInternalFlags.js');
    if (!g.Tables) g.Tables = require('lamejs/src/js/Tables.js');
    if (!g.Encoder) g.Encoder = require('lamejs/src/js/Encoder.js');
    if (!g.L3Side) g.L3Side = require('lamejs/src/js/L3Side.js');

    // Also common types that are often used globally
    const common = require('lamejs/src/js/common.js');
    if (!g.VbrMode) g.VbrMode = common.VbrMode;
    if (!g.Float) g.Float = common.Float;
    if (!g.ShortBlock) g.ShortBlock = common.ShortBlock;
    if (!g.Util) g.Util = common.Util;
    if (!g.Arrays) g.Arrays = common.Arrays;
    if (!g.System) g.System = common.System;
  } catch (e) {
    console.warn('Could not inject lamejs globals:', e);
  }
}

export interface ExportOptions {
  format: string;
  sampleRate?: number;
  channels?: number;
  bitDepth?: number;
  normalize?: boolean;
  start?: number; // seconds
  end?: number; // seconds
  duration?: number; // known duration in seconds, for progress
  onProgress?: (fraction: number) => void;
}

type Planar = Float32Array[];

interface PcmSource {
  sampleRate: number;
  channels: number;
  opusTrack?: WebmAudioTrack;
  blocks(): AsyncGenerator<Planar>;
}

const OPUS_SAMPLE_RATE = 48000;
const OPUS_BITRATE = 128000;
const MP3_SAMPLE_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];
const NORMALIZE_TARGET_PEAK = 0.95; // about -0.5 dBFS

// Yield to the event loop without timers, which Chrome throttles in background tabs
function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(null);
  });
}

function createYielder() {
  let last = performance.now();
  return async () => {
    if (performance.now() - last > 30) {
      await yieldToEventLoop();
      last = performance.now();
    }
  };
}

// --- Sources ---

async function openOpusSource(track: WebmAudioTrack): Promise<PcmSource | null> {
  if (typeof AudioDecoder === 'undefined') return null;
  const config: AudioDecoderConfig = {
    codec: 'opus',
    sampleRate: OPUS_SAMPLE_RATE,
    numberOfChannels: track.channels,
    ...(track.codecPrivate ? { description: track.codecPrivate } : {})
  };
  try {
    if (!(await AudioDecoder.isConfigSupported(config)).supported) return null;
  } catch {
    return null;
  }

  return {
    sampleRate: OPUS_SAMPLE_RATE,
    channels: track.channels,
    opusTrack: track,
    async *blocks() {
      const output: Planar[] = [];
      let error: DOMException | null = null;
      const decoder = new AudioDecoder({
        output: (audioData) => {
          const planar: Planar = [];
          for (let c = 0; c < audioData.numberOfChannels; c++) {
            const plane = new Float32Array(audioData.numberOfFrames);
            audioData.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
            planar.push(plane);
          }
          audioData.close();
          output.push(planar);
        },
        error: (e) => { error = e; }
      });
      decoder.configure(config);

      try {
        for (const frame of track.frames) {
          if (error) throw error;
          decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: frame.timestampUs, data: frame.data }));
          if (decoder.decodeQueueSize > 32) {
            await new Promise<void>(resolve => {
              decoder.addEventListener('dequeue', () => resolve(), { once: true });
              setTimeout(resolve, 50);
            });
          }
          while (output.length) yield output.shift()!;
        }
        await decoder.flush();
        if (error) throw error;
        while (output.length) yield output.shift()!;
      } finally {
        if (decoder.state !== 'closed') decoder.close();
      }
    }
  };
}

async function openDecodeAudioDataSource(blob: Blob): Promise<PcmSource> {
  // Fallback for formats without a streaming reader; holds the whole decoded file in memory
  const context = new OfflineAudioContext(1, 1, OPUS_SAMPLE_RATE);
  const audioBuffer = await context.decodeAudioData(await blob.arrayBuffer());
  const sliceFrames = 65536;
  return {
    sampleRate: audioBuffer.sampleRate,
    channels: audioBuffer.numberOfChannels,
    async *blocks() {
      const channelData = Array.from({ length: audioBuffer.numberOfChannels }, (_, c) => audioBuffer.getChannelData(c));
      for (let i = 0; i < audioBuffer.length; i += sliceFrames) {
        yield channelData.map(d => d.subarray(i, Math.min(i + sliceFrames, audioBuffer.length)));
      }
    }
  };
}

async function openSource(blob: Blob): Promise<PcmSource> {
  const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer());

  if (isWebm(header)) {
    try {
      const track = parseWebm(await blob.arrayBuffer());
      if (track.codecId === 'A_OPUS' && track.frames.length > 0) {
        const source = await openOpusSource(track);
        if (source) return source;
      }
    } catch (error) {
      console.warn('Streaming WebM decode unavailable, falling back to decodeAudioData:', error);
    }
  } else if (isWav(header)) {
    const info = await readWavInfo(blob);
    return {
      sampleRate: info.sampleRate,
      channels: info.channels,
      blocks: () => readWavBlocks(blob, info)
    };
  }

  return openDecodeAudioDataSource(blob);
}

// --- Processing stages ---

async function* trim(blocks: AsyncGenerator<Planar>, sampleRate: number, start?: number, end?: number): AsyncGenerator<Planar> {
  const startFrame = start && start > 0 ? Math.floor(start * sampleRate) : 0;
  const endFrame = end && end > 0 ? Math.floor(end * sampleRate) : Infinity;
  let position = 0;

  for await (const block of blocks) {
    const length = block[0].length;
    const blockStart = position;
    position += length;
    if (blockStart >= endFrame) break;
    const from = Math.max(0, startFrame - blockStart);
    const to = Math.min(length, endFrame - blockStart);
    if (to <= from) continue;
    yield from === 0 && to === length ? block : block.map(ch => ch.subarray(from, to));
  }
}

function mapChannels(block: Planar, target: number): Planar {
  if (block.length === target) return block;
  if (target === 1) {
    const mono = new Float32Array(block[0].length);
    for (const ch of block) {
      for (let i = 0; i < mono.length; i++) mono[i] += ch[i] / block.length;
    }
    return [mono];
  }
  if (block.length === 1) return Array.from({ length: target }, () => block[0]);
  return block.slice(0, target);
}

function applyGain(block: Planar, gain: number): Planar {
  if (gain === 1) return block;
  return block.map(ch => {
    const out = new Float32Array(ch.length);
    for (let i = 0; i < ch.length; i++) out[i] = ch[i] * gain;
    return out;
  });
}

// Streaming linear-interpolation resampler
class Resampler {
  private ratio: number;
  private nextOutput = 0; // index of the next output frame
  private consumed = 0; // input frames seen before the current block
  private previous: number[] | null = null; // last input frame of the previous block

  constructor(inputRate: number, private outputRate: number, private channels: number) {
    this.ratio = inputRate / outputRate;
  }

  process(block: Planar): Planar {
    if (this.ratio === 1) return block;
    const length = block[0].length;
    const blockStart = this.consumed;
    const blockEnd = blockStart + length; // exclusive
    const out: number[][] = Array.from({ length: this.channels }, () => []);

    while (true) {
      const x = this.nextOutput * this.ratio;
      const i = Math.floor(x);
      if (i + 1 >= blockEnd) break;
      const f = x - i;
      for (let c = 0; c < this.channels; c++) {
        const a = i < blockStart ? this.previous![c] : block[c][i - blockStart];
        const b = block[c][i + 1 - blockStart];
        out[c].push(a + (b - a) * f);
      }
      this.nextOutput++;
    }

    this.previous = block.map(ch => ch[length - 1]);
    this.consumed = blockEnd;
    return out.map(samples => Float32Array.from(samples));
  }

  // Emit the final output frames that land on the last input frame
  finish(): Planar {
    if (this.ratio === 1 || !this.previous) return [];
    const out: number[][] = Array.from({ length: this.channels }, () => []);
    while (Math.floor(this.nextOutput * this.ratio) <= this.consumed - 1) {
      for (let c = 0; c < this.channels; c++) out[c].push(this.previous[c]);
      this.nextOutput++;
    }
    return out[0].length ? out.map(samples => Float32Array.from(samples)) : [];
  }
}

// --- Encoders ---

interface Encoder {
  write(block: Planar): Promise<void> | void;
  finish(): Promise<Blob> | Blob;
}

function createMp3Encoder(sampleRate: number, channels: number): Encoder {
  // @ts-ignore
  const mp3encoder = new lamejs_base.Mp3Encoder(channels, sampleRate, 128);
  const parts: Blob[] = [];
  let pending: Int8Array[] = [];
  let pendingBytes = 0;

  const toInt16 = (samples: Float32Array) => {
    const out = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return out;
  };
  const push = (buf: Int8Array) => {
    if (buf.length === 0) return;
    pending.push(buf);
    pendingBytes += buf.length;
    if (pendingBytes > 1024 * 1024) {
      parts.push(new Blob(pending as BlobPart[]));
      pending = [];
      pendingBytes = 0;
    }
  };

  return {
    write(block) {
      const left = toInt16(block[0]);
      const right = channels > 1 ? toInt16(block[1]) : undefined;
      push(mp3encoder.encodeBuffer(left, right as Int16Array));
    },
    finish() {
      push(mp3encoder.flush());
      return new Blob([...parts, new Blob(pending as BlobPart[])], { type: 'audio/mpeg' });
    }
  };
}

async function createOpusEncoder(channels: number, container: 'ogg' | 'webm'): Promise<Encoder> {
  const config: AudioEncoderConfig = { codec: 'opus', sampleRate: OPUS_SAMPLE_RATE, numberOfChannels: channels, bitrate: OPUS_BITRATE };
  if (typeof AudioEncoder === 'undefined' || !(await AudioEncoder.isConfigSupported(config)).supported) {
    throw new Error(`This browser cannot encode ${container.toUpperCase()} audio. Choose WAV or MP3 in Settings.`);
  }

  let oggMuxer: OggOpusMuxer | null = null;
  let webmMuxer: WebmOpusMuxer | null = null;
  let error: DOMException | null = null;
  let framesWritten = 0;

  const encoder = new AudioEncoder({
    output: (chunk, metadata) => {
      if (!oggMuxer && !webmMuxer) {
        const description = metadata?.decoderConfig?.description;
        const opusHead = description
          ? new Uint8Array(description instanceof ArrayBuffer ? description : (description as ArrayBufferView).buffer.slice(
            (description as ArrayBufferView).byteOffset,
            (description as ArrayBufferView).byteOffset + (description as ArrayBufferView).byteLength))
          : buildOpusHead(channels, 312, OPUS_SAMPLE_RATE);
        if (container === 'ogg') oggMuxer = new OggOpusMuxer(opusHead);
        else webmMuxer = new WebmOpusMuxer(channels, opusHead, opusHeadPreSkip(opusHead));
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      if (oggMuxer) oggMuxer.addPacket(data, opusPacketSamples(data));
      else webmMuxer!.addPacket(data, chunk.timestamp, chunk.duration || 20000);
    },
    error: (e) => { error = e; }
  });
  encoder.configure(config);

  return {
    async write(block) {
      if (error) throw error;
      const frames = block[0].length;
      const data = new Float32Array(frames * channels);
      for (let c = 0; c < channels; c++) data.set(block[c], c * frames);
      const audioData = new AudioData({
        format: 'f32-planar',
        sampleRate: OPUS_SAMPLE_RATE,
        numberOfFrames: frames,
        numberOfChannels: channels,
        timestamp: Math.round(framesWritten * 1e6 / OPUS_SAMPLE_RATE),
        data
      });
      framesWritten += frames;
      encoder.encode(audioData);
      audioData.close();
      if (encoder.encodeQueueSize > 32) {
        await new Promise<void>(resolve => {
          encoder.addEventListener('dequeue', () => resolve(), { once: true });
          setTimeout(resolve, 50);
        });
      }
    },
    async finish() {
      await encoder.flush();
      encoder.close();
      if (error) throw error;
      const muxer: OggOpusMuxer | WebmOpusMuxer | null = oggMuxer || webmMuxer;
      if (!muxer) throw new Error('No audio to encode');
      return muxer.finish();
    }
  };
}

// --- Export ---

function remuxOpusToOgg(track: WebmAudioTrack): Blob {
  const opusHead = track.codecPrivate || buildOpusHead(track.channels, 312, OPUS_SAMPLE_RATE);
  const muxer = new OggOpusMuxer(opusHead);
  for (const frame of track.frames) muxer.addPacket(frame.data);
  return muxer.finish();
}

export function mimeTypeForFormat(format: string): string {
  return { wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', webm: 'audio/webm' }[format] || 'application/octet-stream';
}

// Estimated output size in bytes, for warnings before a long export
export function estimateExportSize(duration: number, options: ExportOptions): number {
  const channels = options.channels || 2;
  switch (options.format) {
    case 'wav': return duration * (options.sampleRate || 48000) * channels * ((options.bitDepth || 16) / 8);
    case 'mp3': return duration * 128000 / 8;
    default: return duration * OPUS_BITRATE / 8;
  }
}

export async function exportAudio(blob: Blob, options: ExportOptions): Promise<Blob> {
  const format = options.format.toLowerCase();
  const onProgress = options.onProgress || (() => { });
  const source = await openSource(blob);
  const channels = options.channels || source.channels;
  const isTrimmed = (options.start || 0) > 0 ||
    (options.end !== undefined && options.end > 0 && (!options.duration || options.end < options.duration - 0.01));
  const hasEdits = isTrimmed || channels !== source.channels || !!options.normalize;

  // Lossless fast paths for unedited Opus recordings
  if (source.opusTrack && !hasEdits) {
    if (format === 'webm') return new Blob([blob], { type: 'audio/webm' });
    if (format === 'ogg') return remuxOpusToOgg(source.opusTrack);
  }

  let outputRate: number;
  let encoder: Encoder;
  if (format === 'mp3') {
    const requested = options.sampleRate || source.sampleRate;
    outputRate = MP3_SAMPLE_RATES.includes(requested) ? requested : (requested > 48000 ? 48000 : 44100);
    encoder = createMp3Encoder(outputRate, Math.min(channels, 2));
  } else if (format === 'ogg' || format === 'webm') {
    outputRate = OPUS_SAMPLE_RATE; // Opus always runs at 48 kHz
    encoder = await createOpusEncoder(Math.min(channels, 2), format);
  } else {
    outputRate = options.sampleRate || source.sampleRate;
    encoder = new WavWriter(outputRate, channels, options.bitDepth || 16);
  }
  const outputChannels = format === 'wav' ? channels : Math.min(channels, 2);

  // Progress is measured in source frames
  const duration = options.duration && options.duration > 0 ? options.duration : 0;
  const totalFrames = duration * source.sampleRate;
  const passes = options.normalize ? 2 : 1;
  const yieldNow = createYielder();

  const runPass = async (pass: number, onBlock: (block: Planar) => Promise<void> | void) => {
    let framesSeen = 0;
    const counted = (async function* () {
      for await (const block of source.blocks()) {
        framesSeen += block[0].length;
        if (totalFrames > 0) onProgress(Math.min(1, (pass + framesSeen / totalFrames) / passes));
        yield block;
      }
    })();
    for await (const block of trim(counted, source.sampleRate, options.start, options.end)) {
      await onBlock(mapChannels(block, outputChannels));
      await yieldNow();
    }
  };

  let gain = 1;
  if (options.normalize) {
    let peak = 0;
    await runPass(0, (block) => {
      for (const ch of block) {
        for (let i = 0; i < ch.length; i++) {
          const abs = Math.abs(ch[i]);
          if (abs > peak) peak = abs;
        }
      }
    });
    if (peak > 0) gain = NORMALIZE_TARGET_PEAK / peak;
  }

  const resampler = new Resampler(source.sampleRate, outputRate, outputChannels);
  await runPass(passes - 1, async (block) => {
    const resampled = resampler.process(applyGain(block, gain));
    if (resampled[0].length > 0) await encoder.write(resampled);
  });
  const tail = resampler.finish();
  if (tail.length > 0) await encoder.write(tail);

  const result = await encoder.finish();
  onProgress(1);
  return result;
}

// Waveform peaks for recordings that were saved without them (older versions, recovered recordings)
export async function computeWaveformPeaks(blob: Blob): Promise<WaveformPeaks> {
  const source = await openSource(blob);
  const windowSize = Math.round(source.sampleRate / PEAKS_PER_SECOND);
  const max: number[] = [];
  const avg: number[] = [];
  let count = 0;
  let windowMax = 0;
  let windowSum = 0;
  const yieldNow = createYielder();

  for await (const block of source.blocks()) {
    const length = block[0].length;
    for (let i = 0; i < length; i++) {
      let sample = 0;
      for (const ch of block) {
        const abs = Math.abs(ch[i]);
        if (abs > sample) sample = abs;
      }
      if (sample > windowMax) windowMax = sample;
      windowSum += sample;
      if (++count === windowSize) {
        max.push(Math.min(255, Math.round(windowMax * 255)));
        avg.push(Math.min(255, Math.round(windowSum / count * 255)));
        count = 0;
        windowMax = 0;
        windowSum = 0;
      }
    }
    await yieldNow();
  }
  if (count > 0) {
    max.push(Math.min(255, Math.round(windowMax * 255)));
    avg.push(Math.min(255, Math.round(windowSum / count * 255)));
  }
  return { rate: PEAKS_PER_SECOND, max: Uint8Array.from(max), avg: Uint8Array.from(avg) };
}
