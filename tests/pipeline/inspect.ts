// Structural checks on exported files. They read container headers directly, because decoders
// tolerate wrong chunk sizes, bad page CRCs and missing durations that other players do not.
import { opusHeadPreSkip } from '../../src/popup/utils/ogg';

export async function inspectWav(blob: Blob) {
  const view = new DataView(await blob.slice(0, 44).arrayBuffer());
  const tag = (offset: number) => String.fromCharCode(...new Uint8Array(view.buffer, offset, 4));
  const blockAlign = view.getUint16(32, true);
  const dataSize = view.getUint32(40, true);
  return {
    headerOk: tag(0) === 'RIFF' && view.getUint32(4, true) === blob.size - 8 &&
      tag(36) === 'data' && 44 + dataSize + (dataSize % 2) === blob.size && dataSize % blockAlign === 0 &&
      view.getUint32(28, true) === view.getUint32(24, true) * blockAlign,
    sampleRate: view.getUint32(24, true),
    bitDepth: view.getUint16(34, true),
    frames: dataSize / blockAlign
  };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = (r & 0x80000000) ? (r << 1) ^ 0x04C11DB7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

// Walks every Ogg page: capture pattern, CRC, sequence numbers, BOS/EOS flags and granule positions
export async function inspectOgg(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let pos = 0, pages = 0, crcOk = true, sequenceOk = true, granulesOk = true, bos = false, eos = false;
  let lastGranule = 0, preSkip = -1;
  while (pos < bytes.length) {
    if (String.fromCharCode(...bytes.subarray(pos, pos + 4)) !== 'OggS') return { error: `no page at ${pos}` };
    const view = new DataView(bytes.buffer, pos);
    const segments = bytes[pos + 26];
    const pageLength = 27 + segments + bytes.subarray(pos + 27, pos + 27 + segments).reduce((s, x) => s + x, 0);
    const page = bytes.slice(pos, pos + pageLength);
    page.fill(0, 22, 26);
    let crc = 0;
    for (let i = 0; i < page.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) & 0xFF) ^ page[i]]) >>> 0;
    if (crc !== view.getUint32(22, true)) crcOk = false;
    if (view.getUint32(18, true) !== pages) sequenceOk = false;
    const granule = view.getUint32(6, true) + view.getUint32(10, true) * 2 ** 32;
    if (pages === 0) {
      bos = bytes[pos + 5] === 0x02;
      preSkip = opusHeadPreSkip(bytes.subarray(pos + 27 + segments, pos + pageLength));
    } else if (pages >= 2) {
      if (granule < lastGranule) granulesOk = false;
      lastGranule = granule;
    }
    eos = (bytes[pos + 5] & 0x04) !== 0;
    pages++;
    pos += pageLength;
  }
  return { pages, crcOk, sequenceOk, granulesOk, bos, eos, seconds: (lastGranule - preSkip) / 48000 };
}

// Duration as a media element sees it: Infinity when a WebM has no Duration element
export async function mediaElementDuration(blob: Blob): Promise<number | null> {
  const audio = new Audio(URL.createObjectURL(blob));
  await new Promise((resolve, reject) => { audio.onloadedmetadata = resolve; audio.onerror = reject; });
  return Number.isFinite(audio.duration) ? audio.duration : null;
}
