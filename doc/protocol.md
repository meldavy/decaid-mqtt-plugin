# MQTT Integration — Protocol Specification

This document defines the MQTT wire protocol and observable behavior of the
Decaid MQTT integration. It is written for consumers of the MQTT interface
(Home Assistant, Node-RED, custom scripts) and for implementers of the
integration itself. It is self-contained: no other document is required to
understand it.

Decaid bridges a Decent Espresso DE1 machine to a user-configured MQTT
broker. Its wire format is compatible with the long-standing de1app MQTT
plugin (`simpkins/de1plus-mqtt`), which is the porting reference: any client
that works against that plugin keeps working against Decaid with no changes,
including its Home Assistant auto-discovery entities. Beyond that parity,
Decaid extends the state document with shot details (the weight of the coffee
produced during a shot, when a scale is attached); these extensions are
additive and do not alter any de1app field.

## User stories

- **Migrating de1app owner:** "I move my tablet from de1app to Decaid; my
  existing Home Assistant dashboards, Node-RED flows, and scripts keep
  working with zero reconfiguration — same topics, same JSON, same entities."
- **Smart-home user:** "From my Home Assistant dashboard I can see the
  machine's state and temperatures, and I can wake it, put it to sleep, and
  toggle steam with switches that were auto-discovered."
- **Cafe operator:** "I monitor several machines on one MQTT broker from a
  dashboard; each machine has its own auto-generated topic prefix and client
  ID, so nothing collides."
- **Shot nerd with a scale:** "While a shot pours, my dashboard shows the
  coffee weight climbing in real time, and the final yield stays visible
  afterward."
- **Privacy-conscious user:** "I point the integration at my own broker; when
  the app dies unexpectedly, the broker's last-will tells my automations the
  machine is offline instead of leaving stale data."
- **Any user:** "I configure everything in the app's settings page; my broker
  password is stored securely, not in plaintext."

## Broker connection

- Protocol: MQTT over raw TCP (MQTT 3.1.1 or 5; 5 is used when the broker
  supports it). This matches de1app, which uses native TCP sockets, not
  MQTT-over-WebSocket.
- Default port: `8883` when TLS is enabled (the default), `1883` when it is
  not. The port is user-configurable.
- Authentication: optional username/password.
- Client ID: user-configurable; when unset, a unique ID is generated on first
  run and persisted (see [Config schema](#config-schema)) so that multiple
  machines on the same broker do not collide.
- Keepalive: the integration publishes state updates at least once per
  publish interval, which also serves as MQTT keepalive traffic. The
  keepalive window is set slightly above the publish interval so that no
  separate PINGREQ traffic is needed (matching de1app's behavior).
- Reconnection: on any disconnect, the client reconnects with exponential
  backoff — 2 s base, doubling per attempt, capped at 64 s — giving up after
  15 attempts (~12 minutes). A successful connect resets the counter.
  Intentional disconnects (config change, disable, teardown) do not schedule
  a reconnect.

## Topics

With `T` = topic prefix (default `de1plus/<unique_id>`):

| Topic | Direction | Purpose |
|-------|-----------|---------|
| `T/state` | published by Decaid | Full machine state document |
| `T/command` | subscribed by Decaid | Control commands |

## State document (`T/state`)

A single JSON document published with **QoS 1, retain flag set**. Because it
is retained, a newly connecting consumer immediately receives the last state.

### Fields (de1app-compatible contract)

| Field | Type | Meaning |
|-------|------|---------|
| `online` | bool | Always `true` in messages Decaid publishes while connected to the broker. |
| `de1_connected` | bool | `true` when the machine link is established. |
| `scale_connected` | bool | `true` when a scale is connected. |
| `state` | string | Machine state. Exact strings below. |
| `substate` | string | Machine substate. Exact strings below. |
| `profile` | string | Title of the currently selected shot profile. |
| `profile_filename` | string | Filename of the currently selected shot profile. |
| `espresso_count` | int | Lifetime espresso shot count. |
| `steaming_count` | int | Lifetime steam usage count. |
| `head_temperature` | float | Group head temperature, °C. |
| `mix_temperature` | float | Water mix temperature, °C. |
| `steam_heater_temperature` | float | Steam heater temperature, °C. |
| `water_level_mm` | float | Water tank level, millimeters. |
| `water_level_ml` | int | Water tank level, milliliters (derived from mm). |
| `wake_state` | bool | `false` when state is `Sleep`, `true` otherwise. Convenience for binary-switch consumers. |
| `steam_mode` | string | `"On"`, `"Off"`, or `"Eco"`. |
| `steam_state` | bool | Whether the steam heater is on. |

### Presence rules

- `online` and `de1_connected` are always present.
- When `de1_connected` is `false`, **only** `online` and `de1_connected` are
  present. All machine-derived fields are omitted because machine state is
  unavailable.
- When `de1_connected` is `true`, all remaining fields are present. Water
  level fields come from the machine's water-level stream (see
  [Data sources](#data-sources) in `architecture.md`); when no reading has
  been received yet they carry `0`/`0.0`.

### State and substate strings

`state` and `substate` use the de1app vocabulary exactly (capitalized states,
mixed-case substates). Decaid's internal enum values are mapped to these
strings:

Machine state mapping:

| Decaid internal | Published string |
|-----------------|------------------|
| `booting` | `Init` |
| `busy` | `Busy` |
| `idle` | `Idle` |
| `schedIdle` | `SchedIdle` |
| `sleeping` | `Sleep` |
| `heating` | `Idle` |
| `preheating` | `Idle` |
| `espresso` | `Espresso` |
| `hotWater` | `HotWater` |
| `flush` | `HotWaterRinse` |
| `steam` | `Steam` |
| `steamRinse` | `SteamRinse` |
| `skipStep` | `SkipToNext` |
| `cleaning` | `Clean` |
| `descaling` | `Descale` |
| `calibration` | `ShortCal` |
| `selfTest` | `SelfTest` |
| `airPurge` | `AirPurge` |
| `needsWater` | `Refill` |
| `error` | `FatalError` |
| `fwUpgrade` | `FWUpgrade` |

Note: in the de1app vocabulary, a warming machine reports state `Idle` with
substate `heating`; the substate carries the detail. The mapping is
directionally complete (every Decaid value has a target) but partly lossy:
`heating` and `preheating` both collapse to `Idle` (de1app expresses warmth
through the substate), and `calibration` maps to `ShortCal`, losing de1app's
`ShortCal`/`LongCal` distinction.

Machine substate mapping:

| Decaid internal | Published string |
|-----------------|------------------|
| `idle` | `ready` |
| `preparingForShot` | `heating` |
| `preinfusion` | `preinfusion` |
| `pouring` | `pouring` |
| `pouringDone` | `ending` |
| `cleaningStart` | `CleanInit` |
| `cleaningGroup` | `CleanGroup` |
| `cleanSoaking` | `CleanSoak` |
| `cleaningSteam` | `CleanGroup` |
| `errorNaN` | `Error_NaN` |
| `errorInf` | `Error_Inf` |
| `errorGeneric` | `Error_Generic` |
| `errorAcc` | `Error_ACC` |
| `errorTSensor` | `Error_TSensor` |
| `errorPSensor` | `Error_PSensor` |
| `errorWLevel` | `Error_WLevel` |
| `errorDip` | `Error_DIP` |
| `errorAssertion` | `Error_Assertion` |
| `errorUnsafe` | `Error_Unsafe` |
| `errorInvalidParam` | `Error_InvalidParm` |
| `errorFlash` | `Error_Flash` |
| `errorOOM` | `Error_OOM` |
| `errorDeadline` | `Error_Deadline` |
| `errorHiCurrent` | `Error_HiCurrent` |
| `errorLoCurrent` | `Error_LoCurrent` |
| `errorBootFill` | `Error_BootFill` |
| `errorNoAC` | `Error_NoAC` |

Any internal value without an entry in these tables is published as the
internal enum name. The tables cover the de1app vocabulary; de1app also
defines substates that Decaid's model does not currently produce, so they
never appear in Decaid's output:

| de1app substate | Code | de1app meaning |
|-----------------|------|----------------|
| `starting` | - | Startup |
| `final heating` | 2 | Warm up hot water heater for shot |
| `stabilising` | 3 | Post-heating settle |
| `Steaming` | 7 | Steam heating in progress |
| `DescaleInit` | 8 | Descale setup |
| `DescaleFillGroup` | 9 | Descale: filling group |
| `DescaleReturn` | 10 | Descale: return |
| `DescaleGroup` | 11 | Descale: group |
| `DescaleSteam` | 12 | Descale: steam |
| `CleanFillGroup` | 14 | Cleaning: filling group |
| `refill` | 17 | Water refill prompt |
| `PausedSteam` | 18 | Steam paused |
| `UserNotPresent` | 19 | User absence detected |
| `puffing` | 20 | Steam purge |

### Derived-field rules

- `wake_state`: `state != "Sleep"`.
- `steam_mode` / `steam_state`, evaluated in order:
  1. machine asleep (`state == "Sleep"`) → `"Off"` / `false`;
  2. steam heater disabled → `"Off"` / `false`;
  3. steam heater in Eco mode (idle temperature reduction enabled) → `"Eco"` / `true`;
  4. otherwise → `"On"` / `true`.

### Shot detail extension (additive, beyond de1app)

When a scale is attached, Decaid reports the grams of coffee produced. These
fields are additions to the same `T/state` document; de1app-defined fields and
their values are unchanged, and consumers that ignore unknown fields are
unaffected.

| Field | Type | Meaning |
|-------|------|---------|
| `shot_active` | bool | `true` while a shot is in progress (machine substate is pouring/preinfusion or the shot sequencer is active). |
| `shot_id` | string | Identifier of the most recently completed shot. Present after the first completed shot; omitted otherwise. |
| `shot_started_at` | string | ISO-8601 UTC timestamp of the start of the most recent completed shot. |
| `shot_duration_s` | float | Duration of the most recent completed shot, seconds. |
| `shot_weight_g` | float | Current shot weight in grams. While `shot_active` is true and a scale is connected, this is the live in-shot weight, updated as the scale reports. After the shot completes, it is the final yield of that shot. Absent (or `null`) when no scale is connected and no shot data exists. |

Shot fields are present whenever the machine is connected, regardless of
scale attachment (with `shot_weight_g` absent/null without a scale). They
ride the normal publish triggers of the state document.

### Publish triggers and cadence

A state document is published:

- immediately on any machine state change;
- immediately on any shot-detail change (weight sample, shot start/end);
- on a periodic interval as a heartbeat for consumers that poll, with the
  interval determined by activity:
  - idle: `publishIntervalMs` (default 60000 ms);
  - shot active: a short interval (target 1000 ms) so live weight is usable.

The dynamic interval is a Decaid improvement over de1app, which publishes
immediately on every change and re-publishes on a fixed interval. Wire
compatibility is unaffected; consumers observe the same topic and document.

### Availability and last-will

- On connect, the client registers a last will message:
  topic `T/state`, payload `{"online": false, "de1_connected": false}`,
  QoS 1, retained. If the client dies without a clean disconnect, consumers
  see the machine go offline.
- On an intentional disconnect (config apply, disable, teardown), the client
  publishes the same offline payload explicitly before disconnecting,
  because the broker does not process the will of a clean disconnect.
- All entities published via auto-discovery use the state topic as their
  availability topic with `value_json.de1_connected` as the availability
  template, `payload_available: 1`, `payload_not_available: 0`.

## Command document (`T/command`)

Decaid subscribes to `T/command`. Payloads are plain-text UTF-8 strings;
leading/trailing whitespace is trimmed. Unknown payloads are logged and
ignored. Received messages are never treated as retained state.

| Command | Action |
|---------|--------|
| `wake` | Wake the machine (request the awake/heating path). No-op if already awake. |
| `sleep` | Put the machine to sleep. Only acted on when the machine is `Idle`; ignored when already asleep or when the machine is in use. |
| `steam_on` | Turn the steam heater on. Wakes the machine first if necessary. If the heater was in Eco mode, resets it to full temperature and resets the Eco idle timer. |
| `steam_off` | Turn the steam heater off. No-op if already off. |
| `profile <name>` | Select a profile by title. Everything after the first space is the profile name, without escaping; names may contain spaces and special characters. If no profile has that title, the command is logged and ignored. |
| `profile_filename <file>` | Select a profile by filename. Same trailing-text rule. If no such profile file exists, logged and ignored. |

## Home Assistant auto-discovery

When enabled (off by default), the integration publishes Home Assistant
MQTT discovery config messages on every broker connect, QoS 1, retained.
Disabling auto-discovery retracts the entities by publishing empty retained
messages to their config topics.

Entity topics are
`<discovery_prefix>/<component>/<unique_id>/config` where
`<unique_id>` is `de1plus_<device_id>_<entity_name>` and
`<discovery_prefix>` defaults to `homeassistant`.

Every config message carries:

- `name`: `<entity_name_prefix><Name>` (`entity_name_prefix` defaults to
  `"DE1+ "`);
- `unique_id`: as above;
- `state_topic`: `T/state`;
- `availability`: state topic with template `{{ value_json.de1_connected }}`;
- `device`: model (e.g. `DE1XXL`), name (`ha_device_name`, default
  `"Decent Espresso <model>"`), manufacturer `"Decent Espresso"`, sw_version
  (app version, plus firmware version when known), identifiers
  `[<device_id>]`, and the machine MAC address as a `mac` connection when
  known.

### Sensors

| Name | Entity name | Value field | device_class | state_class | unit | icon |
|------|-------------|-------------|--------------|-------------|------|------|
| State | `state` | `state` | — | — | — | `hass:state-machine` |
| Substate | `substate` | `substate` | — | — | — | `hass:state-machine` |
| Water Level | `water_level` | `water_level_ml` | `volume_storage` | `measurement` | `mL` | `hass:water` |
| Head Temperature | `head_temp` | `head_temperature` | `temperature` | `measurement` | °C | — |
| Mix Temperature | `mix_temp` | `mix_temperature` | `temperature` | `measurement` | °C | — |
| Steam Temperature | `steam_temp` | `steam_heater_temperature` | `temperature` | `measurement` | °C | — |
| Espresso Count | `espresso_count` | `espresso_count` | — | `total_increasing` | — | `hass:coffee` |
| Steaming Count | `steaming_count` | `steaming_count` | — | `total_increasing` | — | `hass:sprinkler` |
| Steam Heater Mode | `steam_mode` | `steam_mode` | — | — | — | `hass:heat-wave` |

Sensor value template: `{{ value_json.<field> | default(None) }}`.

The Steam Heater Mode sensor is only published when Eco steam mode is enabled
on the machine (users without Eco mode get the simple steam switch instead,
avoiding a redundant confusing entity). When Eco mode is turned on later, the
discovery message set is re-published.

### Switches

| Name | Entity name | Value field | payload_on | payload_off | icon |
|------|-------------|-------------|------------|-------------|------|
| On | `switch` | `wake_state` | `wake` | `sleep` | `hass:coffee-maker` |
| Steam Heater On | `steam_switch` | `steam_state` | `steam_on` | `steam_off` | `hass:heat-wave` |

Switches additionally set `command_topic` to `T/command`, so toggling them
sends the payload as a command.

### Select

| Name | Entity name | Command template | Options |
|------|-------------|------------------|---------|
| Profile | `profile_select` | `profile {{ value }}` | Titles of all available profiles |

The select uses `T/command` as `command_topic`, state topic `T/state`, and
value template `{{ value_json.profile }}`, icon `hass:chart-bell-curve`. The
options list is refreshed (discovery re-published) whenever the selected
profile changes or the profile library changes, so newly added/deleted
profiles are reflected.

### Shot sensors (Decaid extension)

When shot detail fields are present in the state document, the following
sensors are added to auto-discovery, following the same config conventions:

| Name | Entity name | Value field | device_class | state_class | unit |
|------|-------------|-------------|--------------|-------------|------|
| Shot Weight | `shot_weight` | `shot_weight_g` | `weight` | `measurement` | `g` |

`shot_active` may also be consumed as a binary sensor
(`Shot Active` / entity name `shot_active`) with no device class. These
entities are additive: consumers using de1app-style discovery see no
difference unless they subscribe to these entities.

## Config schema

All settings are persisted and editable through the app's settings UI for the
plugin. Defaults apply on first run.

| Key | Type | Default | Meaning |
|-----|------|---------|---------|
| `host` | string | *(empty)* | Broker hostname or IP. Empty disables the integration. |
| `port` | int | `8883` | Broker port. |
| `user` | string | *(empty)* | Broker username. |
| `password` | string | *(empty)* | Broker password. Stored as a secret, not in plaintext settings. |
| `clientId` | string | auto | MQTT client ID. Auto-generated as `de1plus_<unique_id>` on first run. |
| `topicPrefix` | string | auto | Topic prefix `T`. Auto-generated as `de1plus/<unique_id>` on first run. |
| `publishIntervalMs` | int | `60000` | Idle heartbeat interval in milliseconds. Minimum 1000. |
| `enableTls` | bool | `true` | Use TLS toward the broker. |
| `caFile` | string | *(empty)* | Custom CA bundle for broker verification. See TLS section. |
| `clientCert` / `clientKey` | string | *(empty)* | Client certificate/key for mutual TLS. See TLS section. |
| `haAutoDiscoveryEnable` | bool | `false` | Publish HA discovery entities on connect. |
| `haDiscoveryPrefix` | string | `homeassistant` | Discovery topic prefix. |
| `haEntityNamePrefix` | string | `DE1+ ` | Prefix prepended to entity display names. |
| `uniqueId` | string | auto | Stable 8-hex-character device identifier, generated on first run and persisted. Used in `clientId`, `topicPrefix`, and HA `unique_id`s. |

Validation rules applied when settings are saved:

- `host` must be non-empty for the integration to run; empty means disabled.
- `port` in 1–65535.
- `topicPrefix` non-empty.
- `publishIntervalMs` >= 1000.
- When TLS is enabled, `clientCert` and `clientKey` must both be set or both
  be empty; `caFile` alone is valid. With TLS off, the three TLS fields are
  ignored.

Changing any connection-affecting setting (host, port, credentials, TLS,
prefixes) takes effect immediately: the current broker connection is closed
cleanly (with the offline state published first), and a new connection is
established with the new settings.

## TLS

With `enableTls`, the connection uses TLS with normal platform certificate
validation (system trust store). This covers brokers with publicly trusted or
platform-trusted certificates.

de1app additionally supports custom CA files and mutual TLS with a client
certificate and key (uploaded files referenced by path). Decaid's plugin
transport layer does not yet expose custom trust material or client
certificates to plugins; this is an upstream capability gap tracked in
[decaid#758](https://github.com/decentespresso/decaid/issues/758). Until that
capability exists, brokers that require custom CAs or mutual client
authentication are out of reach, and this is a documented, explicit gap.
The config fields are retained so the setting surface is stable and the
capability can be adopted without schema changes.

## Known gaps

- Custom CA / mutual TLS: deferred to upstream issue #758 (see TLS section).
- `steam_mode` `"Eco"` requires the machine's Eco steam setting to be
  readable; if the setting is unavailable, mode reports `"On"`/`"Off"` only.

## Wire compatibility statement

An existing consumer of the de1app MQTT plugin (including Home Assistant
configurations created by its auto-discovery) observes, when pointed at the
same broker and topic prefix:

- identical topic names;
- an identical 17-field state document with identical types, capitalization,
  and presence rules;
- identical command grammar and semantics;
- identical auto-discovery entity names, unique IDs, templates, and options;
- additional `shot_*` fields in the state document and additional optional
  shot entities in auto-discovery, which de1app-era consumers ignore.
