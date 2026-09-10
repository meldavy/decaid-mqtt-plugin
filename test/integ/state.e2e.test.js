import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startE2E, machineSnapshot, waitFor, latestStateDoc, sleep } from "./helpers/fixture.js";

let env;

beforeEach(async () => {
  env = await startE2E();
});

afterEach(async () => {
  await env.stop();
});

const ALL_FIELDS = [
  "online", "de1_connected", "scale_connected", "state", "substate",
  "profile", "profile_filename", "espresso_count", "steaming_count",
  "head_temperature", "mix_temperature", "steam_heater_temperature",
  "water_level_mm", "water_level_ml", "wake_state", "steam_mode", "steam_state",
  "shot_active",
];

test("stateUpdate publishes the full de1app-compatible document, QoS 1, retained", async () => {
  const { broker, plugin } = env;
  await waitFor(() => broker.publishes.some((p) => p.topic.endsWith("/state")));

  plugin.event("stateUpdate", machineSnapshot({
    state: "steam",
    substate: "idle",
    groupTemperature: 96.2,
    mixTemperature: 90.3,
    steamTemperature: 148,
  }));

  await waitFor(() => {
    const doc = latestStateDoc(broker);
    return doc && doc.state === "Steam";
  });
  const publish = broker.publishes.filter((p) => p.topic.endsWith("/state")).pop();
  assert.equal(publish.qos, 1);
  assert.equal(publish.retain, true);
  const doc = JSON.parse(publish.payload);
  for (const field of ALL_FIELDS) {
    assert.ok(field in doc, `missing field ${field}`);
  }
  assert.equal(doc.online, true);
  assert.equal(doc.de1_connected, true);
  assert.equal(doc.scale_connected, false);
  assert.equal(doc.state, "Steam");
  assert.equal(doc.substate, "ready");
  assert.equal(doc.head_temperature, 96.2);
  assert.equal(doc.mix_temperature, 90.3);
  assert.equal(doc.steam_heater_temperature, 148);
  assert.equal(doc.water_level_mm, 0.0);
  assert.equal(doc.water_level_ml, 0);
  assert.equal(doc.wake_state, true);
  assert.equal(doc.steam_mode, "Off");
  assert.equal(doc.steam_state, false);
  assert.equal(doc.shot_active, false);
});

test("identical snapshots are not republished; changes publish immediately", async () => {
  const { broker, plugin } = env;
  await waitFor(() => broker.publishes.some((p) => p.topic.endsWith("/state")));

  plugin.event("stateUpdate", machineSnapshot());
  await waitFor(() => latestStateDoc(broker)?.state === "Idle");
  const afterFirst = statePublishCount(broker);

  plugin.event("stateUpdate", machineSnapshot());
  await sleep(200);
  assert.equal(statePublishCount(broker), afterFirst);

  plugin.event("stateUpdate", machineSnapshot({ groupTemperature: 94.1 }));
  await waitFor(() => statePublishCount(broker) > afterFirst);
  assert.equal(latestStateDoc(broker).head_temperature, 94.1);
});

test("idle heartbeat republishes the state document at the configured interval", async () => {
  const { broker, plugin } = env;
  await waitFor(() => broker.publishes.some((p) => p.topic.endsWith("/state")));
  plugin.event("stateUpdate", machineSnapshot());
  await waitFor(() => latestStateDoc(broker)?.online === true);
  const initialCount = statePublishCount(broker);
  await waitFor(() => statePublishCount(broker) > initialCount + 1, 5000);
  assert.equal(latestStateDoc(broker).online, true);
});

test("water level stream maps mm to the de1app ml lookup table", async () => {
  const { sim, broker, plugin } = env;
  await waitFor(() => broker.publishes.some((p) => p.topic.endsWith("/state")));
  plugin.event("stateUpdate", machineSnapshot());
  await waitFor(() => latestStateDoc(broker)?.online === true);
  sim.sendWaterLevels({ currentLevel: 40.6, refillLevel: 5.0 });
  await waitFor(() => latestStateDoc(broker)?.water_level_mm === 40.6);
  const doc = latestStateDoc(broker);
  assert.equal(doc.water_level_mm, 40.6);
  assert.equal(doc.water_level_ml, 1104);
});

test("workflowUpdated sets profile and resolves the profile filename via REST", async () => {
  const { sim, broker, plugin } = env;
  await waitFor(() => broker.publishes.some((p) => p.topic.endsWith("/state")));
  plugin.event("stateUpdate", machineSnapshot());
  await waitFor(() => latestStateDoc(broker)?.online === true);
  sim.state.profiles = [
    { id: "lb.json", profile: { title: "Long Black" } },
    { id: "ris.json", profile: { title: "Ristretto" } },
  ];

  plugin.event("workflowUpdated", {
    id: "wf-1",
    profile: { title: "Ristretto" },
    context: { targetDoseWeight: 18.0, targetYield: 36.0 },
  });

  await waitFor(() => latestStateDoc(broker)?.profile === "Ristretto");
  const doc = latestStateDoc(broker);
  assert.equal(doc.profile, "Ristretto");
  assert.equal(doc.profile_filename, "ris.json");
  const fetches = sim.requests.filter((r) => r.path === "/api/v1/profiles");
  assert.equal(fetches.length, 1);
});

test("unknown internal state enum names are published verbatim", async () => {
  const { broker, plugin } = env;
  await waitFor(() => broker.publishes.some((p) => p.topic.endsWith("/state")));
  plugin.event("stateUpdate", machineSnapshot({ state: "futureState", substate: "futureSubstate" }));
  await waitFor(() => latestStateDoc(broker)?.state === "futureState");
  assert.equal(latestStateDoc(broker).substate, "futureSubstate");
});

function statePublishCount(broker) {
  return broker.publishes.filter((p) => p.topic.endsWith("/state")).length;
}
