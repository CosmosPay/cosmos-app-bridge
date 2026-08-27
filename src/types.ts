/**
 * The message vocabulary shared by both sides of the bridge.
 *
 * This module has zero imports on purpose. Everything else in the package
 * depends on it and it depends on nothing, so the protocol can be published,
 * versioned and reasoned about without dragging any implementation along.
 */

/** Every message that crosses the bridge has this shape. */
export interface BridgeMessage<T = unknown> {
	/** What happened or what is being asked for, e.g. `"navigate:goTo"`. */
	type: string;
	/** Whatever the message carries. Opaque to the transport. */
	payload?: T;
	/**
	 * Correlates a reply with its request. Set by `request()`, echoed by the
	 * responder. Absent on fire-and-forget messages.
	 */
	correlationId?: string;
}

/** Removes a subscription. Calling it twice is safe. */
export type Unsubscribe = () => void;

/** Called with the payload of every message of the subscribed type. */
export type Handler<T = unknown> = (payload: T, message: BridgeMessage<T>) => void;

/**
 * Where a message is allowed to come from, and where it is allowed to go.
 *
 * A string is matched exactly against `MessageEvent.origin`, which is always
 * `scheme://host[:port]` with no trailing slash. A function decides for itself.
 *
 * There is deliberately no wildcard. `postMessage(data, "*")` sends to whatever
 * page happens to be framing you, and a listener that skips `event.origin`
 * accepts messages from whoever can reach the frame. A bridge that carries
 * session tokens cannot do either, so this package makes both impossible rather
 * than merely discouraged.
 */
export type OriginPolicy = string | readonly string[] | ((origin: string) => boolean);

/** Options shared by both ends of the bridge. */
export interface BridgeOptions {
	/**
	 * Identifies the application. Travels with every message so the other end
	 * can tell two embedded apps apart.
	 */
	clientId: string;
	/**
	 * Which origins to trust. Required: there is no safe default, and guessing
	 * one for the caller is how these bridges end up accepting `"*"`.
	 */
	allowedOrigins: OriginPolicy;
	/** Milliseconds before `request()` gives up. Default 10000. */
	timeoutMs?: number;
	/** Called with every rejected message. Useful while wiring things up. */
	onRejected?: (reason: RejectionReason, event: MessageEvent) => void;
}

/** Why an incoming message was not delivered to any handler. */
export type RejectionReason =
	| "untrusted-origin"
	| "not-a-bridge-message"
	| "other-client";

/** The app side of the bridge: what code running inside the frame gets. */
export interface AppBridge {
	readonly clientId: string;
	/** Sends a message to the host and does not wait for an answer. */
	send<T>(type: string, payload?: T): void;
	/** Sends a message and resolves with the host's reply, or rejects on timeout. */
	request<Req, Res>(type: string, payload?: Req): Promise<Res>;
	/** Listens for messages of one type. Returns the unsubscribe function. */
	subscribe<T>(type: string, handler: Handler<T>): Unsubscribe;
	/** Resolves once the host has acknowledged the frame. */
	ready(): Promise<void>;
	/** Tears down every listener this bridge installed. */
	destroy(): void;
}

/** The host side: what the platform embedding the frame gets. */
export interface HostBridge {
	readonly clientId: string;
	send<T>(type: string, payload?: T): void;
	subscribe<T>(type: string, handler: Handler<T>): Unsubscribe;
	/** Answers a `request()` of the given type with whatever the resolver returns. */
	respond<Req, Res>(
		type: string,
		resolver: (payload: Req) => Res | Promise<Res>,
	): Unsubscribe;
	destroy(): void;
}

/** Sent by the host once it has seen the frame. */
export const READY = "bridge:ready";

/** Marks an object as ours, so foreign postMessage traffic is ignored. */
export const ENVELOPE = "__cosmos_bridge__";

/** What actually travels over postMessage. */
export interface Envelope<T = unknown> extends BridgeMessage<T> {
	[ENVELOPE]: true;
	clientId: string;
}
