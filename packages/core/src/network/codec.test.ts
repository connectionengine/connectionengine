import { describe, expect, it } from 'vitest'
import type { AuthoredEnvelope } from '../ecs/world'
import { deserializeAuthoredEnvelope, envelopeKind, serializeAuthoredEnvelope } from './codec'

describe('codec — authored envelope', () => {
  it('round-trips an empty envelope', () => {
    const env: AuthoredEnvelope = { fromPeer: 'did:test:alice', events: [] }
    const buf = serializeAuthoredEnvelope(env)
    expect(envelopeKind(buf)).toBe('authored')
    expect(deserializeAuthoredEnvelope(buf)).toEqual(env)
  })

  it('round-trips events with set / remove / spawn / destroy ops', () => {
    const env: AuthoredEnvelope = {
      fromPeer: 'did:test:alice',
      events: [
        {
          author: 'did:test:alice',
          timestamp: 1700000000,
          op: 'set',
          predicate: 'Health',
          entityPath: ['scene:main', 'avatar:alice'],
          value: { current: 50, max: 100 }
        },
        {
          author: 'did:test:alice',
          timestamp: 1700000001,
          op: 'remove',
          predicate: 'Health',
          entityPath: ['scene:main', 'avatar:dead'],
          value: null
        },
        {
          author: 'did:test:bob',
          timestamp: 1700000002,
          op: 'spawn',
          predicate: 'Avatar',
          entityPath: ['scene:main', 'avatar:new'],
          value: { displayName: 'bob' }
        },
        {
          author: 'did:test:alice',
          timestamp: 1700000003,
          op: 'destroy',
          predicate: 'Avatar',
          entityPath: ['scene:main', 'avatar:dead'],
          value: null
        }
      ]
    }
    const buf = serializeAuthoredEnvelope(env)
    expect(deserializeAuthoredEnvelope(buf)).toEqual(env)
  })

  it('handles unicode in DIDs, predicates, entity paths, and values', () => {
    const env: AuthoredEnvelope = {
      fromPeer: 'did:test:Аличе',
      events: [
        {
          author: 'did:test:Аличе',
          timestamp: 0,
          op: 'set',
          predicate: '名前',
          entityPath: ['シーン:メイン', 'アバター:アリス'],
          value: { 説明: 'こんにちは', emoji: '🎮🌐' }
        }
      ]
    }
    const buf = serializeAuthoredEnvelope(env)
    expect(deserializeAuthoredEnvelope(buf)).toEqual(env)
  })

  it('handles many events (writer growth)', () => {
    const events = Array.from({ length: 2000 }, (_, i) => ({
      author: 'did:test:bulk',
      timestamp: i,
      op: 'set' as const,
      predicate: 'Health',
      entityPath: ['scene', `e${i}`],
      value: { current: i }
    }))
    const env: AuthoredEnvelope = { fromPeer: 'did:test:bulk', events }
    const buf = serializeAuthoredEnvelope(env)
    expect(deserializeAuthoredEnvelope(buf).events).toHaveLength(2000)
  })

  it('rejects buffers with bad magic', () => {
    expect(envelopeKind(new ArrayBuffer(0))).toBe('unknown')
    expect(envelopeKind(new Uint8Array([1, 2, 3, 4, 5]).buffer)).toBe('unknown')
  })
})
