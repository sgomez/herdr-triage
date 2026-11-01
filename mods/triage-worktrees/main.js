// The focused repo's linked worktrees, and removing the ones whose work is safe elsewhere.
// Only git, on that folder's machine: no GitHub API calls.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, exec, run, theme, layout, shared, setShared } from "herdr";
import { parseWorktrees, STATS, parseStats, ready, ago } from "./lib.js";
import { shown } from "./layout.js";

const visible = () => shown(layout(), "triage-worktrees");

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}

// The open space showing a checkout, by where it was made or where its terminals are.
function spaceOf(path, on) {
  const inside = (cwd) => cwd === path || cwd?.startsWith(`${path}/`);
  return spaces().find((s) => (s.machine ?? null) === (on ?? null) && (inside(s.folder)
    || panes().some((p) => s.tabs.some((t) => t.id === p.tab) && inside(p.cwd))));
}

const REASON = { "in base": "in base", "remote gone": "remote branch deleted" };

export default class TriageWorktrees extends View {
  init(_props, cx) {
    this.confirm = null;
    this.errors = {};
    cx.timer.every(30000, (cx) => this.load(cx));
  }

  load(cx) {
    const loc = location(), context = JSON.stringify(loc);
    if (!loc.cwd || this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const git = (args, cwd = loc.cwd) => exec("git", ["--no-optional-locks", ...args], { cwd, on: loc.on });
        const list = await git(["worktree", "list", "--porcelain"]);
        if (context !== this.context) return;
        if (list.code !== 0) { this.list = null; this.error = /not a git repository/i.test(list.stderr ?? "") ? "Not a git repository." : (list.stderr ?? "").trim() || "git worktree failed."; return; }
        const all = parseWorktrees(list.stdout), main = all[0].path;
        const head = await git(["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], main);
        let base = head.code === 0 ? head.stdout.trim() : null;
        for (const b of ["main", "master"]) if (!base && (await git(["show-ref", "-q", "--verify", `refs/heads/${b}`], main)).code === 0) base = b;
        const trees = all.filter((w) => !w.main && w.branch && !w.prunable);
        const stats = trees.length && base
          ? parseStats((await exec("sh", ["-c", STATS, "sh", base, ...trees.flatMap((w) => [w.path, w.branch])], { cwd: main, on: loc.on })).stdout ?? "")
          : {};
        if (context !== this.context) return;
        this.error = null;
        this.main = main; this.base = base;
        this.list = trees.map((w) => {
          const s = stats[w.path] ?? { dirty: 0, behind: 0, ahead: 0, unpushed: 0, date: null };
          const space = spaceOf(w.path, loc.on);
          const busy = w.locked || space?.status === "working" || space?.status === "blocked";
          return { ...w, ...s, space, ready: base ? ready(s, busy) : null };
        }).sort((a, b) => Date.parse(b.date ?? 0) - Date.parse(a.date ?? 0));
        this.badge();
      } catch (e) { this.error = String(e?.message ?? e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  // Only on change, since setting shared state re-renders every mod.
  badge() {
    const value = { count: (this.list ?? []).filter((w) => w.ready).length, tone: "accent" };
    if (JSON.stringify(shared("badge.triage-worktrees")) !== JSON.stringify(value)) setShared("badge.triage-worktrees", value);
  }

  open(w) {
    const s = spaceOf(w.path, this.loc.on);
    if (s) run("space.select", { id: s.id });
    else run("space.new", { folder: w.path, machine: this.loc.on ?? undefined });
  }

  remove(cx, w) {
    this.busy = w.path; this.confirm = null; delete this.errors[w.path];
    cx.spawn(async (cx) => {
      try {
        const git = (args) => exec("git", args, { cwd: this.main, on: this.loc.on });
        // It may have changed since the list was read.
        const status = await exec("git", ["--no-optional-locks", "status", "--porcelain"], { cwd: w.path, on: this.loc.on });
        if (status.code !== 0 || status.stdout.trim()) throw new Error("It has uncommitted changes now.");
        const s = spaceOf(w.path, this.loc.on);
        if (s) run("space.close", { id: s.id, confirmed: true });
        const r = await git(["worktree", "remove", w.path]);
        if (r.code !== 0) throw new Error((r.stderr ?? "").trim() || "git worktree remove failed.");
        // -D: a squash-merged branch isn't merged as far as git knows; ready() already checked.
        const b = await git(["branch", "-D", w.branch]);
        if (b.code !== 0) throw new Error((b.stderr ?? "").trim() || "git branch -D failed.");
        this.list = this.list.filter((x) => x.path !== w.path);
        this.badge();
      } catch (e) { this.errors[w.path] = String(e?.message ?? e); }
      finally { this.busy = null; cx.notify(); this.load(cx); }
    });
    cx.notify();
  }

  button(t, id, label, onClick, danger) {
    return div().id(id).flex_none().px(8).h(22).flex().items_center().rounded(6).text_size(11.5).cursor_pointer()
      .bg(danger ? t.blocked : t.raised).text_color(danger ? t.background : t.foreground).hover((s) => s.opacity(0.85))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); cx.notify(); }).child(label);
  }

  row(t, w) {
    const asking = this.confirm === w.path, removing = this.busy === w.path;
    const bits = [
      w.ready ? div().text_color(t.ansi5).child(REASON[w.ready]) : null,
      w.ahead ? div().text_color(t.foreground).child(`↑${w.ahead}`) : null,
      w.behind ? div().child(`↓${w.behind}`) : null,
      w.dirty ? div().text_color(t.done).child(`${w.dirty} uncommitted`) : null,
      w.unpushed ? div().child(`${w.unpushed} unpushed`) : null,
      w.date ? div().text_color(t.dim).child(ago(w.date)) : null,
    ].filter(Boolean);
    return v_flex().id(`wt-${w.path}`).flex_none().px(8).py(5).gap(3).rounded(7)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => this.open(w))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().child(w.branch))
        .when(Boolean(w.space), (el) => el.child(div().flex_none().text_color(w.space.status === "blocked" ? t.blocked : w.space.status === "working" ? t.working : t.dim).child("●")))
        .when(Boolean(w.ready) && !asking && !removing, (el) => el.child(this.button(t, `rm-${w.path}`, "Remove", () => { this.confirm = w.path; })))
        .when(removing, (el) => el.child(div().flex_none().text_size(11.5).text_color(t.dim).child("Removing…"))))
      .child(h_flex().gap(8).items_center().text_size(10.5).text_color(t.muted)
        .children(bits.map((b) => b.flex_none())))
      .when(asking, (el) => el.child(h_flex().pt(4).gap(6).items_center().text_size(11.5)
        .child(div().flex_1().min_w(0).text_color(t.muted).child("Remove the worktree and its local branch?"))
        .child(this.button(t, `no-${w.path}`, "Cancel", () => { this.confirm = null; }))
        .child(this.button(t, `yes-${w.path}`, "Remove", (cx) => this.remove(cx, w), true))))
      .when(Boolean(this.errors[w.path]), (el) => el.child(div().text_size(11).text_color(t.blocked).child(this.errors[w.path])));
  }

  render(cx) {
    const t = theme();
    const loc = location(), context = JSON.stringify(loc);
    if (context !== this.context) { this.context = context; this.loc = loc; this.list = null; this.confirm = null; this.error = null; this.load(cx); }
    const frame = v_flex().id("worktrees").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background)
      .border_1().border_color(t.border).text_color(t.foreground).text_size(13);
    const section = (label) => div().px(8).pt(10).pb(4).text_size(10.5).font_semibold().text_color(t.dim).child(label);
    const list = this.list ?? [], done = list.filter((w) => w.ready), rest = list.filter((w) => !w.ready);
    const repo = this.main?.split("/").pop();
    return frame
      .child(h_flex().h(42).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(repo ? `${repo} · ${list.length} worktree${list.length === 1 ? "" : "s"}` : "Worktrees"))
        .child(div().id("wt-refresh").text_size(11).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => this.load(cx)).child(this.loading ? "Loading…" : "Refresh")))
      .child(v_flex().id("wt-list").flex_1().min_h(0).p(6).overflow_y_scrollbar()
        .when(Boolean(this.error), (el) => el.child(div().p(8).text_color(t.dim).child(this.error)))
        .when(!this.error && !this.list, (el) => el.child(div().p(8).text_color(t.dim).child(loc.cwd ? "Loading…" : "No folder.")))
        .when(Boolean(this.list) && !list.length, (el) => el.child(div().p(8).text_color(t.dim).child("No worktrees besides the main checkout.")))
        .when(Boolean(this.list) && !this.base, (el) => el.child(div().p(8).text_color(t.dim).child("No main branch found, so nothing is offered for removal.")))
        .when(done.length > 0, (el) => el.child(section("Ready to remove")).children(done.map((w) => this.row(t, w))))
        .when(rest.length > 0, (el) => el.child(section("In progress")).children(rest.map((w) => this.row(t, w)))));
  }
}
