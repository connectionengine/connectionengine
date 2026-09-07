/**
 * Lifecycle — session protocol + per-connection state for live multi-peer
 * worlds.
 *
 * - `session.ts`  — joinWorld / leaveWorld + control protocol orchestration
 * - `replay.ts`   — join-time catch-up: state snapshot + authored-event log
 *                   streaming, and their apply handlers
 * - `fanout.ts`   — outbound publish hooks (authored mesh + per-peer binary)
 * - `network-id.ts` — entity ↔ networkId tables (local + remote)
 * - `binary-channel.ts` — per-connection binary pipeline + bindings sync
 * - `sweep.ts`    — owner-user entity cleanup + authority recovery on disconnect
 */

export type { JoinNetworkOptions, JoinResult, JoinWorldOptions } from './session'
export { joinNetwork, joinWorld, leaveWorld } from './session'
export type { NetworkIdBinding, NetworkIdTable, RemoteBindingTable } from './network-id'
export { createRemoteBindingTable, getNetworkIdTable } from './network-id'
export type { BinaryChannel, BindControlMessage, ChannelOptions } from './binary-channel'
export { createBinaryChannel, isBindControl } from './binary-channel'
export type { ReplayChunkMessage, ReplayEndMessage, SnapshotMessage } from './replay'
export { applyReplayChunk, applyStateSnapshot, streamEventLog, streamStateSnapshot } from './replay'
export { installFanout, rebroadcastAuthored, setConnectionChannel, getConnectionChannel } from './fanout'
export { sweepDisconnectedPeer } from './sweep'
export type { ConnectInMemoryOptions, MemoryConnectionPair } from './connect-memory'
export { connectInMemory } from './connect-memory'
