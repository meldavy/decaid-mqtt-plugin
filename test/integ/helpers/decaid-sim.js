import http from "node:http";
import net from "node:net";
import { WebSocketServer } from "ws";

export function createDecaidSim() {
  const state = {
    shots: [],
    steams: [],
    profiles: [],
    scaleStatus: "connected",
    pendingScaleSamples: [],
  };
  const requests = [];
  const scaleSockets = new Set();
  const waterSockets = new Set();

  const server = httpServer();

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url, "http://localhost").pathname;
    if (path !== "/ws/v1/scale/snapshot" && path !== "/ws/v1/machine/waterLevels") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (path === "/ws/v1/scale/snapshot") {
        scaleSockets.add(ws);
        if (state.scaleStatus) {
          ws.send(JSON.stringify({ status: state.scaleStatus }));
        }
        for (const sample of state.pendingScaleSamples.splice(0)) {
          ws.send(JSON.stringify(sample));
        }
      } else {
        waterSockets.add(ws);
      }
      ws.on("close", () => {
        scaleSockets.delete(ws);
        waterSockets.delete(ws);
      });
    });
  });

  function sendScaleSnapshot(sample) {
    for (const ws of scaleSockets) ws.send(JSON.stringify(sample));
  }

  function queueScaleSnapshot(sample) {
    state.pendingScaleSamples.push(sample);
    sendScaleSnapshot(sample);
  }

  function sendWaterLevels(levels) {
    for (const ws of waterSockets) ws.send(JSON.stringify(levels));
  }

  function start() {
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    });
  }

  function stop() {
    for (const ws of [...scaleSockets, ...waterSockets]) {
      try {
        ws.terminate();
      } catch {}
    }
    scaleSockets.clear();
    waterSockets.clear();
    return new Promise((resolve) => server.close(resolve));
  }

  function httpServer() {
    return http.createServer((req, res) => {
      handler(req, res).catch(() => {
        res.writeHead(500);
        res.end();
      });
    });
  }

  async function handler(req, res) {
    const url = new URL(req.url, "http://localhost");
    const record = { method: req.method, path: url.pathname, body: null };
    requests.push(record);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    record.body = raw || null;

    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (req.method === "GET" && url.pathname === "/api/v1/shots") return json(200, state.shots);
    if (req.method === "GET" && url.pathname === "/api/v1/steams") return json(200, state.steams);
    if (req.method === "GET" && url.pathname === "/api/v1/profiles") return json(200, state.profiles);
    const shotMatch = url.pathname.match(/^\/api\/v1\/shots\/([^/]+)$/);
    if (req.method === "GET" && shotMatch) {
      const shot = state.shots.find((s) => s.id === decodeURIComponent(shotMatch[1]));
      return shot ? json(200, shot) : json(404, { error: "not found" });
    }
    const stateMatch = url.pathname.match(/^\/api\/v1\/machine\/state\/([^/]+)$/);
    if (req.method === "PUT" && stateMatch) {
      record.stateName = decodeURIComponent(stateMatch[1]);
      return json(200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/v1/machine/profile") {
      record.profileBody = raw ? JSON.parse(raw) : null;
      return json(200, { ok: true });
    }
    return json(404, { error: "not found" });
  }

  return {
    start,
    stop,
    requests,
    state,
    sendScaleSnapshot,
    queueScaleSnapshot,
    sendWaterLevels,
    setScaleStatus(status) {
      state.scaleStatus = status;
      for (const ws of scaleSockets) ws.send(JSON.stringify({ status }));
    },
  };
}
