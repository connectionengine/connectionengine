/**
 * Injectable clock — wall-clock by default, manual for tests.
 *
 * Time-dependent behaviour (event timestamps, temporal governance, snapshot
 * metadata) reads from this clock so tests can drive deterministic time.
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
