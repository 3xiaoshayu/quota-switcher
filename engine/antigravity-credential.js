const cp = require("node:child_process");

const { logWarn } = require("./logger");

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
if (-not [AgCredRead]::CredRead("${CREDENTIAL_TARGET}", 1, 0, [ref]$ptr)) {
  $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  if ($err -eq 1168) { "" ; exit 0 }
  throw "CredRead failed: $err"
}
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
$encoded = $env:AG_CRED_B64
if (-not $encoded) { throw "AG_CRED_B64 is missing" }
$bytes = [Convert]::FromBase64String($encoded)
if ($bytes.Length -le 0) { throw "AG_CRED_B64 is empty" }
$ptr = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
try {
  [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $ptr, $bytes.Length)
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
  const { stdout } = await runPowerShell(READ_SCRIPT, runCommand);
  return parseCredentialBlob(stdout);
}

// The payload carries the refresh token, so it never touches the disk: it is
// handed to PowerShell through the child's environment and decoded there.
// A temp file would outlive a crash in %TEMP% in clear text.
function encodeCredentialPayloadForEnv(payload) {
  return Buffer.from(String(payload), "utf8").toString("base64");
}

async function writeWindowsAntigravityCredential(account, runCommand) {
  if (process.platform !== "win32") return true;
  const payload = buildAntigravityCredentialPayload(account);
  await runPowerShell(WRITE_SCRIPT, runCommand, {
    timeout: 8000,
    env: { ...process.env, AG_CRED_B64: encodeCredentialPayloadForEnv(payload) },
  });
  return true;
}

async function deleteWindowsAntigravityCredential(runCommand) {
  if (process.platform !== "win32" && typeof runCommand !== "function") return true;
  await runPowerShell(DELETE_SCRIPT, runCommand);
  return true;
}

async function restoreWindowsAntigravityCredential(snapshot, runCommand) {
  if (snapshot?.snapshotFailed) {
    logWarn("Antigravity credential snapshot failed; leaving the official credential unchanged");
    return false;
  }
  if (!snapshot || !(snapshot.refresh_token || snapshot.access_token)) {
    return deleteWindowsAntigravityCredential(runCommand);
  }
  return writeWindowsAntigravityCredential({ tokens: snapshot }, runCommand);
}

module.exports = {
  CREDENTIAL_TARGET,
  READ_SCRIPT,
  WRITE_SCRIPT,
  parseCredentialBlob,
  buildAntigravityCredentialPayload,
  encodeCredentialPayloadForEnv,
  readWindowsAntigravityCredential,
  writeWindowsAntigravityCredential,
  deleteWindowsAntigravityCredential,
  restoreWindowsAntigravityCredential,
};
