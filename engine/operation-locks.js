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

module.exports = { withAccountLock, withAccountLocks };
