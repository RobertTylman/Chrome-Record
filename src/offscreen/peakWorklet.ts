// AudioWorklet that measures waveform peaks while recording.
// Posts one { max, avg } pair (absolute amplitude, 0-1) per window of `windowSize` frames.
export { };

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: any);
}
declare function registerProcessor(name: string, processorCtor: any): void;

class PeakMeterProcessor extends AudioWorkletProcessor {
  private windowSize: number;
  private count = 0;
  private max = 0;
  private sum = 0;
  private paused = false;

  constructor(options: any) {
    super(options);
    this.windowSize = options.processorOptions.windowSize;
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
      if (sample > this.max) this.max = sample;
      this.sum += sample;
      this.count++;

      if (this.count === this.windowSize) {
        this.port.postMessage({ max: this.max, avg: this.sum / this.count });
        this.count = 0;
        this.max = 0;
        this.sum = 0;
      }
    }
    return true;
  }
}

registerProcessor('peak-meter', PeakMeterProcessor);
