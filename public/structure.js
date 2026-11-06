// Blind structures — shared by the Worker (validation, defaults) and the browser (editor, presets).

// Simple +25 SB progression: 25/50, 50/100, 75/150, 100/200, 125/250 …
// Big blind is always SB × 2.
function buildSimple(levelMin, breakMin, startSb = 25, sbStep = 25, count = 20, breakAfter = 4) {
  const levels = [];
  let played = 0;
  for (let i = 0; i < count; i++) {
    const sb = startSb + sbStep * i;
    const bb = sb * 2;
    levels.push({ sb, bb, ante: 0, min: levelMin });
    played++;
    if (breakAfter > 0 && played % breakAfter === 0 && i < count - 1) levels.push({ brk: true, min: breakMin });
  }
  return levels;
}

export const PRESETS = {
  standard: { name: "Standard — 8 min levels",   levels: buildSimple(8, 10, 25, 25, 20, 0) },
  turbo:    { name: "Turbo — 5 min levels",       levels: buildSimple(5, 5, 25, 25, 20, 0)  },
  deep:     { name: "Deep stack — 15 min levels", levels: buildSimple(15, 10, 25, 25, 20, 0) },
};

export const DEFAULT_LEVELS = PRESETS.standard.levels;

// Build a full structure from the quick-setup choices.
// Uses a simple +SB-step progression: each level SB increases by sbStep, BB = SB × 2.
// breakAfter = number of levels before the first break (and between breaks). 0 = no breaks.
export function generateStructure({ startSb, startBb, levelMin = 20, breakAfter = 4, breakMin = 10, count = 20 }) {
  const sb0 = Math.max(1, Math.round(startSb) || 25);
  const bb0 = Math.max(sb0 + 1, Math.round(startBb) || sb0 * 2);
  // Infer step: use the starting SB itself as the increment (25/50 → +25, 50/100 → +50, etc.)
  const sbStep = sb0;
  const levels = [];
  let played = 0;
  for (let i = 0; i < count; i++) {
    const sb = sb0 + sbStep * i;
    // Keep BB = SB × 2 for all levels after the first. First level preserves the custom bb0.
    const bb = i === 0 ? bb0 : sb * 2;
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
