import {
  RoomConnection, fmtClock, fmtNum, remainingMs, blindsText, timeToBreak, nextPlayingLevel,
  levelNumber, totalLevels, mountEditor, mountSettings, codeFromPath, store,
} from "/app.js";

const $ = (id) => document.getElementById(id);
const code = codeFromPath();

// A host link carries the key in the URL fragment (#k=...). Save it and strip it from the address bar.
const hashKey = new URLSearchParams(location.hash.slice(1)).get("k");
if (hashKey) {
  store(`pc:host:${code}`, hashKey);
  history.replaceState(null, "", location.pathname);
}
const hostKey = store(`pc:host:${code}`);

let state = null;
let role = "player";
let editor = null;
let settingsPanel = null;

$("room").textContent = code;
$("displaylink").textContent = `${location.host}/d/${code}`;
$("name").value = store("pc:name") || "";
$("name").addEventListener("input", () => store("pc:name", $("name").value.trim()));

const conn = new RoomConnection(code, hostKey, onMessage, (status) => {
  if (status === "missing") { $("missing").hidden = false; return; }
  $("dot").className = `r-dot ${status === "online" ? "online" : status === "offline" ? "offline" : ""}`;
});

function onMessage(msg) {
  const prev = state;
  state = msg.state;
  if (msg.role !== role || !prev) setRole(msg.role);
  if (editor && (msg.event === "structure" || msg.event === "reset")) editor.refresh();
  if (settingsPanel && msg.event === "settings") settingsPanel.refresh();
  if (msg.event === "levelUp" && navigator.vibrate) navigator.vibrate([120, 80, 120]);
  if (msg.event === "shotStart" && navigator.vibrate) navigator.vibrate(200);
  render();
}

function setRole(r) {
  role = r;
  const host = r === "host";
  $("role").textContent = host ? "Host" : "Player";
  $("role").classList.toggle("host", host);
  $("tabs").hidden = !host;
  $("hostcontrols").hidden = !host;
  $("namebox").hidden = host;
  if (host && !editor) {
    editor = mountEditor($("editor"), () => state.levels, (levels) => { conn.send("setStructure", { levels }); toast("Blind structure saved"); });
    settingsPanel = mountSettings($("settings"), () => state.settings, (cmd, x) => conn.send(cmd, x));
  }
  if (!host && hostKey) toast("That host link didn't match this game. You're joined as a player.");
}

const cache = {};
function set(id, text) {
  if (cache[id] !== text) { cache[id] = text; $(id).textContent = text; }
}

function render() {
  if (!state) return;
  const s = state;
  const now = conn.serverNow();
  const lvl = s.levels[s.levelIndex];
  const isBreak = !!lvl.brk;
  const rem = remainingMs(s, now);
  const warnMs = (s.settings.warnSeconds || 0) * 1000;

  const card = $("card");
  card.classList.toggle("is-paused", !s.running);
  card.classList.toggle("is-break", isBreak);
  card.classList.toggle("is-warning", s.running && !isBreak && warnMs > 0 && rem <= warnMs);

  set("level", isBreak ? "Break" : `Level ${levelNumber(s.levels, s.levelIndex)} of ${totalLevels(s.levels)}`);
  set("clock", fmtClock(rem));
  set("paused", s.finished ? "Structure complete" : s.running ? "" : "Paused");
  if (isBreak) {
    const nx = nextPlayingLevel(s.levels, s.levelIndex);
    set("blinds", nx ? `Next ${blindsText(nx.level)}` : "Break");
    set("ante", "");
  } else {
    set("blinds", blindsText(lvl));
    set("ante", lvl.ante ? `Ante ${fmtNum(lvl.ante)}` : "");
  }
  const after = s.levels[s.levelIndex + 1];
  set("next", !after ? "—" : after.brk ? `Break ${after.min}m` : blindsText(after));
  const tb = timeToBreak(s, now);
  set("nextbreak", isBreak ? "Now" : tb == null ? "—" : fmtClock(tb));
  set("toggle", s.running ? "Pause" : s.finished ? "Finished" : "Start");
  $("toggle").classList.toggle("btn-primary", !s.running);

  // shot clock
  const active = s.shot && s.shot.endsAt > now;
  $("shotlive").hidden = !active;
  $("callclock").disabled = !!active;
  $("shotcancel").hidden = !(active && role === "host");
  if (active) {
    set("shotnum", String(Math.max(0, Math.ceil((s.shot.endsAt - now) / 1000))));
    set("shotlbl", s.shot.by ? `Clock called by ${s.shot.by}` : "Clock called");
  }
}
setInterval(render, 200);

// ------------------------------------------------------------ actions
$("toggle").addEventListener("click", () => {
  if (!state || state.finished) return;
  send(state.running ? "pause" : "start");
});

document.querySelector("#hostcontrols .r-grid").addEventListener("click", (e) => {
  const b = e.target.closest("[data-cmd]");
  if (!b) return;
  const c = b.dataset.cmd;
  if (c === "plus") return send("addTime", { ms: 60000 });
  if (c === "minus") return send("addTime", { ms: -60000 });
  if (c === "reset" && !confirm("Reset the game back to level 1 and pause the clock?")) return;
  send(c);
});

$("callclock").addEventListener("click", () => {
  send("callClock", { name: role === "host" ? "" : $("name").value.trim() });
});
$("shotcancel").addEventListener("click", () => send("cancelClock"));

$("tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-t]");
  if (!b) return;
  $("tabs").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
  document.querySelectorAll(".r-pane").forEach((p) => (p.hidden = p.dataset.p !== b.dataset.t));
});

function send(cmd, extra) {
  if (!conn.send(cmd, extra)) toast("Not connected. Reconnecting…");
}

let toastTimer;
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}
