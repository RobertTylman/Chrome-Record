import { test, expect } from '@playwright/test';
import { clockSeconds, estimateSeconds, smoothClock, MAX_RUN_AHEAD_SECONDS } from '../src/popup/utils/recordingClock';

// The popup clock follows the recorder's own clock, which is what enforces the length limit

test('runs on between recorder reports', () => {
  const clock = { seconds: 100, at: 1000, paused: false, synced: true };
  expect(clockSeconds(clock, 1016)).toBeCloseTo(100.016, 6);
});

test('does not run ahead while reports stop (computer asleep, no audio recorded)', () => {
  const clock = { seconds: 600, at: 0, paused: false, synced: true };
  // 30 minutes of wall-clock time pass with no reports
  expect(clockSeconds(clock, 30 * 60 * 1000)).toBe(600 + MAX_RUN_AHEAD_SECONDS);
});

test('holds while paused', () => {
  const clock = { seconds: 42.5, at: 0, paused: true, synced: true };
  expect(clockSeconds(clock, 60_000)).toBe(42.5);
});

test('an estimate runs on freely until the first report', () => {
  const clock = { seconds: 10, at: 0, paused: false, synced: false };
  expect(clockSeconds(clock, 5000)).toBe(15);
});

test('ignores tiny backward steps but follows real corrections', () => {
  const clock = { seconds: 10, at: 0, paused: false, synced: true };
  expect(smoothClock(clock, 10.03, 0)).toBe(10.03); // jitter: keep what is shown
  expect(smoothClock(clock, 12, 0)).toBe(10); // a real correction moves back
  expect(smoothClock({ ...clock, paused: true }, 10.03, 0)).toBe(10); // paused shows the exact time
});

test('estimate excludes paused time', () => {
  expect(estimateSeconds(0, null, 2000, 10_000)).toBe(8);
  expect(estimateSeconds(0, 6000, 1000, 10_000)).toBe(5);
});
