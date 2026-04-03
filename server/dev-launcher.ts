/**
 * dev-launcher.ts — development process orchestrator.
 *
 * Spawns two child processes:
 *   1. Web server  (server/index.ts)   — HTTP, SSE, API  — PROCESS_TYPE=web
 *   2. Worker      (server/worker-main.ts) — BG jobs     — PROCESS_TYPE=worker
 *
 * Both processes inherit environment variables from the parent.
 * SIGTERM / SIGINT sent to the launcher are forwarded to both children.
 *
 * Usage: tsx server/dev-launcher.ts
 */

import { spawn, type ChildProcess } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TSX = "tsx";

function spawnProcess(name: string, script: string, extra: Record<string, string>): ChildProcess {
  const env = { ...process.env, ...extra };
  const child = spawn(TSX, [script], {
    env,
    stdio: "inherit",
    shell: false,
  });

  child.on("error", (err) => {
    console.error(`[LAUNCHER] Failed to start ${name}: ${err.message}`);
  });

  child.on("exit", (code, signal) => {
    if (!isShuttingDown) {
      // Worker exits cleanly (code 0) when DISABLE_WORKERS=true — expected, do not shutdown.
      if (code === 0 && process.env.DISABLE_WORKERS === 'true') {
        console.log(`[LAUNCHER] ${name} exited cleanly (DISABLE_WORKERS=true). Web process continues.`);
        return;
      }
      console.error(`[LAUNCHER] ${name} exited unexpectedly (code=${code}, signal=${signal}). Shutting down all processes.`);
      shutdown();
    }
  });

  console.log(`[LAUNCHER] Started ${name} (pid=${child.pid})`);
  return child;
}

let isShuttingDown = false;
let webProcess: ChildProcess | null = null;
let workerProcess: ChildProcess | null = null;

function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log("[LAUNCHER] Forwarding SIGTERM to child processes...");
  webProcess?.kill("SIGTERM");
  workerProcess?.kill("SIGTERM");

  // Force-kill after 25 seconds if children don't exit
  setTimeout(() => {
    console.error("[LAUNCHER] Force-killing unresponsive child processes");
    webProcess?.kill("SIGKILL");
    workerProcess?.kill("SIGKILL");
    process.exit(1);
  }, 25000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

const webScript = path.resolve(__dirname, "index.ts");
const workerScript = path.resolve(__dirname, "worker-main.ts");

webProcess = spawnProcess("web", webScript, { PROCESS_TYPE: "web" });
workerProcess = spawnProcess("worker", workerScript, { PROCESS_TYPE: "worker" });

// Exit the launcher once both children have exited
let exited = 0;
function onChildExited() {
  exited += 1;
  if (exited >= 2) {
    console.log("[LAUNCHER] All child processes exited. Launcher exiting.");
    process.exit(0);
  }
}

webProcess.on("exit", onChildExited);
workerProcess.on("exit", onChildExited);
