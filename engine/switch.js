const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const { tsIso, ts } = require("./crypto-utils");
const { CODEX_DIR, CODEX_AUMID, IDX_PATH } = require("./config");
const { loadIdx, saveIdx, saveAcct, currentAcct, ensureDir, accountFilePath } = require("./storage");
const { writeJsonAtomic, writeTextAtomic, renameWithRetry } = require("./atomic-file");
const { writeManagedProjection, inspectAuthState } = require("./auth-state");
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

async function defaultListProcesses(runCommand = execFileAsync) {
  const script = [
    "$items = Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('ChatGPT.exe','Codex.exe','node_repl.exe') }",
    "$codex = @($items | Where-Object { $_.Name -in @('ChatGPT.exe','Codex.exe') -and (($_.ExecutablePath -like '*WindowsApps*OpenAI.Codex*') -or ($_.ExecutablePath -like '*WindowsApps*OpenAI.ChatGPT*') -or ($_.CommandLine -like '*OpenAI.Codex*') -or ($_.CommandLine -like '*OpenAI.ChatGPT*')) })",
    "$ids = New-Object 'System.Collections.Generic.HashSet[int]'",
    "$codex | ForEach-Object { [void]$ids.Add([int]$_.ProcessId) }",
    // Orphaned helpers (parent GUI already exited) never join the ancestor
    // closure; seed them directly so they cannot survive a switch.
    "$items | Where-Object { $_.Name -eq 'node_repl.exe' -and (($_.ExecutablePath -like '*WindowsApps*OpenAI.Codex*') -or ($_.ExecutablePath -like '*WindowsApps*OpenAI.ChatGPT*') -or ($_.CommandLine -like '*OpenAI.Codex*') -or ($_.CommandLine -like '*OpenAI.ChatGPT*')) } | ForEach-Object { [void]$ids.Add([int]$_.ProcessId) }",
    "do { $changed = $false; foreach ($item in $items) { if ($ids.Contains([int]$item.ParentProcessId) -and -not $ids.Contains([int]$item.ProcessId)) { [void]$ids.Add([int]$item.ProcessId); $changed = $true } } } while ($changed)",
    "@($items | Where-Object { $ids.Contains([int]$_.ProcessId) } | ForEach-Object { $title = ''; try { $title = [string](Get-Process -Id $_.ProcessId -ErrorAction Stop).MainWindowTitle } catch {}; [pscustomobject]@{ Name = $_.Name; ProcessId = $_.ProcessId; ParentProcessId = $_.ParentProcessId; ExecutablePath = $_.ExecutablePath; MainWindowTitle = $title } }) | ConvertTo-Json -Compress",
  ].join("; ");
  try {
    const { stdout } = await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
    });
    const output = String(stdout || "").trim();
    if (!output) return [];
    const parsed = JSON.parse(output);
    return (Array.isArray(parsed) ? parsed : [parsed]).map((item) => ({
      name: item.Name,
      pid: Number(item.ProcessId),
      parentPid: Number(item.ParentProcessId),
      executablePath: item.ExecutablePath || null,
      windowTitle: item.MainWindowTitle || "",
    })).filter((item) => Number.isInteger(item.pid) && item.pid > 0);
  } catch (error) {
    const wrapped = new Error(`Could not enumerate official Codex processes: ${error.message}`, { cause: error });
    wrapped.code = "codex_process_enumeration_failed";
    logWarn(wrapped.message);
    throw wrapped;
  }
}

function processPath(item) {
  return String(item?.executablePath || "").replace(/\//g, "\\").toLowerCase();
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
      await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `try { $p = Get-Process -Id ${Number(pid)} -ErrorAction Stop; [void]$p.CloseMainWindow() } catch {}`,
      ], {
        windowsHide: true,
        timeout: 5000,
      });
    } catch {}
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
      await execFileAsync("taskkill.exe", ["/F", "/PID", String(pid)], {
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

async function waitForProcessesToExit(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let remaining = new Set(pids);
  while (remaining.size > 0 && Date.now() < deadline) {
    const running = new Set((await runtime.listProcesses()).map((item) => item.pid));
    remaining = new Set([...remaining].filter((pid) => running.has(pid)));
    if (remaining.size > 0) await runtime.sleep(200);
  }
  return [...remaining];
}

async function killCodex() {
  const processes = await runtime.listProcesses();
  const pids = [...new Set(processes.map((item) => item.pid))];
  await Promise.all(pids.map((pid) => runtime.gracefulClose(pid)));
  const remaining = await waitForProcessesToExit(pids, 4000);
  await Promise.all(remaining.map((pid) => runtime.forceClose(pid)));
  const forceRemaining = await waitForProcessesToExit(remaining, 5000);
  if (forceRemaining.length > 0) {
    throw new Error(`Official Codex processes did not exit: ${forceRemaining.join(", ")}`);
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
    await runtime.sleep(250);
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
  renameWithRetry(tempPath, filePath);
}

async function doSwitch(account, options = {}) {
  if (!account?.id || !account.tokens?.access_token) throw new Error("The target account is incomplete");
  if (account.requires_reauth) {
    throw new Error("The target account requires reauthorization before it can be switched to");
  }
  const current = currentAcct();
  if (!options.force && current?.id === account.id) {
    const authState = inspectAuthState({ migrateProjection: true });
    if (authState.status === "aligned") return { already: true, account };
  }

  await runtime.assertInstalled();
  ensureDir(CODEX_DIR);
  const authPath = path.join(CODEX_DIR, "auth.json");
  const projectionPath = path.join(CODEX_DIR, "codex_auth_projection.json");
  const configPath = path.join(CODEX_DIR, "config.toml");
  const accountPath = accountFilePath(account.id);
  const snapshot = new Map([
    [authPath, captureFile(authPath)],
    [projectionPath, captureFile(projectionPath)],
    [configPath, captureFile(configPath)],
    [IDX_PATH, captureFile(IDX_PATH)],
    [accountPath, captureFile(accountPath)],
  ]);

  try {
    await killCodex();
    clearApiBaseUrl();
    const authValue = writeAuthJson(account);
    writeProjection(account, authValue);

    const index = loadIdx();
    index.current_account_id = account.id;
    saveIdx(index);

    account.last_used = ts();
    saveAcct(account);
    await startCodex();
    logInfo("Codex account switch transaction completed");
    return { already: false, account };
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
