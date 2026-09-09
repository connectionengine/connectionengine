/**
 * Lifecycle — the session protocol, and the per-connection state for a live
 * multi-peer world.
 *
 * - `session.ts`  — the whole connection lifecycle: handshake, live traffic,
 *                   outbound publish hooks, relay, and disconnect cleanup
 * - `replay.ts`   — join-time catch-up. It streams the authored event log and
 *                   the state snapshot, and holds their apply handlers.
 * - `network-id.ts` — the entity-to-networkId tables, local and remote
 * - `binary-channel.ts` — the per-connection binary pipeline, and the bindings
 *                   sync
 */

export type { JoinNetworkOptions, JoinResult, JoinWorldOptions } from './session'
export { joinNetwork, joinWorld, leaveWorld } from './session'
export type { NetworkIdBinding, NetworkIdTable, RemoteBindingTable } from './network-id'
export { createRemoteBindingTable, getNetworkIdTable } from './network-id'
export type { BinaryChannel, BindControlMessage, ChannelOptions } from './binary-channel'
export { createBinaryChannel, isBindControl } from './binary-channel'
export type { ReplayChunkMessage, ReplayEndMessage, SnapshotMessage } from './replay'
export { applyReplayChunk, applyStateSnapshot, endReplay, streamEventLog, streamStateSnapshot } from './replay'
