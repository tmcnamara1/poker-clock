// End-to-end test of the room: host + player sockets, permissions, auto-advance, shot clock.
const BASE = process.argv[2] || "http://127.0.0.1:8787";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function client(code, key) {
  const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws/${code}${key ? "?k=" + key : ""}`);
  const c = { ws, msgs: [], state: null, role: null };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    c.msgs.push(m);
    if (m.type === "state") { c.state = m.state; c.role = m.role; }
  };
  c.open = new Promise((r) => (ws.onopen = r));
  c.send = (cmd, x = {}) => ws.send(JSON.stringify({ type: "cmd", cmd, ...x }));
  c.events = () => c.msgs.filter((m) => m.type === "state").map((m) => m.event);
  return c;
}

const res = await fetch(`${BASE}/api/rooms`, { method: "POST" });
const { code, hostKey } = await res.json();
ok(/^[A-Z]{4}$/.test(code) && hostKey, `room created ${code}`);
ok((await fetch(`${BASE}/api/rooms/${code}`)).status === 200, "room exists check");
ok((await fetch(`${BASE}/api/rooms/ZZZZ`)).status === 404, "missing room 404");
ok((await fetch(`${BASE}/d/${code}`)).status === 200, "display page served");
ok((await fetch(`${BASE}/r/${code}`)).status === 200, "remote page served");

const host = client(code, hostKey);
const player = client(code);
const bad = client(code, "wrongkey");
await Promise.all([host.open, player.open, bad.open]);
await sleep(300);
ok(host.role === "host", "host role granted");
ok(player.role === "player" && bad.role === "player", "player role (and wrong key) is player");
ok(!("hostKey" in host.state), "hostKey not leaked in state");
ok(host.state.levels.length > 10 && host.state.levelIndex === 0, "default structure loaded");

// players cannot control
player.send("start");
await sleep(300);
ok(player.msgs.some((m) => m.error === "host-only") && !host.state.running, "player cannot start clock");

// host starts; both sides see it
host.send("start");
await sleep(300);
ok(host.state.running && player.state.running, "host start syncs to player");
const rem = host.state.endsAt - Date.now();
ok(rem > 19 * 60000 && rem <= 20 * 60000, `level 1 is 20 min (${Math.round(rem / 1000)}s)`);

// pause / resume keeps remaining time
host.send("pause");
await sleep(300);
ok(!player.state.running && player.state.remainingMs > 19 * 60000, "pause syncs with remaining time");
host.send("start");
await sleep(200);

// auto-advance: shrink the level to ~1s and wait for the alarm
host.send("addTime", { ms: -3600000 });
await sleep(2500);
ok(player.state.levelIndex === 1 && player.state.running, `auto-advanced to level index ${player.state.levelIndex}`);
ok(player.events().includes("levelUp"), "levelUp event broadcast");
const rem2 = player.state.endsAt - Date.now();
ok(rem2 > 18 * 60000, "timer restarted for next level automatically");
ok(player.state.levels[1].sb === 50 && player.state.levels[1].bb === 100, "new blinds are 50/100");

// shot clock: player can call it; second call ignored while active
player.send("callClock", { name: "Mike" });
await sleep(300);
ok(host.state.shot && host.state.shot.by === "Mike", "player called the clock, host sees it");
const firstEnd = host.state.shot.endsAt;
player.send("callClock", { name: "Spammer" });
await sleep(300);
ok(host.state.shot.endsAt === firstEnd && host.state.shot.by === "Mike", "repeat call ignored while active");
host.send("cancelClock");
await sleep(300);
ok(!player.state.shot, "host cancels the clock");

// settings + shot clock expiry (short)
host.send("setSettings", { settings: { shotSeconds: 10, announcer: "trash", title: "Friday Game" } });
await sleep(300);
ok(player.state.settings.shotSeconds === 10 && player.state.settings.announcer === "trash" && player.state.settings.title === "Friday Game", "settings sync");
await sleep(3200); // cooldown after cancel
player.send("callClock", { name: "Ann" });
await sleep(10800);
ok(!player.state.shot && player.events().includes("shotEnd"), "shot clock expires with shotEnd event");

// structure edit: custom 3-level structure, validation clamps junk
host.send("setStructure", { levels: [{ sb: 10, bb: 20, min: 0 }, { brk: true, min: 5 }, { sb: "abc", bb: 40, min: 999 }] });
await sleep(300);
const L = player.state.levels;
ok(L.length === 3 && L[0].min === 1 && L[1].brk && L[2].sb === 0 && L[2].min === 240, "structure saved + validated");
ok(player.state.levelIndex === 1, "level index kept in range");

// next/prev/reset
host.send("next");
await sleep(200);
ok(player.state.levelIndex === 2, "next level");
host.send("next");
await sleep(200);
ok(player.state.levelIndex === 2, "next at last level does nothing");
host.send("reset");
await sleep(300);
ok(player.state.levelIndex === 0 && !player.state.running && player.state.remainingMs === 60000, "reset to level 1, paused");

// break transition: level 0 (1 min) -> break, auto
host.send("start");
await sleep(200);
host.send("addTime", { ms: -3600000 });
await sleep(2300);
ok(player.state.levelIndex === 1 && player.state.levels[1].brk && player.state.running, "auto-advance into break");

// finishing the structure
host.send("next");
await sleep(200);
for (let i = 0; i < 5; i++) host.send("addTime", { ms: -3600000 });
await sleep(2300);
ok(player.state.finished && !player.state.running && player.events().includes("finished"), "structure finishes cleanly");

// persistence: new connection gets full state
const late = client(code);
await late.open;
await sleep(300);
ok(late.state && late.state.finished && late.state.settings.title === "Friday Game", "late joiner gets saved state");

for (const c of [host, player, bad, late]) c.ws.close();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
