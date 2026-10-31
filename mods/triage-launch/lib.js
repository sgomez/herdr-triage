// Pure helpers, kept apart from main.js so they can be tested outside Herdr.

export const argsText = (args) => (args ?? []).map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
export const parseArgs = (text) => (text.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((a) => a.replace(/^(["'])(.*)\1$/, "$2"));

export const slugOf = (s) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
export const fill = (text, vars) => (text ?? "").replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

// Same place as the shipped worktree dialog, so it lists these too.
export function worktreePath(home, commonDir, branch) {
  const main = commonDir.endsWith("/.git") ? commonDir.slice(0, -5) : commonDir;
  return `${home}/.herdr/worktrees/${main.split("/").pop()}/${branch.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
}
