// Pure helpers, kept apart from main.js so they can be tested outside Herdr.

// `git worktree list --porcelain`: one block per checkout, the main one first.
export function parseWorktrees(stdout) {
  return stdout.split("\n\n").filter((b) => b.trim()).map((block, i) => {
    const w = { path: null, branch: null, main: i === 0, locked: false, prunable: false };
    for (const line of block.split("\n")) {
      const [key, ...rest] = line.split(" "), value = rest.join(" ");
      if (key === "worktree") w.path = value;
      else if (key === "branch") w.branch = value.replace(/^refs\/heads\//, "");
      else if (key === "locked") w.locked = true;
      else if (key === "prunable") w.prunable = true;
    }
    return w;
  });
}

// For each "path branch" pair: path, uncommitted files, behind and ahead of base, commits on no remote, last commit,
// and whether its upstream is gone (deleted on the remote, as GitHub does after a merge, and pruned by a fetch).
export const STATS = `base=$1; shift
while [ $# -gt 1 ]; do p=$1; b=$2; shift 2
  d=$(git -C "$p" --no-optional-locks status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  lr=$(git -C "$p" rev-list --left-right --count "$base...$b" 2>/dev/null)
  u=$(git -C "$p" rev-list --count "$b" --not "$base" --remotes 2>/dev/null)
  t=$(git -C "$p" log -1 --format=%cI "$b" 2>/dev/null)
  g=$(git -C "$p" for-each-ref --format='%(upstream:track)' "refs/heads/$b" 2>/dev/null)
  printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$p" "\${d:-0}" "\${lr:-0	0}" "\${u:-0}" "$t" "$g"
done`;

export function parseStats(stdout) {
  const stats = {};
  for (const line of stdout.split("\n").filter(Boolean)) {
    const [path, dirty, behind, ahead, unpushed, date, track] = line.split("\t");
    stats[path] = { dirty: Number(dirty), behind: Number(behind), ahead: Number(ahead), unpushed: Number(unpushed), date: date || null, gone: track === "[gone]" };
  }
  return stats;
}

// Why removing it loses nothing, or null: no uncommitted changes, and its commits are in base,
// or its remote branch was deleted (a squash merge leaves no trace in git but that).
export function ready({ dirty, ahead, gone }, busy) {
  if (busy || dirty > 0) return null;
  if (ahead === 0) return "in base";
  return gone ? "remote gone" : null;
}

export function ago(iso) {
  const m = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  if (!(m >= 1)) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
