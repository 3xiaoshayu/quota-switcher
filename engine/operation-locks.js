const path = require("node:path");

const accountLocks = new Map();

async function withLock(key, task) {
  const lockKey = String(key || "__global__");
  const previous = accountLocks.get(lockKey) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => {}).then(() => gate);
  accountLocks.set(lockKey, tail);

  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release();
    if (accountLocks.get(lockKey) === tail) {
      accountLocks.delete(lockKey);
    }
  }
}

function withAccountLock(id, task) {
  return withLock(`account:${id}`, task);
}

function withAccountLocks(ids, task) {
  const keys = [...new Set((ids || []).filter(Boolean).map(String))].sort();
  const run = (index) => {
    if (index >= keys.length) return task();
    return withAccountLock(keys[index], () => run(index + 1));
  };
  return run(0);
}

function withPathLock(filePath, task) {
  return withLock(`path:${path.resolve(String(filePath || ""))}`, task);
}

async function mapLimit(items, limit, mapper) {
  const list = Array.from(items || []);
  const concurrency = Math.max(1, Math.min(Number(limit) || 1, list.length || 1));
  if (!list.length) return [];
  const results = new Array(list.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, list.length) }, async () => {
    while (next < list.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(list[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

module.exports = { withAccountLock, withAccountLocks, withPathLock, withLock, mapLimit };
