# decaid-mqtt-plugin

MQTT integration for [Decaid](https://github.com/decentespresso/decaid) —
publishes machine state to an MQTT broker and accepts control commands.
Wire-compatible with the de1app MQTT plugin
([simpkins/de1plus-mqtt](https://github.com/simpkins/de1plus-mqtt)), so
existing MQTT consumers (Home Assistant, Node-RED, custom scripts) keep
working unchanged.

Specs: [doc/protocol.md](doc/protocol.md) (wire contract),
[doc/architecture.md](doc/architecture.md) (implementation design).
Tracking: [decentespresso/decaid#681](https://github.com/decentespresso/decaid/issues/681).

## Features

- Publishes machine state to `{topic_prefix}/state` (QoS 1, retained):
  temperatures, pressure, flow, state/substate, profile, usage counts, water
  level — the same 17-field JSON document as the de1app plugin.
- Live shot weight: with a scale attached, `shot_weight_g` updates in real
  time during a shot; the final yield, shot id, start time and duration are
  reported after completion. (Additive fields beyond de1app parity.)
- Subscribes to `{topic_prefix}/command` for `wake`, `sleep`, `steam_on`,
  `steam_off`, `profile <name>`, `profile_filename <file>`.
- MQTT over raw TCP or TLS (matching de1app, not MQTT-over-WebSocket).
- Auto-generated unique client ID and topic prefix so multiple machines never
  collide on one broker.
- Reconnect loop with exponential backoff (2 s doubling, capped at 64 s, 15
  attempts); MQTT last will publishes an explicit offline state document.

## Install

### From a GitHub release (tracked, auto-updates)

```
POST http://<tablet>:8080/api/v1/plugins/install/github-release
{"repo": "meldavy/decaid-mqtt-plugin"}
```

or use the Plugins settings screen in Decaid.

### From a branch (tracked, updates on commit)

```
POST http://<tablet>:8080/api/v1/plugins/install/github-branch
{"repo": "meldavy/decaid-mqtt-plugin"}
```

### From a local build

Zip the `mqtt.reaplugin/` directory and install it from the Plugins settings
screen (local ZIP), or copy it into the app's plugin folder.

## Compatibility

- Requires Decaid **0.8.5 or later** (that is the first stable release with
  the plugin `host.transport` network permissions this plugin needs).
- The manifest deliberately does not request `events.workflow` (0.8.6+ only);
  instead the current profile title is polled from `GET /api/v1/workflow` on
  the heartbeat cadence, so `profile`/`profile_filename` stay correct on both
  0.8.5 and newer builds. After a `profile`/`profile_filename` command the
  state is re-polled immediately.
- The manifest carries explicit empty `api` and `drivers` arrays because
  Decaid's manifest parser requires a (possibly empty) list for `api`.
- On 0.8.5 the broker password is stored in regular settings storage; secure
  credential storage arrives with later Decaid versions (`secure: true` is
  already declared).

## Settings

Configured in Decaid's plugin settings screen:

| Setting | Default | Meaning |
|---------|---------|---------|
| Broker host | *(empty)* | Empty disables the integration |
| Broker port | 8883 | 8883 for TLS, 1883 for plain TCP |
| Username / Password | *(empty)* | Broker credentials; password stored securely |
| Client ID | auto | `de1plus_<unique id>` when empty |
| Topic prefix | auto | `de1plus/<unique id>` when empty |
| Publish interval (ms) | 60000 | Idle heartbeat; mid-shot updates publish at ~1 s |
| Use TLS | on | Platform certificate validation |

Custom CA / mutual TLS is not supported yet — it depends on the plugin
transport gaining custom trust material
([decaid#758](https://github.com/decentespresso/decaid/issues/758)).

## Development

```
npm install
npm run build       # bundles src/ + mqtt.js into mqtt.reaplugin/plugin.js
npm test            # unit tests (no broker or sockets required)
npm run test:integ  # end-to-end integration tests (~2 min, real sockets)
```

### Integration tests

`npm run test:integ` is a separate build target from `npm test`. It runs the
**built** `mqtt.reaplugin/plugin.js` bundle inside a sandboxed VM that mirrors
the Decaid plugin runtime (`host.transport` over real TCP sockets, host-owned
`fetch`, async `storageRead` events, permission gating, transport limits)
against a purpose-built in-process MQTT broker (MQTT 3.1.1 and 5, retained
messages, last will, QoS 1, auth) and a simulated Decaid REST/WebSocket API on
a real loopback HTTP server. No external broker, machine or app instance is
required; everything runs on ephemeral localhost ports, so it works in any
developer environment and in CI.

The suite covers: broker handshake (client id, keepalive, will, MQTT 5 with
3.1.1 fallback), state document wire format and publish triggers, heartbeat
cadence, live shot weight over the scale stream, shot completion records,
water levels, profile selection, all six commands, unknown/invalid commands,
broker outage and restart reconnects, last-will offline documents on abnormal
client death, unload teardown, and broker authentication.

CI runs `npm test` only. It is the developer's responsibility to run
`npm run test:integ` before checking in changes that affect the plugin's
runtime behavior (`src/`, `build.mjs`, or the bundle).

The built `plugin.js` is committed so branch installs work; CI verifies it is
up to date and repackages it for releases. Tag a release `vX.Y.Z` matching
`manifest.json`'s `version`.

### Status and known limitations

- The `host.transport` → MQTT.js adapter (`src/host-transport-stream.js`,
  `src/bridge.js`) is exercised end-to-end by `npm run test:integ` against a
  real in-process broker over real TCP sockets. On-device TLS (platform trust
  store) is not covered by the harness; everything else runs the shipping
  bundle.
- Home Assistant auto-discovery is intentionally out of scope for the first
  release (see doc/protocol.md); the state document is already compatible.
- Commands execute through Decaid's own REST API over loopback HTTP (same
  pattern as the bundled Visualizer plugin).

## License

MIT
