/**
 * Injectable clock. It uses the wall clock by default, and a manual clock for
 * tests.
 *
 * Every time-dependent behaviour reads from this clock, which lets a test drive
 * deterministic time. Event timestamps, temporal governance, and snapshot
 * metadata all read from it.
 */

export interface Clock {
  now(): number
}

export const wallClock: Clock = {
  now: () => Date.now()
}

export interface ManualClock extends Clock {
  set(ts: number): void
  advance(ms: number): void
}

export const createManualClock = (start = 0): ManualClock => {
  let t = start
  return {
    now: () => t,
    set: (ts) => {
      t = ts
    },
    advance: (ms) => {
      t += ms
    }
  }
}
