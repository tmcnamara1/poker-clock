// Shared browser code: connection + clock sync, formatting, sound, announcer, structure editor.

import { PRESETS, levelNumber, totalLevels, generateStructure, describeStructure } from "./structure.js";
export { PRESETS, levelNumber, totalLevels, generateStructure, describeStructure };

// ---------------------------------------------------------------- connection
export class RoomConnection {
  constructor(code, key, onState, onStatus) {
    this.code = code;
    this.key = key;
    this.onState = onState;
    this.onStatus = onStatus || (() => {});
    this.offset = 0; // serverTime - localTime
    this.bestRtt = Infinity;
    this.retry = 0;
    this.connect();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && (!this.ws || this.ws.readyState > 1)) this.connect();
    });
  }

  connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const q = this.key ? `?k=${encodeURIComponent(this.key)}` : "";
    const ws = new WebSocket(`${proto}://${location.host}/ws/${this.code}${q}`);
    this.ws = ws;
    this.onStatus("connecting");
    ws.onopen = () => {
      this.retry = 0;
      this.onStatus("online");
      this.bestRtt = Infinity;
      for (let i = 0; i < 4; i++) setTimeout(() => this.ping(), i * 400);
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.ping(), 20000);
    };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === "pong") {
        const now = Date.now();
        const rtt = now - msg.t;
        if (rtt < this.bestRtt) {
          this.bestRtt = rtt;
          this.offset = msg.server - (msg.t + rtt / 2);
        }
      } else if (msg.type === "state") {
        if (this.bestRtt === Infinity) this.offset = msg.now - Date.now();
        this.onState(msg);
      } else if (msg.type === "error" && msg.error === "room-not-found") {
        this.dead = true;
        this.onStatus("missing");
      }
    };
    ws.onclose = () => {
      clearInterval(this.pingTimer);
      if (this.dead) return;
      this.onStatus("offline");
      const wait = Math.min(10000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), wait);
    };
  }

  ping() {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ type: "ping", t: Date.now() }));
  }

  send(cmd, extra = {}) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify({ type: "cmd", cmd, ...extra }));
      return true;
    }
    return false;
  }

  serverNow() {
    return Date.now() + this.offset;
  }
}

// ---------------------------------------------------------------- formatting
export const fmtNum = (n) => Number(n || 0).toLocaleString("en-US");

export function fmtClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export function remainingMs(state, serverNow) {
  if (state.finished) return 0;
  return state.running ? Math.max(0, state.endsAt - serverNow) : state.remainingMs || 0;
}

export function blindsText(l) {
  return l && !l.brk ? `${fmtNum(l.sb)} / ${fmtNum(l.bb)}` : "Break";
}

// Time until the next break starts (null if no break ahead)
export function timeToBreak(state, serverNow) {
  const { levels, levelIndex } = state;
  if (levels[levelIndex]?.brk) return null;
  let t = remainingMs(state, serverNow);
  for (let i = levelIndex + 1; i < levels.length; i++) {
    if (levels[i].brk) return t;
    t += levels[i].min * 60000;
  }
  return null;
}

export function nextPlayingLevel(levels, index) {
  for (let i = index + 1; i < levels.length; i++) if (!levels[i].brk) return { level: levels[i], index: i };
  return null;
}

// ---------------------------------------------------------------- sound
let actx = null;
export function audioUnlock() {
  if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
  if (actx.state === "suspended") actx.resume();
  // prime speech synthesis (iOS needs a user-gesture utterance)
  if ("speechSynthesis" in window) {
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    speechSynthesis.speak(u);
  }
  return actx;
}

function tone(freq, start, dur, { type = "sine", gain = 0.3, attack = 0.01 } = {}) {
  if (!actx) return;
  const t0 = actx.currentTime + start;
  const osc = actx.createOscillator();
  const g = actx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(actx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

function bell(freq, start, gain = 0.35) {
  tone(freq, start, 1.6, { gain, attack: 0.005 });
  tone(freq * 2.01, start, 0.9, { gain: gain * 0.35, attack: 0.005 });
  tone(freq * 3.02, start, 0.5, { gain: gain * 0.15, attack: 0.005 });
}

export const sounds = {
  levelUp() {
    // ascending three-bell fanfare, played twice
    [0, 1.1].forEach((o) => {
      bell(659, o + 0.0);
      bell(784, o + 0.18);
      bell(1047, o + 0.36, 0.4);
    });
  },
  warning() {
    bell(880, 0, 0.22);
    bell(880, 0.45, 0.22);
  },
  breakStart() {
    bell(523, 0, 0.3);
    bell(659, 0.25, 0.3);
    bell(784, 0.5, 0.3);
    bell(659, 0.75, 0.25);
  },
  tick(last = false) {
    tone(last ? 1600 : 1200, 0, 0.08, { type: "square", gain: last ? 0.18 : 0.1, attack: 0.002 });
  },
  buzzer() {
    tone(110, 0, 1.2, { type: "sawtooth", gain: 0.3, attack: 0.01 });
    tone(116, 0, 1.2, { type: "sawtooth", gain: 0.25, attack: 0.01 });
  },
  clockCalled() {
    tone(392, 0, 0.25, { type: "triangle", gain: 0.3 });
    tone(392, 0.3, 0.25, { type: "triangle", gain: 0.3 });
    tone(523, 0.6, 0.5, { type: "triangle", gain: 0.35 });
  },
};

// ---------------------------------------------------------------- announcer
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

let chosenVoice = null;
function voice() {
  if (chosenVoice) return chosenVoice;
  const voices = speechSynthesis.getVoices().filter((v) => v.lang && v.lang.startsWith("en"));
  chosenVoice =
    voices.find((v) => /Daniel|Google UK English Male|Alex|Aaron|Guy|Davis/i.test(v.name)) ||
    voices.find((v) => v.lang === "en-US") ||
    voices[0] ||
    null;
  return chosenVoice;
}
if ("speechSynthesis" in window) speechSynthesis.onvoiceschanged = () => { chosenVoice = null; };

export function say(text, { delay = 0 } = {}) {
  if (!("speechSynthesis" in window) || !text) return;
  setTimeout(() => {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const v = voice();
    if (v) u.voice = v;
    u.rate = 0.98;
    u.pitch = 0.95;
    speechSynthesis.speak(u);
  }, delay);
}

const spoken = (n) => fmtNum(n);
const blindsSpoken = (l) =>
  `${spoken(l.sb)}, ${spoken(l.bb)}` + (l.ante ? `, with an ante of ${spoken(l.ante)}` : "");

const TRASH = {
  levelUp: [
    (n, l) => `Level ${n}. Blinds are now ${blindsSpoken(l)}. Short stacks, it's time to make some decisions.`,
    (n, l) => `Blinds just went up to ${blindsSpoken(l)}. If you were waiting for aces, I have bad news.`,
    (n, l) => `Level ${n}. ${blindsSpoken(l)}. The blinds are coming for you. Every. Single. Orbit.`,
    (n, l) => `New level. ${blindsSpoken(l)}. Whoever keeps limping, this one's for you.`,
    (n, l) => `Level ${n}, blinds ${blindsSpoken(l)}. Remember, folding is also a strategy. Not a fun one, but a strategy.`,
    (n, l) => `Attention table. Blinds are now ${blindsSpoken(l)}. Your stack just got smaller without you doing anything. Congratulations.`,
  ],
  breakStart: [
    (m) => `We're on a ${m} minute break. Go refill your drink and rethink your life choices.`,
    (m) => `Break time. ${m} minutes. Nobody touch the chips. Yes, I'm talking to you.`,
    (m) => `${m} minute break. Perfect time to tell everyone about that bad beat. They definitely want to hear it.`,
  ],
  warning: [
    () => `One minute left in this level. Steal those blinds while they're cheap.`,
    () => `Sixty seconds until the blinds go up. Tick tock.`,
    () => `One minute warning. Whatever you're planning, plan faster.`,
  ],
  clock: [
    (who) => `${who ? who + " has" : "Someone has"} called the clock. Thirty seconds. Make a decision, Hamlet.`,
    (who) => `Clock is on. ${who ? who + " is" : "The table is"} tired of waiting. Thirty seconds.`,
    (who) => `The clock has been called. It's poker, not chess. Thirty seconds.`,
  ],
  time: [() => `Time! Your hand is dead.`, () => `Time! That's what happens when you tank.`],
  finished: [() => `That's the last level on the clock. Somebody please win already.`],
};

export function announce(mode, kind, data = {}) {
  if (mode === "off") return;
  let text = "";
  const trash = mode === "trash";
  switch (kind) {
    case "levelUp":
      text = trash
        ? pick(TRASH.levelUp)(data.n, data.level)
        : `Level ${data.n}. Blinds are now ${blindsSpoken(data.level)}.`;
      if (data.afterBreak) text = (trash ? "Break's over. Back to your seats. " : "The break is over. ") + text;
      break;
    case "breakStart":
      text = trash ? pick(TRASH.breakStart)(data.min) : `We are now on a ${data.min} minute break.`;
      break;
    case "warning":
      text = trash ? pick(TRASH.warning)() : `One minute remaining in this level.`;
      if (data.seconds && data.seconds !== 60) text = trash ? `${data.seconds} seconds until the blinds go up. Tick tock.` : `${data.seconds} seconds remaining in this level.`;
      break;
    case "clock":
      text = trash
        ? pick(TRASH.clock)(data.by).replace("Thirty seconds", `${data.seconds} seconds`)
        : `${data.by ? data.by + " has called the clock" : "The clock has been called"}. ${data.seconds} seconds.`;
      break;
    case "time":
      text = trash ? pick(TRASH.time)() : "Time.";
      break;
    case "finished":
      text = trash ? pick(TRASH.finished)() : "That was the final level in the structure.";
      break;
  }
  say(text, { delay: data.delay || 0 });
}

// ---------------------------------------------------------------- QR
export function qrSvg(text, { dark = "#0b0f0d", light = "#ffffff" } = {}) {
  const qr = window.qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const pad = 2;
  let path = "";
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) if (qr.isDark(r, c)) path += `M${c + pad},${r + pad}h1v1h-1z`;
  const size = n + pad * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="${light}"/><path d="${path}" fill="${dark}"/></svg>`;
}

// ---------------------------------------------------------------- structure editor
export function mountEditor(root, getLevels, onSave) {
  let levels = JSON.parse(JSON.stringify(getLevels()));
  let dirty = false;

  const render = () => {
    const rows = levels
      .map((l, i) => {
        const n = levelNumber(levels, i);
        if (l.brk) {
          return `<div class="lv-row is-break" data-i="${i}">
            <span class="lv-num">☕</span>
            <span class="lv-break-label">Break</span>
            <label class="lv-field lv-min"><input inputmode="numeric" data-f="min" value="${l.min}"><span>min</span></label>
            <span class="lv-actions"><button data-a="up" title="Move up" aria-label="Move up">↑</button><button data-a="del" title="Delete" aria-label="Delete">✕</button></span>
          </div>`;
        }
        return `<div class="lv-row" data-i="${i}">
          <span class="lv-num">${n}</span>
          <label class="lv-field"><span>SB</span><input inputmode="numeric" data-f="sb" value="${l.sb}"></label>
          <label class="lv-field"><span>BB</span><input inputmode="numeric" data-f="bb" value="${l.bb}"></label>
          <label class="lv-field"><span>Ante</span><input inputmode="numeric" data-f="ante" value="${l.ante || 0}"></label>
          <label class="lv-field lv-min"><input inputmode="numeric" data-f="min" value="${l.min}"><span>min</span></label>
          <span class="lv-actions"><button data-a="up" title="Move up" aria-label="Move up">↑</button><button data-a="del" title="Delete" aria-label="Delete">✕</button></span>
        </div>`;
      })
      .join("");

    root.innerHTML = `
      <div class="ed-tools">
        <label class="ed-preset">Start from
          <select data-x="preset">
            <option value="">Choose a preset…</option>
            ${Object.entries(PRESETS).map(([k, p]) => `<option value="${k}">${p.name}</option>`).join("")}
          </select>
        </label>
        <div class="ed-all">
          <span>Every level</span>
          <input inputmode="numeric" data-x="allmin" placeholder="20" aria-label="Minutes for every level">
          <span>min</span>
          <button class="btn btn-small" data-x="applyall">Apply</button>
        </div>
      </div>
      <div class="ed-summary">${totalLevels(levels)} levels · ${levels.filter((l) => l.brk).length} breaks · about ${(levels.reduce((a, l) => a + l.min, 0) / 60).toFixed(1)} hrs total</div>
      <div class="lv-list">${rows}</div>
      <div class="ed-add">
        <button class="btn btn-small" data-x="addlevel">+ Level</button>
        <button class="btn btn-small" data-x="addbreak">+ Break</button>
      </div>
      <div class="ed-save ${dirty ? "is-dirty" : ""}">
        <button class="btn btn-primary" data-x="save" ${dirty ? "" : "disabled"}>${dirty ? "Save structure" : "Saved"}</button>
        ${dirty ? `<button class="btn btn-ghost" data-x="revert">Discard changes</button>` : ""}
      </div>`;
  };

  const markDirty = () => {
    dirty = true;
    const b = root.querySelector('[data-x="save"]');
    if (b) { b.disabled = false; b.textContent = "Save structure"; b.parentElement.classList.add("is-dirty"); }
  };

  root.addEventListener("input", (e) => {
    const f = e.target.dataset.f;
    if (!f) return;
    const i = +e.target.closest(".lv-row").dataset.i;
    levels[i][f] = Number(String(e.target.value).replace(/[^\d]/g, "")) || 0;
    markDirty();
  });

  root.addEventListener("change", (e) => {
    if (e.target.dataset.x === "preset" && e.target.value) {
      levels = JSON.parse(JSON.stringify(PRESETS[e.target.value].levels));
      dirty = true;
      render();
    }
  });

  root.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const row = btn.closest(".lv-row");
    if (row) {
      const i = +row.dataset.i;
      if (btn.dataset.a === "del" && levels.length > 1) levels.splice(i, 1);
      if (btn.dataset.a === "up" && i > 0) [levels[i - 1], levels[i]] = [levels[i], levels[i - 1]];
      dirty = true;
      render();
      return;
    }
    switch (btn.dataset.x) {
      case "applyall": {
        const v = Number(root.querySelector('[data-x="allmin"]').value);
        if (v >= 1) { levels.forEach((l) => { if (!l.brk) l.min = Math.min(240, Math.round(v)); }); dirty = true; render(); }
        break;
      }
      case "addlevel": {
        const last = [...levels].reverse().find((l) => !l.brk) || { sb: 25, bb: 50, ante: 0, min: 20 };
        levels.push({ sb: last.bb, bb: last.bb * 2, ante: last.ante ? last.bb * 2 : 0, min: last.min });
        dirty = true;
        render();
        break;
      }
      case "addbreak":
        levels.push({ brk: true, min: 10 });
        dirty = true;
        render();
        break;
      case "save":
        onSave(levels);
        dirty = false;
        render();
        break;
      case "revert":
        levels = JSON.parse(JSON.stringify(getLevels()));
        dirty = false;
        render();
        break;
    }
  });

  render();
  return {
    // refresh from server unless the user is mid-edit
    refresh() {
      if (!dirty) { levels = JSON.parse(JSON.stringify(getLevels())); render(); }
    },
  };
}

// ---------------------------------------------------------------- settings panel
export function mountSettings(root, getSettings, send, { onTestSound } = {}) {
  const render = () => {
    const s = getSettings();
    const seg = (key, opts) =>
      `<span class="seg" data-key="${key}">${opts
        .map(([v, label]) => `<button data-v="${v}" class="${String(s[key]) === String(v) ? "on" : ""}">${label}</button>`)
        .join("")}</span>`;
    root.innerHTML = `
      <div class="field"><label for="st-title">Game title</label><input type="text" id="st-title" maxlength="40" value="${(s.title || "").replace(/"/g, "&quot;")}"></div>
      <div class="field"><label>Announcer voice</label>${seg("announcer", [["pro", "Pro"], ["trash", "Trash talk"], ["off", "Off"]])}</div>
      <div class="field"><label>Warning before blinds go up</label>${seg("warnSeconds", [[0, "Off"], [30, "30s"], [60, "1m"], [120, "2m"]])}</div>
      <div class="field"><label>Call the Clock length</label>${seg("shotSeconds", [[20, "20s"], [30, "30s"], [45, "45s"], [60, "60s"]])}</div>
      ${onTestSound ? `<div class="field"><label>Test sound + voice</label><button class="btn btn-small" data-test>Play test</button></div>` : ""}
      <p class="hint" style="margin-top:14px">Sound and voice play on the main clock screen. Turn your TV or laptop volume up.</p>`;
  };
  root.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.hasAttribute("data-test")) return onTestSound && onTestSound();
    const seg = b.closest(".seg");
    if (seg) {
      const key = seg.dataset.key;
      const v = key === "announcer" ? b.dataset.v : Number(b.dataset.v);
      send("setSettings", { settings: { [key]: v } });
      seg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    }
  });
  root.addEventListener("change", (e) => {
    if (e.target.id === "st-title") send("setSettings", { settings: { title: e.target.value } });
  });
  render();
  return {
    refresh() {
      if (!root.contains(document.activeElement) || document.activeElement.tagName !== "INPUT") render();
    },
  };
}

// ---------------------------------------------------------------- misc
export async function keepAwake() {
  try {
    if ("wakeLock" in navigator) {
      let lock = await navigator.wakeLock.request("screen");
      document.addEventListener("visibilitychange", async () => {
        if (document.visibilityState === "visible") {
          try { lock = await navigator.wakeLock.request("screen"); } catch {}
        }
      });
      return true;
    }
  } catch {}
  return false;
}

export function codeFromPath() {
  const m = location.pathname.match(/\/(?:d|r)\/([A-Za-z]{2,12}-[A-Za-z]{2,12})/);
  return m ? m[1].toLowerCase() : null;
}

export function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {}
  return null;
}
