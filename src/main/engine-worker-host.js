const path = require("node:path");
const { REFRESH_TIMEOUT } = require("../../engine/config");
const { httpJsonLocal } = require("../../engine/http-client");
const { readVscdbItemRowsLocal } = require("../../engine/sqlite-native");
const { reviveError } = require("./engine-worker");

const RPC_TIMEOUT_MS = 90_000;
let rpcTimeoutMs = RPC_TIMEOUT_MS;
const WORKER_DOWN = "engine_worker_down";
const RESTART_DELAY_MS = 400;
const MAX_RESTARTS = 3;

let child = null;
let alive = false;
let stopping = false;
let restartTimer = null;
let restartCount = 0;
let nextId = 1;
const pending = new Map();

function workerDownError(message = "Engine worker is not running") {
  const error = new Error(message);
  error.code = WORKER_DOWN;
  return error;
}

function failAllPending(error) {
  for (const [id, waiter] of pending) {
    clearTimeout(waiter.timer);
    waiter.reject(error);
    pending.delete(id);
  }
}

function shouldScheduleWorkerRestart(state = {}) {
  const stoppingNow = state.stopping ?? stopping;
  const aliveNow = state.alive ?? alive;
  const count = state.restartCount ?? restartCount;
  const pendingTimer = state.restartPending ?? !!restartTimer;
  return !stoppingNow && !aliveNow && count < MAX_RESTARTS && !pendingTimer;
}

function scheduleWorkerRestart() {
  if (!shouldScheduleWorkerRestart()) return;
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (stopping || alive) return;
    restartCount += 1;
    startEngineWorker();
  }, RESTART_DELAY_MS);
}

function onWorkerExit() {
  alive = false;
  child = null;
  failAllPending(workerDownError("Engine worker exited"));
  scheduleWorkerRestart();
}

function abandonStuckWorker(message) {
  const error = workerDownError(message);
  alive = false;
  failAllPending(error);
  try { if (child && typeof child.kill === "function") child.kill(); } catch {}
  child = null;
  scheduleWorkerRestart();
}

function onWorkerMessage(data) {
  restartCount = 0;
  const payload = data && Object.prototype.hasOwnProperty.call(data, "data") ? data.data : data;
  const waiter = pending.get(payload?.id);
  if (!waiter) return;
  pending.delete(payload.id);
  clearTimeout(waiter.timer);
  if (payload.ok) waiter.resolve(payload.result);
  else waiter.reject(reviveError(payload.error));
}

function rpcTimeoutForHttpJson(opts = {}) {
  const timeout = Number(opts.timeout) > 0 ? Number(opts.timeout) : REFRESH_TIMEOUT;
  const slack = Math.min(8000, Math.max(1000, timeout));
  return Math.min(rpcTimeoutMs, timeout * 2 + slack);
}

function rpc(op, payload, timeoutMs = rpcTimeoutMs) {
  if (!alive || !child || typeof child.postMessage !== "function") {
    return Promise.reject(workerDownError());
  }
  const id = nextId;
  nextId += 1;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      abandonStuckWorker("Engine worker timed out");
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try {
      child.postMessage({ id, op, payload });
    } catch (error) {
      pending.delete(id);
      clearTimeout(timer);
      reject(error);
    }
  });
}

function canUseUtilityProcess() {
  if (!process.versions.electron) return false;
  try {
    const electron = require("electron");
    return typeof electron.utilityProcess?.fork === "function";
  } catch {
    return false;
  }
}

function startEngineWorker() {
  if (alive) return true;
  stopping = false;
  if (!canUseUtilityProcess()) return false;
  try {
    const { utilityProcess } = require("electron");
    const script = path.join(__dirname, "engine-worker.js");
    child = utilityProcess.fork(script, [], { serviceName: "codex-engine-worker" });
    child.on("message", onWorkerMessage);
    child.on("exit", onWorkerExit);
    if (typeof child.on === "function") {
      child.on("error", onWorkerExit);
    }
    alive = true;
    return true;
  } catch (error) {
    console.error("Engine worker fork failed; using in-process engine:", error);
    alive = false;
    child = null;
    return false;
  }
}

function stopEngineWorker() {
  stopping = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  alive = false;
  failAllPending(workerDownError("Engine worker stopped"));
  try { if (child && typeof child.kill === "function") child.kill(); } catch {}
  child = null;
}

function isEngineWorkerAlive() {
  return alive;
}

function setRpcTimeoutMsForTests(ms) {
  rpcTimeoutMs = ms == null ? RPC_TIMEOUT_MS : Math.max(1, Number(ms) || RPC_TIMEOUT_MS);
}

function setEngineWorkerForTests(next = null) {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  failAllPending(workerDownError("Engine worker test reset"));
  if (next && next.child) {
    child = next.child;
    alive = next.alive !== false;
    stopping = false;
    return;
  }
  child = null;
  alive = false;
  stopping = false;
}

async function httpJson(url, opts = {}) {
  if (!alive) return httpJsonLocal(url, opts);
  try {
    return await rpc("httpJson", { url, opts }, rpcTimeoutForHttpJson(opts));
  } catch (error) {
    if (error && error.code === WORKER_DOWN) {
      // A timed-out worker may already have sent a token POST. Do not
      // replay refresh-token rotation from the parent process.
      if (opts.idempotent === false) throw error;
      return httpJsonLocal(url, opts);
    }
    throw error;
  }
}

async function readVscdbItems(dbPath, keys, options = {}) {
  if (!alive) return readVscdbItemRowsLocal(dbPath, keys, options);
  try {
    return await rpc("readVscdbItems", { dbPath, keys, options });
  } catch (error) {
    if (error && error.code === WORKER_DOWN) return readVscdbItemRowsLocal(dbPath, keys, options);
    throw error;
  }
}

module.exports = {
  startEngineWorker,
  stopEngineWorker,
  isEngineWorkerAlive,
  httpJson,
  readVscdbItems,
  WORKER_DOWN,
  MAX_RESTARTS,
  RPC_TIMEOUT_MS,
  shouldScheduleWorkerRestart,
  setRpcTimeoutMsForTests,
  setEngineWorkerForTests,
  rpcTimeoutForHttpJson,
};
