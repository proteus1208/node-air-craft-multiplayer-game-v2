import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const balancePath = join(dirname(fileURLToPath(import.meta.url)), 'balance.json');
const balance = JSON.parse(readFileSync(balancePath, 'utf8'));

export const MAX_LEVEL = balance.maxLevel;

function roundingMode(entry) {
  if (entry.round) return entry.round;
  return Number.isInteger(entry.level1) && Number.isInteger(entry.level15) ? 'round' : 'none';
}

function applyRounding(mode, value) {
  if (mode === 'round') return Math.round(value);
  if (mode === 'floor') return Math.floor(value);
  if (mode === 'ceil') return Math.ceil(value);
  return value;
}

function assertLevelEntry(key, entry) {
  if (!entry || typeof entry.level1 !== 'number' || typeof entry.level15 !== 'number') {
    throw new Error(`balance.json level.${key} needs numeric level1 and level15`);
  }
}

const levelCache = new Map();

export function levelStats(level) {
  const clamped = Math.max(1, Math.min(MAX_LEVEL, Math.round(level) || 1));
  const cached = levelCache.get(clamped);
  if (cached) return cached;
  const span = Math.max(1, MAX_LEVEL - 1);
  const progress = (clamped - 1) / span;
  const stats = {};
  for (const [key, entry] of Object.entries(balance.level)) {
    assertLevelEntry(key, entry);
    const value = entry.level1 + (entry.level15 - entry.level1) * progress;
    stats[key] = applyRounding(roundingMode(entry), value);
  }
  levelCache.set(clamped, stats);
  return stats;
}

export function fixed(key) {
  const entry = balance.fixed[key];
  if (!entry || !Object.prototype.hasOwnProperty.call(entry, 'value')) {
    throw new Error(`balance.json fixed.${key} needs a value`);
  }
  return entry.value;
}
