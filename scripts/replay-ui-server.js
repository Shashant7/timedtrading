#!/usr/bin/env node
/**
 * Local Replay Control Server
 * Serves a simple UI and API to view status/progress and start, resume, or pause the full-backtest replay.
 *
 * Usage: node scripts/replay-ui-server.js [port]
 * Default port: 3847
 * Then open http://localhost:3847
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const PORT = parseInt(process.env.PORT || process.argv[2] || "3847", 10);
const ROOT = path.resolve(__dirname, "..");
const LOG_FILE = path.join(ROOT, "data", "replay.log");
const CHECKPOINT_FILE = path.join(ROOT, "data", "replay-checkpoint.txt");
const SCRIPT_PATH = path.join(ROOT, "scripts", "full-backtest.sh");

let replayProcess = null;

function readFileSafe(p, def = "") {
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    return def;
  }
}

function getCheckpoint() {
  const raw = readFileSafe(CHECKPOINT_FILE);
  if (!raw) return null;
  const lines = raw.split("\n").map((l) => l.trim());
  return {
    nextDate: lines[0] || null,
    endDate: lines[1] || null,
    tickerBatch: lines[2] || null,
    intervalMin: lines[3] || null,
  };
}

function getLogTail(maxLines = 80) {
  const raw = readFileSafe(LOG_FILE);
  if (!raw) return [];
  return raw.split("\n").slice(-maxLines);
}

function isReplayProcessRunning() {
  if (replayProcess) {
    try {
      process.kill(replayProcess.pid, 0);
      return true;
    } catch {
      replayProcess = null;
      return false;
    }
  }
  return false;
}

function getStatus() {
  const checkpoint = getCheckpoint();
  const logLines = getLogTail(60);
  const running = isReplayProcessRunning();

  let currentDate = null;
  let lastMessage = null;
  for (let i = logLines.length - 1; i >= 0; i--) {
    const m = logLines[i].match(/=== Processing (\d{4}-\d{2}-\d{2}) ===/);
    if (m) {
      currentDate = m[1];
      break;
    }
  }
  if (logLines.length > 0) lastMessage = logLines[logLines.length - 1];

  return {
    running,
    pid: replayProcess ? replayProcess.pid : null,
    checkpoint: checkpoint && checkpoint.nextDate ? checkpoint : null,
    currentDate,
    lastMessage,
    logTail: logLines,
  };
}

function startReplay(resume = false, batchSize = null, traderOnly = false, sequence = false, intervalMin = null) {
  if (isReplayProcessRunning()) {
    return { ok: false, error: "Replay is already running" };
  }
  if (resume) {
    const cp = getCheckpoint();
    if (batchSize != null && cp?.nextDate) {
      const n = Math.max(5, Math.min(50, parseInt(batchSize, 10) || 15));
      const iv = intervalMin != null ? String(Math.max(1, Math.min(30, parseInt(intervalMin, 10) || 5))) : (cp?.intervalMin || "5");
      try {
        fs.writeFileSync(CHECKPOINT_FILE, `${cp.nextDate}\n${cp.endDate || "2026-02-23"}\n${n}\n${iv}\n`, "utf8");
      } catch (_) {}
    }
    return startReplayInner(true, null, traderOnly, sequence, intervalMin != null ? intervalMin : cp?.intervalMin || 5);
  }
  const n = batchSize != null ? Math.max(5, Math.min(50, parseInt(batchSize, 10) || 25)) : 25;
  const iv = intervalMin != null ? Math.max(1, Math.min(30, parseInt(intervalMin, 10) || 5)) : 5;
  return startReplayInner(false, n, traderOnly, sequence, iv);
}

function startReplayInner(resume, batchSize, traderOnly = false, sequence = false, intervalMin = 5) {
  if (isReplayProcessRunning()) {
    return { ok: false, error: "Replay is already running" };
  }
  const args = resume ? ["--resume"] : ["2025-07-01", "2026-02-23", String(batchSize), String(intervalMin)];
  if (sequence) args.push("--sequence");
  else if (traderOnly) args.push("--trader-only");
  const logDir = path.dirname(LOG_FILE);
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch (_) {}
  const logStream = fs.createWriteStream(LOG_FILE, { flags: resume ? "a" : "w" });
  const write = (d) => {
    const s = d.toString();
    logStream.write(s);
    process.stdout.write(s);
  };
  const child = spawn("bash", [SCRIPT_PATH, ...args], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.stdout.on("data", write);
  child.stderr.on("data", write);
  child.on("error", (err) => {
    console.error("[replay-ui] spawn error:", err);
    logStream.end();
  });
  child.on("exit", (code, sig) => {
    logStream.end();
    if (replayProcess === child) replayProcess = null;
    console.log("[replay-ui] process exited:", code, sig);
  });
  replayProcess = child;
  child.unref();
  return { ok: true, pid: child.pid, mode: resume ? "resume" : "start" };
}

function pauseReplay() {
  if (!replayProcess) {
    return { ok: false, error: "No replay process to pause" };
  }
  try {
    process.kill(replayProcess.pid, "SIGTERM");
    replayProcess = null;
    return { ok: true, message: "Replay paused (SIGTERM sent)" };
  } catch (e) {
    replayProcess = null;
    return { ok: false, error: String(e.message || e) };
  }
}

const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Replay Control</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; background: #0f1419; color: #e6edf3; margin: 0; padding: 24px; min-height: 100vh; }
    h1 { font-size: 1.25rem; margin: 0 0 16px; color: #58a6ff; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
    .status { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: #6e7681; }
    .dot.running { background: #3fb950; box-shadow: 0 0 8px #3fb950; }
    .dot.stopped { background: #f85149; }
    .buttons { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
    button { padding: 8px 16px; border-radius: 6px; border: 1px solid #30363d; cursor: pointer; font-size: 14px; }
    button.primary { background: #238636; color: #fff; border-color: #238636; }
    button.primary:hover { background: #2ea043; }
    button.secondary { background: #21262d; color: #c9d1d9; }
    button.secondary:hover { background: #30363d; }
    button.danger { background: #da3633; color: #fff; border-color: #da3633; }
    button.danger:hover { background: #b62324; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    pre { margin: 0; font-size: 12px; line-height: 1.4; color: #8b949e; overflow-x: auto; white-space: pre-wrap; word-break: break-all; max-height: 280px; overflow-y: auto; }
    .meta { font-size: 12px; color: #8b949e; margin-bottom: 8px; }
    a { color: #58a6ff; }
  </style>
</head>
<body>
  <h1>Replay control</h1>
  <div class="card">
    <div class="status">
      <span class="dot" id="dot"></span>
      <span id="statusText">Checking…</span>
    </div>
    <div class="meta" id="meta"></div>
    <div class="meta" style="margin-bottom: 8px;">Batch size: <select id="batchSize"><option value="15">15</option><option value="20">20</option><option value="25" selected>25</option><option value="30">30</option><option value="40">40</option></select> &nbsp; Interval: <select id="intervalMin"><option value="5" selected>5 min</option><option value="10">10 min (faster)</option></select> <span id="batchNote"></span></div>
    <div class="meta" style="margin-bottom: 8px;">
      <label><input type="checkbox" id="traderOnly" /> Trader only</label> — faster (skips investor at EOD)
      <span style="margin-left: 12px;"><label><input type="checkbox" id="sequence" /> Sequence</label> — trader-only then investor-only (saves day state, then backfills investor)</span>
    </div>
    <div class="buttons">
      <button class="primary" id="btnStart">Start (fresh)</button>
      <button class="secondary" id="btnResume">Resume</button>
      <button class="danger" id="btnPause">Pause</button>
    </div>
  </div>
  <div class="card">
    <div class="meta">Log tail (auto-refresh)</div>
    <pre id="log"></pre>
  </div>
  <script>
    const dot = document.getElementById("dot");
    const statusText = document.getElementById("statusText");
    const meta = document.getElementById("meta");
    const logEl = document.getElementById("log");
    const btnStart = document.getElementById("btnStart");
    const btnResume = document.getElementById("btnResume");
    const btnPause = document.getElementById("btnPause");
    const batchSizeEl = document.getElementById("batchSize");
    const intervalMinEl = document.getElementById("intervalMin");
    const batchNoteEl = document.getElementById("batchNote");
    const traderOnlyEl = document.getElementById("traderOnly");
    const sequenceEl = document.getElementById("sequence");

    function render(s) {
      dot.className = "dot " + (s.running ? "running" : "stopped");
      statusText.textContent = s.running ? "Running (PID " + (s.pid || "?") + ")" : "Stopped";
      let metaHtml = "";
      if (s.currentDate) metaHtml += "Current date: " + s.currentDate + " ";
      if (s.checkpoint) metaHtml += "Checkpoint: " + s.checkpoint.nextDate + " → " + (s.checkpoint.endDate || "?");
      if (s.checkpoint && s.checkpoint.tickerBatch) metaHtml += " · Batch: " + s.checkpoint.tickerBatch;
      meta.innerHTML = metaHtml || "—";
      if (s.checkpoint && s.checkpoint.tickerBatch && batchSizeEl) {
        batchSizeEl.value = s.checkpoint.tickerBatch;
        if (intervalMinEl && s.checkpoint.intervalMin) intervalMinEl.value = s.checkpoint.intervalMin;
        batchNoteEl.textContent = "(Resume will use selected size/interval)";
      } else if (batchNoteEl) batchNoteEl.textContent = "";
      logEl.textContent = (s.logTail || []).join("\\n") || "(no log)"; // \\n -> newline in browser
      btnStart.disabled = !!s.running;
      btnResume.disabled = !!s.running;
      btnPause.disabled = !s.running;
    }

    function fetchStatus() {
      fetch("/api/status")
        .then(r => r.json())
        .then(render)
        .catch(() => { statusText.textContent = "Error loading status"; });
    }

    btnStart.onclick = () => {
      const batch = batchSizeEl ? batchSizeEl.value : "25";
      const interval = intervalMinEl ? intervalMinEl.value : "5";
      const traderOnly = traderOnlyEl && traderOnlyEl.checked ? "1" : "0";
      const sequence = sequenceEl && sequenceEl.checked ? "1" : "0";
      fetch("/api/start?batchSize=" + encodeURIComponent(batch) + "&intervalMin=" + encodeURIComponent(interval) + "&traderOnly=" + traderOnly + "&sequence=" + sequence, { method: "POST" }).then(r => r.json()).then(d => { alert(d.ok ? "Started" : (d.error || "Failed")); fetchStatus(); });
    };
    btnResume.onclick = () => {
      const batch = batchSizeEl ? batchSizeEl.value : "25";
      const interval = intervalMinEl ? intervalMinEl.value : "5";
      const traderOnly = traderOnlyEl && traderOnlyEl.checked ? "1" : "0";
      const sequence = sequenceEl && sequenceEl.checked ? "1" : "0";
      fetch("/api/resume?batchSize=" + encodeURIComponent(batch) + "&intervalMin=" + encodeURIComponent(interval) + "&traderOnly=" + traderOnly + "&sequence=" + sequence, { method: "POST" }).then(r => r.json()).then(d => { alert(d.ok ? "Resumed" : (d.error || "Failed")); fetchStatus(); });
    };
    btnPause.onclick = () => {
      fetch("/api/pause", { method: "POST" }).then(r => r.json()).then(d => { alert(d.ok ? "Paused" : (d.error || "Failed")); fetchStatus(); });
    };

    fetchStatus();
    setInterval(fetchStatus, 4000);
  </script>
</body>
</html>
`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const setJson = (obj) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(obj));
  };

  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.setHeader("Content-Type", "text/html");
    res.end(HTML_PAGE);
    return;
  }

  if (url.pathname === "/api/status") {
    setJson(getStatus());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/start") {
    const batch = url.searchParams.get("batchSize") || url.searchParams.get("batch") || null;
    const traderOnly = url.searchParams.get("traderOnly") === "1" || url.searchParams.get("traderOnly") === "true";
    const sequence = url.searchParams.get("sequence") === "1" || url.searchParams.get("sequence") === "true";
    const intervalMin = url.searchParams.get("intervalMin") || url.searchParams.get("interval") || null;
    setJson(startReplay(false, batch, traderOnly, sequence, intervalMin));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/resume") {
    const batch = url.searchParams.get("batchSize") || url.searchParams.get("batch") || null;
    const traderOnly = url.searchParams.get("traderOnly") === "1" || url.searchParams.get("traderOnly") === "true";
    const sequence = url.searchParams.get("sequence") === "1" || url.searchParams.get("sequence") === "true";
    const intervalMin = url.searchParams.get("intervalMin") || url.searchParams.get("interval") || null;
    setJson(startReplay(true, batch, traderOnly, sequence, intervalMin));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/pause") {
    setJson(pauseReplay());
    return;
  }

  res.statusCode = 404;
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`Replay control UI: http://localhost:${PORT}`);
  console.log(`Log: ${LOG_FILE}`);
  console.log(`Checkpoint: ${CHECKPOINT_FILE}`);
});
