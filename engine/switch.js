const path = require("node:path");
const cp = require("node:child_process");
const { tsIso, ts } = require("./crypto-utils");
const { CODEX_DIR, CODEX_AUMID, IDX_PATH } = require("./config");
const { loadIdx, saveIdx, saveAcct, ensureDir, accountFilePath } = require("./storage");
const { writeJsonAtomic, writeTextAtomic, captureFile, readFileWithRetry, restoreCapturedFile } = require("./atomic-file");
const { writeManagedProjection, isInspectBusyError, busyAuthState } = require("./auth-state");

function inspectSwitchAuth(accountId, options) {
  try {
    return require("./auth-state").inspectAuthState(options);
  } catch (error) {
    if (isInspectBusyError(error)) return busyAuthState(accountId);
    throw error;
  }
}

function acceptWrittenSwitchAuth(verified, account) {
  if (verified.status === "aligned" && verified.currentAccountId === account.id) return verified;
  if (verified.status === "unknown" && verified.requiresResolution === false) {
    return {
      status: "aligned",
      requiresResolution: false,
      currentAccountId: account.id,
      matchedAccountId: account.id,
      officialIdentity: verified.officialIdentity || null,
      message: null,
    };
  }
  return null;
}
const { assertOfficialCodexInstalledAsync } = require("./codex-installation");
const { logInfo, logWarn, logError } = require("./logger");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    cp.execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

const GRACEFUL_WAIT_MS = 1500;
const FORCE_WAIT_MS = 4000;
const LEFTOVER_WAIT_MS = 2500;
const PID_POLL_MS = 50;
const START_POLL_MS = 50;

const LIST_CODEX_PROCESSES_COMMAND = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$rows = @(Get-Process -Name 'ChatGPT','Codex','node_repl' -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ Name = ($_.ProcessName + '.exe'); ProcessId = $_.Id; ExecutablePath = $_.Path; MainWindowTitle = [string]$_.MainWindowTitle } })",
  "if ($rows.Count -eq 0) { '[]' } else { @($rows) | ConvertTo-Json -Compress }",
].join("; ");

function processPath(item) {
  return String(item?.executablePath || "").replace(/\//g, "\\").toLowerCase();
}

function isStoreCodexPath(exe) {
  return exe.includes("windowsapps") && (exe.includes("openai.codex") || exe.includes("openai.chatgpt"));
}

function isListedCodexProcess(item) {
  const name = String(item?.name || "").toLowerCase();
  const exe = processPath(item);
  if (name === "chatgpt.exe") return true;
  if (name === "codex.exe") {
    if (!exe) return true;
    if (isStoreCodexPath(exe)) return true;
    return !exe.includes("\\resources\\");
  }
  if (name === "node_repl.exe") return isStoreCodexPath(exe);
  return false;
}

function mapListedProcess(item) {
  return {
    name: item.Name || item.name,
    pid: Number(item.ProcessId ?? item.pid),
    parentPid: Number(item.ParentProcessId ?? item.parentPid) || 0,
    executablePath: item.ExecutablePath || item.executablePath || null,
    windowTitle: item.MainWindowTitle || item.windowTitle || "",
  };
}

async function defaultListProcesses(runCommand = execFileAsync) {
  try {
    const { stdout } = await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", LIST_CODEX_PROCESSES_COMMAND], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 8000,
    });
    const output = String(stdout || "").trim();
    if (!output || output === "[]") return [];
    const parsed = JSON.parse(output);
    return (Array.isArray(parsed) ? parsed : [parsed])
      .map(mapListedProcess)
      .filter((item) => Number.isInteger(item.pid) && item.pid > 0 && isListedCodexProcess(item));
  } catch (error) {
    const wrapped = new Error(`Could not enumerate official Codex processes: ${error.message}`, { cause: error });
    wrapped.code = "codex_process_enumeration_failed";
    logWarn(wrapped.message);
    throw wrapped;
  }
}

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitForPidsToExit(pids, timeoutMs) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  let remaining = pids.filter(pidIsAlive);
  while (remaining.length > 0 && Date.now() < deadline) {
    await runtime.sleep(PID_POLL_MS);
    remaining = remaining.filter(pidIsAlive);
  }
  return remaining;
}

function isOfficialGuiProcess(item) {
  const name = String(item?.name || "").toLowerCase();
  const exe = processPath(item);
  if (name === "chatgpt.exe") return true;
  if (name !== "codex.exe") return false;
  if (!exe) return true;
  return !exe.includes("\\resources\\");
}

function isCrashWindow(item) {
  const title = String(item?.windowTitle || "");
  if (!title) return false;
  return /意外停止|unexpectedly stopped|stopped unexpectedly/i.test(title);
}

const defaultRuntime = {
  assertInstalled: assertOfficialCodexInstalledAsync,
  listProcesses: defaultListProcesses,
  async gracefulClose(pid) {
    try {
      await execFileAsync("taskkill.exe", ["/PID", String(pid)], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  },
  async forceClose(pid) {
    try {
      await execFileAsync("taskkill.exe", ["/F", "/T", "/PID", String(pid)], {
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
    launchOfficialCodex();
  },
  sleep,
};

let runtime = defaultRuntime;

function launchOfficialCodex(childProcess = cp) {
  const child = childProcess.spawn(
    "explorer.exe",
    [`shell:AppsFolder\\${CODEX_AUMID}`],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  child.once?.("error", (error) => {
    logWarn(`Could not launch official Codex: ${error.message}`);
  });
  child.unref?.();
  return true;
}

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
  if (String(account?.id || "").startsWith("cursor_")) {
    throw new Error("Cursor accounts cannot be written to official Codex");
  }
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
  let text;
  try {
    text = readFileWithRetry(configPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  const lines = text.split(/\r?\n/);
  let inRoot = true;
  const filtered = lines.filter((line) => {
    if (/^\s*\[/.test(line)) inRoot = false;
    return !(inRoot && /^\s*(api_base_url|openai_base_url)\s*=/.test(line));
  });
  if (filtered.length === lines.length) return false;
  writeTextAtomic(configPath, filtered.join("\n"));
  return true;
}

async function killCodex() {
  const processes = await runtime.listProcesses();
  const pids = [...new Set(processes.map((item) => item.pid).filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (pids.length === 0) return pids;
  await Promise.all(pids.map((pid) => runtime.gracefulClose(pid)));
  let remaining = await waitForPidsToExit(pids, GRACEFUL_WAIT_MS);
  if (remaining.length > 0) {
    await Promise.all(remaining.map((pid) => runtime.forceClose(pid)));
    remaining = await waitForPidsToExit(remaining, FORCE_WAIT_MS);
  }
  if (remaining.length > 0) {
    throw new Error(`Official Codex processes did not exit: ${remaining.join(", ")}`);
  }
  const leftovers = await runtime.listProcesses();
  if (leftovers.length > 0) {
    await Promise.all(leftovers.map((item) => runtime.forceClose(item.pid)));
    remaining = await waitForPidsToExit(leftovers.map((item) => item.pid), LEFTOVER_WAIT_MS);
    if (remaining.length > 0) {
      throw new Error(`Official Codex processes did not exit: ${remaining.join(", ")}`);
    }
  }
  logInfo(`Closed ${pids.length} official Codex process(es)`);
  return pids;
}

async function startCodex(options = {}) {
  await runtime.launch();
  if (options.verify === false) return true;
  const deadline = Date.now() + (options.timeoutMs || 10000);
  let lastEnumerationError = null;
  let sawCrashWindow = false;
  let pollMs = START_POLL_MS;
  while (Date.now() < deadline) {
    try {
      const processes = await runtime.listProcesses();
      lastEnumerationError = null;
      const gui = processes.filter(isOfficialGuiProcess);
      const healthy = gui.filter((item) => !isCrashWindow(item));
      if (healthy.length > 0) {
        logInfo("Official Codex process started");
        return true;
      }
      if (gui.some(isCrashWindow)) sawCrashWindow = true;
    } catch (error) {
      // A transient enumeration failure (slow PowerShell, AV scan) must not
      // fail the whole switch: the launch itself may already have succeeded,
      // and rolling back then leaves the running app on different credentials.
      lastEnumerationError = error;
    }
    await runtime.sleep(pollMs);
    pollMs = Math.min(pollMs * 2, 400);
  }
  if (lastEnumerationError) {
    logWarn(`Codex start verification skipped (process enumeration unavailable): ${lastEnumerationError.message}`);
    return true;
  }
  if (sawCrashWindow) {
    throw new Error("Official Codex opened a crash recovery window instead of a working session");
  }
  throw new Error("Official Codex did not start within the expected time");
}

function restoreFile(filePath, content) {
  restoreCapturedFile(filePath, content);
}

async function doSwitch(account, options = {}) {
  if (String(account?.id || "").startsWith("cursor_")) {
    throw new Error("Cursor accounts cannot be switched into official Codex");
  }
  if (!account?.id || !account.tokens?.access_token) throw new Error("The target account is incomplete");
  if (account.banned) {
    throw new Error("The target account is banned and cannot be switched to");
  }
  if (account.requires_reauth) {
    throw new Error("The target account requires reauthorization before it can be switched to");
  }
  const currentId = loadIdx().current_account_id;
  if (!options.force && currentId === account.id) {
    const authState = inspectSwitchAuth(account.id, { migrateProjection: true });
    if (authState.status === "aligned") return { already: true, account, authState };
    if (authState.status === "unknown" && authState.requiresResolution === false) {
      return { already: true, account, authState };
    }
  }

  await runtime.assertInstalled();
  ensureDir(CODEX_DIR);
  const authPath = path.join(CODEX_DIR, "auth.json");
  const projectionPath = path.join(CODEX_DIR, "codex_auth_projection.json");
  const configPath = path.join(CODEX_DIR, "config.toml");
  const accountPath = accountFilePath(account.id);
  const snapshot = new Map();

  const started = Date.now();
  let killMs = 0;
  let startMs = 0;
  try {
    const killStarted = Date.now();
    await killCodex();
    killMs = Date.now() - killStarted;
    snapshot.set(authPath, captureFile(authPath));
    snapshot.set(projectionPath, captureFile(projectionPath));
    snapshot.set(configPath, captureFile(configPath));
    snapshot.set(IDX_PATH, captureFile(IDX_PATH));
    snapshot.set(accountPath, captureFile(accountPath));
    clearApiBaseUrl();
    const authValue = writeAuthJson(account);
    writeProjection(account, authValue);

    const index = loadIdx();
    index.current_account_id = account.id;
    saveIdx(index);

    account.last_used = ts();
    saveAcct(account);
    const verified = acceptWrittenSwitchAuth(
      inspectSwitchAuth(account.id, { migrateProjection: false }),
      account,
    );
    if (!verified) {
      const error = new Error("Codex 官方登录写入后核对失败，没有切到目标账号");
      error.code = "codex_switch_verify_failed";
      throw error;
    }
    const startStarted = Date.now();
    await startCodex();
    startMs = Date.now() - startStarted;
    logInfo(`Codex switch timings kill=${killMs}ms start=${startMs}ms total=${Date.now() - started}ms`);
    logInfo("Codex account switch transaction completed");
    try { require("./auto-switch").noteOfficialSwitch(); } catch {}
    return { already: false, account, authState: verified };
  } catch (error) {
    logError(`Codex account switch failed; restoring previous state: ${error.message}`);
    for (const [filePath, content] of snapshot) {
      try { restoreFile(filePath, content); } catch (restoreError) {
        logError(`Rollback failed for ${filePath}: ${restoreError.message}`);
      }
    }
    try { await startCodex({ timeoutMs: 10000 }); } catch (restartError) {
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
  launchOfficialCodex,
  defaultListProcesses,
  setSwitchRuntimeForTests,
};
