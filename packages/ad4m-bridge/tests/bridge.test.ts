/**
 * AD4M bridge unit tests.
 *
 * Uses real `@coasys/ad4m` classes (Link, LinkExpression, ExpressionProof)
 * for data shapes, and structurally-typed `Ad4mClient` / `PerspectiveProxy`
 * test doubles for the I/O surfaces. The doubles satisfy the real interfaces
 * for the methods the bridge actually calls (me, signMessage, addLinks,
 * addListener, removeListener) — TypeScript verifies this via cast.
 *
 * End-to-end tests against a running AD4M executor require Holochain and
 * live elsewhere.
 */

import { describe, expect, it, vi } from 'vitest'
import { Ad4mClient, ExpressionProof, Link, LinkExpression, PerspectiveProxy } from '@coasys/ad4m'
import {
  applyAuthoredEnvelope,
  type AuthoredEvent,
  createEngine,
  defineComponent,
  destroyWorld,
  getComponent,
  getEntityByUID,
  getNetwork,
  publishAuthored,
  Schema
} from '@connectionengine/core'
import { AD4M_NETWORK_ID, createAd4mAgent, eventToLink, linkExpressionToEvent } from '../src'
import { createAd4mRuntime } from '../src/runtime'

const Health = defineComponent({
  id: 'B.Health',
  schema: Schema.Object({
    current: Schema.Number({ default: 100 }),
    max: Schema.Number({ default: 100 })
  })
})

// ── Test doubles ──────────────────────────────────────────────────────────────
// Structurally satisfy the methods we use; cast through `unknown` because the
// real classes carry private state we don't replicate.

const mockClient = (did: string): Ad4mClient =>
  ({
    agent: {
      me: vi.fn().mockResolvedValue({ did }),
      signMessage: vi.fn().mockImplementation(async (msg: string) => `sig:${msg.slice(0, 8)}`)
    }
  }) as unknown as Ad4mClient

interface MockPerspective {
  proxy: PerspectiveProxy
  listeners: Set<(le: LinkExpression) => void>
  added: ReturnType<typeof vi.fn>
}

const mockPerspective = (): MockPerspective => {
  const listeners = new Set<(le: LinkExpression) => void>()
  const added = vi.fn().mockImplementation(async (links) => links)
  const proxy = {
    add: vi.fn(),
    addLinks: added,
    remove: vi.fn(),
    addListener: vi.fn().mockImplementation(async (_type: string, cb: (le: LinkExpression) => void) => {
      listeners.add(cb)
    }),
    removeListener: vi.fn().mockImplementation(async (_type: string, cb: (le: LinkExpression) => void) => {
      listeners.delete(cb)
    })
  } as unknown as PerspectiveProxy
  return { proxy, listeners, added }
}

const mkLinkExpression = (event: AuthoredEvent): LinkExpression => {
  const link = eventToLink(event)
  return Object.assign(new LinkExpression(), {
    author: event.author,
    timestamp: String(event.timestamp),
    data: link,
    proof: new ExpressionProof('sig', 'key'),
    source: link.source,
    target: link.target,
    predicate: link.predicate
  }) as LinkExpression
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createAd4mAgent', () => {
  it('wraps an Ad4mClient agent into an opaque Agent with did + sign', async () => {
    const client = mockClient('did:ad4m:test-alice')
    const agent = await createAd4mAgent(client)
    expect(agent.did).toBe('did:ad4m:test-alice')
    const sig = await agent.sign!(new Uint8Array([1, 2, 3, 4]))
    expect(sig).toBeInstanceOf(Uint8Array)
    expect(client.agent.signMessage).toHaveBeenCalledWith('01020304')
  })
})

describe('expression encoding', () => {
  it('eventToLink + linkExpressionToEvent round-trip preserves the event', () => {
    const event: AuthoredEvent = {
      entityPath: ['scene:main', 'avatar:alice'],
      predicate: 'B.Health',
      op: 'set',
      value: { current: 50, max: 100 },
      author: 'did:ad4m:alice',
      timestamp: 1234567890,
      seq: 0
    }
    const link = eventToLink(event)
    expect(link).toBeInstanceOf(Link)
    expect(link.source).toContain('cengine:event:')
    // op : seq : predicate — seq keeps two same-value writes in one tick distinct
    expect(link.predicate).toBe('set:0:B.Health')
    expect(JSON.parse(link.target)).toEqual({ current: 50, max: 100 })

    const decoded = linkExpressionToEvent(mkLinkExpression(event))
    expect(decoded).toEqual(event)
  })

  it('linkExpressionToEvent returns null for non-cengine links', () => {
    const foreign = Object.assign(new LinkExpression(), {
      author: 'did:ad4m:other',
      timestamp: '0',
      data: new Link({ source: 'flux://some-other-app', target: 'whatever', predicate: 'set:X' }),
      proof: new ExpressionProof('', '')
    }) as LinkExpression
    expect(linkExpressionToEvent(foreign)).toBeNull()
  })
})

describe('connectAd4m — outbound', () => {
  it('publishAuthored calls perspective.addLinks with encoded events', async () => {
    const client = mockClient('did:ad4m:alice')
    const { proxy, added } = mockPerspective()
    const { world } = await createAd4mRuntime(client, proxy, { engine: createEngine() })

    const network = getNetwork(world, AD4M_NETWORK_ID)
    if (!network) throw new Error('expected the ad4m network')
    publishAuthored(world, network, {
      fromPeer: 'did:ad4m:alice',
      events: [
        {
          entityPath: ['scene:x', 'thing'],
          predicate: 'B.Health',
          op: 'set',
          value: { current: 50, max: 100 },
          author: 'did:ad4m:alice',
          timestamp: 0,
          seq: 0
        }
      ]
    })

    await Promise.resolve()
    expect(added).toHaveBeenCalledTimes(1)
    const links = added.mock.calls[0][0] as Link[]
    expect(links[0]).toBeInstanceOf(Link)
    expect(links[0].predicate).toMatch(/^set:\d+:B\.Health$/)

    destroyWorld(world)
  })
})

describe('connectAd4m — inbound', () => {
  it('link-added listener decodes the LinkExpression and applies to the world', async () => {
    const client = mockClient('did:ad4m:bob')
    const { proxy, listeners } = mockPerspective()
    const { world } = await createAd4mRuntime(client, proxy, { engine: createEngine() })

    const aliceEvent: AuthoredEvent = {
      entityPath: ['scene:ad4m', 'avatar'],
      predicate: 'B.Health',
      op: 'set',
      value: { current: 60, max: 100 },
      author: 'did:ad4m:alice',
      timestamp: 0,
      seq: 0
    }

    expect(listeners.size).toBe(1)
    for (const cb of listeners) cb(mkLinkExpression(aliceEvent))

    const scene = getEntityByUID(world, world.worldRoot, 'scene:ad4m')
    expect(scene).toBeDefined()
    const ava = getEntityByUID(world, scene!, 'avatar')
    expect(ava).toBeDefined()
    expect(getComponent(world, ava!, Health)).toEqual({ current: 60, max: 100 })

    destroyWorld(world)
  })

  it('echoes from our own DID are ignored', async () => {
    const client = mockClient('did:ad4m:bob')
    const { proxy, listeners } = mockPerspective()
    const { world } = await createAd4mRuntime(client, proxy, { engine: createEngine() })

    const ownEvent: AuthoredEvent = {
      entityPath: ['echo'],
      predicate: 'B.Health',
      op: 'set',
      value: { current: 1, max: 1 },
      author: 'did:ad4m:bob',
      timestamp: 0,
      seq: 0
    }
    for (const cb of listeners) cb(mkLinkExpression(ownEvent))
    expect(world.eventLog).toEqual([])
    destroyWorld(world)
  })
})

describe('Ad4mTransportHandle.close', () => {
  it('detaches the listener and removes the ad4m network', async () => {
    const client = mockClient('did:ad4m:bob')
    const { proxy, listeners } = mockPerspective()
    const { world, transport } = await createAd4mRuntime(client, proxy, { engine: createEngine() })
    expect(listeners.size).toBe(1)
    expect(getNetwork(world, AD4M_NETWORK_ID)).toBeDefined()
    await transport.close()
    expect(listeners.size).toBe(0)
    expect(getNetwork(world, AD4M_NETWORK_ID)).toBeUndefined()
    destroyWorld(world)
  })
})

describe('Sanity: applyAuthoredEnvelope still works alongside the bridge', () => {
  it('a bridge-installed world still accepts direct envelope applies', async () => {
    const client = mockClient('did:ad4m:carol')
    const { proxy } = mockPerspective()
    const { world } = await createAd4mRuntime(client, proxy, { engine: createEngine() })
    applyAuthoredEnvelope(world, {
      fromPeer: 'did:test:other',
      events: [
        {
          entityPath: ['direct'],
          predicate: 'B.Health',
          op: 'set',
          value: { current: 7, max: 10 },
          author: 'did:test:other',
          timestamp: 0,
          seq: 0
        }
      ]
    })
    expect(world.eventLog.length).toBe(1)
    destroyWorld(world)
  })
})
