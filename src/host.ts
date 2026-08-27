import { Registry, listen, originAllowed, wrap } from "./shared";
import {
	READY,
	type BridgeOptions,
	type Handler,
	type HostBridge,
	type Unsubscribe,
} from "./types";

/** What the host needs on top of the shared options. */
export interface HostBridgeOptions extends BridgeOptions {
	/** The frame the app runs in. Its `contentWindow` is the send target. */
	frame: HTMLIFrameElement;
}

/**
 * Creates the platform side of the bridge, to be called by the page that embeds
 * the app.
 *
 * ```ts
 * const host = createHostBridge({
 *   clientId: "my-app",
 *   allowedOrigins: "https://apps.cosmospay.lat",
 *   frame: document.querySelector("iframe")!,
 * });
 *
 * host.respond("auth:sessionToken", () => ({ token: mintScopedToken() }));
 * ```
 *
 * Shipping both ends in one package is deliberate. A protocol with its two
 * halves in different repositories drifts, and the half that lives in a private
 * codebase drifts unobserved: the app authors find out at runtime.
 */
export function createHostBridge(options: HostBridgeOptions): HostBridge {
	const { clientId, allowedOrigins, frame, onRejected } = options;

	if (typeof window === "undefined") {
		throw new Error("createHostBridge needs a browser window.");
	}

	const registry = new Registry();
	const stopListening = listen(registry, clientId, allowedOrigins, onRejected);

	const send = <T>(type: string, payload?: T, cid?: string) => {
		const target = frame.contentWindow;
		if (!target) return;

		// The frame's own origin is the target, taken from its src rather than
		// from the policy: the policy says who we trust, the src says where this
		// particular frame actually lives.
		let origin: string;
		try {
			origin = new URL(frame.src, window.location.href).origin;
		} catch {
			return;
		}
		if (!originAllowed(allowedOrigins, origin)) return;

		target.postMessage(
			wrap(clientId, { type, payload, correlationId: cid }),
			origin,
		);
	};

	// The frame announces itself when it loads; the host answers so the app's
	// ready() resolves. Doing it this way round means the host does not have to
	// guess when the frame finished booting.
	const stopReady = registry.on(READY, () => send(READY));

	return {
		clientId,

		send(type, payload) {
			send(type, payload);
		},

		subscribe<T>(type: string, handler: Handler<T>): Unsubscribe {
			return registry.on(type, handler);
		},

		respond<Req, Res>(
			type: string,
			resolver: (payload: Req) => Res | Promise<Res>,
		): Unsubscribe {
			return registry.on<Req>(type, (payload, message) => {
				// Only answer what was asked as a question. A fire-and-forget
				// message of the same type carries no correlation id and must
				// not produce a reply nobody is waiting for.
				if (!message.correlationId) return;
				const cid = message.correlationId;

				Promise.resolve()
					.then(() => resolver(payload))
					.then(
						(answer) => send(type, answer, cid),
						(error) => {
							// The requester is waiting on a timeout. Letting the
							// rejection disappear here turns a resolver bug into
							// a ten second hang on the other side.
							send(`${type}:error`, String(error), cid);
						},
					);
			});
		},

		destroy() {
			stopReady();
			stopListening();
			registry.clear();
		},
	};
}
