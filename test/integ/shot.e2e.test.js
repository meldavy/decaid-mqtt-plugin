import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startE2E, machineSnapshot, shotRecord, waitFor, latestStateDoc, sleep } from "./helpers/fixture.js";

let env;

beforeEach(async () => {
  env = await startE2E();
});

afterEach(async () => {
  await env.stop();
});

test("shot lifecycle: activation cadence, live weight, completion record", async () => {
  const { sim, broker, plugin } = env;
  await waitFor(() => broker.publishes.some((p) => p.topic.endsWith("/state")));

  plugin.event("stateUpdate", machineSnapshot({ state: "idle", substate: "preinfusion" }));
  await waitFor(() => latestStateDoc(broker)?.shot_active === true);

  sim.setScaleStatus("connected");
  const before = statePublishCount(broker);
  sim.queueScaleSnapshot({ timestamp: new Date().toISOString(), weight: 3.2, batteryLevel: 90, timerValue: 1200, flow: 2.2 });
  await waitFor(() => latestStateDoc(broker)?.shot_weight_g === 3.2);

  sim.queueScaleSnapshot({ timestamp: new Date().toISOString(), weight: 8.7, batteryLevel: 90, timerValue: 4000, flow: 2.0 });
  await waitFor(() => latestStateDoc(broker)?.shot_weight_g === 8.7);

  const duringShot = statePublishCount(broker) - before;
  await sleep(2100);
  const withHeartbeat = statePublishCount(broker) - before;
  assert.ok(withHeartbeat >= duringShot + 1, `expected 1s cadence during shot, got ${withHeartbeat} publishes`);

  plugin.event("stateUpdate", machineSnapshot({ state: "idle", substate: "idle" }));
  await waitFor(() => latestStateDoc(broker)?.shot_active === false);

  sim.state.shots = [shotRecord("shot-123")];
  plugin.event("shotStored", { id: "shot-123" });
  await waitFor(() => latestStateDoc(broker)?.shot_id === "shot-123");
  const doc = latestStateDoc(broker);
  assert.equal(doc.shot_id, "shot-123");
  assert.equal(doc.shot_started_at, "2026-09-09T07:15:00.000Z");
  assert.equal(doc.shot_duration_s, 28.4);
  assert.equal(doc.shot_weight_g, 18.5);
  assert.equal(doc.shot_active, false);

  const fetches = sim.requests.filter((r) => r.path === "/api/v1/shots/shot-123");
  assert.equal(fetches.length, 1);
});

test("shotStored failure keeps the document publishable", async () => {
  const { sim, broker, plugin } = env;
  await waitFor(() => broker.publishes.some((p) => p.topic.endsWith("/state")));
  sim.state.shots = [];
  plugin.event("shotStored", { id: "missing" });
  await plugin.waitForLog(/shot fetch failed|shot record fetch failed/);
  plugin.event("stateUpdate", machineSnapshot({ groupTemperature: 91.0 }));
  await waitFor(() => latestStateDoc(broker)?.head_temperature === 91.0);
  assert.equal(latestStateDoc(broker).online, true);
});

test("scale disconnect marks scale_connected false without blocking publishing", async () => {
  const { sim, broker, plugin } = env;
  await waitFor(() => broker.publishes.some((p) => p.topic.endsWith("/state")));
  plugin.event("stateUpdate", machineSnapshot());
  await waitFor(() => latestStateDoc(broker)?.online === true);
  sim.setScaleStatus("connected");
  await waitFor(() => latestStateDoc(broker)?.scale_connected === true);
  sim.setScaleStatus("disconnected");
  await waitFor(() => latestStateDoc(broker)?.scale_connected === false);
  plugin.event("stateUpdate", machineSnapshot({ groupTemperature: 90.0 }));
  await waitFor(() => latestStateDoc(broker)?.head_temperature === 90.0);
});

function statePublishCount(broker) {
  return broker.publishes.filter((p) => p.topic.endsWith("/state")).length;
}
