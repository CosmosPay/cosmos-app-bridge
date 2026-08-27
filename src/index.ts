/**
 * The bridge between a Cosmos App and the platform that embeds it.
 *
 * Both ends ship together on purpose: a protocol whose halves live in separate
 * codebases drifts, and when one half is private the drift is invisible to the
 * people writing apps against it.
 */
export { createAppBridge } from "./app";
export { createHostBridge, type HostBridgeOptions } from "./host";
export {
	READY,
	type AppBridge,
	type BridgeMessage,
	type BridgeOptions,
	type Handler,
	type HostBridge,
	type OriginPolicy,
	type RejectionReason,
	type Unsubscribe,
} from "./types";
