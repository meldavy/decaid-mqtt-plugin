export const DISCOVERY_PREFIX = "homeassistant";
export const ENTITY_NAME_PREFIX = "DE1+ ";
export const DEFAULT_DEVICE_NAME = "Decent Espresso";
export const DEFAULT_MODEL = "DE1";

function deviceBlock(config, deviceInfo) {
  const model = deviceInfo?.model || DEFAULT_MODEL;
  const name = `${DEFAULT_DEVICE_NAME} ${model}`;
  const device = {
    identifiers: [config.uniqueId],
    name,
    manufacturer: "Decent Espresso",
    model,
  };
  if (deviceInfo?.firmwareVersion) {
    device.sw_version = String(deviceInfo.firmwareVersion);
  }
  if (deviceInfo?.mac) {
    device.connections = [["mac", deviceInfo.mac]];
  }
  return device;
}

function availability(stateTopic) {
  return {
    availability_topic: stateTopic,
    availability_template: "{{ value_json.de1_connected }}",
    payload_available: "True",
    payload_not_available: "False",
  };
}

function uniqueId(config, entityName) {
  return `de1plus_${config.uniqueId}_${entityName}`;
}

function sensorConfig(config, device, stateTopic, { entityName, displayName, field, deviceClass, stateClass, unit, icon }) {
  const cfg = {
    name: `${ENTITY_NAME_PREFIX}${displayName}`,
    unique_id: uniqueId(config, entityName),
    state_topic: stateTopic,
    value_template: `{{ value_json.${field} | default(None) }}`,
    device,
    ...availability(stateTopic),
  };
  if (deviceClass) cfg.device_class = deviceClass;
  if (stateClass) cfg.state_class = stateClass;
  if (unit) cfg.unit_of_measurement = unit;
  if (icon) cfg.icon = icon;
  return cfg;
}

const SENSORS = [
  { entityName: "state", displayName: "State", field: "state", icon: "mdi:state-machine" },
  { entityName: "substate", displayName: "Substate", field: "substate", icon: "mdi:state-machine" },
  { entityName: "water_level", displayName: "Water Level", field: "water_level_ml", deviceClass: "volume_storage", stateClass: "measurement", unit: "mL", icon: "mdi:water" },
  { entityName: "head_temp", displayName: "Head Temperature", field: "head_temperature", deviceClass: "temperature", stateClass: "measurement", unit: "°C" },
  { entityName: "mix_temp", displayName: "Mix Temperature", field: "mix_temperature", deviceClass: "temperature", stateClass: "measurement", unit: "°C" },
  { entityName: "steam_temp", displayName: "Steam Temperature", field: "steam_heater_temperature", deviceClass: "temperature", stateClass: "measurement", unit: "°C" },
  { entityName: "espresso_count", displayName: "Espresso Count", field: "espresso_count", stateClass: "total_increasing", icon: "mdi:coffee" },
  { entityName: "steaming_count", displayName: "Steaming Count", field: "steaming_count", stateClass: "total_increasing", icon: "mdi:sprinkler" },
  { entityName: "steam_mode", displayName: "Steam Heater Mode", field: "steam_mode", icon: "mdi:heat-wave" },
  { entityName: "shot_weight", displayName: "Shot Weight", field: "shot_weight_g", deviceClass: "weight", stateClass: "measurement", unit: "g" },
];

export function buildDiscoveryConfigs({ config, deviceInfo, profileTitles }) {
  const stateTopic = `${config.topicPrefix}/state`;
  const commandTopic = `${config.topicPrefix}/command`;
  const device = deviceBlock(config, deviceInfo);
  const configs = [];

  // Sensors
  for (const def of SENSORS) {
    configs.push({
      topic: `${DISCOVERY_PREFIX}/sensor/${uniqueId(config, def.entityName)}/config`,
      payload: sensorConfig(config, device, stateTopic, def),
    });
  }

  // Binary sensor: shot_active
  configs.push({
    topic: `${DISCOVERY_PREFIX}/binary_sensor/${uniqueId(config, "shot_active")}/config`,
    payload: {
      name: `${ENTITY_NAME_PREFIX}Shot Active`,
      unique_id: uniqueId(config, "shot_active"),
      state_topic: stateTopic,
      value_template: "{{ value_json.shot_active | default(False) }}",
      payload_on: "True",
      payload_off: "False",
      device,
      ...availability(stateTopic),
    },
  });

  // Switch: wake/sleep
  configs.push({
    topic: `${DISCOVERY_PREFIX}/switch/${uniqueId(config, "switch")}/config`,
    payload: {
      name: `${ENTITY_NAME_PREFIX}On`,
      unique_id: uniqueId(config, "switch"),
      state_topic: stateTopic,
      command_topic: commandTopic,
      value_template: "{{ value_json.wake_state }}",
      payload_on: "wake",
      payload_off: "sleep",
      state_on: "True",
      state_off: "False",
      icon: "mdi:coffee-maker",
      device,
      ...availability(stateTopic),
    },
  });

  // Switch: steam
  configs.push({
    topic: `${DISCOVERY_PREFIX}/switch/${uniqueId(config, "steam_switch")}/config`,
    payload: {
      name: `${ENTITY_NAME_PREFIX}Steam Heater On`,
      unique_id: uniqueId(config, "steam_switch"),
      state_topic: stateTopic,
      command_topic: commandTopic,
      value_template: "{{ value_json.steam_state }}",
      payload_on: "steam_on",
      payload_off: "steam_off",
      state_on: "True",
      state_off: "False",
      icon: "mdi:heat-wave",
      device,
      ...availability(stateTopic),
    },
  });

  // Select: profile
  if (Array.isArray(profileTitles) && profileTitles.length > 0) {
    configs.push({
      topic: `${DISCOVERY_PREFIX}/select/${uniqueId(config, "profile_select")}/config`,
      payload: {
        name: `${ENTITY_NAME_PREFIX}Profile`,
        unique_id: uniqueId(config, "profile_select"),
        state_topic: stateTopic,
        command_topic: commandTopic,
        value_template: "{{ value_json.profile }}",
        command_template: "profile {{ value }}",
        options: profileTitles,
        icon: "mdi:chart-bell-curve",
        device,
        ...availability(stateTopic),
      },
    });
  }

  return configs;
}

export function discoveryTopics(configs) {
  return configs.map((c) => c.topic);
}
