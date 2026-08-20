const fs = require("node:fs");
const { hasPendingWalFile } = require("./atomic-file");
const {
  withVscdb,
  snapshotItems,
  restoreItems,
  waitForVscdbWritable,
  getSqliteNativeTiming,
  deleteItem,
  setItem,
  getItem,
  asText,
  asBuffer,
  ensureItemTable,
  readVscdbItemRows,
} = require("./sqlite-native");

const AUTH_KEYS = [
  "cursorAuth/accessToken",
  "cursorAuth/refreshToken",
  "cursorAuth/cachedEmail",
  "cursorAuth/authId",
  "cursorAuth/userId",
  "cursorAuth/stripeMembershipAuthId",
  "cursorAuth/stripeMembershipType",
  "cursorAuth/stripeSubscriptionStatus",
  "cursorAuth/cachedSignUpType",
  "cursorAuth/cachedTeam",
  "cursorAuth/cachedScopedProfile",
  "cursor.accessToken",
  "cursor.email",
  "cursor.customize.userDisplayNameCache",
  "glass.lastSignedInAuthId",
];

const APPLICATION_USER_KEY = "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser";
const ADMIN_TEAM_ID_KEY = "adminSettings.cachedTeamId";
const ADMIN_AUTH_ID_KEY = "adminSettings.cachedAuthId";
const ADMIN_CACHED_KEY = "adminSettings.cached";
const SESSION_KEYS = [
  APPLICATION_USER_KEY,
  ADMIN_TEAM_ID_KEY,
  ADMIN_AUTH_ID_KEY,
  ADMIN_CACHED_KEY,
];
const SWITCH_SNAPSHOT_KEYS = [...AUTH_KEYS, ...SESSION_KEYS];

function parseJsonValue(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function finiteTeamId(value) {
  const teamId = Number(value);
  return Number.isFinite(teamId) && teamId > 0 ? teamId : null;
}

function readCursorSessionFromDb(db) {
  const blobText = asText(getItem(db, APPLICATION_USER_KEY) || "") || "";
  const blob = blobText ? parseJsonValue(blobText) : null;
  const ai = blob?.aiSettings && typeof blob.aiSettings === "object" ? blob.aiSettings : {};
  const teamId = finiteTeamId(ai.teamId);
  const teamIds = Array.isArray(ai.teamIds)
    ? ai.teamIds.map(finiteTeamId).filter((id) => id != null)
    : [];
  return {
    teamId,
    teamIds,
    membershipType: blob?.membershipType != null ? String(blob.membershipType) : null,
    isEnterprise: blob?.isEnterprise === true,
    adminTeamId: asText(getItem(db, ADMIN_TEAM_ID_KEY) || "") || null,
    adminAuthId: asText(getItem(db, ADMIN_AUTH_ID_KEY) || "") || null,
    adminCached: asText(getItem(db, ADMIN_CACHED_KEY) || "") || null,
  };
}

function applyCursorSessionToDb(db, session) {
  if (!session || typeof session !== "object") return;
  const blobText = asText(getItem(db, APPLICATION_USER_KEY) || "") || "";
  const blob = blobText ? parseJsonValue(blobText) : null;
  if (blob && typeof blob === "object") {
    if (!blob.aiSettings || typeof blob.aiSettings !== "object") blob.aiSettings = {};
    const teamId = finiteTeamId(session.teamId);
    if (teamId != null) {
      blob.aiSettings.teamId = teamId;
      blob.aiSettings.teamIds = Array.isArray(session.teamIds) && session.teamIds.length
        ? session.teamIds.map(finiteTeamId).filter((id) => id != null)
        : [teamId];
    } else {
      delete blob.aiSettings.teamId;
      blob.aiSettings.teamIds = [];
    }
    if (session.membershipType) blob.membershipType = String(session.membershipType);
    blob.isEnterprise = session.isEnterprise === true;
    setItem(db, APPLICATION_USER_KEY, JSON.stringify(blob));
  }

  const teamId = finiteTeamId(session.teamId);
  if (teamId != null) {
    setItem(db, ADMIN_TEAM_ID_KEY, String(session.adminTeamId || teamId));
    if (session.adminAuthId) setItem(db, ADMIN_AUTH_ID_KEY, String(session.adminAuthId));
    else deleteItem(db, ADMIN_AUTH_ID_KEY);
    if (session.adminCached) setItem(db, ADMIN_CACHED_KEY, String(session.adminCached));
    else deleteItem(db, ADMIN_CACHED_KEY);
  } else {
    deleteItem(db, ADMIN_TEAM_ID_KEY);
    deleteItem(db, ADMIN_AUTH_ID_KEY);
    deleteItem(db, ADMIN_CACHED_KEY);
  }
}

const SQLITE_LABELS = {
  busyMessage: "官方 Cursor 还在占用登录库，请关掉后再切",
  busyCode: "cursor_vscdb_busy",
  openMessage: "官方 Cursor 登录库无法打开",
  openCode: "cursor_vscdb_open_failed",
};

function hasPendingWal(dbPath) {
  if (!dbPath) return false;
  return hasPendingWalFile(`${dbPath}-wal`);
}

async function waitForWalToClear(dbPath, timeoutMs, sleep) {
  const wait = typeof sleep === "function" ? sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const maxTries = Math.max(1, Math.ceil((Number(timeoutMs) || 0) / 200));
  for (let attempt = 0; attempt < maxTries && hasPendingWal(dbPath); attempt += 1) {
    await wait(200);
  }
  return !hasPendingWal(dbPath);
}

async function waitForCursorVscdbWritable(dbPath, options = {}) {
  return waitForVscdbWritable(dbPath, { ...options, labels: SQLITE_LABELS });
}

async function readCursorAuth(dbPath, options = {}) {
  void options.copyFirst;
  const rows = await readVscdbItemRows(dbPath, AUTH_KEYS, { labels: SQLITE_LABELS });
  if (!rows) return null;
  const values = {};
  for (const key of AUTH_KEYS) {
    if (rows[key] != null) values[key] = Buffer.from(rows[key], "base64").toString("utf8").trim();
  }
  return values;
}

async function readCursorSessionState(dbPath) {
  if (!dbPath || !fs.existsSync(dbPath)) return null;
  return withVscdb(dbPath, {
    readOnly: true,
    labels: SQLITE_LABELS,
  }, (db) => (db ? readCursorSessionFromDb(db) : null));
}

function captureSwitchSnapshot(db, dbPath) {
  const rows = {};
  for (const key of SWITCH_SNAPSHOT_KEYS) {
    const value = getItem(db, key);
    rows[key] = value == null ? null : Buffer.from(asBuffer(value));
  }
  return { dbPath, missing: false, rows };
}

function readAuthValuesFromDb(db) {
  const values = {};
  for (const key of AUTH_KEYS) {
    const raw = getItem(db, key);
    if (raw == null) continue;
    const text = asText(raw).trim();
    if (text) values[key] = text;
  }
  return values;
}

function writeAuthKeysToDb(db, incoming) {
  for (const key of AUTH_KEYS) {
    const value = incoming[key];
    if (value == null || value === "") deleteItem(db, key);
    else setItem(db, key, String(value));
  }
}

async function writeCursorAuth(dbPath, values, options = {}) {
  if (!dbPath) throw new Error("Cursor state.vscdb path is required");
  await withVscdb(dbPath, {
    labels: SQLITE_LABELS,
    timeout: options.timeout ?? getSqliteNativeTiming().switchTimeoutMs,
  }, (db) => {
    ensureItemTable(db);
    db.exec("BEGIN IMMEDIATE");
    try {
      writeAuthKeysToDb(db, values || {});
      if (options.session !== undefined) applyCursorSessionToDb(db, options.session);
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  });
}

async function applyOfficialCursorSwitch(dbPath, options = {}) {
  if (!dbPath) throw new Error("Cursor state.vscdb path is required");
  const buildWrite = typeof options.buildWrite === "function"
    ? options.buildWrite
    : () => ({ values: options.values || {}, session: options.session });
  return withVscdb(dbPath, {
    labels: SQLITE_LABELS,
    timeout: options.timeout ?? getSqliteNativeTiming().switchTimeoutMs,
  }, (db) => {
    ensureItemTable(db);
    db.exec("BEGIN IMMEDIATE");
    let snapshot;
    let officialValues;
    let officialSession;
    let values;
    let session;
    try {
      snapshot = captureSwitchSnapshot(db, dbPath);
      officialValues = readAuthValuesFromDb(db);
      officialSession = readCursorSessionFromDb(db);
      const planned = buildWrite({ officialValues, officialSession }) || {};
      values = planned.values || {};
      session = planned.session;
      writeAuthKeysToDb(db, values);
      if (session !== undefined) applyCursorSessionToDb(db, session);
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
    return {
      snapshot,
      officialValues,
      officialSession,
      values,
      session,
      writtenValues: readAuthValuesFromDb(db),
      writtenSession: readCursorSessionFromDb(db),
    };
  });
}

async function snapshotVscdb(dbPath) {
  return snapshotItems(dbPath, SWITCH_SNAPSHOT_KEYS, SQLITE_LABELS, { timeout: getSqliteNativeTiming().switchTimeoutMs });
}

function restoreVscdbSnapshot(snapshot) {
  restoreItems(snapshot, SQLITE_LABELS);
}

module.exports = {
  AUTH_KEYS,
  SESSION_KEYS,
  APPLICATION_USER_KEY,
  SQLITE_LABELS,
  hasPendingWal,
  waitForWalToClear,
  waitForCursorVscdbWritable,
  readCursorAuth,
  readCursorSessionState,
  writeCursorAuth,
  applyOfficialCursorSwitch,
  snapshotVscdb,
  restoreVscdbSnapshot,
  finiteTeamId,
};
