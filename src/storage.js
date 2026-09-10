export function createStorageAdapter(host) {
  const pendingReads = new Set();

  function read(key, timeoutMs = 2000) {
    return new Promise((resolve) => {
      const pending = { key, resolve };
      pendingReads.add(pending);
      host.storage({ type: "read", key });
      setTimeout(() => {
        if (pendingReads.delete(pending)) {
          resolve(null);
        }
      }, timeoutMs);
    });
  }

  function write(key, data) {
    host.storage({ type: "write", key, data });
  }

  function settle(event) {
    if (event?.name !== "storageRead") return false;
    const key = event?.payload?.key;
    let settled = false;
    for (const pending of Array.from(pendingReads)) {
      if (pending.key === key) {
        pendingReads.delete(pending);
        pending.resolve(event.payload?.value ?? null);
        settled = true;
      }
    }
    return settled;
  }

  return { read, write, settle };
}
