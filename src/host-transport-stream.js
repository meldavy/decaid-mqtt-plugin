function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

class TinyEmitter {
  constructor() {
    this._listeners = new Map();
  }
  on(event, cb) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(cb);
    return this;
  }
  once(event, cb) {
    const wrapper = (...args) => {
      this.removeListener(event, wrapper);
      cb(...args);
    };
    return this.on(event, wrapper);
  }
  removeListener(event, cb) {
    this._listeners.get(event)?.delete(cb);
    return this;
  }
  removeAllListeners(event) {
    if (event === undefined) this._listeners.clear();
    else this._listeners.delete(event);
    return this;
  }
  emit(event, ...args) {
    const set = this._listeners.get(event);
    if (!set) return false;
    for (const cb of Array.from(set)) cb(...args);
    return true;
  }
}

export class HostTransportStream extends TinyEmitter {
  constructor(hostTransport, openOptions) {
    super();
    this._hostTransport = hostTransport;
    this._openOptions = openOptions;
    this._handle = null;
    this._writable = true;
    this._pendingWrites = [];
    this._flushing = false;
    this._closed = false;
    this._openPromise = null;
    this._onTransportEvent = (event) => this._handleTransportEvent(event);
  }

  async open() {
    this._openPromise = this._open();
    return this._openPromise;
  }

  async _open() {
    const opened = await this._hostTransport.open(this._openOptions);
    this._handle = opened.handle;
    this._hostTransport.onEvent(this._handle, this._onTransportEvent);
  }

  _handleTransportEvent(event) {
    if (this._closed) return;
    switch (event.type) {
      case "data": {
        const bytes = event.dataType === "binary"
          ? base64ToBytes(event.data)
          : new TextEncoder().encode(event.data);
        this.emit("data", bytes);
        break;
      }
      case "error":
        this.emit("error", new Error(event.message ?? "transport_error"));
        break;
      case "close":
        this._markClosed();
        break;
      default:
        break;
    }
  }

  _markClosed() {
    if (this._closed) return;
    this._closed = true;
    this._writable = false;
    this.emit("close");
  }

  write(chunk, cb) {
    if (this._closed || !this._writable) {
      const err = new Error("stream is closed");
      if (typeof cb === "function") cb(err);
      else this.emit("error", err);
      return false;
    }
    const bytes = chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(String(chunk));
    this._pendingWrites.push({ bytes, cb });
    this._flush();
    return true;
  }

  _flush() {
    if (this._flushing || this._pendingWrites.length === 0) return;
    this._flushing = true;
    const next = this._pendingWrites.shift();
    const payload = { type: "binary", data: bytesToBase64(next.bytes) };
    const sendPromise = this._openPromise
      ? this._openPromise
        .then(() => this._hostTransport.send(this._handle, payload))
      : this._hostTransport.send(this._handle, payload);
    sendPromise
      .then(() => {
        if (typeof next.cb === "function") next.cb();
        this._flushing = false;
        if (this._pendingWrites.length > 0) this._flush();
      })
      .catch((e) => {
        this._flushing = false;
        if (typeof next.cb === "function") next.cb(e);
        else this.emit("error", e);
        if (this._pendingWrites.length > 0) this._flush();
      });
  }

  async end() {
    await this._hostTransport.close(this._handle).catch(() => {});
    this._markClosed();
  }

  destroy() {
    this.end();
  }

  pipe(dest) {
    this.on("data", (chunk) => dest.write(chunk));
    return dest;
  }

  setMaxListeners() {
    return this;
  }

  cork() {}

  uncork() {}
}
