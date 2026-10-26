// Streaming WAV writer and reader.
// The writer emits RIFF/WAVE, switching to RF64 (EBU Tech 3306) when the data exceeds 4 GB,
// which plain WAV's 32-bit size fields cannot describe.

const FLUSH_BYTES = 4 * 1024 * 1024;
const RIFF_MAX_DATA = 0xFFFFFFFF - 36;

function writeString(view: DataView, offset: number, value: string) {
  for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
}

function setUint64(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value % 0x100000000, true);
  view.setUint32(offset + 4, Math.floor(value / 0x100000000), true);
}

export class WavWriter {
  private parts: Blob[] = [];
  private buffer: Uint8Array;
  private view: DataView;
  private offset = 0;
  private dataSize = 0;
  private bytesPerSample: number;

  constructor(private sampleRate: number, private channels: number, private bitDepth: number) {
    if (bitDepth !== 16 && bitDepth !== 24 && bitDepth !== 32) {
      throw new Error(`Unsupported bit depth: ${bitDepth}`);
    }
    this.bytesPerSample = bitDepth / 8;
    this.buffer = new Uint8Array(FLUSH_BYTES);
    this.view = new DataView(this.buffer.buffer);
  }

  write(planar: Float32Array[]) {
    const frames = planar[0].length;
    const frameBytes = this.channels * this.bytesPerSample;
    const view = this.view;

    for (let i = 0; i < frames; i++) {
      if (this.offset + frameBytes > this.buffer.length) this.flush();
      for (let c = 0; c < this.channels; c++) {
        const s = Math.max(-1, Math.min(1, planar[c][i]));
        if (this.bitDepth === 16) {
          view.setInt16(this.offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        } else if (this.bitDepth === 24) {
          const v = Math.round(s < 0 ? s * 0x800000 : s * 0x7FFFFF);
          this.buffer[this.offset] = v & 0xFF;
          this.buffer[this.offset + 1] = (v >> 8) & 0xFF;
          this.buffer[this.offset + 2] = (v >> 16) & 0xFF;
        } else {
          view.setInt32(this.offset, s < 0 ? s * 0x80000000 : s * 0x7FFFFFFF, true);
        }
        this.offset += this.bytesPerSample;
      }
    }
    this.dataSize += frames * frameBytes;
  }

  private flush() {
    if (this.offset === 0) return;
    this.parts.push(new Blob([this.buffer.slice(0, this.offset)]));
    this.offset = 0;
  }

  finish(): Blob {
    this.flush();
    const blockAlign = this.channels * this.bytesPerSample;
    const padded = this.dataSize % 2 === 1;
    const useRf64 = this.dataSize > RIFF_MAX_DATA;
    const headerSize = useRf64 ? 80 : 44;
    const header = new ArrayBuffer(headerSize);
    const view = new DataView(header);
    const fileSize = headerSize + this.dataSize + (padded ? 1 : 0);

    let offset = 0;
    if (useRf64) {
      writeString(view, 0, 'RF64');
      view.setUint32(4, 0xFFFFFFFF, true);
      writeString(view, 8, 'WAVE');
      writeString(view, 12, 'ds64');
      view.setUint32(16, 28, true);
      setUint64(view, 20, fileSize - 8); // RIFF size
      setUint64(view, 28, this.dataSize); // data size
      setUint64(view, 36, this.dataSize / blockAlign); // sample count
      view.setUint32(44, 0, true); // table length
      offset = 48;
    } else {
      writeString(view, 0, 'RIFF');
      view.setUint32(4, fileSize - 8, true);
      writeString(view, 8, 'WAVE');
      offset = 12;
    }

    writeString(view, offset, 'fmt ');
    view.setUint32(offset + 4, 16, true); // fmt chunk size
    view.setUint16(offset + 8, 1, true); // audio format (PCM)
    view.setUint16(offset + 10, this.channels, true);
    view.setUint32(offset + 12, this.sampleRate, true);
    view.setUint32(offset + 16, this.sampleRate * blockAlign, true); // byte rate
    view.setUint16(offset + 20, blockAlign, true);
    view.setUint16(offset + 22, this.bitDepth, true);
    writeString(view, offset + 24, 'data');
    view.setUint32(offset + 28, useRf64 ? 0xFFFFFFFF : this.dataSize, true);

    const parts: BlobPart[] = [header, ...this.parts];
    if (padded) parts.push(new Uint8Array(1)); // RIFF chunks are word-aligned
    return new Blob(parts, { type: 'audio/wav' });
  }
}

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  isFloat: boolean;
  dataOffset: number;
  dataSize: number;
}

export function isWav(header: Uint8Array): boolean {
  const tag = String.fromCharCode(...header.subarray(0, 4));
  const wave = String.fromCharCode(...header.subarray(8, 12));
  return (tag === 'RIFF' || tag === 'RF64') && wave === 'WAVE';
}

export async function readWavInfo(blob: Blob): Promise<WavInfo> {
  const head = new DataView(await blob.slice(0, 12).arrayBuffer());
  const isRf64 = String.fromCharCode(head.getUint8(0), head.getUint8(1), head.getUint8(2), head.getUint8(3)) === 'RF64';

  let offset = 12;
  let rf64DataSize: number | undefined;
  let fmt: DataView | null = null;

  while (offset + 8 <= blob.size) {
    const chunkHead = new DataView(await blob.slice(offset, offset + 8).arrayBuffer());
    const id = String.fromCharCode(chunkHead.getUint8(0), chunkHead.getUint8(1), chunkHead.getUint8(2), chunkHead.getUint8(3));
    const size = chunkHead.getUint32(4, true);
    const body = offset + 8;

    if (id === 'ds64') {
      const ds64 = new DataView(await blob.slice(body, body + 16).arrayBuffer());
      rf64DataSize = ds64.getUint32(8, true) + ds64.getUint32(12, true) * 0x100000000;
    } else if (id === 'fmt ') {
      fmt = new DataView(await blob.slice(body, body + Math.min(size, 40)).arrayBuffer());
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV file has no fmt chunk');
      let formatTag = fmt.getUint16(0, true);
      if (formatTag === 0xFFFE && fmt.byteLength >= 26) formatTag = fmt.getUint16(24, true); // WAVE_FORMAT_EXTENSIBLE
      const declared = isRf64 && size === 0xFFFFFFFF ? rf64DataSize : size;
      return {
        channels: fmt.getUint16(2, true),
        sampleRate: fmt.getUint32(4, true),
        bitsPerSample: fmt.getUint16(14, true),
        isFloat: formatTag === 3,
        dataOffset: body,
        dataSize: Math.min(declared ?? Infinity, blob.size - body)
      };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('WAV file has no data chunk');
}

const READ_FRAMES = 65536;

// Yield planar float blocks from a WAV blob without loading the whole file
export async function* readWavBlocks(blob: Blob, info: WavInfo): AsyncGenerator<Float32Array[]> {
  const bytesPerSample = info.bitsPerSample / 8;
  const blockAlign = bytesPerSample * info.channels;
  const end = info.dataOffset + info.dataSize - (info.dataSize % blockAlign);

  for (let pos = info.dataOffset; pos < end; pos += READ_FRAMES * blockAlign) {
    const sliceEnd = Math.min(end, pos + READ_FRAMES * blockAlign);
    const view = new DataView(await blob.slice(pos, sliceEnd).arrayBuffer());
    const frames = (sliceEnd - pos) / blockAlign;
    const planar = Array.from({ length: info.channels }, () => new Float32Array(frames));

    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < info.channels; c++) {
        const o = i * blockAlign + c * bytesPerSample;
        let v: number;
        if (info.isFloat) {
          v = bytesPerSample === 8 ? view.getFloat64(o, true) : view.getFloat32(o, true);
        } else if (bytesPerSample === 1) {
          v = (view.getUint8(o) - 128) / 128;
        } else if (bytesPerSample === 2) {
          v = view.getInt16(o, true) / 0x8000;
        } else if (bytesPerSample === 3) {
          v = ((view.getUint8(o + 2) << 24 >> 8) | (view.getUint8(o + 1) << 8) | view.getUint8(o)) / 0x800000;
        } else {
          v = view.getInt32(o, true) / 0x80000000;
        }
        planar[c][i] = v;
      }
    }
    yield planar;
  }
}
