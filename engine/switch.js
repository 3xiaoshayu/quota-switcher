const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const { tsIso, ts } = require("./crypto-utils");
const { CODEX_DIR, CODEX_AUMID, IDX_PATH, ACCTS_DIR } = require("./config");
const { loadIdx, saveIdx, saveAcct, currentAcct, ensureDir } = require("./storage");
const { writeJsonAtomic, writeTextAtomic } = require("./atomic-file");
const { writeManagedProjection, inspectAuthState } = require("./auth-state");
const { assertOfficialCodexInstalled } = require("./codex-installation");
const { logInfo, logWarn, logError } = require("./logger");

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function defaultListProcesses() {
  const script = [
    "$items = Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('Codex.exe','node_repl.exe') }",
    "$codex = @($items | Where-Object { $_.Name -eq 'Codex.exe' -and (($_.ExecutablePath -like '*WindowsApps*OpenAI.Codex*') -or ($_.CommandLine -like '*OpenAI.Codex*')) })",
    "$ids = New-Object 'System.Collections.Generic.HashSet[int]'",
    "$codex | ForEach-Object { [void]$ids.Add([int]$_.ProcessId) }",
    "do { $changed = $false; foreach ($item in $items) { if ($ids.Contains([int]$item.ParentProcessId) -and -not $ids.Contains([int]$item.ProcessId)) { [void]$ids.Add([int]$item.ProcessId); $changed = $true } } } while ($changed)",
    "@($items | Where-Object { $ids.Contains([int]$_.ProcessId) } | Select-Object Name,ProcessId,ParentProcessId,ExecutablePath) | ConvertTo-Json -Compress",
  ].join("; ");
  try {
    const output = cp.execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
    }).trim();
    if (!output) return [];
    const parsed = JSON.parse(output);
    return (Array.isArray(parsed) ? parsed : [parsed]).map((item) => ({
      name: item.Name,
      pid: Number(item.ProcessId),
      parentPid: Number(item.ParentProcessId),
      executablePath: item.ExecutablePath || null,
    })).filter((item) => Number.isInteger(item.pid) && item.pid > 0);
  } catch (error) {
    logWarn(`Could not enumerate official Codex processes: ${error.message}`);
    return [];
  }
}

const defaultRuntime = {
  assertInstalled: assertOfficialCodexInstalled,
  listProcesses: defaultListProcesses,
  gracefulClose(pid) {
    try {
      cp.execFileSync("taskkill.exe", ["/PID", String(pid)], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  },
  forceClose(pid) {
    try {
      cp.execFileSync("taskkill.exe", ["/F", "/PID", String(pid)], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  },
  launch() {
    cp.execFileSync("explorer.exe", [`shell:AppsFolder\\${CODEX_AUMID}`], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 10000,
    });
  },
  sleep,
};

let runtime = defaultRuntime;

function setSwitchRuntimeForTests(nextRuntime = null) {
  runtime = nextRuntime ? { ...defaultRuntime, ...nextRuntime } : defaultRuntime;
}

function buildAuthJson(account) {
  return {
    auth_mode: null,
    OPENAI_API_KEY: null,
    tokens: {
      id_token: account.tokens.id_token,
      access_token: account.tokens.access_token,
      refresh_token: account.tokens.refresh_token || null,
      account_id: account.account_id,
    },
    last_refresh: tsIso(),
  };
}

function writeAuthJson(account) {
  ensureDir(CODEX_DIR);
  const value = buildAuthJson(account);
  writeJsonAtomic(path.join(CODEX_DIR, "auth.json"), value);
  return value;
}

function writeProjection(account, authValue = null) {
  return writeManagedProjection(account, authValue || buildAuthJson(account));
}

function clearApiBaseUrl() {
  const configPath = path.join(CODEX_DIR, "config.toml");
  if (!fs.existsSync(configPath)) return false;
  const lines = fs.readFileSync(configPath, "utf8").split(/\r?\n/);
  let inRoot = true;
  const filtered = lines.filter((line) => {
    if (/^\s*\[/.test(line)) inRoot = false;
    return !(inRoot && /^\s*(api_base_url|openai_base_url)\s*=/.test(line));
  });
  if (filtered.length === lines.length) return false;
  writeTextAtomic(configPath, filtered.join("\n"));
  return true;
}

function waitForProcessesToExit(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let remaining = new Set(pids);
  while (remaining.size > 0 && Date.now() < deadline) {
    const running = new Set(runtime.listProcesses().map((item) => item.pid));
    remaining = new Set([...remaining].filter((pid) => running.has(pid)));
    if (remaining.size > 0) runtime.sleep(200);
  }
  return [...remaining];
}

function killCodex() {
  const processes = runtime.listProcesses();
  const pids = [...new Set(processes.map((item) => item.pid))];
  for (const pid of pids) runtime.gracefulClose(pid);
  const remaining = waitForProcessesToExit(pids, 2500);
  for (const pid of remaining) runtime.forceClose(pid);
  const forceRemaining = waitForProcessesToExit(remaining, 5000);
  if (forceRemaining.length > 0) {
    throw new Error(`Official Codex processes did not exit: ${forceRemaining.join(", ")}`);
  }
  logInfo(`Closed ${pids.length} official Codex process(es)`);
  return pids;
}

function startCodex(options = {}) {
  runtime.launch();
  if (options.verify === false) return true;
  const deadline = Date.now() + (options.timeoutMs || 10000);
  while (Date.now() < deadline) {
    if (runtime.listProcesses().some((item) => String(item.name).toLowerCase() === "codex.exe")) {
      logInfo("Official Codex process started");
      return true;
    }
    runtime.sleep(250);
  }
  throw new Error("Official Codex did not start within the expected time");
}

function captureFile(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
}

function restoreFile(filePath, content) {
  if (content === null) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return;
  }
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.rollback.tmp`;
  fs.writeFileSync(tempPath, content);
  fs.renameSync(tempPath, filePath);
}

function doSwitch(account, options = {}) {
  if (!account?.id || !account.tokens?.access_token) throw new Error("The target account is incomplete");
  const current = currentAcct();
  if (!options.force && current?.id === account.id) {
    const authState = inspectAuthState({ migrateProjection: true });
    if (authState.status === "aligned") return { already: true, account };
  }

  runtime.assertInstalled();
  ensureDir(CODEX_DIR);
  const authPath = path.join(CODEX_DIR, "auth.json");
  const projectionPath = path.join(CODEX_DIR, "codex_auth_projection.json");
  const configPath = path.join(CODEX_DIR, "config.toml");
  const accountPath = path.join(ACCTS_DIR, `${account.id}.json`);
  const snapshot = new Map([
    [authPath, captureFile(authPath)],
    [projectionPath, captureFile(projectionPath)],
    [configPath, captureFile(configPath)],
    [IDX_PATH, captureFile(IDX_PATH)],
    [accountPath, captureFile(accountPath)],
  ]);

  try {
    killCodex();
    clearApiBaseUrl();
    const authValue = writeAuthJson(account);
    writeProjection(account, authValue);

    const index = loadIdx();
    index.current_account_id = account.id;
    saveIdx(index);

    account.last_used = ts();
    saveAcct(account);
    startCodex();
    logInfo("Codex account switch transaction completed");
    return { already: false, account };
  } catch (error) {
    logError(`Codex account switch failed; restoring previous state: ${error.message}`);
    for (const [filePath, content] of snapshot) {
      try { restoreFile(filePath, content); } catch (restoreError) {
        logError(`Rollback failed for ${filePath}: ${restoreError.message}`);
      }
    }
    try { startCodex({ timeoutMs: 10000 }); } catch (restartError) {
      logError(`Could not restart Codex after rollback: ${restartError.message}`);
    }
    throw error;
  }
}

module.exports = {
  buildAuthJson,
  writeAuthJson,
  writeProjection,
  clearApiBaseUrl,
  killCodex,
  startCodex,
  doSwitch,
  setSwitchRuntimeForTests,
};
