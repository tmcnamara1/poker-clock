// Blind structures — shared by the Worker (validation, defaults) and the browser (editor, presets).

const BLINDS = [
  [25, 50], [50, 100], [75, 150], [100, 200], "BREAK",
  [150, 300], [200, 400], [300, 600], [400, 800], "BREAK",
  [500, 1000], [600, 1200], [800, 1600], [1000, 2000], "BREAK",
  [1500, 3000], [2000, 4000], [3000, 6000], [4000, 8000], [5000, 10000],
  [6000, 12000], [8000, 16000], [10000, 20000],
];

function build(levelMin, breakMin) {
  return BLINDS.map((b) =>
    b === "BREAK"
      ? { brk: true, min: breakMin }
      : { sb: b[0], bb: b[1], ante: 0, min: levelMin }
  );
}

export const PRESETS = {
  standard: { name: "Standard — 20 min levels", levels: build(20, 10) },
  turbo: { name: "Turbo — 10 min levels", levels: build(10, 5) },
  deep: { name: "Deep stack — 30 min levels", levels: build(30, 15) },
};

export const DEFAULT_LEVELS = PRESETS.standard.levels;

// Big-blind ladder for a 25/50 start. Other starting blinds scale it up or down.
const BB_LADDER = [
  50, 100, 150, 200, 300, 400, 600, 800, 1000, 1200, 1600, 2000,
  3000, 4000, 5000, 6000, 8000, 10000, 12000, 16000, 20000, 25000,
  30000, 40000, 50000,
];

// Round a blind to a value people can actually make with chips
function niceRound(v) {
  if (v < 10) return Math.max(1, Math.round(v));
  const step = v < 100 ? 5 : v < 250 ? 25 : v < 1000 ? 50 : v < 10000 ? 100 : 1000;
  return Math.round(v / step) * step;
}

// Build a full structure from the three quick-setup choices.
// breakAfter = number of levels before the first break (and between breaks after that). 0 = no breaks.
export function generateStructure({ startSb, startBb, levelMin = 20, breakAfter = 4, breakMin = 10, count = 20 }) {
  const bb0 = Math.max(2, Math.round(startBb) || 50);
  const sbRatio = startSb > 0 && startSb < bb0 ? startSb / bb0 : 0.5;
  const scale = bb0 / BB_LADDER[0];
  const levels = [];
  let played = 0;
  for (let i = 0; i < count && i < BB_LADDER.length; i++) {
    let sb, bb;
    if (i === 0) {
      bb = bb0;
      sb = Math.round(startSb) || Math.round(bb0 / 2);
    } else {
      // round the small blind first, then derive the big blind so the pair stays clean (e.g. 60/120, not 65/125)
      sb = niceRound(BB_LADDER[i] * scale * sbRatio);
      bb = sbRatio === 0.5 ? sb * 2 : niceRound(sb / sbRatio);
    }
    levels.push({ sb, bb, ante: 0, min: levelMin });
    played++;
    if (breakAfter > 0 && played % breakAfter === 0 && i < count - 1) levels.push({ brk: true, min: breakMin });
  }
  return levels;
}

// Read the quick-setup values back out of an existing structure
export function describeStructure(levels) {
  const first = levels.find((l) => !l.brk) || { sb: 25, bb: 50, min: 20 };
  const firstBreak = levels.findIndex((l) => l.brk);
  const brk = levels.find((l) => l.brk);
  return {
    startSb: first.sb,
    startBb: first.bb,
    levelMin: first.min,
    breakAfter: firstBreak < 0 ? 0 : levels.slice(0, firstBreak).filter((l) => !l.brk).length,
    breakMin: brk ? brk.min : 10,
  };
}

const int = (v, lo, hi) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
};

// Clean up anything that arrives from a client before it is stored.
export function normalizeLevels(levels) {
  if (!Array.isArray(levels)) return [];
  return levels.slice(0, 100).map((l) => {
    const min = int(l && l.min, 1, 240);
    if (l && l.brk) return { brk: true, min };
    const sb = int(l && l.sb, 0, 100_000_000);
    const bb = int(l && l.bb, 0, 100_000_000);
    const ante = int(l && l.ante, 0, 100_000_000);
    return { sb, bb, ante, min };
  });
}

// Number of the level as players think of it (breaks don't count)
export function levelNumber(levels, index) {
  let n = 0;
  for (let i = 0; i <= index && i < levels.length; i++) if (!levels[i].brk) n++;
  return n;
}

export function totalLevels(levels) {
  return levels.filter((l) => !l.brk).length;
}
