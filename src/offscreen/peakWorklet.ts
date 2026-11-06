// AudioWorklet that measures waveform peaks while recording.
// Posts { max, avg } (absolute amplitude, 0-1) per window of `windowSize` frames for the saved
// waveform, and { live: true, max, avg } per shorter `liveWindowSize` window for the live view.

class Window {
  count = 0;
  max = 0;
  sum = 0;

  add(sample: number, size: number): { max: number; avg: number } | null {
    if (sample > this.max) this.max = sample;
    this.sum += sample;
    if (++this.count < size) return null;
    const result = { max: this.max, avg: this.sum / this.count };
    this.count = 0;
    this.max = 0;
    this.sum = 0;
    return result;
  }
}
export { };

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: any);
}
declare function registerProcessor(name: string, processorCtor: any): void;

class PeakMeterProcessor extends AudioWorkletProcessor {
  private windowSize: number;
  private liveWindowSize: number;
  private stored = new Window();
  private live = new Window();
  private paused = false;

  constructor(options: any) {
    super(options);
    this.windowSize = options.processorOptions.windowSize;
    this.liveWindowSize = options.processorOptions.liveWindowSize || 0;
    this.port.onmessage = (event: MessageEvent) => {
      if (event.data === 'pause') this.paused = true;
      if (event.data === 'resume') this.paused = false;
    };
  }

  process(inputs: Float32Array[][]): boolean {
    if (this.paused) return true;

    const input = inputs[0];
    // A disconnected or silent input still advances time so peaks stay aligned with the recording
    const frames = input && input.length > 0 ? input[0].length : 128;

    for (let i = 0; i < frames; i++) {
      let sample = 0;
      if (input) {
        for (let c = 0; c < input.length; c++) {
          const abs = Math.abs(input[c][i]);
          if (abs > sample) sample = abs;
        }
      }
      const stored = this.stored.add(sample, this.windowSize);
      if (stored) this.port.postMessage(stored);
      if (this.liveWindowSize) {
        const live = this.live.add(sample, this.liveWindowSize);
        if (live) this.port.postMessage({ live: true, ...live });
      }
    }
    return true;
  }
}

registerProcessor('peak-meter', PeakMeterProcessor);
