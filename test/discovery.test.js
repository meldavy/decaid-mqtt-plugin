import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDiscoveryConfigs,
  discoveryTopics,
  DISCOVERY_PREFIX,
  ENTITY_NAME_PREFIX,
  DEFAULT_MODEL,
  DEFAULT_DEVICE_NAME,
} from "../src/discovery.js";

const BASE_CONFIG = {
  uniqueId: "abcd1234",
  topicPrefix: "de1plus/abcd1234",
};

test("buildDiscoveryConfigs produces all expected entities", () => {
  const configs = buildDiscoveryConfigs({
    config: BASE_CONFIG,
    deviceInfo: null,
    profileTitles: ["Ristretto", "Long Black"],
  });
  // 10 sensors + 1 binary_sensor + 2 switches + 1 select = 14
  assert.equal(configs.length, 14);
  const topics = configs.map((c) => c.topic);
  assert.ok(topics.every((t) => t.startsWith(`${DISCOVERY_PREFIX}/`)));
  assert.ok(topics.every((t) => t.endsWith("/config")));
});

test("sensor configs have correct structure", () => {
  const configs = buildDiscoveryConfigs({ config: BASE_CONFIG, deviceInfo: null, profileTitles: [] });
  const state = configs.find((c) => c.payload.unique_id === "de1plus_abcd1234_state");
  assert.ok(state);
  assert.equal(state.topic, `${DISCOVERY_PREFIX}/sensor/de1plus_abcd1234_state/config`);
  assert.equal(state.payload.name, `${ENTITY_NAME_PREFIX}State`);
  assert.equal(state.payload.state_topic, "de1plus/abcd1234/state");
  assert.equal(state.payload.value_template, "{{ value_json.state | default(None) }}");
  assert.equal(state.payload.icon, "mdi:state-machine");
  assert.equal(state.payload.availability_topic, "de1plus/abcd1234/state");
  assert.equal(state.payload.payload_available, "True");
  assert.equal(state.payload.payload_not_available, "False");
});

test("temperature sensors have device_class and unit", () => {
  const configs = buildDiscoveryConfigs({ config: BASE_CONFIG, deviceInfo: null, profileTitles: [] });
  const headTemp = configs.find((c) => c.payload.unique_id === "de1plus_abcd1234_head_temp");
  assert.ok(headTemp);
  assert.equal(headTemp.payload.device_class, "temperature");
  assert.equal(headTemp.payload.state_class, "measurement");
  assert.equal(headTemp.payload.unit_of_measurement, "°C");
  assert.equal(headTemp.payload.icon, undefined);
});

test("shot_weight sensor has weight device class", () => {
  const configs = buildDiscoveryConfigs({ config: BASE_CONFIG, deviceInfo: null, profileTitles: [] });
  const shotWeight = configs.find((c) => c.payload.unique_id === "de1plus_abcd1234_shot_weight");
  assert.ok(shotWeight);
  assert.equal(shotWeight.payload.device_class, "weight");
  assert.equal(shotWeight.payload.unit_of_measurement, "g");
});

test("binary sensor shot_active is correct", () => {
  const configs = buildDiscoveryConfigs({ config: BASE_CONFIG, deviceInfo: null, profileTitles: [] });
  const shotActive = configs.find((c) => c.payload.unique_id === "de1plus_abcd1234_shot_active");
  assert.ok(shotActive);
  assert.equal(shotActive.topic, `${DISCOVERY_PREFIX}/binary_sensor/de1plus_abcd1234_shot_active/config`);
  assert.equal(shotActive.payload.payload_on, "True");
  assert.equal(shotActive.payload.payload_off, "False");
});

test("wake/sleep switch has correct command topic and payloads", () => {
  const configs = buildDiscoveryConfigs({ config: BASE_CONFIG, deviceInfo: null, profileTitles: [] });
  const sw = configs.find((c) => c.payload.unique_id === "de1plus_abcd1234_switch");
  assert.ok(sw);
  assert.equal(sw.topic, `${DISCOVERY_PREFIX}/switch/de1plus_abcd1234_switch/config`);
  assert.equal(sw.payload.command_topic, "de1plus/abcd1234/command");
  assert.equal(sw.payload.payload_on, "wake");
  assert.equal(sw.payload.payload_off, "sleep");
  assert.equal(sw.payload.state_on, "True");
  assert.equal(sw.payload.state_off, "False");
  assert.equal(sw.payload.value_template, "{{ value_json.wake_state }}");
  assert.equal(sw.payload.icon, "mdi:coffee-maker");
});

test("steam switch has correct payloads", () => {
  const configs = buildDiscoveryConfigs({ config: BASE_CONFIG, deviceInfo: null, profileTitles: [] });
  const sw = configs.find((c) => c.payload.unique_id === "de1plus_abcd1234_steam_switch");
  assert.ok(sw);
  assert.equal(sw.payload.payload_on, "steam_on");
  assert.equal(sw.payload.payload_off, "steam_off");
  assert.equal(sw.payload.icon, "mdi:heat-wave");
});

test("profile select is included when profiles are provided", () => {
  const configs = buildDiscoveryConfigs({
    config: BASE_CONFIG,
    deviceInfo: null,
    profileTitles: ["Ristretto", "Long Black"],
  });
  const sel = configs.find((c) => c.payload.unique_id === "de1plus_abcd1234_profile_select");
  assert.ok(sel);
  assert.equal(sel.topic, `${DISCOVERY_PREFIX}/select/de1plus_abcd1234_profile_select/config`);
  assert.equal(sel.payload.command_topic, "de1plus/abcd1234/command");
  assert.equal(sel.payload.command_template, "profile {{ value }}");
  assert.deepEqual(sel.payload.options, ["Ristretto", "Long Black"]);
  assert.equal(sel.payload.value_template, "{{ value_json.profile }}");
});

test("profile select is omitted when no profiles", () => {
  const configs = buildDiscoveryConfigs({ config: BASE_CONFIG, deviceInfo: null, profileTitles: [] });
  const sel = configs.find((c) => c.payload.unique_id === "de1plus_abcd1234_profile_select");
  assert.equal(sel, undefined);
  // 10 sensors + 1 binary_sensor + 2 switches = 13
  assert.equal(configs.length, 13);
});

test("device block uses machine info when available", () => {
  const configs = buildDiscoveryConfigs({
    config: BASE_CONFIG,
    deviceInfo: { model: "DE1XXL", firmwareVersion: "1352", mac: "AA:BB:CC:DD:EE:FF" },
    profileTitles: [],
  });
  const device = configs[0].payload.device;
  assert.equal(device.model, "DE1XXL");
  assert.equal(device.name, `${DEFAULT_DEVICE_NAME} DE1XXL`);
  assert.equal(device.sw_version, "1352");
  assert.deepEqual(device.connections, [["mac", "AA:BB:CC:DD:EE:FF"]]);
  assert.deepEqual(device.identifiers, ["abcd1234"]);
  assert.equal(device.manufacturer, "Decent Espresso");
});

test("device block falls back to defaults when machine info is null", () => {
  const configs = buildDiscoveryConfigs({ config: BASE_CONFIG, deviceInfo: null, profileTitles: [] });
  const device = configs[0].payload.device;
  assert.equal(device.model, DEFAULT_MODEL);
  assert.equal(device.name, `${DEFAULT_DEVICE_NAME} ${DEFAULT_MODEL}`);
  assert.equal(device.sw_version, undefined);
  assert.equal(device.connections, undefined);
});

test("all configs share the same device block reference", () => {
  const configs = buildDiscoveryConfigs({ config: BASE_CONFIG, deviceInfo: null, profileTitles: ["X"] });
  const devices = configs.map((c) => c.payload.device);
  for (const d of devices) {
    assert.equal(d, devices[0], "all entities must reference the same device object");
  }
});

test("discoveryTopics extracts topic list", () => {
  const configs = buildDiscoveryConfigs({ config: BASE_CONFIG, deviceInfo: null, profileTitles: [] });
  const topics = discoveryTopics(configs);
  assert.equal(topics.length, configs.length);
  assert.ok(topics.every((t) => typeof t === "string"));
});

test("custom topic prefix is reflected in state and command topics", () => {
  const configs = buildDiscoveryConfigs({
    config: { ...BASE_CONFIG, topicPrefix: "myprefix" },
    deviceInfo: null,
    profileTitles: ["P"],
  });
  for (const c of configs) {
    assert.equal(c.payload.state_topic, "myprefix/state");
    assert.equal(c.payload.availability_topic, "myprefix/state");
  }
  const sw = configs.find((c) => c.payload.command_topic);
  assert.equal(sw.payload.command_topic, "myprefix/command");
});
