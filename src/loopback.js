export const LOCAL_API_BASE = "http://localhost:8080";
export const LOCAL_WS_BASE = "ws://localhost:8080";

export function createLoopbackJsonStream({ host, path, onJson, onStatus, log }) {
  const url = `${LOCAL_WS_BASE}${path}`;
  let handle = null;
  let stopped = false;
  let reconnectTimer = null;
  let backoffMs = 2000;
  let connected = false;

  function scheduleReconnect() {
    if (stopped) return;
    connected = false;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!stopped) connect();
    }, backoffMs);
    backoffMs = Math.min(backoffMs * 2, 64000);
  }

  async function connect() {
    if (stopped || handle !== null) return;
    try {
      const opened = await host.transport.open({
        kind: "websocket",
        url,
      });
      if (stopped) {
        host.transport.close(opened.handle);
        return;
      }
      handle = opened.handle;
      backoffMs = 2000;
      host.transport.onEvent(opened.handle, (event) => {
        switch (event.type) {
          case "data": {
            if (event.dataType !== "text") return;
            let parsed;
            try {
              parsed = JSON.parse(event.data);
            } catch {
              log(`non-JSON loopback message on ${path}`);
              return;
            }
            if (parsed && typeof parsed.status === "string") {
              onStatus?.(parsed.status);
            } else {
              connected = true;
              onJson?.(parsed);
            }
            break;
          }
          case "error":
            log(`loopback error on ${path}: ${event.message ?? event.code}`);
            break;
          case "close":
            handle = null;
            scheduleReconnect();
            break;
          default:
            break;
        }
      });
    } catch (e) {
      log(`loopback connect failed (${path}): ${e?.message ?? e}`);
      scheduleReconnect();
    }
  }

  async function stop() {
    stopped = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (handle !== null) {
      const dead = handle;
      handle = null;
      await host.transport.close(dead).catch(() => {});
    }
    connected = false;
  }

  function start() {
    stopped = false;
    backoffMs = 2000;
    connect();
  }

  return {
    start,
    stop,
    get healthy() {
      return connected;
    },
  };
}
