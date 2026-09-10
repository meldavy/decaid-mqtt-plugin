# MQTT Integration — Architecture Specification

This document defines how Decaid implements the MQTT integration described in
[`protocol.md`](protocol.md) (the wire contract). It is written for
implementers. It is self-contained with respect to the design decisions made
here; [`protocol.md`](protocol.md) holds the external wire behavior.

## Goal

A feature-parity port of the de1app MQTT plugin (`simpkins/de1plus-mqtt`) to
Decaid, extended with shot-detail reporting. Any existing de1app MQTT consumer
keeps working unchanged against Decaid (same topics, same state document,
same commands, same Home Assistant entities), and gains live shot weight when
a scale is attached.

## User stories and how the design serves them

| User story | Design consequence |
|------------|--------------------|
| "My de1app automations keep working after migrating, unchanged." | Wire parity is the hard constraint: raw TCP MQTT, byte-frozen state document, identical commands and HA entities (see `protocol.md`). |
| "I can wake/sleep/steam my machine from my dashboard." | Inbound commands map onto Decaid's existing machine-control REST endpoints. |
| "I see the shot weight climbing in real time." | The plugin connects to Decaid's own live scale snapshot stream and folds weight into the state document at an active-shot publish cadence. |
| "My two machines don't collide on one broker." | Auto-generated, persisted unique client ID and topic prefix on first run. |
| "I configure it in the app; my password is safe." | Manifest settings render in the plugin settings page; secrets use the host's secure credential storage. |
| "If the app crashes, my automations must know." | MQTT last will publishes an explicit offline state document. |
| "Everything keeps working when the broker or Wi-Fi blips." | Reconnect loop with capped exponential backoff; live weight loss degrades gracefully without blocking state publishing. |

## Why a plugin

Decaid's plugin system provides permission-gated outbound network transports
(WebSocket, raw TCP, raw TLS) to JavaScript plugins, along with machine state
events, HTTP fetch, persistent settings, and timers. Every capability MQTT
needs is available inside the plugin sandbox:

- raw TCP/TLS byte streams for the MQTT protocol;
- machine state as events;
- HTTP fetch to Decaid's own REST API for shot records and machine control;
- timers for keepalive/publish scheduling;
- persistent, secret-capable settings for broker configuration.

Implementing MQTT as a plugin keeps protocol logic (packet handling, QoS,
subscriptions, reconnect policy) out of the trusted core, matching the
platform boundary Decaid has adopted: **the core owns safe native
capabilities; plugins own protocols and integration logic.** No MQTT protocol
code lives in Dart.

The plugin uses the same MQTT-over-raw-TCP approach as de1app (not
MQTT-over-WebSocket), so existing brokers configured for de1app keep working.

## Components

| Component | Layer | Role |
|-----------|-------|------|
| Plugin manifest | `manifest.json` | Declares permissions, settings, and metadata |
| MQTT protocol engine | bundled JavaScript (MQTT.js) | Packet encoding/decoding, keepalive, subscriptions |
| Transport adapter | plugin JavaScript | Maps MQTT.js's socket interface onto `host.transport` |
| State mapper | plugin JavaScript | Machine events → state document (per `protocol.md`) |
| Shot collector | plugin JavaScript | Shot lifecycle events + record fetch → shot fields |
| Command dispatcher | plugin JavaScript | Command payloads → machine control calls |
| Settings UI | plugin manifest settings | Broker and behavior configuration |

## Permissions

```json
{
  "permissions": [
    "log",
    "api",
    "emit",
    "pluginStorage",
    "events.machine",
    "events.shots",
    "network.tcp",
    "network.tls"
  ]
}
```

- `network.tcp`: raw TCP to the broker (port 1883 or custom).
- `network.tls`: TLS to the broker (port 8883 or custom). Needed only when
  `enableTls` is on; the plugin requests both unconditionally since the
  config is user-selectable at runtime.
- `api`: HTTP fetch to Decaid's own REST API (shot records, machine control).
- `events.machine` / `events.shots`: machine state and shot lifecycle events.
- `pluginStorage`: persisting derived state (e.g. last published shot id).

## Host API surface used

The following host APIs are part of Decaid's plugin contract. Their shapes
are restated here so this document stands alone.

### `host.transport` (network transports)

```js
const opened = await host.transport.open({
  kind: "tcp",            // or "tls"
  host: "broker.example",
  port: 1883,             // 8883 for tls
});
// opened = { handle: "<opaque>", protocol: /* subprotocol, ws only */ }

host.transport.onEvent(handle, (event) => {
  // event.type: "data" | "error" | "close"
  // data events: { type: "data", dataType: "binary", data: "<base64>" }
});

await host.transport.send(handle, { type: "binary", data: "<base64>" });
await host.transport.close(handle);
```

Rules that matter for MQTT:

- TCP/TLS carry binary frames only; the plugin encodes/decodes MQTT packets
  and bridges bytes as base64.
- `open()` resolves once the connection is established; failures reject the
  promise. MQTT-level connection failures (CONNACK error codes) are detected
  by the protocol engine after establishment.
- Resource bounds per plugin generation: at most 8 live transports; 1 MiB
  outbound and inbound buffers per transport; over-limit operations reject
  with `transport_resource_limit` (data is never silently dropped).
- Handles are owned by the plugin generation; unload closes all transports.

### Events (host → plugin)

- `stateUpdate` (requires `events.machine`): machine snapshot JSON —
  timestamp, state/substate, flow, pressure, targets, mix/group/steam
  temperatures, profile frame. Emitted on every machine snapshot change.
- `shotStored` (requires `events.shots`): `{ id: "<shotId>" }` when a shot
  has finished persisting.
- `shutdown`: the plugin is being unloaded; close connections promptly.

### HTTP fetch

```js
const res = await fetch("http://localhost:8080/api/v1/shots/<id>");
```

Gated by the `api` permission. Reaches any URL, including Decaid's own REST
API on the local web server (fixed port 8080). General `/api/v1/*` routes are
unauthenticated locally; no token handling is needed.

### Storage and settings

- Manifest-declared `settings` (string/number/boolean, `secure: true` for
  secrets) render in the app's plugin settings UI and are persisted by the
  host. The broker password uses `secure: true`.
- `host.storage` for plugin-local key/value state.

### Timers

Standards-compatible `setTimeout`/`setInterval`/`clear*` with variadic
argument forwarding — required by MQTT.js for keepalive and reconnect
scheduling.

## MQTT protocol engine

MQTT.js is bundled with the plugin and adapted to `host.transport`:

- A small adapter implements MQTT.js's expected duplex socket interface on
  top of `open`/`onEvent`/`send`/`close`, decoding base64 data events to
  `Uint8Array` and encoding writes to base64.
- Connect options: clean session, keepalive = `(publishIntervalMs + 3000) /
  1000` seconds (so state publishes double as keepalive traffic, matching
  de1app), MQTT 5 with fallback to 3.1.1 where the broker rejects v5.
- Last will registered at connect: topic `T/state`, payload
  `{"online": false, "de1_connected": false}`, QoS 1, retained.
- Subscription: `T/command`, QoS 1.
- Publishes: `T/state` at QoS 1 with retain.

## Data flows

### Publish path (state)

```
host events (stateUpdate) ──► state mapper ──► MQTT publish T/state
host events (scale WS)   ──►            ──►
REST fetch (shot record) ──►            ──►
```

1. Each `stateUpdate` event is mapped to the state document:
   - state/substate strings via the mapping tables in `protocol.md`;
   - temperatures, flow, pressure from the snapshot;
   - `wake_state` derived from `state`;
   - `scale_connected` from the scale WS connection status;
   - `profile`/`profile_filename` from the current profile (via
     `stateUpdate` fields or a REST fetch on change);
   - `espresso_count`/`steaming_count` from lifetime counters (derived from
     shot history; see [Data sources](#data-sources)).
2. Publish decision: publish immediately on change; otherwise on the
   activity-dependent heartbeat (idle: `publishIntervalMs`; shot active:
   ~1000 ms). The shortest applicable timer wins; a change always publishes
   immediately and reschedules the heartbeat.

### Publish path (live shot weight)

The plugin opens persistent transport connections to Decaid's own snapshot
streams:

```
host.transport.open({ kind: "websocket", url: "ws://localhost:8080/ws/v1/scale/snapshot" })
```

This is the same loopback pattern used by Decaid's plugin acceptance tests
(a plugin connecting to its own snapshot endpoints). The stream emits
`WeightSnapshot` JSON on every scale sample:

```json
{
  "timestamp": "2026-09-08T07:15:03.000Z",
  "weight": 12.4,
  "weightFlow": 1.8,
  "battery": 87,
  "timerValue": 5200
}
```

The plugin uses it to:

- set `scale_connected` (stream open + status messages vs. closed);
- update `shot_weight_g` live while `shot_active`;
- refresh the state document at the active-shot cadence.

The WS connection is re-established with the broker-independent reconnect
loop if it drops; its absence never blocks machine-state publishing (weight
fields are omitted/null until it is healthy).

Water level uses the same loopback pattern against
`ws://localhost:8080/ws/v1/machine/waterLevels`, which streams
`{currentLevel, refillLevel}` (mm) whenever the machine reports it. Water
level changes rarely, so samples only refresh the state document when they
differ from the last published value. No REST GET endpoint exists for live
water level; a plugin event does not carry it either.

### Publish path (shot record)

On `shotStored`:

1. `fetch("http://localhost:8080/api/v1/shots/" + id)`.
2. Extract `started_at`, duration, and the final `measurements[].scale.weight`
   sample as the yield.
3. Update `shot_id`, `shot_started_at`, `shot_duration_s`, `shot_weight_g`;
   `shot_active` flips to false.
4. Publish the state document immediately.

The full measurements array is not published (see `protocol.md`).

### Command path (inbound control)

On a message to `T/command`, trim and dispatch:

| Command | Decaid REST call |
|---------|------------------|
| `wake` | `PUT /api/v1/machine/state/heating` |
| `sleep` | `PUT /api/v1/machine/state/sleeping` |
| `steam_on` | `PUT /api/v1/machine/state/steam` |
| `steam_off` | `PUT /api/v1/machine/state/idle` |
| `profile <name>` | `GET /api/v1/profiles` → find record whose title matches → `POST /api/v1/machine/profile` with that profile's JSON |
| `profile_filename <file>` | same, matching on filename |

Guard rails reproducing de1app semantics where the REST surface allows:

- `sleep` is suppressed unless the machine is `Idle` (de1app ignores sleep
  when the machine is in use or already asleep);
- `steam_on` wakes the machine first (send `wake`'s state request, then
  steam);
- unknown commands are logged and ignored;
- command failures (REST error responses) are logged with the command text
  for diagnosis.

**Architectural note.** This command path crosses the plugin boundary by
calling Decaid's own REST API over loopback HTTP, gated by the broad `api`
permission. It is the same mechanism the bundled Visualizer plugin uses to
read shot records, and it requires no core changes. It is deliberately chosen
for v1. The cleaner long-term shape is a dedicated, narrowly scoped machine
control API for plugins (e.g. a `machine.control` permission with explicit
`requestState`/`selectProfile` operations); no such API exists yet and no
upstream issue tracks it. When one lands, the command dispatcher should move
onto it and drop the loopback fetches.

## Settings UI

Manifest settings render automatically in Decaid's plugin settings page:

| Setting | Type | Notes |
|---------|------|-------|
| Broker Host | string | Empty disables the integration. |
| Broker Port | number | Default 8883. |
| Username | string | Optional. |
| Password | string, `secure: true` | Stored via the host's secure credential path, not plaintext settings. |
| Client ID | string | Defaults to `de1plus_<uniqueId>`. |
| Topic Prefix | string | Defaults to `de1plus/<uniqueId>`. |
| Publish Interval (ms) | number | Default 60000, minimum 1000. |
| Use TLS | boolean | Default true. |
| CA File | string | Path; requires the #758 capability to take effect (documented gap). |
| Client Certificate / Key | string, string | Same. |
| Enable HA Auto-Discovery | boolean | Default false. |
| HA Device Name | string | Default `"Decent Espresso <model>"`. |
| HA Entity Name Prefix | string | Default `"DE1+ "`. |
| HA Discovery Prefix | string | Default `homeassistant`. |

`uniqueId` is generated once (8 hex characters) and persisted via
`host.storage`; it seeds the defaults above so multi-machine setups never
collide. Validation follows `protocol.md` (port range, interval minimum,
cert pairing) and invalid saves are rejected in the UI with the reason.

Settings changes take effect live: apply → close broker connection cleanly
(publish offline state first) → reconnect with new settings.

## Lifecycle

```
plugin load
  ├─ read settings; if host empty → stay disabled (log once)
  ├─ open broker transport (tcp or tls per config)
  ├─ MQTT CONNECT (+ will, keepalive)
  ├─ on CONNACK success:
  │    ├─ subscribe T/command
  │    ├─ publish state immediately
  │    ├─ publish HA discovery messages (if enabled)
  │    └─ open loopback scale WS; start heartbeat timer
  └─ on failure: schedule reconnect (2s base, ×2 per attempt, cap 64s,
       give up after 15; reset counter on success)

settings change → clean disconnect (publish offline first) → reconnect
plugin unload / shutdown → close MQTT connection, close scale WS,
                           cancel timers, flush pending writes
```

Plugin unload must always produce deterministic native cleanup even if
JavaScript cleanup throws; the host closes all transports owned by the
generation.

## Data sources

| State field | Source | Notes |
|-------------|--------|-------|
| state/substate, temperatures, flow, pressure | `stateUpdate` events | Direct from machine snapshot. |
| profile, profile_filename | `stateUpdate` / profile-change events or REST fetch | Matches the machine's selected profile. |
| scale_connected, shot_weight_g | loopback scale WS | Live. |
| shot_id/started_at/duration_s | `shotStored` + `GET /api/v1/shots/<id>` | Post-shot. |
| espresso_count, steaming_count | shot history | Lifetime counters; derived from the app's shot/steam history (implementation: count from storage or a maintained counter). |
| water_level_mm/ml | loopback machine WS | `ws://localhost:8080/ws/v1/machine/waterLevels` streams `De1WaterLevels{currentLevel, refillLevel}` (mm); `water_level_ml` derived from mm via de1app's tank lookup table (ported verbatim in `src/state-doc.js`). |
| steam_mode/steam_state | steam settings + snapshot | Derived per the rules in `protocol.md`. |

## Testing strategy

1. **Unit (Dart + JS fixtures):** state mapper tests — every internal
   state/substate maps to the exact de1app string; derived-field rules
   (`wake_state`, `steam_mode`/`steam_state`) across sleep/off/eco/on;
   command parser (trim, `profile ` prefix vs. longer names, unknown
   commands); config validation rules.
2. **Transport integration:** the MQTT.js adapter against an in-process fake
   MQTT broker (CONNECT/CONNACK, SUBSCRIBE, PUBLISH with QoS 1, retained
   flags, will message on abnormal close, keepalive behavior). Broker
   disconnect triggers the reconnect loop with the documented backoff.
3. **Loopback integration:** scale WS adapter against a fake WS server
   (weight samples update `shot_weight_g`; disconnect degrades gracefully);
   command dispatcher against a fake REST server (correct verbs/paths/bodies;
   sleep guard; profile resolution by title and filename; failure logging).
4. **E2E (headless app):** boot the app with simulated machine and scale,
   plugin enabled against an in-process broker; assert both directions —
   observed `T/state` documents match `protocol.md` (including degraded
   mode and shot fields), and publishing `sleep`/`wake` to `T/command`
   changes the machine state.
5. **Settings UI:** widget tests for the settings page (validation errors,
   secure password handling, live apply).

Static analysis, formatting, and the full test suite per repository
conventions apply to any host-side changes (there are none planned for v1
beyond the plugin itself).

## Security notes

- Broker credentials: password stored through the host's secure/credential
  storage path (not plaintext settings).
- The `api` permission grants unrestricted outbound HTTP; the plugin only
  ever calls loopback URLs, but the permission is coarse. The future
  `machine.control` API (see Command path note) would narrow this.
- TLS uses platform trust validation; custom CA/mTLS is pending upstream
  #758 (documented gap in `protocol.md`).
- The plugin treats broker-published command payloads as untrusted input:
  trimmed, grammar-checked, and mapped to a fixed set of actions.

## Provenance

- Feature request and discussion: [decaid#681](https://github.com/decentespresso/decaid/issues/681)
- Plugin network transports: [decaid#146](https://github.com/decentespresso/decaid/issues/146) (implemented in PR #759)
- JS timer primitives (MQTT.js prerequisite): [tadelv/dart_js#9](https://github.com/tadelv/dart_js/issues/9)
- Custom CA / mTLS gap: [decaid#758](https://github.com/decentespresso/decaid/issues/758)
- Porting reference (wire parity source): [simpkins/de1plus-mqtt](https://github.com/simpkins/de1plus-mqtt) (`docs/topics.md`, `docs/settings.md`, `plugin.tcl`)
