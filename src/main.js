import {
  normalizeConfig,
  generateUniqueId,
  UNIQUE_ID_KEY,
  ACTIVE_SHOT_PUBLISH_INTERVAL_MS,
} from "./config.js";
import { buildStateMessage } from "./state-doc.js";
import { mapState, mapSubstate, isShotActive } from "./mapping.js";
import { parseCommand } from "./commands.js";
import { CommandDispatcher } from "./dispatcher.js";
import { createCommandHandler } from "./command-handler.js";
import { createMqttBridge } from "./bridge.js";
import { createLoopbackJsonStream } from "./loopback.js";
import { createStorageAdapter } from "./storage.js";
import { createDecaidApi } from "./decaid-api.js";

export const PLUGIN_ID = "mqtt.reaplugin";

export function createPlugin(host) {
  const log = (message) => {
    try {
      host.log(`[mqtt] ${message}`);
    } catch {}
  };
  const storage = createStorageAdapter(host);
  const api = createDecaidApi({ fetchImpl: fetch, log });

  let config = null;
  let bridge = null;
  let scaleStream = null;
  let waterStream = null;
  let publishTimer = null;
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
    lastPublishedStateJson: null,
    lastState: null,
    lastSubstate: null,
  };

  function lastPublishedMachineState() {
    if (!runtime.lastPublishedStateJson) return undefined;
    try {
      return JSON.parse(runtime.lastPublishedStateJson).state;
    } catch {
      return undefined;
    }
  }

  function shotFieldsForStateMessage() {
    const shotActive = runtime.shot?.active === true;
    return {
      active: shotActive,
      id: shotActive ? null : runtime.shot?.id ?? null,
      startedAt: shotActive ? null : runtime.shot?.startedAt ?? null,
      durationS: shotActive ? null : runtime.shot?.durationS ?? null,
      weightG: shotActive ? runtime.shotWeightG : runtime.shot?.weightG ?? runtime.shotWeightG,
    };
  }

  // Single publish path. Every message that reaches the broker is built here,
  // from a message that is refreshed first, so a publish never ships a field
  // that some other code path forgot to update.
  //
  // It is reached from exactly three places: the periodic timer, a main
  // state/substate change, and the end of a shot. Nothing else publishes.
  //
  // The workflow is re-read every time because the profile can be changed from
  // the app at any moment and Decaid raises no event this plugin can see. The
  // counts are not: they only move when a shot or steam is recorded, and the
  // publishes that follow those ask for the counts to be refreshed first.
  async function publish({ refreshCountsFirst = false } = {}) {
    if (!bridge) return;
    await pollWorkflow();
    if (refreshCountsFirst) await refreshCounts();
    if (!bridge) return;
    const stateMessage = buildStateMessage({
      snapshot: runtime.snapshot,
      scaleConnected: runtime.scaleConnected,
      waterLevelMm: runtime.waterLevelMm,
      profile: runtime.profile,
      profileFilename: runtime.profileFilename,
      espressoCount: runtime.espressoCount,
      steamingCount: runtime.steamingCount,
      steamDisabled: runtime.steamDisabled,
      ecoSteamOn: runtime.ecoSteamOn,
      shot: runtime.shot ? shotFieldsForStateMessage() : null,
    });
    runtime.lastPublishedStateJson = JSON.stringify(stateMessage);
    bridge.publishState(stateMessage, (e) => {
      if (e) log(`state publish failed: ${e?.message ?? e}`);
    });
    armPublishTimer(stateMessage);
  }

  function armPublishTimer(stateMessage) {
    if (publishTimer) {
      clearTimeout(publishTimer);
      publishTimer = null;
    }
    if (!bridge) return;
    const interval = stateMessage.shot_active
      ? ACTIVE_SHOT_PUBLISH_INTERVAL_MS
      : config.publishIntervalMs;
    publishTimer = setTimeout(() => {
      publishTimer = null;
      publish();
    }, interval);
  }

  function onStateUpdate(payload) {
    runtime.snapshot = payload;
    const rawState = payload.state?.state ?? payload.state;
    const rawSubstate = payload.state?.substate ?? payload.substate;
    const state = mapState(rawState);
    const substate = mapSubstate(rawSubstate) ?? "";
    const shotActive = isShotActive(state, substate);
    const transitioned = state !== runtime.lastState || substate !== runtime.lastSubstate;
    runtime.lastState = state;
    runtime.lastSubstate = substate;
    if (shotActive && runtime.shot?.active !== true) {
      runtime.shot = { active: true };
      runtime.shotWeightG = null;
    } else if (!shotActive && runtime.shot?.active === true) {
      runtime.shot = { ...runtime.shot, active: false };
    }
    // Telemetry (temperatures, pressure, flow) arrives ~5x/second and only
    // updates the cache. A main state or substate change is a publish trigger;
    // everything else waits for the timer.
    if (transitioned) publish();
  }

  async function onShotStored(payload) {
    const shotId = payload?.id;
    if (!shotId) return;
    try {
      const record = await api.fetchShotRecord(shotId);
      if (!record) return;
      const measurements = Array.isArray(record.measurements) ? record.measurements : [];
      const firstSample = measurements[0];
      const lastSample = measurements[measurements.length - 1];
      let durationS = null;
      if (firstSample && lastSample) {
        const startMs = new Date(firstSample.machine?.timestamp).getTime();
        const endMs = new Date(lastSample.machine?.timestamp).getTime();
        if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
          durationS = Math.max(0, (endMs - startMs) / 1000);
        }
      }
      // The measurement series stops when flow stops, while coffee is still
      // dripping into the cup, so its last sample undershoots the real yield.
      // Decaid records the settled figure on the shot itself.
      const actualYield = record.annotations?.actualYield;
      const finalWeight = typeof actualYield === "number"
        ? actualYield
        : lastSample?.scale?.weight ?? null;
      if (typeof actualYield !== "number") {
        log(`shot ${shotId} has no actualYield; falling back to the last scale sample`);
      }
      runtime.shot = {
        active: false,
        id: record.id ?? shotId,
        startedAt: record.timestamp ?? null,
        durationS,
        weightG: finalWeight,
      };
      runtime.shotWeightG = finalWeight;
      // End of shot is the one message that has to be exact, so refresh
      // everything rather than reusing anything cached.
      await publish({ refreshCountsFirst: true });
    } catch (e) {
      log(`shot ${shotId} processing failed: ${e?.message ?? e}`);
    }
  }

  async function onWorkflowUpdated(payload) {
    await applyWorkflowPayload(payload);
  }

  async function applyWorkflowPayload(payload) {
    const title = payload?.profile?.title;
    if (typeof title === "string" && title !== runtime.profile) {
      runtime.profile = title;
      runtime.profileFilename = await findProfileIdByTitle(title);
    }
  }

  async function pollWorkflow() {
    const workflow = await api.fetchWorkflow();
    if (workflow) await applyWorkflowPayload(workflow);
  }

  async function findProfileIdByTitle(title) {
    const records = await api.fetchProfiles();
    if (!Array.isArray(records)) return "";
    const match = records.find((record) => record.profile?.title === title);
    return match?.id ?? "";
  }

  async function refreshCounts() {
    // limit=1 keeps the payload small; only the total is wanted.
    const [espressoCount, steamingCount] = await Promise.all([
      api.fetchCollectionCount("/api/v1/shots?limit=1", "espresso"),
      api.fetchCollectionCount("/api/v1/steams?limit=1", "steaming"),
    ]);
    if (espressoCount !== null) runtime.espressoCount = espressoCount;
    if (steamingCount !== null) runtime.steamingCount = steamingCount;
  }

  function buildAndStartServices() {
    dispatcher = new CommandDispatcher({
      fetchImpl: fetch,
      currentStateProvider: lastPublishedMachineState,
    });
    bridge = createMqttBridge({
      host,
      config,
      onCommand: createCommandHandler(dispatcher, log),
      log,
    });
    bridge.onConnectedHandler = () => {
      publish({ refreshCountsFirst: true });
    };
    bridge.start();

    scaleStream = createLoopbackJsonStream({
      host,
      path: "/ws/v1/scale/snapshot",
      onJson: (snapshot) => {
        if (typeof snapshot.weight === "number") {
          runtime.shotWeightG = snapshot.weight;
          if (runtime.shot?.active) {
            runtime.shot.weightG = snapshot.weight;
          }
        }
      },
      onStatus: (status) => {
        runtime.scaleConnected = status === "connected";
      },
      log,
    });
    scaleStream.start();

    waterStream = createLoopbackJsonStream({
      host,
      path: "/ws/v1/machine/waterLevels",
      onJson: (waterLevelReading) => {
        if (typeof waterLevelReading.currentLevel !== "number") return;
        runtime.waterLevelMm = waterLevelReading.currentLevel;
      },
      log,
    });
    waterStream.start();
  }

  async function stopAll() {
    if (publishTimer) {
      clearTimeout(publishTimer);
      publishTimer = null;
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
    runtime.lastPublishedStateJson = null;
  }

  return {
    id: PLUGIN_ID,

    async onLoad(settings) {
      const storedUniqueId = await storage.read(UNIQUE_ID_KEY);
      const { config: normalized, uniqueId, warnings } = normalizeConfig(settings, storedUniqueId);
      if (!storedUniqueId) {
        storage.write(UNIQUE_ID_KEY, uniqueId);
      }
      for (const warning of warnings) {
        log(`config warning: ${warning}`);
      }
      config = normalized;
      if (!config.enabled) {
        log("disabled: no broker host configured");
        return;
      }
      buildAndStartServices();
    },

    async onUnload() {
      await stopAll();
    },

    onEvent(event) {
      if (storage.resolvePendingRead(event)) return;
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
