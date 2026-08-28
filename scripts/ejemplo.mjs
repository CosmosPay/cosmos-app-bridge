// Levanta el ejemplo en dos puertos y deja las URLs a mano.
//
// Dos puertos y no uno: para un navegador son dos origenes distintos, que es
// lo que hace que la lista blanca del puente signifique algo. Servido todo
// junto, la comprobacion de origen se cumple sola y el ejemplo no demuestra
// nada.
import { spawn } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";

for (const lado of ["panel", "app"]) {
  mkdirSync(`examples/${lado}/dist`, { recursive: true });
  cpSync("dist/index.js", `examples/${lado}/dist/index.js`);
}

for (const [dir, puerto] of [["examples/panel", 8090], ["examples/app", 8091]]) {
  spawn("python3", ["-m", "http.server", String(puerto), "--bind", "127.0.0.1"],
        { cwd: dir, stdio: "ignore" });
}

console.log("  panel:  http://127.0.0.1:8090/");
console.log("  la app: http://127.0.0.1:8091/  (se carga sola adentro del panel)");
console.log("  ctrl-c para cortar");
