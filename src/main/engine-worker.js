const path = require("node:path");

const engineRoot = path.resolve(__dirname, "..", "..", "engine");
const { httpJsonLocal } = require(path.join(engineRoot, "http-client"));
const { readVscdbItemRowsLocal } = require(path.join(engineRoot, "sqlite-native"));

function serializeError(error) {
  return {
    message: error?.message || String(error || "unknown error"),
    code: error?.code || null,
    name: error?.name || "Error",
  };
}

function reviveError(payload) {
  const error = new Error(payload?.message || "engine worker failed");
  if (payload?.code) error.code = payload.code;
  if (payload?.name) error.name = payload.name;
  return error;
}

async function handleWorkerJob(op, payload = {}) {
  if (op === "httpJson") {
    return httpJsonLocal(payload.url, payload.opts || {});
  }
  if (op === "readVscdbItems") {
    return readVscdbItemRowsLocal(payload.dbPath, payload.keys || [], payload.options || {});
  }
  const error = new Error(`Unknown engine worker operation: ${op}`);
  error.code = "engine_worker_unknown_op";
  throw error;
}

function attachParentPort(port) {
  if (!port || typeof port.on !== "function") return;
  port.on("message", async (event) => {
    const data = event && Object.prototype.hasOwnProperty.call(event, "data") ? event.data : event;
    const id = data?.id;
    try {
      const result = await handleWorkerJob(data?.op, data?.payload);
      port.postMessage({ id, ok: true, result });
    } catch (error) {
      port.postMessage({ id, ok: false, error: serializeError(error) });
    }
  });
}

if (process.parentPort) attachParentPort(process.parentPort);

module.exports = {
  handleWorkerJob,
  attachParentPort,
  serializeError,
  reviveError,
};
