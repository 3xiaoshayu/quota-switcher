const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function yieldMain() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function copySqliteForRead(dbPath, prefix) {
  const dest = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  await fs.promises.copyFile(dbPath, dest);
  await yieldMain();
  for (const suffix of ["-wal", "-shm"]) {
    try {
      await fs.promises.copyFile(`${dbPath}${suffix}`, `${dest}${suffix}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await yieldMain();
  }
  return dest;
}

async function readSqliteBytes(filePath) {
  await yieldMain();
  const bytes = await fs.promises.readFile(filePath);
  await yieldMain();
  return bytes;
}

function cleanupSqliteCopy(copyPath) {
  for (const target of [copyPath, `${copyPath}-wal`, `${copyPath}-shm`]) {
    try { fs.unlinkSync(target); } catch {}
  }
}

module.exports = {
  yieldMain,
  copySqliteForRead,
  readSqliteBytes,
  cleanupSqliteCopy,
};
