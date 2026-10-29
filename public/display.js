import {
  RoomConnection, fmtClock, fmtNum, remainingMs, blindsText, timeToBreak, nextPlayingLevel,
  levelNumber, totalLevels, audioUnlock, sounds, announce, qrSvg, mountEditor, mountSettings,
  keepAwake, codeFromPath, store, generateStructure, describeStructure,
} from "/app.js";

const $ = (id) => document.getElementById(id);
const code = codeFromPath();
const hostKey = store(`pc:host:${code}`);
const isHost = !!hostKey;

let state = null;
let conn = null;
let started = false; // user has clicked the start overlay (audio unlocked)
let warnedKey = null;
let lastShotTick = null;
let shotTimeUntil = 0;
let editor = null;
let settingsPanel = null;

// ------------------------------------------------------------ static setup
document.title = `Poker Clock · ${code}`;
$("joincode").textContent = code;
$("startcode").textContent = code;
const playerUrl = `${location.origin}/r/${code}`;
$("joinqr").innerHTML = qrSvg(playerUrl);
if (isHost) {
  const hostUrl = `${location.origin}/r/${code}#k=${hostKey}`;
  $("hostqr").innerHTML = qrSvg(hostUrl);
  $("setupqr").innerHTML = qrSvg(hostUrl);
  $("hostlink").textContent = hostUrl;
  $("controls").hidden = false;
  $("setupgrid").hidden = false;
  $("startmsg").textContent = "Turning on the clock enables sound and keeps this screen awake. The timer won't start until you press Start.";
} else {
  $("keyshint").hidden = true;
  $("startmsg").textContent = "This screen will follow the game. Click to turn on sound.";
}

// ------------------------------------------------------------ setup screen (host, before the game starts)
const setup = { startSb: 25, startBb: 50, levelMin: 20, breakAfter: 4, breakMin: 10 };
let setupLoaded = false;
let setupTouched = false;

const notStarted = (s) => s.levelIndex === 0 && !s.running && !s.finished && s.remainingMs === s.levels[0].min * 60000;

function loadSetup() {
  if (setupLoaded || !state || !isHost) return;
  setupLoaded = true;
  Object.assign(setup, describeStructure(state.levels));
  const fresh = notStarted(state);
  $("setupform").hidden = !fresh;
  $("setupinprogress").hidden = fresh;
  if (!fresh) $("startmsg").textContent = "Turning on the clock enables sound and keeps this screen awake.";
  const sel = $("su-break");
  if (![...sel.options].some((o) => +o.value === setup.breakAfter)) {
    sel.add(new Option(`After level ${setup.breakAfter}`, setup.breakAfter), sel.options[sel.options.length - 1]);
  }
  paintSetup();
}

function paintSetup() {
  $("su-min").value = setup.levelMin;
  $("su-sb").value = setup.startSb;
  $("su-bb").value = setup.startBb;
  $("su-break").value = String(setup.breakAfter);
  $("su-minseg").querySelectorAll("button").forEach((b) => b.classList.toggle("on", +b.dataset.v === setup.levelMin));
  $("su-blindseg").querySelectorAll("button").forEach((b) =>
    b.classList.toggle("on", +b.dataset.sb === setup.startSb && +b.dataset.bb === setup.startBb));
  const hm = (min) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;
  $("su-breaknote").textContent = setup.breakAfter ? `starts ${hm(setup.breakAfter * setup.levelMin)} into the game` : "";

  const levels = generateStructure(setup);
  const play = levels.filter((l) => !l.brk);
  const at = (n) => play[Math.min(n, play.length) - 1];
  const totalMin = levels.reduce((a, l) => a + l.min, 0);
  $("su-preview").innerHTML =
    `Level 1 <b>${blindsText(at(1))}</b> → level 4 <b>${blindsText(at(4))}</b> → level 8 <b>${blindsText(at(8))}</b> → level 12 <b>${blindsText(at(12))}</b><br>` +
    `${play.length} levels${setup.breakAfter ? `, ${setup.breakMin}-minute breaks every ${setup.breakAfter} levels` : ", no breaks"} · about ${(totalMin / 60).toFixed(1)} hours if it runs to the end.`;
}

function touch() { setupTouched = true; paintSetup(); }

$("su-minseg").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  setup.levelMin = +b.dataset.v; touch();
});
$("su-min").addEventListener("input", (e) => {
  const v = Math.round(+e.target.value.replace(/\D/g, ""));
  if (v >= 1 && v <= 240) { setup.levelMin = v; setupTouched = true; paintSetupKeepFocus(); }
});
$("su-break").addEventListener("change", (e) => { setup.breakAfter = +e.target.value; touch(); });
$("su-blindseg").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  setup.startSb = +b.dataset.sb; setup.startBb = +b.dataset.bb; touch();
});
for (const id of ["su-sb", "su-bb"]) {
  $(id).addEventListener("input", () => {
    const sb = Math.round(+$("su-sb").value.replace(/\D/g, ""));
    const bb = Math.round(+$("su-bb").value.replace(/\D/g, ""));
    if (sb >= 1 && bb > sb) { setup.startSb = sb; setup.startBb = bb; setupTouched = true; paintSetupKeepFocus(); }
  });
}
// repaint everything except the field being typed in
function paintSetupKeepFocus() {
  const active = document.activeElement;
  const val = active && active.value;
  paintSetup();
  if (active && active.tagName === "INPUT") active.value = val;
}

$("startbtn").addEventListener("click", async () => {
  audioUnlock();
  if (isHost && setupTouched && state && notStarted(state)) {
    conn.send("setStructure", { levels: generateStructure(setup) });
  }
  started = true;
  $("start").hidden = true;
  keepAwake();
  try { await document.documentElement.requestFullscreen?.(); } catch {}
});

// ------------------------------------------------------------ connection
conn = new RoomConnection(code, hostKey, onMessage, (status) => {
  if (status === "missing") { $("missing").hidden = false; $("start").hidden = true; return; }
  $("status").classList.toggle("show", status === "offline" || (status === "connecting" && !!state));
});

function onMessage(msg) {
  const prev = state;
  state = msg.state;
  loadSetup();
  if (isHost && !editor) {
    editor = mountEditor($("editor"), () => state.levels, (levels) => conn.send("setStructure", { levels }));
    settingsPanel = mountSettings($("settings"), () => state.settings, (cmd, x) => conn.send(cmd, x), {
      onTestSound: () => { audioUnlock(); sounds.levelUp(); announce(state.settings.announcer, "levelUp", { n: 1, level: { sb: 100, bb: 200, ante: 0 }, delay: 2200 }); },
    });
  } else if (editor) {
    if (msg.event === "structure" || msg.event === "reset") editor.refresh();
    if (msg.event === "settings") settingsPanel.refresh();
  }
  handleEvent(msg.event, prev);
  render(true);
}

// ------------------------------------------------------------ events → sound + voice
function handleEvent(event, prev) {
  if (!started || !event) return;
  const s = state;
  const mode = s.settings.announcer;
  const lvl = s.levels[s.levelIndex];

  if (event === "levelUp") {
    const wasBreak = prev && prev.levels[prev.levelIndex]?.brk;
    if (lvl.brk) {
      sounds.breakStart();
      announce(mode, "breakStart", { min: lvl.min, delay: 1400 });
    } else {
      sounds.levelUp();
      announce(mode, "levelUp", { n: levelNumber(s.levels, s.levelIndex), level: lvl, afterBreak: wasBreak, delay: 2300 });
    }
  } else if (event === "levelBack") {
    if (!lvl.brk) announce(mode, "levelUp", { n: levelNumber(s.levels, s.levelIndex), level: lvl });
  } else if (event === "finished") {
    sounds.buzzer();
    announce(mode, "finished", { delay: 1300 });
  } else if (event === "shotStart") {
    sounds.clockCalled();
    announce(mode, "clock", { by: s.shot?.by, seconds: s.settings.shotSeconds, delay: 900 });
  } else if (event === "shotEnd") {
    shotTimeUntil = Date.now() + 3500;
    sounds.buzzer();
    announce(mode, "time", { delay: 900 });
  }
}

// ------------------------------------------------------------ render loop
const cache = {};
function set(id, text) {
  if (cache[id] !== text) { cache[id] = text; $(id).textContent = text; }
}

function render(force) {
  if (!state) return;
  const s = state;
  const now = conn.serverNow();
  const lvl = s.levels[s.levelIndex];
  const rem = remainingMs(s, now);
  const isBreak = !!lvl.brk;
  const warnMs = (s.settings.warnSeconds || 0) * 1000;
  const warning = s.running && !isBreak && warnMs > 0 && rem <= warnMs;

  const d = $("display");
  d.classList.toggle("is-paused", !s.running);
  d.classList.toggle("is-break", isBreak);
  d.classList.toggle("is-warning", warning);
  d.classList.toggle("is-final10", s.running && rem <= 10000 && !isBreak);

  set("title", s.settings.title);
  set("level", isBreak ? "Break" : `Level ${levelNumber(s.levels, s.levelIndex)} of ${totalLevels(s.levels)}`);
  set("clock", fmtClock(rem));
  set("badge", s.finished ? "Structure complete" : !s.running ? (s.levelStartedAt && rem < lvl.min * 60000 ? "Paused" : "Ready") : isBreak ? "On break" : "");
  set("blindslabel", isBreak ? "Next up" : "Blinds");

  if (isBreak) {
    const nx = nextPlayingLevel(s.levels, s.levelIndex);
    set("blinds", nx ? blindsText(nx.level) : "Break");
    set("ante", nx && nx.level.ante ? `Ante ${fmtNum(nx.level.ante)}` : "");
  } else {
    set("blinds", blindsText(lvl));
    set("ante", lvl.ante ? `Ante ${fmtNum(lvl.ante)}` : "");
  }

  const pct = lvl.min ? Math.min(100, Math.max(0, (1 - rem / (lvl.min * 60000)) * 100)) : 0;
  const pctStr = pct.toFixed(1) + "%";
  if (cache.pct !== pctStr) { cache.pct = pctStr; $("progress").style.width = pctStr; }

  // footer
  const after = s.levels[s.levelIndex + 1];
  if (!after) set("next", "—");
  else if (after.brk) set("next", `Break · ${after.min} min`);
  else set("next", `${blindsText(after)}${after.ante ? ` · A ${fmtNum(after.ante)}` : ""}`);
  const tb = timeToBreak(s, now);
  set("nextbreak", isBreak ? "Now" : tb == null ? "—" : fmtClock(tb));
  set("now", new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));

  // play button label
  if (isHost) set("playbtn", s.running ? "Pause" : "Start");

  // one-minute warning (fires once per level, only when crossing the threshold live)
  const key = `${s.levelIndex}:${s.levelStartedAt}`;
  if (started && warning && warnedKey !== key && rem > warnMs - 3000 && rem > 2000) {
    warnedKey = key;
    sounds.warning();
    announce(s.settings.announcer, "warning", { seconds: s.settings.warnSeconds, delay: 900 });
  }

  renderShot(now);
}

function renderShot(now) {
  const s = state;
  const el = $("shot");
  const active = s.shot && s.shot.endsAt > now;
  const showTime = !active && Date.now() < shotTimeUntil;
  el.hidden = !(active || showTime);
  if (el.hidden) { lastShotTick = null; return; }

  $("shotcancel").hidden = !isHost || !active;
  if (active) {
    const secs = Math.max(0, Math.ceil((s.shot.endsAt - now) / 1000));
    set("shotnum", String(secs));
    set("shotlabel", "Clock called");
    set("shotby", s.shot.by ? `by ${s.shot.by}` : "");
    el.classList.toggle("is-low", secs <= 10);
    el.classList.remove("is-time");
    if (started && secs <= 10 && secs > 0 && lastShotTick !== secs) {
      lastShotTick = secs;
      sounds.tick(secs <= 3);
    }
  } else {
    set("shotnum", "TIME!");
    set("shotlabel", "");
    set("shotby", "");
    el.classList.add("is-time");
    el.classList.remove("is-low");
  }
  const lvl = s.levels[s.levelIndex];
  set("shotbg", `${lvl.brk ? "Break" : "Blinds " + blindsText(lvl)} · ${fmtClock(remainingMs(s, now))} left in level`);
}

setInterval(() => render(false), 200);

// ------------------------------------------------------------ host controls
function command(c) {
  if (!state) return;
  switch (c) {
    case "toggle": conn.send(state.running ? "pause" : "start"); break;
    case "plus": conn.send("addTime", { ms: 60000 }); break;
    case "minus": conn.send("addTime", { ms: -60000 }); break;
    case "drawer": $("drawer").classList.toggle("open"); break;
    case "callClock": conn.send("callClock", { name: "" }); break;
    default: conn.send(c);
  }
}

$("controls").addEventListener("click", (e) => {
  const b = e.target.closest("[data-cmd]");
  if (b && isHost) command(b.dataset.cmd);
});
$("drawerclose").addEventListener("click", () => $("drawer").classList.remove("open"));
$("shotcancel").addEventListener("click", () => conn.send("cancelClock"));

$("dtabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-t]");
  if (!b) return;
  $("dtabs").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
  document.querySelectorAll("[data-p]").forEach((p) => (p.hidden = p.dataset.p !== b.dataset.t));
});

document.addEventListener("keydown", (e) => {
  if (!isHost || e.target.closest("input, select, textarea")) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const map = { " ": "toggle", ArrowRight: "next", ArrowLeft: "prev", ArrowUp: "plus", ArrowDown: "minus", c: "callClock", C: "callClock", s: "drawer", S: "drawer" };
  if (e.key === "f" || e.key === "F") {
    e.preventDefault();
    if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.();
    return;
  }
  if (e.key === "Escape") { $("drawer").classList.remove("open"); return; }
  if (map[e.key]) { e.preventDefault(); command(map[e.key]); }
});

// hide the cursor + controls when idle
let idleTimer;
document.addEventListener("mousemove", () => {
  document.body.style.cursor = "";
  $("display").classList.add("is-idle-show");
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    $("display").classList.remove("is-idle-show");
    if (!$("drawer").classList.contains("open")) document.body.style.cursor = "none";
  }, 3000);
});
