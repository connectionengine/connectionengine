/**
 * Lifecycle — the session protocol, and the per-connection state for a live
 * multi-peer world.
 *
 * - `session.ts`  — joinWorld, leaveWorld, and the control protocol
 * - `replay.ts`   — join-time catch-up. It streams the authored event log and
 *                   the state snapshot, and holds their apply handlers.
 * - `fanout.ts`   — outbound publish hooks: the authored mesh, and the per-peer
 *                   binary channel
 * - `network-id.ts` — the entity-to-networkId tables, local and remote
 * - `binary-channel.ts` — the per-connection binary pipeline, and the bindings
 *                   sync
 * - `sweep.ts`    — cleanup of owner-user entities, and authority recovery, on
 *                   disconnect
 */

export type { JoinNetworkOptions, JoinResult, JoinWorldOptions } from './session'
export { joinNetwork, joinWorld, leaveWorld } from './session'
export type { NetworkIdBinding, NetworkIdTable, RemoteBindingTable } from './network-id'
export { createRemoteBindingTable, getNetworkIdTable } from './network-id'
export type { BinaryChannel, BindControlMessage, ChannelOptions } from './binary-channel'
export { createBinaryChannel, isBindControl } from './binary-channel'
export type { ReplayChunkMessage, ReplayEndMessage, SnapshotMessage } from './replay'
export { applyReplayChunk, applyStateSnapshot, endReplay, streamEventLog, streamStateSnapshot } from './replay'
export { installFanout, rebroadcastAuthored, setConnectionChannel, getConnectionChannel } from './fanout'
export { sweepDisconnectedPeer } from './sweep'
export type { ConnectInMemoryOptions, MemoryConnectionPair } from './connect-memory'
export { connectInMemory } from './connect-memory'
