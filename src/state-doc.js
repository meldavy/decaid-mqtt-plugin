import { mapState, mapSubstate, deriveWakeState, deriveSteamFields } from "./mapping.js";

const WATER_LEVEL_FIELDS = ["water_level_mm", "water_level_ml"];

const SHOT_FIELDS = ["shot_active", "shot_id", "shot_started_at", "shot_duration_s", "shot_weight_g"];

const BASE_FIELDS = [
  "online",
  "de1_connected",
  "scale_connected",
  "state",
  "substate",
  "profile",
  "profile_filename",
  "espresso_count",
  "steaming_count",
  "head_temperature",
  "mix_temperature",
  "steam_heater_temperature",
  "water_level_mm",
  "water_level_ml",
  "wake_state",
  "steam_mode",
  "steam_state",
];

export function offlineDocument() {
  return { online: false, de1_connected: false };
}

export function buildStateDocument(input) {
  const {
    snapshot,
    scaleConnected = false,
    waterLevelMm = null,
    profile = null,
    profileFilename = null,
    espressoCount = 0,
    steamingCount = 0,
    steamDisabled = true,
    ecoSteamOn = false,
    shot = null,
  } = input;

  if (!snapshot) return offlineDocument();

  const state = mapState(snapshot.state?.state ?? snapshot.state);
  const substate = mapSubstate(snapshot.state?.substate ?? snapshot.substate);
  const steam = deriveSteamFields(state, steamDisabled, ecoSteamOn);

  const doc = {
    online: true,
    de1_connected: true,
    scale_connected: Boolean(scaleConnected),
    state,
    substate,
    profile: profile ?? "",
    profile_filename: profileFilename ?? "",
    espresso_count: espressoCount,
    steaming_count: steamingCount,
    head_temperature: snapshot.groupTemperature,
    mix_temperature: snapshot.mixTemperature,
    steam_heater_temperature: snapshot.steamTemperature,
    water_level_mm: waterLevelMm ?? 0.0,
    water_level_ml: mmToMl(waterLevelMm),
    wake_state: deriveWakeState(state),
    steam_mode: steam.steam_mode,
    steam_state: steam.steam_state,
  };

  doc.shot_active = shot ? Boolean(shot.active) : false;
  if (shot?.id !== undefined && shot?.id !== null) doc.shot_id = shot.id;
  if (shot?.startedAt !== undefined && shot?.startedAt !== null) doc.shot_started_at = shot.startedAt;
  if (shot?.durationS !== undefined && shot?.durationS !== null) doc.shot_duration_s = shot.durationS;
  if (shot?.weightG !== undefined && shot?.weightG !== null) doc.shot_weight_g = shot.weightG;

  return doc;
}

export function mmToMl(mm) {
  if (mm === null || mm === undefined || !Number.isFinite(mm)) return 0;
  return waterTankLevelToMilliliters(mm);
}

export const WATER_TANK_MM_TO_ML = [
  0, 16, 43, 70, 97, 124, 151, 179, 206, 233, 261, 288, 316, 343, 371, 398,
  426, 453, 481, 509, 537, 564, 592, 620, 648, 676, 704, 732, 760, 788, 816,
  844, 872, 900, 929, 957, 985, 1013, 1042, 1070, 1104, 1138, 1172, 1207,
  1242, 1277, 1312, 1347, 1382, 1417, 1453, 1488, 1523, 1559, 1594, 1630,
  1665, 1701, 1736, 1772, 1808, 1843, 1879, 1915, 1951, 1986, 2022, 2058,
];

export const WATER_TANK_FULL_ML = 2058;

export function waterTankLevelToMilliliters(mm) {
  const index = Math.trunc(mm);
  if (index < 0 || index >= WATER_TANK_MM_TO_ML.length) {
    return WATER_TANK_FULL_ML;
  }
  return WATER_TANK_MM_TO_ML[index];
}

export function stateFieldOrder() {
  return [...BASE_FIELDS, ...SHOT_FIELDS, ...WATER_LEVEL_FIELDS];
}
