const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { writeFileWithRetry, unlinkIfPresent } = require("./atomic-file");

const CREDENTIAL_TARGET = "gemini:antigravity";

const READ_SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class AgCredRead {
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredRead(string target, int type, int reservedFlag, out IntPtr credentialPtr);
  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern void CredFree(IntPtr credentialPtr);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags;
    public int Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize;
    public IntPtr CredentialBlob;
    public int Persist;
    public int AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }
}
"@
$ptr = [IntPtr]::Zero
if (-not [AgCredRead]::CredRead("${CREDENTIAL_TARGET}", 1, 0, [ref]$ptr)) { "" ; exit 0 }
try {
  $cred = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][AgCredRead+CREDENTIAL])
  if ($cred.CredentialBlobSize -le 0) { "" ; exit 0 }
  $bytes = New-Object byte[] $cred.CredentialBlobSize
  [Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $cred.CredentialBlobSize)
  $unicode = [Text.Encoding]::Unicode.GetString($bytes).Trim([char]0)
  if ($unicode) { $unicode } else { [Text.Encoding]::UTF8.GetString($bytes).Trim([char]0) }
} finally {
  [AgCredRead]::CredFree($ptr)
}
`;

const WRITE_SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class AgCredWrite {
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredWrite(ref CREDENTIAL credential, uint flags);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredDelete(string target, int type, int flags);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags;
    public int Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize;
    public IntPtr CredentialBlob;
    public int Persist;
    public int AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }
}
"@
$path = $env:AG_CRED_FILE
if (-not $path) { throw "AG_CRED_FILE is missing" }
$json = [IO.File]::ReadAllText($path)
$bytes = [Text.Encoding]::UTF8.GetBytes($json)
$ptr = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
try {
  [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $ptr, $bytes.Length)
  [void][AgCredWrite]::CredDelete("${CREDENTIAL_TARGET}", 1, 0)
  $cred = New-Object AgCredWrite+CREDENTIAL
  $cred.Type = 1
  $cred.TargetName = "${CREDENTIAL_TARGET}"
  $cred.UserName = "antigravity"
  $cred.Persist = 2
  $cred.CredentialBlobSize = $bytes.Length
  $cred.CredentialBlob = $ptr
  if (-not [AgCredWrite]::CredWrite([ref]$cred, 0)) {
    throw (New-Object ComponentModel.Win32Exception([Runtime.InteropServices.Marshal]::GetLastWin32Error())).Message
  }
} finally {
  [Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)
}
`;

const DELETE_SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class AgCredDelete {
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredDelete(string target, int type, int flags);
}
"@
[void][AgCredDelete]::CredDelete("${CREDENTIAL_TARGET}", 1, 0)
`;

function expiryTimestampFromValue(value) {
  if (value == null || value === "") return 0;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  }
  const text = String(value).trim();
  if (!text) return 0;
  if (/^\d+$/.test(text)) {
    const number = Number(text);
    return number > 1e12 ? Math.floor(number / 1000) : number;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

function tokenFieldsFromPayload(parsed) {
  const nested = parsed?.token && typeof parsed.token === "object" ? parsed.token : null;
  const refresh = String(
    nested?.refresh_token
    || nested?.refreshToken
    || parsed?.refresh_token
    || parsed?.refreshToken
    || parsed?.secret
    || "",
  ).trim();
  const access = String(
    nested?.access_token
    || nested?.accessToken
    || parsed?.access_token
    || parsed?.accessToken
    || "",
  ).trim();
  const email = String(parsed?.email || parsed?.username || nested?.email || "").trim();
  const expiry = expiryTimestampFromValue(
    nested?.expiry
    || nested?.expiry_timestamp
    || nested?.expiryTimestamp
    || parsed?.expiry
    || parsed?.expiry_timestamp,
  );
  return { refresh, access, email, expiry };
}

function parseCredentialBlob(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      const fields = tokenFieldsFromPayload(parsed);
      if (fields.refresh || fields.access) {
        return {
          refresh_token: fields.refresh || null,
          access_token: fields.access || null,
          email: fields.email || null,
          expiry_timestamp: fields.expiry || 0,
          token_type: String(parsed?.token?.token_type || parsed?.token_type || "Bearer"),
        };
      }
    } catch {}
  }
  return { refresh_token: text, access_token: null, email: null, expiry_timestamp: 0, token_type: "Bearer" };
}

function expiryRfc3339(seconds) {
  const value = Number(seconds) || 0;
  const date = value > 0 ? new Date(value * 1000) : new Date();
  const iso = date.toISOString();
  return iso.replace(/\.(\d{3})Z$/, (_, ms) => `.${ms}000Z`);
}

function buildAntigravityCredentialPayload(account) {
  const tokens = account?.tokens && typeof account.tokens === "object" ? account.tokens : account || {};
  return JSON.stringify({
    token: {
      access_token: String(tokens.access_token || ""),
      token_type: String(tokens.token_type || "Bearer"),
      refresh_token: String(tokens.refresh_token || ""),
      expiry: expiryRfc3339(tokens.expiry_timestamp),
    },
    auth_method: "consumer",
  });
}

function defaultExecFile(file, args, options) {
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

function resolveExec(runCommand) {
  return typeof runCommand === "function" ? runCommand : defaultExecFile;
}

async function runPowerShell(script, runCommand, extra = {}) {
  return resolveExec(runCommand)("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ], {
    encoding: "utf8",
    windowsHide: true,
    timeout: extra.timeout || 8000,
    env: extra.env || process.env,
  });
}

async function readWindowsAntigravityCredential(runCommand) {
  if (process.platform !== "win32") return null;
  try {
    const { stdout } = await runPowerShell(READ_SCRIPT, runCommand);
    return parseCredentialBlob(stdout);
  } catch {
    return null;
  }
}

async function writeWindowsAntigravityCredential(account, runCommand) {
  if (process.platform !== "win32") return true;
  const payload = buildAntigravityCredentialPayload(account);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-cred-"));
  const filePath = path.join(dir, "payload.json");
  writeFileWithRetry(filePath, payload, "utf8");
  try {
    await runPowerShell(WRITE_SCRIPT, runCommand, {
      timeout: 8000,
      env: { ...process.env, AG_CRED_FILE: filePath },
    });
    return true;
  } finally {
    try { unlinkIfPresent(filePath); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

async function deleteWindowsAntigravityCredential(runCommand) {
  if (process.platform !== "win32") return true;
  try {
    await runPowerShell(DELETE_SCRIPT, runCommand);
  } catch {}
  return true;
}

async function restoreWindowsAntigravityCredential(snapshot, runCommand) {
  if (!snapshot || !(snapshot.refresh_token || snapshot.access_token)) {
    return deleteWindowsAntigravityCredential(runCommand);
  }
  return writeWindowsAntigravityCredential({ tokens: snapshot }, runCommand);
}

module.exports = {
  CREDENTIAL_TARGET,
  parseCredentialBlob,
  buildAntigravityCredentialPayload,
  readWindowsAntigravityCredential,
  writeWindowsAntigravityCredential,
  deleteWindowsAntigravityCredential,
  restoreWindowsAntigravityCredential,
};
