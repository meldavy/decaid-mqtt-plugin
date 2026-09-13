import {
  normalizeConfig,
  generateUniqueId,
  UNIQUE_ID_KEY,
  ACTIVE_SHOT_PUBLISH_INTERVAL_MS,
} from "./config.js";
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
    lastDocJson: null,
    lastState: null,
    lastSubstate: null,
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

  // Single publish path. Every message that reaches the broker is built here,
  // from a document that is refreshed first, so a publish never ships a field
  // that some other code path forgot to update.
  //
  // It is reached from exactly three places: the periodic timer, a main
  // state/substate change, and the end of a shot. Nothing else publishes.
  //
  // The workflow is re-read every time because the profile can be changed from
  // the app at any moment and Decaid raises no event this plugin can see. The
  // counts are not: they only move when a shot or steam is recorded, and the
  // publishes that follow those ask for `full`.
  async function publish({ full = false } = {}) {
    if (!bridge) return;
    await pollWorkflow();
    if (full) await refreshCounts();
    if (!bridge) return;
    const doc = buildDoc();
    runtime.lastDocJson = JSON.stringify(doc);
    bridge.publishState(doc, (e) => {
      if (e) log(`state publish failed: ${e?.message ?? e}`);
    });
    armPublishTimer(doc);
  }

  function armPublishTimer(doc) {
    if (publishTimer) {
      clearTimeout(publishTimer);
      publishTimer = null;
    }
    if (!bridge) return;
    const interval = doc.shot_active
      ? ACTIVE_SHOT_PUBLISH_INTERVAL_MS
      : config.publishIntervalMs;
    publishTimer = setTimeout(() => {
      publishTimer = null;
      publish();
    }, interval);
  }

  function onStateUpdate(payload) {
    runtime.snapshot = payload;
    const state = mapState(payload.state?.state ?? payload.state);
    const substate = mapSubstate(payload.state?.substate ?? payload.substate) ?? "";
    const active = isShotActive(state, substate);
    const transitioned = state !== runtime.lastState || substate !== runtime.lastSubstate;
    runtime.lastState = state;
    runtime.lastSubstate = substate;
    if (active && runtime.shot?.active !== true) {
      runtime.shot = { active: true };
      runtime.shotWeightG = null;
    } else if (!active && runtime.shot?.active === true) {
      runtime.shot = { ...runtime.shot, active: false };
    }
    // Telemetry (temperatures, pressure, flow) arrives ~5x/second and only
    // updates the cache. A main state or substate change is a publish trigger;
    // everything else waits for the timer.
    if (transitioned) publish();
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
      // The measurement series stops when flow stops, while coffee is still
      // dripping into the cup, so its last sample undershoots the real yield.
      // Decaid records the settled figure on the shot itself.
      const actualYield = record.annotations?.actualYield;
      const finalWeight = typeof actualYield === "number"
        ? actualYield
        : last?.scale?.weight ?? null;
      if (typeof actualYield !== "number") {
        log(`shot ${id} has no actualYield; falling back to the last scale sample`);
      }
      runtime.shot = {
        active: false,
        id: record.id ?? id,
        startedAt: record.timestamp ?? null,
        durationS,
        weightG: finalWeight,
      };
      runtime.shotWeightG = finalWeight;
      // End of shot is the one message that has to be exact, so refresh
      // everything rather than reusing anything cached.
      await publish({ full: true });
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

  // These lists are paginated on newer Decaid builds ({items, total, ...}) and
  // a plain array on older ones. Read the lifetime figure out of either, and
  // say so when it is neither, rather than silently keeping a stale count.
  function countFrom(payload, what) {
    if (Array.isArray(payload)) return payload.length;
    if (payload && typeof payload.total === "number") return payload.total;
    log(`${what} count: unrecognised response shape, keeping the previous value`);
    return null;
  }

  async function refreshCounts() {
    try {
      // limit=1 keeps the payload small; only the total is wanted.
      const [shotsRes, steamsRes] = await Promise.all([
        fetch(`${LOCAL_API_BASE}/api/v1/shots?limit=1`),
        fetch(`${LOCAL_API_BASE}/api/v1/steams?limit=1`),
      ]);
      if (shotsRes.ok) {
        const n = countFrom(await shotsRes.json(), "espresso");
        if (n !== null) runtime.espressoCount = n;
      }
      if (steamsRes.ok) {
        const n = countFrom(await steamsRes.json(), "steaming");
        if (n !== null) runtime.steamingCount = n;
      }
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
      onCommand: createCommandHandler(dispatcher, log, () => {}),
      log,
    });
    bridge.onConnectedHandler = () => {
      publish({ full: true });
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
      onJson: (data) => {
        if (typeof data.currentLevel !== "number") return;
        runtime.waterLevelMm = data.currentLevel;
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
