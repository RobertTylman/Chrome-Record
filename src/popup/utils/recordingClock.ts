// The popup's recording clock. The recorder reports its recorded time (the same clock that
// enforces the length limit, pauses excluded) many times a second; between reports the clock runs
// on locally so it ticks smoothly. Until the first report arrives it starts from an estimate.

export interface ClockState {
  seconds: number; // recorded seconds at `at`
  at: number; // performance.now()
  paused: boolean;
  synced: boolean; // `seconds` came from the recorder rather than an estimate
}

// How far the clock may run past the recorder's last report. Reports arrive about every 16 ms, so
// this only matters when they stop, e.g. while the computer sleeps and no audio is recorded.
export const MAX_RUN_AHEAD_SECONDS = 0.25;
// Ignore tiny backward steps when a report lands, so the hundredths don't flicker
export const BACKWARD_JITTER_SECONDS = 0.05;

export function clockSeconds(clock: ClockState, now = performance.now()): number {
  if (clock.paused) return clock.seconds;
  const elapsed = Math.max(0, (now - clock.at) / 1000);
  return clock.seconds + (clock.synced ? Math.min(elapsed, MAX_RUN_AHEAD_SECONDS) : elapsed);
}

// The value to show next, given the one shown last
export function smoothClock(clock: ClockState, shown: number, now = performance.now()): number {
  const value = clockSeconds(clock, now);
  if (!clock.paused && value < shown && shown - value < BACKWARD_JITTER_SECONDS) return shown;
  return value;
}

// Wall-clock estimate of recorded time from the state the background keeps, excluding pauses
export function estimateSeconds(startTime: number, pausedAt: number | null, pausedTotal: number, now = Date.now()): number {
  const end = pausedAt ?? now;
  return Math.max(0, (end - startTime - pausedTotal) / 1000);
}
