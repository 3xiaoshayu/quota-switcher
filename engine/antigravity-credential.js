const cp = require("node:child_process");

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
        };
      }
    } catch {}
  }
  return { refresh_token: text, access_token: null, email: null, expiry_timestamp: 0 };
}

async function readWindowsAntigravityCredential(runCommand) {
  if (process.platform !== "win32") return null;
  const exec = typeof runCommand === "function"
    ? runCommand
    : (file, args, options) => new Promise((resolve, reject) => {
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
  try {
    const { stdout } = await exec("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      READ_SCRIPT,
    ], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 8000,
    });
    return parseCredentialBlob(stdout);
  } catch {
    return null;
  }
}

module.exports = {
  CREDENTIAL_TARGET,
  parseCredentialBlob,
  readWindowsAntigravityCredential,
};
