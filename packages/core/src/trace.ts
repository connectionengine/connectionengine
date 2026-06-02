/**
 * Structured trace log.
 *
 * Every meaningful event in the engine emits a TraceEvent. Tests assert against
 * trace shape (origin, predicate, accept/reject, peer, timestamp) — this is the
 * single most valuable debugging surface for distributed/observer behaviour.
 */

export type TraceKind =
  | 'entity.create'
  | 'entity.remove'
  | 'component.set'
  | 'component.remove'
  | 'relation.add'
  | 'relation.remove'
  | 'mutation.emit'
  | 'mutation.receive'
  | 'mutation.reject'
  | 'transport.send'
  | 'transport.receive'
  | 'authority.request'
  | 'authority.transfer'
  | 'snapshot.create'
  | 'snapshot.apply'
  | 'governance.accept'
  | 'governance.reject'

export type Origin = 'local' | 'network' | 'system'

export interface TraceEvent {
  kind: TraceKind
  /** Wall-clock time in ms (deterministic in tests via injected clock) */
  ts: number
  /** Origin tag — drives re-broadcast suppression */
  origin?: Origin
  /** Peer id of the local engine (undefined before peer creation) */
  peer?: string
  /** Predicate / component or relation id (e.g. 'Transform', 'BelongsTo') */
  predicate?: string
  /** Entity involved (local id, runtime-only) */
  entity?: number
  /** Free-form details */
  detail?: Record<string, unknown>
}

export interface TraceSink {
  emit(event: TraceEvent): void
  events(): readonly TraceEvent[]
  clear(): void
  /** Filter helper — returns events matching kind. */
  byKind(kind: TraceKind): readonly TraceEvent[]
}

export const createTraceSink = (): TraceSink => {
  const events: TraceEvent[] = []
  return {
    emit: (event) => {
      events.push(event)
    },
    events: () => events,
    clear: () => {
      events.length = 0
    },
    byKind: (kind) => events.filter((e) => e.kind === kind)
  }
}

/** A noop sink for production / detached worlds. */
export const noopTraceSink: TraceSink = {
  emit: () => {},
  events: () => [],
  clear: () => {},
  byKind: () => []
}
