export const DEFAULT_PORT = 8883;
export const DEFAULT_PUBLISH_INTERVAL_MS = 60000;
export const MIN_PUBLISH_INTERVAL_MS = 1000;
export const ACTIVE_SHOT_PUBLISH_INTERVAL_MS = 1000;
export const UNIQUE_ID_KEY = "uniqueId";

export function generateUniqueId() {
  const n = Math.floor(Math.random() * 0xffffffff);
  return n.toString(16).padStart(8, "0");
}

export function normalizeConfig(raw, storedUniqueId) {
  const errors = [];
  const uniqueId = storedUniqueId || generateUniqueId();

  const host = typeof raw.Host === "string" ? raw.Host.trim() : "";
  let port = raw.Port;
  if (port === undefined || port === null || port === "") port = DEFAULT_PORT;
  port = Number(port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push(`port must be an integer in 1-65535, got ${raw.Port}`);
    port = DEFAULT_PORT;
  }

  let publishIntervalMs = raw.PublishIntervalMs;
  if (publishIntervalMs === undefined || publishIntervalMs === null || publishIntervalMs === "") {
    publishIntervalMs = DEFAULT_PUBLISH_INTERVAL_MS;
  }
  publishIntervalMs = Number(publishIntervalMs);
  if (!Number.isFinite(publishIntervalMs) || publishIntervalMs < MIN_PUBLISH_INTERVAL_MS) {
    errors.push(`publishIntervalMs must be >= ${MIN_PUBLISH_INTERVAL_MS}, got ${raw.PublishIntervalMs}`);
    publishIntervalMs = DEFAULT_PUBLISH_INTERVAL_MS;
  }

  const enableTls = raw.EnableTls === undefined || raw.EnableTls === null
    ? true
    : Boolean(raw.EnableTls);

  const clientId = typeof raw.ClientId === "string" && raw.ClientId.trim() !== ""
    ? raw.ClientId.trim()
    : `de1plus_${uniqueId}`;

  const topicPrefix = typeof raw.TopicPrefix === "string" && raw.TopicPrefix.trim() !== ""
    ? raw.TopicPrefix.trim()
    : `de1plus/${uniqueId}`;

  return {
    errors,
    uniqueId,
    config: {
      enabled: host !== "",
      host,
      port,
      username: typeof raw.Username === "string" ? raw.Username : "",
      password: typeof raw.Password === "string" ? raw.Password : "",
      clientId,
      topicPrefix,
      publishIntervalMs,
      enableTls,
      uniqueId,
    },
  };
}
