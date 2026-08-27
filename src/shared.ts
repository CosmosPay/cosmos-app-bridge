import {
	ENVELOPE,
	type BridgeMessage,
	type Envelope,
	type Handler,
	type OriginPolicy,
	type RejectionReason,
	type Unsubscribe,
} from "./types";

/** Resolves an origin policy against one concrete origin. */
export function originAllowed(policy: OriginPolicy, origin: string): boolean {
	if (typeof policy === "function") return policy(origin);
	if (typeof policy === "string") return policy === origin;
	return policy.includes(origin);
}

/**
 * The first origin a policy names, used as the `targetOrigin` when sending.
 *
 * A function policy cannot be turned into a single origin, so callers that pass
 * one have to say where to send. This is why `allowedOrigins` is required: the
 * alternative is `postMessage(data, "*")`, and that is the bug this package
 * exists to avoid.
 */
export function primaryOrigin(policy: OriginPolicy): string | null {
	if (typeof policy === "string") return policy;
	if (Array.isArray(policy)) return policy[0] ?? null;
	return null;
}

export function isEnvelope(data: unknown): data is Envelope {
	return (
		typeof data === "object" &&
		data !== null &&
		(data as Record<string, unknown>)[ENVELOPE] === true &&
		typeof (data as Record<string, unknown>).type === "string" &&
		typeof (data as Record<string, unknown>).clientId === "string"
	);
}

export function wrap<T>(
	clientId: string,
	message: BridgeMessage<T>,
): Envelope<T> {
	return { ...message, [ENVELOPE]: true, clientId };
}

/**
 * A correlation id that does not need `crypto.randomUUID`.
 *
 * The bridge runs in browsers we do not choose, including webviews, so it only
 * uses what is available everywhere. These ids never leave the pair of frames
 * and are not secrets; they only have to be unique within one session.
 */
let contador = 0;
export function correlationId(): string {
	contador += 1;
	return `${Date.now().toString(36)}-${contador.toString(36)}`;
}

/** Keeps handlers by message type and dispatches to them. */
export class Registry {
	private readonly porTipo = new Map<string, Set<Handler<never>>>();

	on<T>(type: string, handler: Handler<T>): Unsubscribe {
		let set = this.porTipo.get(type);
		if (!set) {
			set = new Set();
			this.porTipo.set(type, set);
		}
		set.add(handler as Handler<never>);

		let activa = true;
		return () => {
			// Unsubscribing twice has to be harmless: callers keep these in
			// cleanup functions that frameworks may run more than once.
			if (!activa) return;
			activa = false;
			set?.delete(handler as Handler<never>);
			if (set && set.size === 0) this.porTipo.delete(type);
		};
	}

	emit(message: Envelope): void {
		const set = this.porTipo.get(message.type);
		if (!set) return;
		// Copied before iterating: a handler is allowed to unsubscribe itself.
		for (const handler of [...set]) {
			(handler as Handler<unknown>)(message.payload, message);
		}
	}

	clear(): void {
		this.porTipo.clear();
	}
}

/**
 * Installs the `message` listener that both ends share.
 *
 * Every incoming event goes through the same three gates before reaching a
 * handler: the origin has to be allowed, the data has to be one of our
 * envelopes, and the client id has to match. Anything else is reported through
 * `onRejected` and dropped.
 */
export function listen(
	registry: Registry,
	clientId: string,
	allowedOrigins: OriginPolicy,
	onRejected?: (reason: RejectionReason, event: MessageEvent) => void,
): Unsubscribe {
	const handler = (event: MessageEvent) => {
		if (!originAllowed(allowedOrigins, event.origin)) {
			onRejected?.("untrusted-origin", event);
			return;
		}
		if (!isEnvelope(event.data)) {
			onRejected?.("not-a-bridge-message", event);
			return;
		}
		if (event.data.clientId !== clientId) {
			onRejected?.("other-client", event);
			return;
		}
		registry.emit(event.data);
	};

	window.addEventListener("message", handler);
	return () => window.removeEventListener("message", handler);
}
