const API_BASE = "http://localhost:8080";

export class CommandDispatcher {
  constructor({ fetchImpl, currentStateProvider }) {
    this._fetch = fetchImpl;
    this._currentStateProvider = currentStateProvider;
  }

  async dispatch(parsed) {
    switch (parsed.kind) {
      case "wake":
        return this._putState("heating");
      case "sleep":
        return this._sleep();
      case "steam_on":
        await this._wakeIfNeeded();
        return this._putState("steam");
      case "steam_off":
        return this._putState("idle");
      case "profile":
        return this._selectProfileByTitle(parsed.argument);
      case "profile_filename":
        return this._selectProfileById(parsed.argument);
      default:
        return { ok: false, reason: "unknown command" };
    }
  }

  async _putState(stateName) {
    const res = await this._fetch(`${API_BASE}/api/v1/machine/state/${stateName}`, {
      method: "PUT",
    });
    return { ok: res.ok, status: res.status };
  }

  async _sleep() {
    const current = this._currentStateProvider();
    if (current !== "Idle") {
      return { ok: false, reason: `machine in use (${current}); not sleeping` };
    }
    return this._putState("sleeping");
  }

  async _wakeIfNeeded() {
    const current = this._currentStateProvider();
    if (current === "Sleep") {
      await this._putState("heating");
    }
  }

  async _selectProfileByTitle(title) {
    const record = await this._findProfile((r) => r.profile?.title === title);
    if (!record) {
      return { ok: false, reason: `no profile found with the title "${title}"` };
    }
    return this._selectProfile(record);
  }

  async _selectProfileById(id) {
    const record = await this._findProfile((r) => r.id === id);
    if (!record) {
      return { ok: false, reason: `no profile named "${id}"` };
    }
    return this._selectProfile(record);
  }

  async _findProfile(predicate) {
    const res = await this._fetch(`${API_BASE}/api/v1/profiles`);
    if (!res.ok) {
      return null;
    }
    const records = await res.json();
    if (!Array.isArray(records)) return null;
    return records.find(predicate) ?? null;
  }

  async _selectProfile(record) {
    const res = await this._fetch(`${API_BASE}/api/v1/machine/profile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record.profile),
    });
    return { ok: res.ok, status: res.status };
  }
}
