import mqtt from "mqtt";
import { HostTransportStream } from "./host-transport-stream.js";
import { offlineDocument } from "./state-doc.js";

export const MAX_RECONNECT_ATTEMPTS = 15;
export const BASE_RECONNECT_DELAY_MS = 2000;
export const MAX_RECONNECT_DELAY_MS = 64000;

export function createMqttBridge({ host, config, onCommand, log }) {
  const stateTopic = `${config.topicPrefix}/state`;
  const commandTopic = `${config.topicPrefix}/command`;

  let client = null;
  let reconnectTimer = null;
  let disposed = false;
  let attempts = 0;
  let onConnected = null;
  let protocolVersion = 5;

  function openStream() {
    const stream = new HostTransportStream(host.transport, {
      kind: config.enableTls ? "tls" : "tcp",
      host: config.host,
      port: config.port,
    });
    stream.open().catch((e) => stream.emit("error", e));
    return stream;
  }

  function scheduleReconnect() {
    if (disposed) return;
    if (attempts >= MAX_RECONNECT_ATTEMPTS) {
      log(`giving up after ${attempts} reconnect attempts`);
      return;
    }
    const delay = Math.min(
      BASE_RECONNECT_DELAY_MS * 2 ** attempts,
      MAX_RECONNECT_DELAY_MS,
    );
    attempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!disposed) start();
    }, delay);
  }

  function start() {
    if (disposed || client) return;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    client = new mqtt.MqttClient(openStream, {
      clientId: config.clientId,
      username: config.username || undefined,
      password: config.password || undefined,
      clean: true,
      reconnectPeriod: 0,
      keepalive: Math.ceil((config.publishIntervalMs + 3000) / 1000),
      protocolVersion,
      will: {
        topic: stateTopic,
        payload: JSON.stringify(offlineDocument()),
        qos: 1,
        retain: true,
      },
    });
    client.on("connect", () => {
      attempts = 0;
      client.subscribe(commandTopic, { qos: 1 });
      if (onConnected) onConnected();
    });
    client.on("message", onCommand);
    client.on("error", (e) => {
      log(`broker error: ${e?.message ?? e}`);
      if (protocolVersion === 5 && /protocol version/i.test(String(e?.message ?? e))) {
        protocolVersion = 4;
        log("broker rejected MQTT 5; retrying with MQTT 3.1.1");
        const dead = client;
        client = null;
        killClient(dead);
        if (!disposed) start();
      }
    });
    client.on("close", () => {
      const dead = client;
      client = null;
      if (dead) killClient(dead);
      scheduleReconnect();
    });
  }

  function killClient(dead) {
    dead.removeAllListeners();
    dead.on("error", () => {});
    dead.end(true);
  }

  function stop() {
    disposed = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (client) {
      const dead = client;
      client = null;
      if (dead.connected) {
        dead.publish(stateTopic, JSON.stringify(offlineDocument()), { qos: 1, retain: true }, () => {
          killClient(dead);
        });
      } else {
        killClient(dead);
      }
    }
  }

  function reset() {
    stop();
    disposed = false;
    attempts = 0;
  }

  function publishState(doc, cb) {
    if (!client) return false;
    client.publish(stateTopic, JSON.stringify(doc), { qos: 1, retain: true }, cb);
    return true;
  }

  return {
    start,
    stop,
    reset,
    publishState,
    get connected() {
      return Boolean(client);
    },
    get reconnectAttempts() {
      return attempts;
    },
    topics: { stateTopic, commandTopic },
    set onConnectedHandler(fn) {
      onConnected = fn;
    },
  };
}
