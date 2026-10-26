// MP3 encoding with lamejs, shared by the MP3 Web Worker and the in-page fallback
// @ts-ignore - lamejs lacks type definitions
import * as lamejs_base from 'lamejs';

// Fix for lamejs scope issues - it expects these to be global (window or worker scope)
const g = globalThis as any;
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

export const MP3_BITRATE_KBPS = 128;

function toInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return out;
}

export class Mp3BlockEncoder {
  private encoder: any;

  constructor(private channels: number, sampleRate: number) {
    // @ts-ignore
    this.encoder = new lamejs_base.Mp3Encoder(channels, sampleRate, MP3_BITRATE_KBPS);
  }

  encode(left: Float32Array, right?: Float32Array): Int8Array {
    const l = toInt16(left);
    const r = this.channels > 1 && right ? toInt16(right) : undefined;
    return this.encoder.encodeBuffer(l, r);
  }

  flush(): Int8Array {
    return this.encoder.flush();
  }
}
