// Pure helpers, kept apart from main.js so they can be tested outside Herdr.

export const FORMAT = "%H%x1f%P%x1f%an%x1f%aI%x1f%D%x1f%s";

// `git log --decorate=full --format=FORMAT`: one commit per line, fields split by \x1f.
// Full ref names tell a local "a/b" branch from a remote one.
const KINDS = [["local", /^(?:HEAD -> )?refs\/heads\/(.+)$/], ["remote", /^refs\/remotes\/(.+)$/], ["tag", /^tag: refs\/tags\/(.+)$/]];
function refOf(r) {
  for (const [kind, re] of KINDS) { const m = re.exec(r); if (m) return { name: m[1], kind }; }
  return null;
}

export function parseLog(stdout) {
  return stdout.split("\n").filter(Boolean).map((line) => {
    const [hash, parents, author, date, refs, subject] = line.split("\x1f");
    return {
      hash, author, date, subject: subject ?? "",
      parents: parents ? parents.split(" ") : [],
      refs: refs ? refs.split(", ").map(refOf).filter(Boolean) : [],
      head: /^HEAD(?: -> |$)/.test(refs ?? ""),
    };
  });
}

// Lays commits (newest first) out in lanes. Per row: the commit's lane and color, the lines above and
// below its middle, and the curves across it: "in" from a lane that ends here, "out" to a parent's lane.
// A line keeps its color from where it starts until it ends.
export function graph(commits) {
  let open = [], next = 0;
  const slot = () => { const i = open.indexOf(null); return i < 0 ? open.length : i; };
  return commits.map((c) => {
    let lane = open.findIndex((o) => o?.hash === c.hash);
    const color = lane < 0 ? next++ : open[lane].color;
    if (lane < 0) lane = slot();
    const joins = [];
    const top = open.flatMap((o, i) => (o && (o.hash !== c.hash || i === lane) ? [{ lane: i, color: o.color }] : []));
    open = open.map((o, i) => (o?.hash === c.hash && i !== lane ? (joins.push({ lane: i, color: o.color, dir: "in" }), null) : o));
    open[lane] = c.parents[0] ? { hash: c.parents[0], color } : null;
    const fresh = new Set();
    for (const p of c.parents.slice(1)) {
      let j = open.findIndex((o) => o?.hash === p);
      if (j < 0) { j = slot(); open[j] = { hash: p, color: next++ }; fresh.add(j); }
      joins.push({ lane: j, color: open[j].color, dir: "out" });
    }
    while (open.length && open[open.length - 1] === null) open.pop();
    const bottom = open.flatMap((o, i) => (o && !fresh.has(i) ? [{ lane: i, color: o.color }] : []));
    const used = [lane, ...[...top, ...bottom, ...joins].map((l) => l.lane)];
    return { lane, color, top, bottom, joins, width: Math.max(...used) + 1 };
  });
}

// "feat(api)!: add x" gives type, scope and breaking; "Merge pull request #12 from o/b" gives pr.
export function parseSubject(s) {
  const pr = /^Merge pull request #(\d+) from (\S+)/.exec(s);
  if (pr) return { pr: Number(pr[1]), text: pr[2].replace(/^[^/]+\//, "") };
  const m = /^([a-z]+)(?:\(([^)]+)\))?(!)?: (.+)$/.exec(s);
  return m ? { type: m[1], scope: m[2] ?? null, breaking: Boolean(m[3]), text: m[4] } : { text: s };
}

export function initials(name) {
  const words = (name ?? "").trim().split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return "?";
  return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : "")).toUpperCase();
}

// Same text, same number, so an author keeps their color.
export function hashOf(text) {
  let h = 0;
  for (const ch of text ?? "") h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h;
}

// `git show --numstat --format=%B%x1e`: the message, then "added\tdeleted\tpath" per file ("-" if binary).
export function parseShow(stdout) {
  const [message, stat = ""] = stdout.split("\x1e");
  const files = stat.split("\n").filter(Boolean).map((l) => {
    const [add, del, ...path] = l.split("\t");
    return { path: path.join("\t"), add: add === "-" ? null : Number(add), del: del === "-" ? null : Number(del) };
  });
  return { body: message.trim().split("\n").slice(1).join("\n").trim(), files };
}

export function matches(c, query) {
  const q = query.trim().toLowerCase();
  return !q || [c.subject, c.author, c.hash, ...c.refs.map((r) => r.name)].some((s) => s.toLowerCase().includes(q));
}

export function ago(iso) {
  const m = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  if (!(m >= 1)) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return d < 365 ? `${d}d` : `${Math.floor(d / 365)}y`;
}
