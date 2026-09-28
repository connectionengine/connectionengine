import type { AuthoredEvent, World } from './world'

export const eventSignature = (e: AuthoredEvent): string =>
  `${e.author}|${e.timestamp}|${e.seq}|${e.op}|${e.predicate}|${e.entityPath.join('/')}|${JSON.stringify(e.value ?? null)}`

export const appendEventLog = (world: World, event: AuthoredEvent): boolean => {
  const sig = eventSignature(event)
  if (world.eventLogSeen.has(sig)) return false
  world.eventLog.push(event)
  world.eventLogSeen.add(sig)
  return true
}

export const hasEventBeenSeen = (world: World, event: AuthoredEvent): boolean =>
  world.eventLogSeen.has(eventSignature(event))
