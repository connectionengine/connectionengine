/**
 * AuthoredEvent ↔ AD4M Link / LinkExpression encoding.
 *
 * v0 encoding — one Link per event:
 *   source    = `cengine:event:<JSON entityPath>`
 *   predicate = `<op>:<predicate>`     (e.g. `set:Health`)
 *   target    = JSON-encoded value
 *
 * Author + timestamp + signature live on the LinkExpression wrapper that AD4M
 * adds when the link enters a Perspective.
 */

import { Link, type LinkExpression } from '@coasys/ad4m'
import type { AuthoredEvent } from '@connectionengine/core'

const PREFIX = 'cengine:event:'

export const eventToLink = (event: AuthoredEvent): Link =>
  new Link({
    source: `${PREFIX}${JSON.stringify(event.entityPath)}`,
    predicate: `${event.op}:${event.predicate}`,
    target: JSON.stringify(event.value)
  })

export const linkExpressionToEvent = (le: LinkExpression): AuthoredEvent | null => {
  const link = le.data ?? le
  if (typeof link.source !== 'string' || !link.source.startsWith(PREFIX)) return null
  if (typeof link.predicate !== 'string') return null
  const colon = link.predicate.indexOf(':')
  if (colon === -1) return null
  const op = link.predicate.slice(0, colon) as AuthoredEvent['op']
  if (op !== 'set' && op !== 'remove' && op !== 'spawn' && op !== 'destroy') return null
  let entityPath: string[]
  let value: unknown
  try {
    entityPath = JSON.parse(link.source.slice(PREFIX.length))
    value = JSON.parse(link.target)
  } catch {
    return null
  }
  return {
    entityPath,
    predicate: link.predicate.slice(colon + 1),
    op,
    value,
    author: le.author,
    timestamp: Number(le.timestamp) || 0
  }
}
