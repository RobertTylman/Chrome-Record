// Minimal WebM (Matroska) demuxer and muxer for single-track Opus audio.
// The demuxer handles MediaRecorder output: unknown-size Segment/Cluster elements, no Cues,
// and a possibly truncated tail (recovered recordings).

const ID = {
  EBML: 0x1A45DFA3,
  Segment: 0x18538067,
  Info: 0x1549A966,
  TimecodeScale: 0x2AD7B1,
  Duration: 0x4489,
  MuxingApp: 0x4D80,
  WritingApp: 0x5741,
  Tracks: 0x1654AE6B,
  TrackEntry: 0xAE,
  TrackNumber: 0xD7,
  TrackUID: 0x73C5,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63A2,
  CodecDelay: 0x56AA,
  SeekPreRoll: 0x56BB,
  Audio: 0xE1,
  SamplingFrequency: 0xB5,
  Channels: 0x9F,
  Cluster: 0x1F43B675,
  Timecode: 0xE7,
  SimpleBlock: 0xA3,
  BlockGroup: 0xA0,
  Block: 0xA1
};

// Elements whose children we walk into; everything else is skipped by size
const MASTER_IDS = new Set([ID.Segment, ID.Info, ID.Tracks, ID.TrackEntry, ID.Audio, ID.Cluster, ID.BlockGroup]);

export interface WebmFrame {
  timestampUs: number;
  data: Uint8Array;
}

export interface WebmAudioTrack {
  codecId: string;
  codecPrivate?: Uint8Array;
  channels: number;
  sampleRate: number;
  frames: WebmFrame[];
}

interface TrackInfo {
  number?: number;
  type?: number;
  codecId?: string;
  codecPrivate?: Uint8Array;
  channels?: number;
  sampleRate?: number;
}

export function isWebm(header: Uint8Array): boolean {
  return header.length >= 4 && header[0] === 0x1A && header[1] === 0x45 && header[2] === 0xDF && header[3] === 0xA3;
}

function readUint(bytes: Uint8Array, start: number, end: number): number {
  let value = 0;
  for (let i = start; i < end; i++) value = value * 256 + bytes[i];
  return value;
}

function readFloat(bytes: Uint8Array, start: number, end: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset + start, end - start);
  return end - start === 4 ? view.getFloat32(0) : view.getFloat64(0);
}

// Number of bytes in a variable-length integer, from its first byte (0 if invalid)
function vintLength(firstByte: number, maxLength: number): number {
  for (let length = 1; length <= maxLength; length++) {
    if (firstByte & (0x80 >> (length - 1))) return length;
  }
  return 0;
}

// Parse the audio track of a WebM file. Throws if the file has no supported audio track.
export function parseWebm(buffer: ArrayBuffer): WebmAudioTrack {
  const bytes = new Uint8Array(buffer);
  const length = bytes.length;
  const tracks: TrackInfo[] = [];
  const frames: WebmFrame[] = [];
  let timecodeScale = 1000000; // ns per timecode unit
  let clusterTimecode = 0;
  let audioTrackNumber: number | undefined;
  let pos = 0;

  while (pos < length) {
    const idLength = vintLength(bytes[pos], 4);
    if (!idLength || pos + idLength >= length) break;
    const id = readUint(bytes, pos, pos + idLength);
    pos += idLength;

    const sizeLength = vintLength(bytes[pos], 8);
    if (!sizeLength || pos + sizeLength > length) break;
    let size = bytes[pos] & (0xFF >> sizeLength);
    let unknownSize = size === (0xFF >> sizeLength);
    for (let i = 1; i < sizeLength; i++) {
      size = size * 256 + bytes[pos + i];
      if (bytes[pos + i] !== 0xFF) unknownSize = false;
    }
    pos += sizeLength;

    if (MASTER_IDS.has(id)) {
      if (id === ID.TrackEntry) tracks.push({});
      continue; // Walk into children
    }

    const end = unknownSize ? length : pos + size;
    if (end > length) break; // Truncated element at the end of the file

    const track = tracks[tracks.length - 1];
    switch (id) {
      case ID.TimecodeScale: timecodeScale = readUint(bytes, pos, end); break;
      case ID.TrackNumber: if (track) track.number = readUint(bytes, pos, end); break;
      case ID.TrackType: if (track) track.type = readUint(bytes, pos, end); break;
      case ID.CodecID: if (track) track.codecId = String.fromCharCode(...bytes.subarray(pos, end)); break;
      case ID.CodecPrivate: if (track) track.codecPrivate = bytes.slice(pos, end); break;
      case ID.Channels: if (track) track.channels = readUint(bytes, pos, end); break;
      case ID.SamplingFrequency: if (track) track.sampleRate = readFloat(bytes, pos, end); break;
      case ID.Timecode: clusterTimecode = readUint(bytes, pos, end); break;
      case ID.SimpleBlock:
      case ID.Block: {
        if (audioTrackNumber === undefined) {
          const audioTrack = tracks.find(t => t.type === 2 || t.codecId?.startsWith('A_'));
          if (!audioTrack) throw new Error('WebM file has no audio track');
          audioTrackNumber = audioTrack.number;
        }
        const trackLength = vintLength(bytes[pos], 8);
        const trackNumber = readUint(bytes, pos, pos + trackLength) - (0x80 >> (trackLength - 1)) * Math.pow(256, trackLength - 1);
        if (trackNumber !== audioTrackNumber) break;
        const headerEnd = pos + trackLength + 3;
        const relativeTimecode = (bytes[pos + trackLength] << 24 >> 16) | bytes[pos + trackLength + 1];
        const flags = bytes[pos + trackLength + 2];
        if (flags & 0x06) throw new Error('Laced WebM blocks are not supported');
        frames.push({
          timestampUs: ((clusterTimecode + relativeTimecode) * timecodeScale) / 1000,
          data: bytes.subarray(headerEnd, end)
        });
        break;
      }
    }
    pos = end;
  }

  const audioTrack = tracks.find(t => t.number === audioTrackNumber) || tracks.find(t => t.type === 2 || t.codecId?.startsWith('A_'));
  if (!audioTrack || !audioTrack.codecId) throw new Error('WebM file has no audio track');

  return {
    codecId: audioTrack.codecId,
    codecPrivate: audioTrack.codecPrivate,
    channels: audioTrack.channels || 2,
    sampleRate: audioTrack.sampleRate || 48000,
    frames
  };
}

// --- Muxer ---

function idBytes(id: number): number[] {
  const out: number[] = [];
  while (id > 0) {
    out.unshift(id & 0xFF);
    id = Math.floor(id / 256);
  }
  return out;
}

// 8-byte size field: valid for any size up to 2^56 - 2
function sizeBytes(size: number): number[] {
  const out = [0x01];
  for (let i = 6; i >= 0; i--) out.push(Math.floor(size / Math.pow(256, i)) & 0xFF);
  return out;
}

function uintBytes(value: number): number[] {
  const out: number[] = [];
  do {
    out.unshift(value & 0xFF);
    value = Math.floor(value / 256);
  } while (value > 0);
  return out;
}

function element(id: number, payload: ArrayLike<number>): Uint8Array<ArrayBuffer> {
  const head = [...idBytes(id), ...sizeBytes(payload.length)];
  const out = new Uint8Array(head.length + payload.length);
  out.set(head, 0);
  out.set(payload, head.length);
  return out;
}

function concat(parts: ArrayLike<number>[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function uintElement(id: number, value: number): Uint8Array<ArrayBuffer> {
  return element(id, uintBytes(value));
}

function floatElement(id: number, value: number): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setFloat64(0, value);
  return element(id, buf);
}

function stringElement(id: number, value: string): Uint8Array<ArrayBuffer> {
  return element(id, Array.from(value, c => c.charCodeAt(0)));
}

const CLUSTER_DURATION_MS = 5000;

// Streams Opus packets into a WebM file. Output is a Blob assembled from parts, so memory use
// stays bounded; the header is written last because it carries the final duration.
export class WebmOpusMuxer {
  private parts: Blob[] = [];
  private clusterBlocks: Uint8Array<ArrayBuffer>[] = [];
  private clusterStartMs = -1;
  private bodySize = 0;
  private lastTimestampMs = 0;

  constructor(private channels: number, private opusHead: Uint8Array, private preSkip: number) { }

  addPacket(data: Uint8Array, timestampUs: number, durationUs: number) {
    const timestampMs = Math.round(timestampUs / 1000);
    if (this.clusterStartMs < 0 || timestampMs - this.clusterStartMs >= CLUSTER_DURATION_MS) {
      this.flushCluster();
      this.clusterStartMs = timestampMs;
    }
    const relative = timestampMs - this.clusterStartMs;
    const block = new Uint8Array(4 + data.length);
    block[0] = 0x81; // track 1
    block[1] = (relative >> 8) & 0xFF;
    block[2] = relative & 0xFF;
    block[3] = 0x80; // keyframe
    block.set(data, 4);
    this.clusterBlocks.push(element(ID.SimpleBlock, block));
    this.lastTimestampMs = (timestampUs + durationUs) / 1000;
  }

  private flushCluster() {
    if (this.clusterBlocks.length === 0) return;
    const cluster = element(ID.Cluster, concat([uintElement(ID.Timecode, this.clusterStartMs), ...this.clusterBlocks]));
    this.parts.push(new Blob([cluster]));
    this.bodySize += cluster.length;
    this.clusterBlocks = [];
  }

  finish(): Blob {
    this.flushCluster();

    const ebmlHeader = element(ID.EBML, concat([
      uintElement(0x4286, 1), // EBMLVersion
      uintElement(0x42F7, 1), // EBMLReadVersion
      uintElement(0x42F2, 4), // EBMLMaxIDLength
      uintElement(0x42F3, 8), // EBMLMaxSizeLength
      stringElement(0x4282, 'webm'), // DocType
      uintElement(0x4287, 4), // DocTypeVersion
      uintElement(0x4285, 2) // DocTypeReadVersion
    ]));

    const info = element(ID.Info, concat([
      uintElement(ID.TimecodeScale, 1000000),
      floatElement(ID.Duration, this.lastTimestampMs),
      stringElement(ID.MuxingApp, 'Chrome Recorder'),
      stringElement(ID.WritingApp, 'Chrome Recorder')
    ]));

    const tracks = element(ID.Tracks, element(ID.TrackEntry, concat([
      uintElement(ID.TrackNumber, 1),
      uintElement(ID.TrackUID, 1),
      uintElement(ID.TrackType, 2),
      stringElement(ID.CodecID, 'A_OPUS'),
      element(ID.CodecPrivate, this.opusHead),
      uintElement(ID.CodecDelay, Math.round(this.preSkip * 1e9 / 48000)),
      uintElement(ID.SeekPreRoll, 80000000),
      element(ID.Audio, concat([
        floatElement(ID.SamplingFrequency, 48000),
        uintElement(ID.Channels, this.channels)
      ]))
    ])));

    const segmentSize = info.length + tracks.length + this.bodySize;
    const segmentHead = new Uint8Array([...idBytes(ID.Segment), ...sizeBytes(segmentSize)]);
    return new Blob([ebmlHeader, segmentHead, info, tracks, ...this.parts], { type: 'audio/webm' });
  }
}
