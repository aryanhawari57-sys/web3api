#!/usr/bin/env node
// Terminal-only setup wizard (no browser UI); its name and command come from brand.json → bridge.
// Starts the router engine in the background, asks which model and which tool, writes the
// tool's config, then keeps running: the tool reaches the models through this process.
// Names, command and models come from brand.json → "bridge" and "models.renames".

const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");
const readline = require("readline");

const BRAND = require("./src/brand");
const api = require("./src/cli/api/client");
const { ensureSqliteRuntime, buildEnvWithRuntime } = require("./hooks/sqliteRuntime");
const pkg = require("./package.json");

const BRIDGE = {
  name: BRAND.bridge.name || `${BRAND.name} Bridge`,
  // Optional: build a combo of the provider's free models for combo-backed targets.
  combo: BRAND.bridge.combo || null,
  comboProvider: BRAND.bridge.comboProvider || "opencode",
};
const MODELS = (BRAND.bridge.models || [])
  .map((id) => BRAND.modelRenames.find((r) => r.id === id))
  .filter(Boolean);
const TOOLS = [
  { id: "codex", label: "Codex", hint: "OpenAI Codex CLI" },
  { id: "copilot", label: "VS Code", hint: "GitHub Copilot Chat in VS Code" },
];

const args = process.argv.slice(2);
const portArg = args.findIndex((a) => a === "-p" || a === "--port");
const PORT = portArg >= 0 ? parseInt(args[portArg + 1], 10) || 20128 : 20128;
const HOST = "127.0.0.1";
const BASE_URL = `http://${HOST}:${PORT}/v1`;

if (args.includes("-h") || args.includes("--help")) {
  console.log(`\n${BRIDGE.name} v${pkg.version}\n\nUsage: ${BRAND.bridge.command || BRAND.slug} [-p <port>]\n\nSets up a free model in Codex or VS Code and keeps the router running.\n`);
  process.exit(0);
}

// ── look ────────────────────────────────────────────────────────────────────
const tty = process.stdout.isTTY;
const c = (code) => (text) => (tty ? `\x1b[${code}m${text}\x1b[0m` : String(text));
const bold = c("1");
const dim = c("2");
const green = c("38;5;84");
const amber = c("38;5;214");
const red = c("38;5;203");
const accent = c("38;5;111");
const GRADIENT = [57, 63, 69, 75, 81, 87, 51];
const paint = (text, offset = 0) => (tty
  ? [...text].map((ch, i) => (ch === " " ? ch : `\x1b[38;5;${GRADIENT[Math.floor(((i + offset) / Math.max(text.length, 1)) * GRADIENT.length) % GRADIENT.length]}m${ch}`)).join("") + "\x1b[0m"
  : text);

// Block letters (ANSI Shadow) for the first word of the wizard name; plain title otherwise.
const FONT = {
  A: [" █████╗ ", "██╔══██╗", "███████║", "██╔══██║", "██║  ██║", "╚═╝  ╚═╝"],
  C: [" ██████╗", "██╔════╝", "██║     ", "██║     ", "╚██████╗", " ╚═════╝"],
  K: ["██╗  ██╗", "██║ ██╔╝", "█████╔╝ ", "██╔═██╗ ", "██║  ██╗", "╚═╝  ╚═╝"],
  O: [" ██████╗ ", "██╔═══██╗", "██║   ██║", "██║   ██║", "╚██████╔╝", " ╚═════╝ "],
  B: ["██████╗ ", "██╔══██╗", "██████╔╝", "██╔══██╗", "██████╔╝", "╚═════╝ "],
  D: ["██████╗ ", "██╔══██╗", "██║  ██║", "██║  ██║", "██████╔╝", "╚═════╝ "],
  E: ["███████╗", "██╔════╝", "█████╗  ", "██╔══╝  ", "███████╗", "╚══════╝"],
  F: ["███████╗", "██╔════╝", "█████╗  ", "██╔══╝  ", "██║     ", "╚═╝     "],
  G: [" ██████╗ ", "██╔════╝ ", "██║  ███╗", "██║   ██║", "╚██████╔╝", " ╚═════╝ "],
  H: ["██╗  ██╗", "██║  ██║", "███████║", "██╔══██║", "██║  ██║", "╚═╝  ╚═╝"],
  I: ["██╗", "██║", "██║", "██║", "██║", "╚═╝"],
  N: ["███╗   ██╗", "████╗  ██║", "██╔██╗ ██║", "██║╚██╗██║", "██║ ╚████║", "╚═╝  ╚═══╝"],
  T: ["████████╗", "╚══██╔══╝", "   ██║   ", "   ██║   ", "   ██║   ", "   ╚═╝   "],
  Z: ["███████╗", "╚══███╔╝", "  ███╔╝ ", " ███╔╝  ", "███████╗", "╚══════╝"],
  L: ["██╗     ", "██║     ", "██║     ", "██║     ", "███████╗", "╚══════╝"],
  P: ["██████╗ ", "██╔══██╗", "██████╔╝", "██╔═══╝ ", "██║     ", "╚═╝     "],
  R: ["██████╗ ", "██╔══██╗", "██████╔╝", "██╔══██╗", "██║  ██║", "╚═╝  ╚═╝"],
  S: ["███████╗", "██╔════╝", "███████╗", "╚════██║", "███████║", "╚══════╝"],
};

function banner() {
  const [word, ...rest] = BRIDGE.name.split(" ");
  const letters = word.toUpperCase().split("");
  console.log("");
  const artWidth = letters.reduce((w, l) => w + (FONT[l]?.[0].length || 0), 2);
  if (tty && letters.every((l) => FONT[l]) && (process.stdout.columns || 80) >= artWidth) {
    for (let row = 0; row < 6; row++) console.log("  " + paint(letters.map((l) => FONT[l][row]).join(""), row));
    const subtitle = [rest.join(" ").toUpperCase(), "free AI models for your coding tools"].filter(Boolean).join("  ·  ");
    console.log(`  ${bold(paint(subtitle))}  ${dim(`v${pkg.version}`)}`);
  } else {
    console.log(`  ${bold(paint(BRIDGE.name.toUpperCase()))}  ${dim(`v${pkg.version}`)}`);
    console.log(`  ${dim("free AI models for your coding tools")}`);
  }
  console.log("");
}

// Width ignores ANSI colour codes so bold/coloured lines stay aligned.
const visibleLength = (text) => text.replace(/\x1b\[[0-9;]*m/g, "").length;

function box(lines, colour = amber) {
  const width = Math.max(...lines.map(visibleLength)) + 2;
  console.log(colour(`  ╭${"─".repeat(width)}╮`));
  for (const line of lines) console.log(colour("  │ ") + line + " ".repeat(width - 1 - visibleLength(line)) + colour("│"));
  console.log(colour(`  ╰${"─".repeat(width)}╯`));
}

function spinner(text) {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const timer = tty ? setInterval(() => process.stdout.write(`\r  ${accent(frames[i++ % frames.length])} ${text}`), 80) : null;
  if (!tty) console.log(`  … ${text}`);
  const end = (mark, msg) => {
    if (timer) clearInterval(timer);
    if (tty) process.stdout.write("\r\x1b[K");
    console.log(`  ${mark} ${msg}`);
  };
  return { ok: (msg = text) => end(green("✔"), msg), fail: (msg = text) => end(red("✖"), msg) };
}

// ── input ───────────────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
// Lines typed (or pasted) before a prompt is shown are queued, not dropped.
const pendingLines = [];
let waitingForLine = null;
rl.on("line", (line) => {
  if (waitingForLine) { const resolve = waitingForLine; waitingForLine = null; resolve(line); }
  else pendingLines.push(line);
});
const question = (q) => {
  process.stdout.write(q);
  if (pendingLines.length) {
    const line = pendingLines.shift();
    if (!tty) process.stdout.write(`${line}\n`);
    return Promise.resolve(line);
  }
  return new Promise((resolve) => { waitingForLine = resolve; });
};

async function choose(step, title, options) {
  console.log(`  ${accent(`STEP ${step}/3`)}  ${bold(title)}\n`);
  options.forEach((o, i) => console.log(`    ${accent(bold(`[${i + 1}]`))}  ${bold(o.label)}  ${dim(o.hint || "")}`));
  console.log("");
  for (;;) {
    const answer = (await question(`  ${accent("›")} Select ${options.map((_, i) => i + 1).join(", ")}: `)).trim();
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && options[index]) {
      console.log(`    ${green("✔")} ${options[index].label}\n`);
      return options[index];
    }
    console.log(`    ${red("Please type a number from the list.")}`);
  }
}

// ── engine ──────────────────────────────────────────────────────────────────
let engine = null;
let stopping = false;
let engineLog = [];

function healthy() {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port: PORT, path: "/api/health", timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

async function startEngine() {
  if (await healthy()) return { reused: true };
  const serverPath = [path.join(__dirname, "app", "custom-server.js"), path.join(__dirname, "app", "server.js")].find((p) => fs.existsSync(p));
  if (!serverPath) throw new Error("The router engine is not built yet. From the repository run: npm run bridge");
  try { ensureSqliteRuntime({ silent: true }); } catch { /* sql.js fallback still works */ }
  engine = spawn(process.execPath, ["--dns-result-order=ipv4first", serverPath], {
    cwd: path.dirname(serverPath),
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
    env: { ...buildEnvWithRuntime(process.env), PORT: String(PORT), HOSTNAME: HOST },
  });
  engine.stderr.on("data", (d) => { engineLog = engineLog.concat(String(d).split("\n").filter(Boolean)).slice(-15); });
  engine.on("exit", (code) => {
    if (stopping) return;
    console.log(`\n  ${red("✖")} The router engine stopped (code ${code}). Your tools can't reach the models until you run this again.`);
    if (engineLog.length) console.log(dim(engineLog.map((l) => `    ${l}`).join("\n")));
    process.exit(1);
  });
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (await healthy()) return { reused: false };
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Engine did not start on port ${PORT}${engineLog.length ? `:\n${engineLog.join("\n")}` : ""}`);
}

function shutdown() {
  if (stopping) return;
  stopping = true;
  if (engine && !engine.killed) {
    console.log(`\n  ${dim(`${BRIDGE.name} stopped — your tools can no longer reach the models.`)}`);
    engine.kill("SIGTERM");
    setTimeout(() => { try { engine.kill("SIGKILL"); } catch { /* gone */ } process.exit(0); }, 1500);
  } else {
    process.exit(0);
  }
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, shutdown);
rl.on("SIGINT", shutdown);

// ── setup ───────────────────────────────────────────────────────────────────
const unwrap = (result, what) => {
  if (!result.success) throw new Error(`${what}: ${result.error}`);
  return result.data;
};

async function ensureCombo() {
  const catalog = unwrap(await api.getModelCatalog(), "Could not read the model catalog");
  const models = catalog.models
    .filter((m) => m.providerId === BRIDGE.comboProvider && m.kind === "llm" && m.ready && m.source !== "rename")
    .map((m) => m.id);
  if (!models.length) throw new Error("No free models are reachable right now — check your internet connection and try again.");
  const { combos = [] } = unwrap(await api.getCombos(), "Could not read combos");
  const existing = combos.find((cb) => cb.name === BRIDGE.combo);
  unwrap(existing
    ? await api.updateCombo(existing.id, { name: BRIDGE.combo, models })
    : await api.createCombo({ name: BRIDGE.combo, models }), "Could not save the model setup");
  return models.length;
}

async function ensureApiKey() {
  const { keys = [] } = unwrap(await api.getApiKeys(), "Could not read API keys");
  const active = keys.find((k) => k.isActive !== false && k.key);
  if (active) return active.key;
  return unwrap(await api.createApiKey(BRIDGE.name), "Could not create an API key").key;
}

async function applyToTool(tool, model, apiKey) {
  const body = tool.id === "codex"
    ? { baseUrl: BASE_URL, apiKey, model: model.id }
    : { baseUrl: BASE_URL, apiKey, models: [{ id: model.id, name: model.name }] };
  return unwrap(await api.applyCliToolSettings(tool.id, body), `Could not update ${tool.label}`);
}

function testModel(model, apiKey) {
  const payload = JSON.stringify({ model: model.id, messages: [{ role: "user", content: "Reply with: ready" }], max_tokens: 16, stream: false });
  const started = Date.now();
  return new Promise((resolve) => {
    const req = http.request({
      host: HOST, port: PORT, path: "/v1/chat/completions", method: "POST", timeout: 60000,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), Authorization: `Bearer ${apiKey}` },
    }, (res) => {
      res.resume();
      res.on("end", () => resolve({ ok: res.statusCode === 200, ms: Date.now() - started, status: res.statusCode }));
    });
    req.on("error", () => resolve({ ok: false }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false }); });
    req.end(payload);
  });
}

// ── run ─────────────────────────────────────────────────────────────────────
async function main() {
  banner();
  if (!MODELS.length) throw new Error("brand.json → bridge.models lists no known models.");

  const boot = spinner("Starting the router engine…");
  let reused;
  try {
    ({ reused } = await startEngine());
    boot.ok(reused ? `Router engine already running on port ${PORT}` : `Router engine online on port ${PORT}`);
  } catch (err) {
    boot.fail("Router engine failed to start");
    throw err;
  }
  api.configure({ port: PORT });
  console.log("");

  const model = await choose(1, "Choose your model", MODELS.map((m) => ({ ...m, label: m.name, hint: "free" })));
  const tool = await choose(2, "Where do you want to use it?", TOOLS);

  console.log(`  ${accent("STEP 3/3")}  ${bold("Confirm")}\n`);
  console.log(`    Apply ${bold(accent(model.name))} to ${bold(accent(tool.label))}?\n`);
  await question(`  ${accent("›")} Press ${bold("Enter")} to apply, or Ctrl+C to cancel `);
  rl.close();
  console.log("");

  const s1 = spinner(`Preparing ${model.name}…`);
  if (BRIDGE.combo) await ensureCombo().catch((err) => { s1.fail(`Could not prepare ${model.name}`); throw err; });
  s1.ok(`${model.name} is ready`);

  const s2 = spinner(`Configuring ${tool.label}…`);
  const apiKey = await ensureApiKey();
  await applyToTool(tool, model, apiKey).catch((err) => { s2.fail(`Could not configure ${tool.label}`); throw err; });
  s2.ok(`${tool.label} now uses ${model.name}`);

  const s3 = spinner(`Testing ${model.name}…`);
  const test = await testModel(model, apiKey);
  if (test.ok) s3.ok(`${model.name} answered in ${(test.ms / 1000).toFixed(1)}s`);
  else s3.fail(`${model.name} did not answer yet${test.status ? ` (HTTP ${test.status})` : ""} — it will retry when you use it`);

  console.log(`\n  ${green(bold("✔ Done!"))} ${bold(model.name)} is set up in ${bold(tool.label)}.`);
  console.log(tool.id === "codex"
    ? `    Open a new terminal and run ${bold("codex")} — it already points at ${model.name}.`
    : `    Reload VS Code, open Copilot Chat → model picker → ${bold("Manage Models")} → enable ${bold(model.name)}.`);
  console.log("");

  if (reused) {
    box([
      `${bold("ⓘ")}  The router engine was already running in another window.`,
      "   Keep that window open — the models work only while it runs.",
    ], accent);
    process.exit(0);
  }
  box([
    `${bold("⚠  Please don't close this window.")}`,
    `   ${model.name} runs through it — if you close it,`,
    `   ${tool.label} can't reach the models until you run ${BRAND.bridge.command || BRAND.slug} again.`,
  ]);
  console.log(`\n  ${dim(`Running on ${BASE_URL} · press Ctrl+C to stop`)}`);
}

main().catch((err) => {
  console.error(`\n  ${red("✖")} ${err.message}\n`);
  stopping = true;
  if (engine) engine.kill("SIGTERM");
  process.exit(1);
});
