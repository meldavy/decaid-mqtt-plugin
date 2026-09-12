import { normalizeConfig, generateUniqueId, UNIQUE_ID_KEY } from "./config.js";
import { buildStateDocument } from "./state-doc.js";
import { mapState, mapSubstate, isShotActive } from "./mapping.js";
import { parseCommand } from "./commands.js";
import { CommandDispatcher } from "./dispatcher.js";
import { createCommandHandler } from "./command-handler.js";
import { createMqttBridge } from "./bridge.js";
import { createLoopbackJsonStream, LOCAL_API_BASE } from "./loopback.js";
import { createStorageAdapter } from "./storage.js";

export const PLUGIN_ID = "mqtt.reaplugin";

export function createPlugin(host) {
  const log = (msg) => {
    try {
      host.log(`[mqtt] ${msg}`);
    } catch {}
  };
  const storage = createStorageAdapter(host);

  let config = null;
  let bridge = null;
  let scaleStream = null;
  let waterStream = null;
  let heartbeatTimer = null;
  let dispatcher = null;

  const runtime = {
    snapshot: null,
    scaleConnected: false,
    shotWeightG: null,
    waterLevelMm: null,
    profile: "",
    profileFilename: "",
    espressoCount: 0,
    steamingCount: 0,
    steamDisabled: true,
    ecoSteamOn: false,
    shot: null,
    lastDocJson: null,
  };

  function publishedState() {
    if (!runtime.lastDocJson) return undefined;
    try {
      return JSON.parse(runtime.lastDocJson).state;
    } catch {
      return undefined;
    }
  }

  function currentShotFields() {
    const active = runtime.shot?.active === true;
    return {
      active,
      id: active ? null : runtime.shot?.id ?? null,
      startedAt: active ? null : runtime.shot?.startedAt ?? null,
      durationS: active ? null : runtime.shot?.durationS ?? null,
      weightG: active ? runtime.shotWeightG : runtime.shot?.weightG ?? runtime.shotWeightG,
    };
  }

  function buildDoc() {
    return buildStateDocument({
      snapshot: runtime.snapshot,
      scaleConnected: runtime.scaleConnected,
      waterLevelMm: runtime.waterLevelMm,
      profile: runtime.profile,
      profileFilename: runtime.profileFilename,
      espressoCount: runtime.espressoCount,
      steamingCount: runtime.steamingCount,
      steamDisabled: runtime.steamDisabled,
      ecoSteamOn: runtime.ecoSteamOn,
      shot: runtime.shot ? currentShotFields() : null,
    });
  }

  function heartbeatIntervalMs(doc) {
    return doc.shot_active
      ? 1000
      : config.publishIntervalMs;
  }

  function publishNow() {
    if (!bridge) return;
    const doc = buildDoc();
    const json = JSON.stringify(doc);
    runtime.lastDocJson = json;
    bridge.publishState(doc, (e) => {
      if (e) log(`state publish failed: ${e?.message ?? e}`);
    });
    scheduleHeartbeat(doc);
  }

  function publishIfChanged() {
    if (!bridge) return;
    const doc = buildDoc();
    const json = JSON.stringify(doc);
    if (json === runtime.lastDocJson) {
      scheduleHeartbeat(doc);
      return;
    }
    runtime.lastDocJson = json;
    bridge.publishState(doc, (e) => {
      if (e) log(`state publish failed: ${e?.message ?? e}`);
    });
    scheduleHeartbeat(doc);
  }

  function scheduleHeartbeat(doc) {
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (!bridge) return;
    const interval = heartbeatIntervalMs(doc);
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = null;
      if (!bridge) return;
      publishNow();
      pollWorkflow();
    }, interval);
  }

  function onStateUpdate(payload) {
    runtime.snapshot = payload;
    const state = mapState(payload.state?.state ?? payload.state);
    const substate = mapSubstate(payload.state?.substate ?? payload.substate) ?? "";
    const active = isShotActive(state, substate);
    if (active && runtime.shot?.active !== true) {
      runtime.shot = { active: true };
      runtime.shotWeightG = null;
    } else if (!active && runtime.shot?.active === true) {
      runtime.shot = { ...runtime.shot, active: false };
    }
    publishIfChanged();
  }

  async function onShotStored(payload) {
    const id = payload?.id;
    if (!id) return;
    try {
      const res = await fetch(`${LOCAL_API_BASE}/api/v1/shots/${id}`);
      if (!res.ok) {
        log(`shot fetch failed: ${res.status}`);
        return;
      }
      const record = await res.json();
      const measurements = Array.isArray(record.measurements) ? record.measurements : [];
      const first = measurements[0];
      const last = measurements[measurements.length - 1];
      let durationS = null;
      if (first && last) {
        const start = new Date(first.machine?.timestamp).getTime();
        const end = new Date(last.machine?.timestamp).getTime();
        if (Number.isFinite(start) && Number.isFinite(end)) {
          durationS = Math.max(0, (end - start) / 1000);
        }
      }
      runtime.espressoCount += 1;
      runtime.shot = {
        active: false,
        id: record.id ?? id,
        startedAt: record.timestamp ?? null,
        durationS,
        weightG: last?.scale?.weight ?? null,
      };
      publishIfChanged();
    } catch (e) {
      log(`shot record fetch failed: ${e?.message ?? e}`);
    }
  }

  async function onWorkflowUpdated(payload) {
    await applyWorkflowPayload(payload);
  }

  async function applyWorkflowPayload(payload) {
    const title = payload?.profile?.title;
    if (typeof title === "string" && title !== runtime.profile) {
      runtime.profile = title;
      runtime.profileFilename = await resolveProfileFilename(title);
      publishIfChanged();
    }
  }

  async function pollWorkflow() {
    try {
      const res = await fetch(`${LOCAL_API_BASE}/api/v1/workflow`);
      if (!res.ok) return;
      await applyWorkflowPayload(await res.json());
    } catch (e) {
      log(`workflow poll failed: ${e?.message ?? e}`);
    }
  }

  async function resolveProfileFilename(title) {
    try {
      const res = await fetch(`${LOCAL_API_BASE}/api/v1/profiles`);
      if (!res.ok) return "";
      const records = await res.json();
      if (!Array.isArray(records)) return "";
      const match = records.find((r) => r.profile?.title === title);
      return match?.id ?? "";
    } catch {
      return "";
    }
  }

  async function refreshCounts() {
    try {
      const [shotsRes, steamsRes] = await Promise.all([
        fetch(`${LOCAL_API_BASE}/api/v1/shots`),
        fetch(`${LOCAL_API_BASE}/api/v1/steams`),
      ]);
      if (shotsRes.ok) {
        const shots = await shotsRes.json();
        runtime.espressoCount = Array.isArray(shots) ? shots.length : runtime.espressoCount;
      }
      if (steamsRes.ok) {
        const steams = await steamsRes.json();
        runtime.steamingCount = Array.isArray(steams) ? steams.length : runtime.steamingCount;
      }
      publishIfChanged();
    } catch (e) {
      log(`count refresh failed: ${e?.message ?? e}`);
    }
  }

  function startAll() {
    dispatcher = new CommandDispatcher({
      fetchImpl: fetch,
      currentStateProvider: publishedState,
    });
    bridge = createMqttBridge({
      host,
      config,
      onCommand: createCommandHandler(dispatcher, log, () => pollWorkflow()),
      log,
    });
    bridge.onConnectedHandler = () => {
      publishNow();
      refreshCounts();
      pollWorkflow();
    };
    bridge.start();

    scaleStream = createLoopbackJsonStream({
      host,
      path: "/ws/v1/scale/snapshot",
      onJson: (data) => {
        if (typeof data.weight === "number") {
          runtime.shotWeightG = data.weight;
          if (runtime.shot?.active) {
            runtime.shot.weightG = data.weight;
          }
          publishIfChanged();
        }
      },
      onStatus: (status) => {
        runtime.scaleConnected = status === "connected";
        publishIfChanged();
      },
      log,
    });
    scaleStream.start();

    waterStream = createLoopbackJsonStream({
      host,
      path: "/ws/v1/machine/waterLevels",
      onJson: (data) => {
        if (typeof data.currentLevel === "number" && data.currentLevel !== runtime.waterLevelMm) {
          runtime.waterLevelMm = data.currentLevel;
          publishIfChanged();
        }
      },
      log,
    });
    waterStream.start();
  }

  async function stopAll() {
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (scaleStream) {
      await scaleStream.stop();
      scaleStream = null;
    }
    if (waterStream) {
      await waterStream.stop();
      waterStream = null;
    }
    if (bridge) {
      bridge.stop();
      bridge = null;
    }
    dispatcher = null;
    runtime.lastDocJson = null;
  }

  return {
    id: PLUGIN_ID,

    async onLoad(settings) {
      const storedUniqueId = await storage.read(UNIQUE_ID_KEY);
      const { config: normalized, uniqueId, errors } = normalizeConfig(settings, storedUniqueId);
      if (!storedUniqueId) {
        storage.write(UNIQUE_ID_KEY, uniqueId);
      }
      for (const err of errors) {
        log(`config warning: ${err}`);
      }
      config = normalized;
      if (!config.enabled) {
        log("disabled: no broker host configured");
        return;
      }
      startAll();
    },

    async onUnload() {
      await stopAll();
    },

    onEvent(event) {
      if (storage.settle(event)) return;
      switch (event?.name) {
        case "stateUpdate":
          onStateUpdate(event.payload);
          break;
        case "shotStored":
          onShotStored(event.payload);
          break;
        case "workflowUpdated":
          onWorkflowUpdated(event.payload);
          break;
        case "shutdown":
          stopAll();
          break;
        default:
          break;
      }
    },
  };
}
