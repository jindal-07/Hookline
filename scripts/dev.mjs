// Starts the API server, waits until it answers, then starts the web app (`npm run dev`), on any OS.
// Output is prefixed per process; Ctrl+C (or either process exiting) stops both.
import { spawn } from "node:child_process";

const PORT = process.env.PORT || 5000;
const children = [];
let stopping = false;

/** Run npm without a shell: through the same npm CLI that launched us (no argument-escaping concerns). */
function npm(args) {
  const cli = process.env.npm_execpath;
  if (cli && cli.endsWith(".js")) return spawn(process.execPath, [cli, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  // Started without npm (e.g. `node scripts/dev.mjs`): fall back to the npm binary as one command string.
  return process.platform === "win32"
    ? spawn(`npm ${args.join(" ")}`, { stdio: ["ignore", "pipe", "pipe"], shell: true })
    : spawn("npm", args, { stdio: ["ignore", "pipe", "pipe"] });
}

function stopAll(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    if (c.exitCode !== null) continue;
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(c.pid), "/T", "/F"], { stdio: "ignore" });
    else c.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 500);
}

function start(name, color, args) {
  const child = npm(args);
  children.push(child);
  const prefix = `${color}[${name}]\x1b[0m `;
  for (const stream of [child.stdout, child.stderr]) {
    let buf = "";
    stream.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) process.stdout.write(prefix + line + "\n");
    });
  }
  child.on("exit", (code) => {
    if (!stopping) {
      process.stdout.write(`${prefix}exited with code ${code} — stopping the other process too\n`);
      stopAll(code ?? 1);
    }
  });
  return child;
}

/** Resolve once the API answers its health check (or after a timeout, so the web app still starts). */
async function waitForServer(timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until && !stopping) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (r.status < 500) return true;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));

start("server", "\x1b[33m", ["run", "dev", "-w", "server"]);
if (!(await waitForServer())) process.stdout.write("\x1b[36m[client]\x1b[0m the API isn't answering yet — starting the web app anyway\n");
if (!stopping) start("client", "\x1b[36m", ["run", "dev", "-w", "client"]);
