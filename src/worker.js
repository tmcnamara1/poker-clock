// Poker Clock — Cloudflare Worker + Durable Object
// One Durable Object ("Room") per game. It owns the clock, advances levels
// with an alarm, and pushes state to every connected screen over WebSockets.

import { DurableObject } from "cloudflare:workers";
import { DEFAULT_LEVELS, normalizeLevels } from "../public/structure.js";
import { ADJECTIVES, NOUNS, normalizeCode } from "../public/words.js";

const MAX_MSG_BYTES = 32_000;
const CODE_RE = "([A-Za-z]{2,12}-[A-Za-z]{2,12})";
const ROOM_IDLE_REUSE_MS = 3 * 24 * 60 * 60 * 1000; // a code can be reused after 3 idle days

function randomCode() {
  const [a, b] = crypto.getRandomValues(new Uint32Array(2));
  return `${ADJECTIVES[a % ADJECTIVES.length]}-${NOUNS[b % NOUNS.length]}`;
}

function randomKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Create a new game room
    if (path === "/api/rooms" && request.method === "POST") {
      for (let attempt = 0; attempt < 12; attempt++) {
        const code = randomCode();
        const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
        const res = await stub.fetch("https://room/init", {
          method: "POST",
          body: JSON.stringify({ code, hostKey: randomKey() }),
        });
        if (res.status === 200) return json(await res.json());
      }
      return json({ error: "Could not allocate a game code" }, 503);
    }

    // Check that a room exists (used by the join screen)
    let m = path.match(new RegExp(`^/api/rooms/${CODE_RE}$`));
    if (m && request.method === "GET") {
      const code = normalizeCode(m[1]);
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      const res = await stub.fetch("https://room/exists");
      return json({ exists: res.status === 200 }, res.status === 200 ? 200 : 404);
    }

    // WebSocket connection to a room
    m = path.match(new RegExp(`^/ws/${CODE_RE}$`));
    if (m) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      const code = normalizeCode(m[1]);
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      return stub.fetch(request);
    }

    // Pretty URLs: /d/lucky-river -> display page, /r/lucky-river -> remote page
    if (new RegExp(`^/d/${CODE_RE}/?$`).test(path)) {
      return env.ASSETS.fetch(new Request(new URL("/display", url), request));
    }
    if (new RegExp(`^/r/${CODE_RE}/?$`).test(path)) {
      return env.ASSETS.fetch(new Request(new URL("/remote", url), request));
    }

    return env.ASSETS.fetch(request);
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.state = null;
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get("state")) || null;
    });
  }

  // ---------- HTTP entry ----------
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/init") {
      if (this.state) {
        // Codes are reusable once an old game has sat untouched for a few days
        const idle = Date.now() - (this.state.updatedAt || this.state.created);
        if (this.state.running || idle < ROOM_IDLE_REUSE_MS) return new Response("exists", { status: 409 });
        for (const ws of this.ctx.getWebSockets()) { try { ws.close(4410, "Game expired"); } catch {} }
      }
      const { code, hostKey } = await request.json();
      const levels = normalizeLevels(DEFAULT_LEVELS);
      this.state = {
        code,
        hostKey,
        created: Date.now(),
        levels,
        levelIndex: 0,
        running: false,
        endsAt: null,
        remainingMs: levels[0].min * 60_000,
        levelStartedAt: Date.now(),
        finished: false,
        shot: null,
        lastShotEnd: 0,
        settings: { title: "Poker Night", announcer: "pro", warnSeconds: 60, shotSeconds: 30 },
      };
      await this.save();
      return Response.json({ code, hostKey });
    }

    if (url.pathname === "/exists") {
      return new Response(null, { status: this.state ? 200 : 404 });
    }

    // WebSocket upgrade
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      if (!this.state) {
        this.ctx.acceptWebSocket(server, ["player"]);
        server.send(JSON.stringify({ type: "error", error: "room-not-found" }));
        server.close(4404, "Room not found");
        return new Response(null, { status: 101, webSocket: client });
      }
      const key = url.searchParams.get("k");
      const role = key && key === this.state.hostKey ? "host" : "player";
      this.ctx.acceptWebSocket(server, [role]);
      server.send(this.stateMessage(null, role));
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("Not found", { status: 404 });
  }

  // ---------- WebSocket handlers (hibernation API) ----------
  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > MAX_MSG_BYTES) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!this.state) return;

    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", t: msg.t, server: Date.now() }));
      return;
    }
    if (msg.type !== "cmd") return;

    const role = this.ctx.getTags(ws)[0] || "player";
    const isHost = role === "host";
    const now = Date.now();
    const s = this.state;
    let event = null;

    switch (msg.cmd) {
      // ----- anyone -----
      case "callClock": {
        if (this.shotActive(now)) return;
        if (now - s.lastShotEnd < 3000) return; // tiny cooldown against spam
        const name = String(msg.name || "").trim().slice(0, 24);
        s.shot = { endsAt: now + s.settings.shotSeconds * 1000, by: name, startedAt: now };
        event = "shotStart";
        break;
      }
      default:
        if (!isHost) {
          ws.send(JSON.stringify({ type: "error", error: "host-only" }));
          return;
        }
    }

    if (isHost) {
      switch (msg.cmd) {
        case "start":
          if (!s.running && !s.finished) {
            s.running = true;
            s.endsAt = now + Math.max(1000, s.remainingMs);
            s.remainingMs = null;
            event = "resume";
          }
          break;
        case "pause":
          if (s.running) {
            s.remainingMs = Math.max(0, s.endsAt - now);
            s.running = false;
            s.endsAt = null;
            event = "pause";
          }
          break;
        case "addTime": {
          const delta = Math.max(-3_600_000, Math.min(3_600_000, Number(msg.ms) || 0));
          if (s.running) s.endsAt = Math.max(now + 1000, s.endsAt + delta);
          else s.remainingMs = Math.max(1000, (s.remainingMs || 0) + delta);
          event = "time";
          break;
        }
        case "next":
          if (s.levelIndex < s.levels.length - 1) {
            this.goToLevel(s.levelIndex + 1, now);
            event = "levelUp";
          }
          break;
        case "prev":
          if (s.levelIndex > 0) {
            this.goToLevel(s.levelIndex - 1, now);
            event = "levelBack";
          }
          break;
        case "restartLevel":
          this.goToLevel(s.levelIndex, now);
          event = "time";
          break;
        case "reset":
          s.finished = false;
          s.running = false;
          this.goToLevel(0, now);
          event = "reset";
          break;
        case "setStructure": {
          const levels = normalizeLevels(msg.levels);
          if (!levels.length) return;
          const wasLevel = s.levels[s.levelIndex];
          s.levels = levels;
          if (s.levelIndex >= levels.length) s.levelIndex = levels.length - 1;
          s.finished = false;
          // If the current level's length changed, re-scale the remaining time sensibly
          const cur = levels[s.levelIndex];
          if (wasLevel && cur.min !== wasLevel.min) {
            const elapsed = wasLevel.min * 60_000 - (s.running ? s.endsAt - now : s.remainingMs);
            const remain = Math.max(1000, cur.min * 60_000 - elapsed);
            if (s.running) s.endsAt = now + remain;
            else s.remainingMs = remain;
          }
          event = "structure";
          break;
        }
        case "setSettings": {
          const inc = msg.settings || {};
          if (typeof inc.title === "string") s.settings.title = inc.title.trim().slice(0, 40) || "Poker Night";
          if (["pro", "trash", "off"].includes(inc.announcer)) s.settings.announcer = inc.announcer;
          if (Number.isFinite(+inc.warnSeconds)) s.settings.warnSeconds = Math.max(0, Math.min(600, Math.round(+inc.warnSeconds)));
          if (Number.isFinite(+inc.shotSeconds)) s.settings.shotSeconds = Math.max(10, Math.min(180, Math.round(+inc.shotSeconds)));
          event = "settings";
          break;
        }
        case "cancelClock":
          if (s.shot) {
            s.shot = null;
            s.lastShotEnd = now;
            event = "shotCancel";
          }
          break;
      }
    }

    if (!event) return;
    await this.syncAlarm();
    await this.save();
    this.broadcast(event);
  }

  async webSocketClose(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch {}
  }

  async webSocketError() {}

  // ---------- Level timing ----------
  goToLevel(i, now) {
    const s = this.state;
    s.levelIndex = i;
    s.levelStartedAt = now;
    const dur = s.levels[i].min * 60_000;
    if (s.running) {
      s.endsAt = now + dur;
      s.remainingMs = null;
    } else {
      s.endsAt = null;
      s.remainingMs = dur;
    }
  }

  shotActive(now) {
    return this.state.shot && this.state.shot.endsAt > now;
  }

  async syncAlarm() {
    const s = this.state;
    const times = [];
    if (s.running && s.endsAt) times.push(s.endsAt);
    if (s.shot) times.push(s.shot.endsAt);
    if (times.length) await this.ctx.storage.setAlarm(Math.min(...times));
    else await this.ctx.storage.deleteAlarm();
  }

  async alarm() {
    const s = this.state;
    if (!s) return;
    const now = Date.now();
    const events = [];

    // Shot clock expiry
    if (s.shot && s.shot.endsAt <= now + 50) {
      s.shot = null;
      s.lastShotEnd = now;
      events.push("shotEnd");
    }

    // Level advance (catch up if the alarm ran late)
    if (s.running && s.endsAt && s.endsAt <= now + 50) {
      let advanced = false;
      while (s.running && s.endsAt <= now + 50) {
        if (s.levelIndex < s.levels.length - 1) {
          const boundary = s.endsAt;
          s.levelIndex += 1;
          s.levelStartedAt = boundary;
          s.endsAt = boundary + s.levels[s.levelIndex].min * 60_000;
          advanced = true;
        } else {
          s.running = false;
          s.finished = true;
          s.endsAt = null;
          s.remainingMs = 0;
          events.push("finished");
        }
      }
      if (advanced) events.unshift("levelUp");
    }

    await this.syncAlarm();
    await this.save();
    for (const e of events) this.broadcast(e);
  }

  // ---------- Helpers ----------
  async save() {
    this.state.updatedAt = Date.now();
    await this.ctx.storage.put("state", this.state);
  }

  publicState() {
    const { hostKey, lastShotEnd, updatedAt, ...rest } = this.state;
    return rest;
  }

  stateMessage(event, role) {
    return JSON.stringify({ type: "state", event, role, now: Date.now(), state: this.publicState() });
  }

  broadcast(event) {
    for (const ws of this.ctx.getWebSockets()) {
      const role = this.ctx.getTags(ws)[0] || "player";
      try {
        ws.send(this.stateMessage(event, role));
      } catch {}
    }
  }
}
