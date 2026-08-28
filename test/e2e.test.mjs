// El puente en un navegador de verdad, con dos origenes de verdad.
//
// Los otros 19 tests corren contra un `window` escrito a mano. Prueban la
// logica, no que el navegador se comporte como creo. Este levanta el ejemplo en
// dos puertos, que para el navegador son dos origenes distintos, y comprueba
// que el lazo entero cierre: handshake, pregunta con respuesta, empujon del
// anfitrion, y un mensaje de otra app que tiene que rebotar.
//
// Se saltea solo si playwright no esta instalado, asi que `npm test` sigue
// funcionando en una maquina sin navegador.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.join(AQUI, '..');
const PUERTO_PANEL = 8090;
const PUERTO_APP = 8091;

let chromium = null;
let servidores = [];
let navegador = null;

before(async () => {
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    return; // sin playwright, los tests se saltean
  }

  for (const [dir, puerto] of [
    ['examples/panel', PUERTO_PANEL],
    ['examples/app', PUERTO_APP],
  ]) {
    servidores.push(
      spawn('python3', ['-m', 'http.server', String(puerto), '--bind', '127.0.0.1'], {
        cwd: path.join(RAIZ, dir),
        stdio: 'ignore',
      }),
    );
  }
  await new Promise((r) => setTimeout(r, 1200));
  navegador = await chromium.launch();
});

after(async () => {
  await navegador?.close();
  for (const s of servidores) s.kill();
});

const saltear = () => (chromium ? false : { skip: 'playwright no esta instalado' });

test('el lazo completo cierra entre dos origenes', async (t) => {
  const motivo = saltear();
  if (motivo) return t.skip(motivo.skip);

  const pagina = await navegador.newPage();
  const errores = [];
  pagina.on('pageerror', (e) => errores.push(String(e)));

  await pagina.goto(`http://127.0.0.1:${PUERTO_PANEL}/`, { waitUntil: 'networkidle' });
  const marco = pagina.frameLocator('#app');

  // El frame saluda, el anfitrion contesta, ready() resuelve.
  await marco.locator('#estado').waitFor({ state: 'visible' });
  assert.equal((await marco.locator('#estado').textContent()).trim(), 'conectado');

  // Una pregunta con respuesta, cruzando origenes.
  assert.match(await marco.locator('#tienda').textContent(), /Tienda de prueba/);

  // Otra, disparada por el usuario.
  await marco.locator('#pedir').click();
  await pagina.waitForTimeout(300);
  const token = (await marco.locator('#token').textContent()).trim();
  assert.match(token, /^tok_demo_/);

  // El anfitrion empuja algo que la app no pidio.
  await pagina.locator('#empujar').click();
  await pagina.waitForTimeout(300);
  assert.match(await marco.locator('#aviso').textContent(), /pago nuevo/);

  assert.deepEqual(errores, []);
  await pagina.close();
});

test('un mensaje con el clientId de otra app rebota', async (t) => {
  const motivo = saltear();
  if (motivo) return t.skip(motivo.skip);

  const pagina = await navegador.newPage();
  await pagina.goto(`http://127.0.0.1:${PUERTO_PANEL}/`, { waitUntil: 'networkidle' });
  const marco = pagina.frameLocator('#app');
  await marco.locator('#estado').waitFor({ state: 'visible' });

  await marco.locator('#pedir').click();
  await pagina.waitForTimeout(300);
  const antes = (await marco.locator('#token').textContent()).trim();

  // Un sobre bien formado, del origen permitido, pero de otra app.
  await pagina.locator('#hostil').click();
  await pagina.waitForTimeout(400);

  assert.match(await marco.locator('#aviso').textContent(), /other-client/);
  assert.equal(
    (await marco.locator('#token').textContent()).trim(),
    antes,
    'el token no fue reemplazado por el del mensaje ajeno',
  );

  await pagina.close();
});
