// Ogg Opus muxer (RFC 7845). Used to write OGG downloads without real-time re-recording.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) {
      r = (r & 0x80000000) ? ((r << 1) ^ 0x04C11DB7) : (r << 1);
    }
    table[i] = r >>> 0;
  }
  return table;
})();

function oggCrc(data: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < data.length; i++) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) & 0xFF) ^ data[i]]) >>> 0;
  }
  return crc;
}

// Samples (at 48 kHz) in an Opus packet, from its TOC byte (RFC 6716 section 3.1)
export function opusPacketSamples(packet: Uint8Array): number {
  if (packet.length === 0) return 0;
  const toc = packet[0];
  const config = toc >> 3;
  let frameSize: number; // in samples at 48 kHz
  if (config < 12) {
    frameSize = [480, 960, 1920, 2880][config & 3]; // SILK: 10, 20, 40, 60 ms
  } else if (config < 16) {
    frameSize = [480, 960][config & 1]; // Hybrid: 10, 20 ms
  } else {
    frameSize = [120, 240, 480, 960][config & 3]; // CELT: 2.5, 5, 10, 20 ms
  }
  const code = toc & 3;
  const frameCount = code === 0 ? 1 : code === 3 ? (packet.length > 1 ? packet[1] & 0x3F : 0) : 2;
  return frameSize * frameCount;
}

// Build an OpusHead identification header
export function buildOpusHead(channels: number, preSkip: number, inputSampleRate: number): Uint8Array {
  const head = new Uint8Array(19);
  const view = new DataView(head.buffer);
  head.set([0x4F, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]); // "OpusHead"
  head[8] = 1; // version
  head[9] = channels;
  view.setUint16(10, preSkip, true);
  view.setUint32(12, inputSampleRate, true);
  view.setInt16(16, 0, true); // output gain
  head[18] = 0; // channel mapping family
  return head;
}

export function opusHeadPreSkip(opusHead: Uint8Array): number {
  return opusHead.length >= 12 ? opusHead[10] | (opusHead[11] << 8) : 312;
}

function buildOpusTags(): Uint8Array {
  const vendor = 'Chrome Recorder';
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  const view = new DataView(tags.buffer);
  tags.set([0x4F, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73]); // "OpusTags"
  view.setUint32(8, vendor.length, true);
  for (let i = 0; i < vendor.length; i++) tags[12 + i] = vendor.charCodeAt(i);
  view.setUint32(12 + vendor.length, 0, true); // no user comments
  return tags;
}

const MAX_PACKETS_PER_PAGE = 50;

export class OggOpusMuxer {
  private parts: Blob[] = [];
  private pending: Uint8Array[] = [];
  private pendingSegments = 0;
  private granule = 0;
  private sequence = 0;
  private serial = (Math.random() * 0xFFFFFFFF) >>> 0;

  constructor(opusHead: Uint8Array) {
    this.writePage([opusHead], 0, 0x02); // beginning of stream
    this.writePage([buildOpusTags()], 0, 0);
  }

  // Granule positions count every decoded sample, including the encoder pre-skip
  addPacket(packet: Uint8Array, samples: number = opusPacketSamples(packet)) {
    const segments = Math.floor(packet.length / 255) + 1;
    if (this.pending.length >= MAX_PACKETS_PER_PAGE || this.pendingSegments + segments > 255) {
      this.flushPage(0);
    }
    this.pending.push(packet);
    this.pendingSegments += segments;
    this.granule += samples;
  }

  private flushPage(flags: number) {
    if (this.pending.length === 0 && !(flags & 0x04)) return;
    this.writePage(this.pending, this.granule, flags);
    this.pending = [];
    this.pendingSegments = 0;
  }

  private writePage(packets: Uint8Array[], granule: number, flags: number) {
    const lacing: number[] = [];
    for (const packet of packets) {
      let remaining = packet.length;
      while (remaining >= 255) {
        lacing.push(255);
        remaining -= 255;
      }
      lacing.push(remaining);
    }
    const dataLength = packets.reduce((sum, p) => sum + p.length, 0);
    const page = new Uint8Array(27 + lacing.length + dataLength);
    const view = new DataView(page.buffer);
    page.set([0x4F, 0x67, 0x67, 0x53]); // "OggS"
    page[4] = 0; // version
    page[5] = flags;
    view.setUint32(6, granule % 0x100000000, true);
    view.setUint32(10, Math.floor(granule / 0x100000000), true);
    view.setUint32(14, this.serial, true);
    view.setUint32(18, this.sequence++, true);
    page[26] = lacing.length;
    page.set(lacing, 27);
    let offset = 27 + lacing.length;
    for (const packet of packets) {
      page.set(packet, offset);
      offset += packet.length;
    }
    view.setUint32(22, oggCrc(page), true);
    this.parts.push(new Blob([page]));
  }

  finish(): Blob {
    this.flushPage(0x04); // end of stream
    return new Blob(this.parts, { type: 'audio/ogg' });
  }
}
