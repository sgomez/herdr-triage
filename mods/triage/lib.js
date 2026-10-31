// Pure helpers, kept apart from main.js so they can be tested outside Herdr.

const RANKS = { blocked: 4, done: 3, working: 2, idle: 1 };
export const rank = (s) => RANKS[s] ?? 0;

export const machineOf = (addr) => (addr.includes("/") ? addr.split("/")[0] : null);
export const qualify = (id, machine) => (id && machine ? `${machine}/${id}` : id);
export const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
export const firstLine = (s) => (s ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";

export function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
