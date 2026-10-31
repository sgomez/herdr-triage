// Pure helpers, kept apart from main.js so they can be tested outside Herdr.

// `git status --porcelain=v1 -b`: branch, ahead/behind its upstream, changed files.
export function parseStatus(stdout) {
  const [head, ...rest] = stdout.split("\n");
  const m = /^## (?:No commits yet on )?([^.\s]+)(?:\.\.\.\S+)?(?: \[(.*)\])?/.exec(head) ?? [];
  return {
    branch: m[1] ?? "?",
    ahead: Number(/ahead (\d+)/.exec(m[2] ?? "")?.[1] ?? 0),
    behind: Number(/behind (\d+)/.exec(m[2] ?? "")?.[1] ?? 0),
    dirty: rest.filter(Boolean).length,
  };
}
