import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import mqtt from "mqtt";
import { startE2E } from "./helpers/fixture.js";
import { loadMqttPlugin } from "./helpers/plugin-runner.js";
import { waitFor } from "./helpers/broker.js";

let env;

beforeEach(async () => {
  env = await startE2E({
    settings: {
      HaAutoDiscoveryEnable: true,
    },
    simSetup: (sim) => {
      sim.state.profiles = [{ profile: { title: "Profile A" } }];
    },
  });
});

afterEach(async () => {
  if (env) await env.stop();
});

test("publishes HA discovery entities on connect when enabled", async () => {
  env.sim.state.machineInfo = { model: "DE1XXL", firmwareVersion: "1234" };
  env.sim.state.profiles = [{ profile: { title: "Test Profile" } }];

  await waitFor(() => env.broker.subscriptions.length > 0);
  await waitFor(() => env.broker.publishes.some((p) => p.topic.includes("/config")));

  const discoveryMessages = env.broker.publishes.filter((p) =>
    p.topic.startsWith("homeassistant/") && p.topic.endsWith("/config") && p.payload.length > 0
  );

  assert.equal(discoveryMessages.length, 14);

  assert.ok(discoveryMessages.every((m) => m.retain === true));
  assert.ok(discoveryMessages.every((m) => m.qos === 1));

  const stateEntity = discoveryMessages.find((m) => m.topic.includes("state/config"));
  assert.ok(stateEntity);
  const payload = JSON.parse(stateEntity.payload.toString());
  assert.equal(payload.device.model, "DE1XXL");
  assert.equal(payload.device.sw_version, "1234");
});

test("does not publish HA discovery when disabled", async () => {
  await env.stop();
  env = await startE2E({
    settings: {
      HaAutoDiscoveryEnable: false,
    }
  });

  await waitFor(() => env.broker.subscriptions.length > 0);
  await new Promise((r) => setTimeout(r, 100));

  const discoveryMessages = env.broker.publishes.filter((p) =>
    p.topic.startsWith("homeassistant/") && p.topic.endsWith("/config") && p.payload.length > 0
  );
  assert.equal(discoveryMessages.length, 0);
});

test("re-publishes discovery configs when a profile command is received", async () => {
  env.sim.state.profiles = [{ profile: { title: "Profile A" } }];
  await waitFor(() => env.broker.subscriptions.length > 0);

  env.broker.publishes.length = 0;

  env.sim.state.profiles = [{ profile: { title: "Profile B" } }, { profile: { title: "Profile C" } }];
  
  const commandTopic = env.broker.connections[0].id.replace("de1plus_", "de1plus/") + "/command";
  const sender = mqtt.connect(`mqtt://127.0.0.1:${env.broker.port}`, { clean: true });
  try {
    await new Promise((resolve, reject) => {
      sender.once("connect", resolve);
      sender.once("error", reject);
    });
    await new Promise((resolve, reject) => {
      sender.publish(commandTopic, "profile Profile B", { qos: 1 }, (e) => (e ? reject(e) : resolve()));
    });

    await waitFor(() => {
      return env.broker.publishes.some((p) =>
        p.topic.startsWith("homeassistant/") && p.topic.endsWith("/config")
      );
    }, 5000);
  } finally {
    await new Promise((resolve) => sender.end(true, {}, resolve));
  }

  const discoveryMessages = env.broker.publishes.filter((p) =>
    p.topic.startsWith("homeassistant/") && p.topic.endsWith("/config")
  );
  
  assert.equal(discoveryMessages.length, 14);
  const selectEntity = discoveryMessages.find((m) => m.topic.includes("profile_select/config"));
  assert.ok(selectEntity);
  const payload = JSON.parse(selectEntity.payload.toString());
  assert.deepEqual(payload.options, ["Profile B", "Profile C"]);
});

test("retracts discovery topics when profile list becomes empty", async () => {
  env.sim.state.profiles = [{ profile: { title: "Profile A" } }];
  await waitFor(() => env.broker.subscriptions.length > 0);
  await waitFor(() => env.broker.publishes.filter((p) =>
    p.topic.startsWith("homeassistant/") && p.topic.endsWith("/config")
  ).length === 14);

  env.broker.publishes.length = 0;
  env.sim.state.profiles = [];

  // Force a reconnect to trigger publishDiscovery.
  const clientId = env.broker.connections[0].id;
  assert.equal(env.broker.crashClient(clientId), true);
  await waitFor(() => env.broker.connections.length >= 2, 10000);

  await waitFor(() => env.broker.publishes.filter((p) =>
    p.topic.startsWith("homeassistant/") && p.payload.length === 0
  ).length === 1, 10000);
  const retractions = env.broker.publishes.filter((p) =>
    p.topic.startsWith("homeassistant/") && p.payload.length === 0
  );
  assert.equal(retractions.length, 1);
  assert.ok(retractions[0].topic.includes("profile_select/config"));
  assert.equal(env.broker.retained.has(retractions[0].topic), false);
});

test("retracts previously retained entities when discovery is disabled", async () => {
  env.sim.state.profiles = [{ profile: { title: "Test Profile" } }];
  const discoveryTopicsKey = "discoveryTopics";
  await waitFor(() => {
    const topics = JSON.parse(env.plugin.shim.store.get(discoveryTopicsKey) || "[]");
    return topics.length === 14;
  });

  const seedStore = Object.fromEntries(env.plugin.shim.store.entries());
  // Simulate upgrading from a version that did not persist its discovery topics.
  delete seedStore[discoveryTopicsKey];
  await env.plugin.unload();
  env.plugin = await loadMqttPlugin({
    sim: { port: env.simPort },
    settings: {
      Host: "127.0.0.1",
      Port: env.broker.port,
      EnableTls: false,
      PublishIntervalMs: 1000,
      HaAutoDiscoveryEnable: false,
    },
    seedStore
  });

  await waitFor(() => env.broker.publishes.filter((p) =>
    p.topic.startsWith("homeassistant/") && p.payload.length === 0
  ).length === 14);

  const retractions = env.broker.publishes.filter((p) =>
    p.topic.startsWith("homeassistant/") && p.payload.length === 0
  );
  assert.equal(retractions.length, 14);
  assert.equal([...env.broker.retained.keys()].filter((topic) => topic.startsWith("homeassistant/")).length, 0);
});

test("retracts a legacy profile select when the first post-upgrade profile list is empty", async () => {
  const discoveryTopicsKey = "discoveryTopics";
  await waitFor(() => {
    const topics = JSON.parse(env.plugin.shim.store.get(discoveryTopicsKey) || "[]");
    return topics.length === 14;
  });
  const profileSelectTopic = [...env.broker.retained.keys()].find((topic) => topic.includes("profile_select/config"));
  assert.ok(profileSelectTopic);

  const seedStore = Object.fromEntries(env.plugin.shim.store.entries());
  delete seedStore[discoveryTopicsKey];
  env.broker.publishes.length = 0;
  env.sim.state.profiles = [];
  await env.plugin.unload();
  env.plugin = await loadMqttPlugin({
    sim: { port: env.simPort },
    settings: {
      Host: "127.0.0.1",
      Port: env.broker.port,
      EnableTls: false,
      PublishIntervalMs: 1000,
      HaAutoDiscoveryEnable: true,
    },
    seedStore,
  });

  await waitFor(() => env.broker.publishes.some((publish) =>
    publish.topic === profileSelectTopic && publish.payload.length === 0
  ));
  assert.equal(env.broker.retained.has(profileSelectTopic), false);
});
