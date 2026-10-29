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
