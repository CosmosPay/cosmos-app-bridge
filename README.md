# @cosmosapp/app_bridge

El puente entre una Cosmos App y la plataforma que la embebe.

Una app de terceros corre adentro de un iframe y necesita pedirle cosas al
anfitrión: el token de sesión, los datos de la tienda, navegar, abrirse a
pantalla completa. Eso viaja por `postMessage`, y `postMessage` es exactamente
tan seguro como el cuidado que se le ponga.

Cero dependencias. Las dos puntas en el mismo paquete.

## Por qué existe

Los puentes de este tipo se escriben una vez y se auditan nunca. Los dos errores
son siempre los mismos:

```js
// al enviar: le habla a cualquier padre que lo esté enmarcando
window.parent.postMessage(mensaje, "*");

// al recibir: nunca mira de dónde vino
window.addEventListener("message", (e) => manejadores.forEach((h) => h(e.data)));
```

El primero filtra lo que mandás a cualquier página que logre enmarcar tu app.
El segundo acepta como legítimo cualquier mensaje que alguien pueda inyectar.
Juntos, en un puente que transporta tokens de sesión, son una toma de cuenta.

Este paquete hace las dos cosas imposibles en vez de desaconsejarlas:

- **`allowedOrigins` es obligatorio.** No hay valor por defecto, porque no existe
  uno seguro y adivinarlo es cómo se termina en `"*"`.
- **No hay comodín.** Ni al enviar ni al recibir. Una política que no nombre
  ningún origen concreto falla al construir el puente, no en producción.
- **Todo mensaje entrante pasa por tres puertas** antes de llegar a un
  manejador: origen permitido, sobre reconocible, y `clientId` que coincida.
  Lo que no pasa se reporta por `onRejected` en vez de desaparecer.

## Uso

Del lado de la app, adentro del iframe:

```ts
import { createAppBridge } from "@cosmosapp/app_bridge";

const bridge = createAppBridge({
  clientId: "mi-app",
  allowedOrigins: "https://admin.cosmospay.lat",
});

await bridge.ready();

const { token } = await bridge.request("auth:sessionToken");

bridge.subscribe("cart:updated", (carrito) => {
  render(carrito);
});
```

Del lado de la plataforma, en la página que embebe:

```ts
import { createHostBridge } from "@cosmosapp/app_bridge";

const host = createHostBridge({
  clientId: "mi-app",
  allowedOrigins: "https://apps.cosmospay.lat",
  frame: document.querySelector("iframe")!,
});

host.respond("auth:sessionToken", () => ({ token: emitirTokenAcotado() }));
host.send("cart:updated", carritoActual);
```

## La API

**App** (`createAppBridge`)

| | |
|---|---|
| `send(type, payload?)` | manda y sigue, sin esperar respuesta |
| `request(type, payload?)` | manda y espera la respuesta, o rechaza por tiempo |
| `subscribe(type, handler)` | escucha, devuelve la función para dar de baja |
| `ready()` | resuelve cuando el anfitrión saludó de vuelta |
| `destroy()` | saca todos los listeners |

**Anfitrión** (`createHostBridge`): lo mismo, más `respond(type, resolver)` para
contestar preguntas.

**Opciones**

| | |
|---|---|
| `clientId` | identifica la app; viaja en cada mensaje |
| `allowedOrigins` | string, lista o función. Obligatorio |
| `timeoutMs` | cuánto espera `request()`. Por defecto 10000 |
| `onRejected` | se llama con cada mensaje descartado y por qué |

## Decisiones que valen la pena explicar

**Las dos puntas viajan juntas.** Un protocolo con sus mitades en repositorios
distintos se desincroniza, y cuando una mitad es privada la desincronización es
invisible: quien escribe apps se entera en producción.

**`request()` correlaciona.** Sin eso, dos preguntas del mismo tipo lanzadas a
la vez se resuelven cada una con la respuesta de la otra. Hay un test que lo
prueba contestando fuera de orden a propósito.

**Un resolver que explota contesta igual.** Si el anfitrión deja caer la
excepción, del otro lado hay un `await` esperando diez segundos para nada. Se
manda un `tipo:error` con el mismo id de correlación.

**El anfitrión mira el `src` del frame, no sólo la política.** La política dice
a quién le creemos; el `src` dice dónde vive *este* frame en concreto. Si no
coincide, no se manda nada.

**`ready()` lo inicia el frame.** El anfitrión no puede saber cuándo terminó de
cargar la app, así que la app saluda y el anfitrión contesta.

## Verificación

```
npm run typecheck    tsc --noEmit, limpio
npm test             19 tests, todos en verde
```

Los tests corren sin navegador ni red: un `window` falso hecho a mano registra
cada `postMessage` con el `targetOrigin` con el que fue llamado, así la
afirmación de que nunca se usa un comodín se comprueba en vez de prometerse.

## Licencia

Ver `LICENSE`.

## Por qué este paquete es MIT

El resto de Cosmos es source-available. Este no, y la razón es que no es el
negocio: el negocio son los pagos, Stellar y la red de comerciantes. Un puente
de `postMessage` y un renderizador son infraestructura de integración.

Mantenerla cerrada no protege nada y sí cuesta: nadie audita lo que no puede
leer, y en un paquete cuya única función es no dejar pasar mensajes de origen
ajeno, que lo miren desde afuera es parte del producto.

Es lo mismo que hacen Shopify con su App Bridge y Stripe con `stripe-js`. La
capa de integración abierta empuja la adopción de lo que sí se cobra.
