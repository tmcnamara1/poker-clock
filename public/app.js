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

// Voice presets: each is a priority list of name patterns + tuning options.
// The browser picks whichever installed voice matches first.
export const VOICE_PRESETS = [
  {
    id: "auto",
    label: "Auto",
    patterns: [/Daniel|Google UK English Male|Alex|Aaron|Guy|Davis/i],
    lang: "en-US",
    rate: 0.98, pitch: 0.95,
  },
  {
    id: "deep",
    label: "Deep & Slow",
    patterns: [/Google UK English Male|Daniel|Alex|Aaron|Guy|Davis|Fred|Bruce/i],
    lang: "en-US",
    rate: 0.82, pitch: 0.7,
  },
  {
    id: "fast",
    label: "Fast & Energetic",
    patterns: [/Google US English|Samantha|Karen|Zira|Aria/i],
    lang: "en-US",
    rate: 1.18, pitch: 1.1,
  },
  {
    id: "british",
    label: "British",
    patterns: [/Daniel|Google UK English Male|Google UK English Female|Kate|Serena|Oliver/i],
    lang: "en-GB",
    rate: 0.95, pitch: 1.0,
  },
  {
    id: "woman",
    label: "Woman",
    patterns: [/Samantha|Karen|Google US English Female|Zira|Aria|Ava|Victoria|Allison|Susan|Nicky/i],
    lang: "en-US",
    rate: 1.0, pitch: 1.15,
  },
];

let _voicePresetId = null;
try { _voicePresetId = localStorage.getItem("pc:voicePreset") || "auto"; } catch {}

export function getVoicePresetId() { return _voicePresetId || "auto"; }
export function setVoicePresetId(id) {
  _voicePresetId = id;
  try { localStorage.setItem("pc:voicePreset", id); } catch {}
}

function resolveVoice() {
  const preset = VOICE_PRESETS.find(p => p.id === _voicePresetId) || VOICE_PRESETS[0];
  const all = ("speechSynthesis" in window) ? speechSynthesis.getVoices().filter(v => v.lang && v.lang.startsWith("en")) : [];
  let match = null;
  for (const pat of preset.patterns) {
    match = all.find(v => pat.test(v.name));
    if (match) break;
  }
  if (!match) match = all.find(v => v.lang === (preset.lang || "en-US")) || all[0] || null;
  return { voice: match, rate: preset.rate, pitch: preset.pitch };
}

if ("speechSynthesis" in window) speechSynthesis.onvoiceschanged = () => {};

export function say(text, { delay = 0 } = {}) {
  if (!("speechSynthesis" in window) || !text) return;
  setTimeout(() => {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const { voice, rate, pitch } = resolveVoice();
    if (voice) u.voice = voice;
    u.rate = rate;
    u.pitch = pitch;
    speechSynthesis.speak(u);
  }, delay);
}

// ---------------------------------------------------------------- countdown lines
const COUNTDOWN_TRASH = {
  30: [
    () => "Thirty seconds. Tick tock, motherfucker.",
    () => "Thirty seconds left. I suggest you think fast.",
    () => "Thirty seconds until the blinds eat you alive.",
    () => "Half a minute. Whatever you're holding, it won't save you.",
    () => "Thirty seconds. Say what again. SAY what again.",
    () => "Half a minute. Does he look like a bitch? Do you? Then act like it and fold.",
    () => "Thirty seconds left. English, motherfucker — do you speak it? Then use it. Play.",
  ],
  20: [
    () => "Twenty seconds. You better pray to whatever god you believe in.",
    () => "Twenty seconds, jackass. Move it.",
    () => "Twenty seconds left. If you don't have a plan, you are the plan.",
    () => "Twenty seconds. You feel that? That's the blinds breathing down your neck.",
    () => "Twenty seconds. The path of the righteous man is making a goddamn decision.",
    () => "Twenty seconds. I'm tired of these motherfucking tanks on this motherfucking table. MOVE.",
    () => "Twenty seconds. Hold onto your butts.",
    () => "Twenty seconds and I will strike down upon thee with great vengeance if you tank any longer.",
    () => "Twenty seconds. You in or you out? This isn't a philosophy seminar.",
  ],
  10: [
    () => "Ten seconds. English, do you speak it?",
    () => "Ten seconds. Figure it the hell out.",
    () => "Ten! Get some balls and play a hand.",
    () => "Ten seconds left. This is not a drill.",
    () => "Ten seconds. What's in your wallet? Because it won't be chips for long.",
    () => "Ten seconds. I have had it. PLAY.",
    () => "Ten seconds. Does not compute — just bet the damn thing.",
    () => "Ten seconds. You're a wizard, Harry — so do some fucking magic already.",
  ],
};

export function countdownLine(secs, mode) {
  if (mode === "trash" && COUNTDOWN_TRASH[secs]) {
    return pick(COUNTDOWN_TRASH[secs])();
  }
  if (secs <= 5) return String(secs);
  return `${secs} seconds`;
}

const spoken = (n) => fmtNum(n);
const blindsSpoken = (l) =>
  `${spoken(l.sb)}, ${spoken(l.bb)}` + (l.ante ? `, with an ante of ${spoken(l.ante)}` : "");

// ---------------------------------------------------------------- player roster
export const DEFAULT_PLAYERS = ["Scotty", "Eddie", "Bywater", "Pels", "Tmac", "Daniels", "Ty"];

// Per-player trash talk lines. Each array entry is a function so they read naturally.
// 'bust' fires when the player is eliminated.
// 'levelUp' fires (sometimes) when a new blind level starts and that player is still in.
// Add "Tmac" only gets praised — never insulted.
const PLAYER_LINES = {
  Scotty: {
    levelUp: [
      () => "Scotty, before you do it — that is NOT a good hand to shove with.",
      () => "Scotty sees the new blinds and immediately starts counting his chips to shove. We see you.",
      () => "New level, and somewhere Scotty is already reaching for his stack. Calm down.",
      () => "Scotty, I know what you're thinking. Don't. Just… don't.",
      () => "Every new level, Scotty gets that look in his eye. The 'I'm going all in on garbage' look.",
    ],
    bust: [
      () => "Scotty is out. He went all in. Of course he did. That's literally all he does.",
      () => "And Scotty has been eliminated. He pushed all his chips in and lost. SHOCKED. Absolutely shocked.",
      () => "Scotty is busted. He shoved again, they called, and that's the game for the most aggressive man at the table.",
    ],
  },
  Eddie: {
    levelUp: [
      () => "Eddie, statistically speaking, you are due for a win. Statistically. It hasn't happened yet, but mathematically…",
      () => "New level. Eddie still hasn't won a hand. The drought continues.",
      () => "Eddie is about to tell you about a bad beat. Brace yourselves.",
      () => "Eddie's here. Still trying. Still losing. Still complaining about it.",
      () => "New blinds. Eddie would like you to know that his last loss was absolutely not his fault.",
    ],
    bust: [
      () => "Eddie is out. And we can all expect a detailed breakdown of exactly why it wasn't his fault.",
      () => "Eddie has been eliminated. His bad beat story begins… now.",
      () => "Eddie busted. This will be talked about for the rest of the night. Probably the rest of the month.",
    ],
  },
  Bywater: {
    levelUp: [
      () => "Bywater has a message for the table. It's unprintable, but we all know what it is.",
      () => "New level. Bywater would like everyone to — and I quote — suck it.",
      () => "Bywater's poker strategy is simple: suck it.",
      () => "Bywater looking around the table with that look. You know the look. It says 'suck it.'",
      () => "Bywater's playing well. His commentary remains consistent. Two words. Classic.",
    ],
    bust: [
      () => "Bywater is out! He has one final message for the table. Everyone say it together: suck it.",
      () => "Bywater has been eliminated. His parting words are, as always, suck it.",
      () => "Bywater busted. He wants the winner to know: suck it.",
    ],
  },
  Pels: {
    levelUp: [
      () => "Pels, you doing okay over there? You seem very relaxed. Very, very relaxed.",
      () => "New level. Pels would like to know if anyone has any snacks.",
      () => "Pels is in a great mood. A suspiciously great mood.",
      () => "Pels is vibing. That's all we'll say about that.",
      () => "New blinds. Pels isn't stressed about it. Pels isn't stressed about anything.",
    ],
    bust: [
      () => "Pels is out. He seems fine with it. Very zen. Almost too zen.",
      () => "Pels has been eliminated and is handling it remarkably well. Suspiciously well.",
      () => "Pels busted. He's already forgotten it happened.",
    ],
  },
  Tmac: {
    levelUp: [
      () => "T-Mac is at the table, which means somebody is losing to greatness tonight.",
      () => "New level. T-Mac is still in. As expected. As it should be.",
      () => "T-Mac studies the new blinds, nods, and continues being the best player at this table.",
      () => "New blinds. T-Mac's chip stack remains magnificent.",
      () => "The blinds are up. T-Mac is unbothered. Champions don't sweat the small stuff.",
      () => "T-Mac with another level survived. This is a man who was simply built for this game.",
    ],
    bust: [
      // Tmac shouldn't bust, but just in case...
      () => "T-Mac has been eliminated, which means the deck cheated. There is no other explanation.",
      () => "T-Mac is out? T-MAC IS OUT? This game has been rigged. Alert the authorities.",
    ],
  },
  Daniels: {
    levelUp: [
      () => "Daniels, it's a new level. That means you have to actually play a hand eventually. This level, maybe.",
      () => "New blinds. Daniels has thoughts about this. Many, many thoughts he'd like to share with the group.",
      () => "Daniels is mid-sentence. He has been mid-sentence for the last four hands.",
      () => "New level. Daniels still hasn't decided what he's having for dinner, let alone what to do with his hand.",
      () => "Daniels would like everyone to know his opinion on something. Unfortunately, it's not poker-related.",
      () => "New blinds. Daniels is thinking. He's been thinking. He'll continue thinking until the clock runs out.",
      () => "Daniels. It's your turn. It has been your turn. It will be your turn for another four minutes apparently.",
    ],
    bust: [
      () => "Daniels is out. He spent so long deliberating that the blinds just ate him alive. Poetic.",
      () => "Daniels has been eliminated. We'd like to say it was quick, but nothing involving Daniels is quick.",
      () => "Daniels busted. He'd like to explain, in detail, the thought process behind every decision he made tonight. Clear your schedule.",
    ],
  },
  Ty: {
    levelUp: [
      () => "Ty is at the table, believing with his whole chest that he cannot lose. He can. He very much can.",
      () => "New level. Ty has entered his Superman arc. Someone's about to find the kryptonite.",
      () => "Ty looking at his cards like he already knows they're the best cards. They might not be, Ty.",
      () => "New blinds. Ty is unfazed, because Ty does not understand the concept of being fased.",
      () => "Ty. Buddy. You are not, in fact, Superman. This is a poker game. Please check in.",
      () => "New level. Ty thinks he's invincible. The table is about to run an experiment.",
    ],
    bust: [
      () => "Ty is out. Even Superman has a weakness, and apparently Ty's is bluffing with nothing.",
      () => "Ty has been eliminated. The Man of Steel has fallen. The kryptonite was a decent hand.",
      () => "Ty busted. It turns out you are not Superman, Ty. You were never Superman. We love you though.",
    ],
  },
};

// Returns lines for a specific player if they're in the active roster, or null
function playerLine(kind, name) {
  const p = PLAYER_LINES[name];
  if (!p || !p[kind] || !p[kind].length) return null;
  return pick(p[kind])();
}

// Sometimes (not always) fire a player-specific callout on level up
export function maybePlayerCallout(mode, activePlayers, busted) {
  if (mode === "off" || !activePlayers || !activePlayers.length) return;
  // 40% chance of a player-specific callout on level up
  if (Math.random() > 0.4) return;
  const eligible = activePlayers.filter(p => !busted?.includes(p) && PLAYER_LINES[p]?.levelUp?.length);
  if (!eligible.length) return;
  const name = pick(eligible);
  const line = playerLine("levelUp", name);
  if (line) say(line, { delay: 4500 }); // fires after the main level-up announcement
}

export function bustCallout(mode, name) {
  if (mode === "off") return;
  const line = playerLine("bust", name);
  if (line) say(line, { delay: 500 });
  else say(`${name} is out!`, { delay: 500 });
}

// ---------------------------------------------------------------- roster panel (host-only)
export function mountRoster(root, getState, sendFn) {
  // Load saved roster from localStorage
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem("pc:roster") || "[]"); } catch {}
  // Default: all players checked
  if (!saved.length) saved = [...DEFAULT_PLAYERS];

  const save = () => {
    try { localStorage.setItem("pc:roster", JSON.stringify(saved)); } catch {}
  };

  const render = () => {
    const s = getState();
    const busted = s?.busted || [];
    const active = s?.players?.map(p => p.name) || [];

    root.innerHTML = `
      <div class="roster-section">
        <div class="roster-header">
          <span class="roster-title">Who's playing tonight?</span>
          <button class="btn btn-small" data-roster-action="apply">Update table</button>
        </div>
        <div class="roster-checks">
          ${DEFAULT_PLAYERS.map(name => `
            <label class="roster-check${busted.includes(name) ? " is-busted" : ""}">
              <input type="checkbox" data-player="${name}" ${saved.includes(name) ? "checked" : ""} ${busted.includes(name) ? "disabled" : ""}>
              <span>${name}</span>
              ${busted.includes(name) ? '<span class="bust-badge">OUT</span>' : ""}
            </label>
          `).join("")}
        </div>
      </div>
      ${active.length ? `
      <div class="roster-section" style="margin-top:16px">
        <div class="roster-header"><span class="roster-title">Bust someone out</span></div>
        <div class="bust-list">
          ${active.filter(n => !busted.includes(n)).map(name => `
            <button class="btn btn-small btn-bust" data-bust="${name}">💀 ${name}</button>
          `).join("") || '<span style="opacity:0.5;font-size:0.9em">No active players — click Update table first.</span>'}
        </div>
      </div>` : ""}`;
  };

  root.addEventListener("change", (e) => {
    if (e.target.dataset.player) {
      const name = e.target.dataset.player;
      if (e.target.checked) { if (!saved.includes(name)) saved.push(name); }
      else saved = saved.filter(n => n !== name);
      save();
    }
  });

  root.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    if (btn.dataset.rosterAction === "apply") {
      sendFn("setPlayers", { players: saved.map(n => ({ name: n })) });
      return;
    }
    if (btn.dataset.bust) {
      sendFn("bustPlayer", { name: btn.dataset.bust });
    }
  });

  render();
  return { refresh: render };
}

const TRASH = {
  levelUp: [
    (n, l) => `Level ${n}. Blinds are now ${blindsSpoken(l)}. Short stacks, it's time to make some damn decisions.`,
    (n, l) => `Blinds just went up to ${blindsSpoken(l)}. If you were waiting for aces, you're screwed.`,
    (n, l) => `Level ${n}. ${blindsSpoken(l)}. The blinds are coming for you. Every. Single. Orbit.`,
    (n, l) => `New level. ${blindsSpoken(l)}. Whoever keeps limping in, this one's especially for you, you cheap bastard.`,
    (n, l) => `Level ${n}, blinds ${blindsSpoken(l)}. Folding is a strategy. It's YOUR strategy. And it's pathetic.`,
    (n, l) => `Attention table. Blinds are ${blindsSpoken(l)}. Your stack just got smaller without you doing a damn thing. Congratulations, idiot.`,
    (n, l) => `Level ${n}. ${blindsSpoken(l)}. If you haven't won a hand yet, maybe poker isn't your game. Try Go Fish.`,
    (n, l) => `Blinds up. ${blindsSpoken(l)}. For the love of god, somebody play a hand.`,
    (n, l) => `${blindsSpoken(l)} is the new normal. If your stack can't handle it, that's not a poker problem, that's a you problem.`,
    (n, l) => `Level ${n}. ${blindsSpoken(l)}. The small blind costs more than your dignity at this point.`,
    (n, l) => `Blinds are ${blindsSpoken(l)}. Stop slowplaying everything, you coward.`,
    (n, l) => `Level ${n}! ${blindsSpoken(l)}! Wake the hell up!`,
    (n, l) => `${blindsSpoken(l)}. If you folded every hand this level, do us all a favor and fold yourself out of the game.`,
    (n, l) => `Level ${n}. Blinds now ${blindsSpoken(l)}. The antes aren't the only thing bleeding you out tonight.`,
    (n, l) => `${blindsSpoken(l)}. Another level, another chance for you to make terrible decisions. Go for it.`,
  ],
  breakStart: [
    (m) => `${m} minute break. Go pee, get a drink, and rethink every bad call you just made.`,
    (m) => `Break time. ${m} minutes. Nobody touch the chips. You know who you are.`,
    (m) => `${m} minute break. Perfect time to tell everyone about that bad beat. They are absolutely dying to hear it.`,
    (m) => `Break. ${m} minutes. Use this time to find whatever shred of poker skill you left at home.`,
    (m) => `${m} minute break. Stretch your legs. Rest your brain. Lord knows it's tired from all those bad decisions.`,
  ],
  warning: [
    () => `One minute left. Steal those blinds before some other jackass does.`,
    () => `Sixty seconds until the blinds go up. What's your plan, genius?`,
    () => `One minute warning. Whatever stupid move you're planning, plan it faster.`,
    () => `Thirty seconds left in this level. Don't do anything dumber than you already have.`,
    () => `One minute. Tick tock, you indecisive son of a bitch.`,
    () => `One minute. You feel me? You FEEL me? The blinds. Are. COMING.`,
    () => `Sixty seconds. You know what they say about a man who can't make a decision? He goes home broke.`,
    () => `One minute warning. Get busy playing, or get busy busting out.`,
  ],
  clock: [
    (who) => `${who ? who + " has" : "Someone has"} called the clock. Thirty seconds. Make a decision, Hamlet.`,
    (who) => `Clock is on. ${who ? who + " is" : "The whole damn table is"} tired of waiting. Move it.`,
    (who) => `The clock has been called. It's poker, not a philosophical debate. Thirty seconds.`,
    (who) => `${who || "Someone"} called the clock. We're all waiting on you. No pressure. Actually, full pressure.`,
  ],
  time: [
    () => `Time! Your hand is dead. Just like your poker career.`,
    () => `Time! That's what happens when you tank for ten minutes on a two-dollar decision.`,
    () => `Time! Fold the damn cards already.`,
  ],
  finished: [
    () => `That's the last level on the clock. Somebody please win already so we can all go home.`,
    () => `Structure's done. If nobody's out yet, you're all playing scared and everyone knows it.`,
  ],
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

// ---------------------------------------------------------------- R-rated warning modal
function showTrashWarning(onConfirm) {
  const id = "trash-warning-modal";
  if (document.getElementById(id)) return;
  const modal = document.createElement("div");
  modal.id = id;
  modal.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;padding:20px";
  modal.innerHTML = `
    <div style="background:#1a1f1d;border:2px solid var(--gold,#c9a84c);border-radius:12px;padding:28px 32px;max-width:420px;text-align:center;color:#e8e0c8">
      <div style="font-size:2.2rem;margin-bottom:8px">🤬 R-RATED</div>
      <h2 style="margin:0 0 12px;color:var(--gold,#c9a84c);font-size:1.3rem">You're entering Shit Talk Mode</h2>
      <p style="margin:0 0 20px;line-height:1.6;font-size:0.95rem">This mode uses strong language, insults, and general jackassery. It's rude on purpose. This is just an app we use internally — don't take it personally. <b>Or do. That's on you.</b></p>
      <div style="display:flex;gap:12px;justify-content:center">
        <button id="trash-confirm" style="background:var(--gold,#c9a84c);color:#0b0f0d;border:none;padding:10px 24px;border-radius:6px;font-weight:700;font-size:1rem;cursor:pointer">I can handle it</button>
        <button id="trash-cancel" style="background:transparent;color:#e8e0c8;border:1px solid #555;padding:10px 24px;border-radius:6px;font-size:1rem;cursor:pointer">Never mind</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  document.getElementById("trash-confirm").onclick = () => { modal.remove(); onConfirm(true); };
  document.getElementById("trash-cancel").onclick = () => { modal.remove(); onConfirm(false); };
}

// ---------------------------------------------------------------- settings panel
export function mountSettings(root, getSettings, send, { onTestSound, showVoicePicker } = {}) {
  const render = () => {
    const s = getSettings();
    const seg = (key, opts) =>
      `<span class="seg" data-key="${key}">${opts
        .map(([v, label]) => `<button data-v="${v}" class="${String(s[key]) === String(v) ? "on" : ""}">${label}</button>`)
        .join("")}</span>`;
    const curVoice = getVoicePresetId();
    const voiceButtons = VOICE_PRESETS.map(p =>
      `<button data-voice="${p.id}" class="btn btn-small${curVoice === p.id ? " on" : ""}">${p.label}</button>`
    ).join("");
    const voiceRow = showVoicePicker
      ? `<div class="field"><label>Voice style <span style="font-size:0.8em;opacity:0.7">(saved on this screen)</span></label><span class="seg" data-key="voicePreset">${voiceButtons}</span></div>`
      : "";
    root.innerHTML = `
      <div class="field"><label for="st-title">Game title</label><input type="text" id="st-title" maxlength="40" value="${(s.title || "").replace(/"/g, "&quot;")}"></div>
      <div class="field"><label>Announcer voice</label>${seg("announcer", [["pro", "Pro"], ["trash", "Trash talk"], ["off", "Off"]])}</div>
      ${voiceRow}
      <div class="field"><label>Warning before blinds go up</label>${seg("warnSeconds", [[0, "Off"], [30, "30s"], [60, "1m"], [120, "2m"]])}</div>
      <div class="field"><label>Call the Clock length</label>${seg("shotSeconds", [[20, "20s"], [30, "30s"], [45, "45s"], [60, "60s"]])}</div>
      ${onTestSound ? `<div class="field"><label>Test sound + voice</label><button class="btn btn-small" data-test>Play test</button></div>` : ""}
      <p class="hint" style="margin-top:14px">Sound and voice play on the main clock screen. Turn your TV or laptop volume up.</p>`;
  };
  root.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.hasAttribute("data-test")) return onTestSound && onTestSound();
    // Voice preset (local-only, not sent to server)
    if (b.dataset.voice) {
      setVoicePresetId(b.dataset.voice);
      b.closest(".seg").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      return;
    }
    const seg = b.closest(".seg");
    if (seg) {
      const key = seg.dataset.key;
      if (key === "voicePreset") return; // handled above
      const v = key === "announcer" ? b.dataset.v : Number(b.dataset.v);
      // Show R-rated warning before enabling trash talk
      if (key === "announcer" && v === "trash" && getSettings().announcer !== "trash") {
        showTrashWarning((confirmed) => {
          if (confirmed) {
            send("setSettings", { settings: { [key]: v } });
            seg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x.dataset.v === v));
          }
          // If not confirmed, leave the current selection as-is
        });
        return;
      }
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
