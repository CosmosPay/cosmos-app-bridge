import {
	Registry,
	correlationId,
	listen,
	primaryOrigin,
	wrap,
} from "./shared";
import {
	READY,
	type AppBridge,
	type BridgeOptions,
	type Handler,
	type Unsubscribe,
} from "./types";

/**
 * Creates the application side of the bridge, to be called from inside the
 * embedded frame.
 *
 * ```ts
 * const bridge = createAppBridge({
 *   clientId: "my-app",
 *   allowedOrigins: "https://admin.cosmospay.lat",
 * });
 *
 * await bridge.ready();
 * const { token } = await bridge.request("auth:sessionToken");
 * ```
 *
 * Throws if it is not running inside a frame: an app that calls this from a top
 * level window has nobody to talk to, and failing loudly beats a bridge whose
 * messages silently go nowhere.
 */
export function createAppBridge(options: BridgeOptions): AppBridge {
	const { clientId, allowedOrigins, timeoutMs = 10_000, onRejected } = options;

	if (typeof window === "undefined") {
		throw new Error("createAppBridge needs a browser window.");
	}
	if (window.parent === window) {
		throw new Error(
			"createAppBridge must run inside a frame: window.parent is the window itself.",
		);
	}

	const destino = primaryOrigin(allowedOrigins);
	if (destino === null) {
		throw new Error(
			"allowedOrigins must name at least one concrete origin so messages have a target. " +
				"A function policy can filter what arrives but cannot say where to send.",
		);
	}

	const registry = new Registry();
	const dejarDeEscuchar = listen(registry, clientId, allowedOrigins, onRejected);

	const enviar = <T>(type: string, payload?: T, cid?: string) => {
		window.parent.postMessage(
			wrap(clientId, { type, payload, correlationId: cid }),
			destino,
		);
	};

	// Resolved the first time the host answers our greeting. Calling ready()
	// after that still works: the promise is already settled.
	let resolverListo: (() => void) | null = null;
	const listo = new Promise<void>((resolve) => {
		resolverListo = resolve;
	});
	const bajaReady = registry.on(READY, () => resolverListo?.());

	// The host cannot tell when the frame finished booting, so the frame says so.
	enviar(READY);

	return {
		clientId,

		send(type, payload) {
			enviar(type, payload);
		},

		request<Req, Res>(type: string, payload?: Req): Promise<Res> {
			const cid = correlationId();
			return new Promise<Res>((resolve, reject) => {
				const temporizador = setTimeout(() => {
					baja();
					reject(
						new Error(
							`The host did not answer "${type}" within ${timeoutMs}ms.`,
						),
					);
				}, timeoutMs);

				const baja = registry.on<Res>(type, (respuesta, mensaje) => {
					// Without this check, two concurrent request() calls of the
					// same type resolve with each other's answer.
					if (mensaje.correlationId !== cid) return;
					clearTimeout(temporizador);
					baja();
					resolve(respuesta);
				});

				enviar(type, payload, cid);
			});
		},

		subscribe<T>(type: string, handler: Handler<T>): Unsubscribe {
			return registry.on(type, handler);
		},

		ready() {
			return listo;
		},

		destroy() {
			bajaReady();
			dejarDeEscuchar();
			registry.clear();
		},
	};
}
