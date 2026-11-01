// Clickable counters by state, and the focused folder's branch with ahead/behind and changes.

import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { parseStatus } from "./lib.js";
import { reveal } from "./layout.js";
import { spaces, panes, focused, agents, terminals, exec, theme, run, window, layout, shared, setShared } from "herdr";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}

// Counts for triage-activity's icons; only on change, since setting re-renders every mod.
function badge(mod, count, tone) {
  const key = `badge.${mod}`, value = { count, tone };
  if (JSON.stringify(shared(key)) !== JSON.stringify(value)) setShared(key, value);
}

export default class TriageStatus extends View {
  init(_props, cx) {
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  refresh(cx) {
    const { cwd, on } = location(), context = JSON.stringify({ cwd, on });
    if (!cwd || this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", ["--no-optional-locks", "status", "--porcelain=v1", "-b"], { cwd, on });
        if (context !== this.context) return;
        if (r.code !== 0) { this.git = null; return; }
        this.git = parseStatus(r.stdout);
      } catch { this.git = null; }
      finally { this.loading = false; cx.notify(); }
    });
  }

  render(cx) {
    const t = theme();
    const context = JSON.stringify(location());
    if (context !== this.context) { this.context = context; this.git = null; this.refresh(cx); }
    const live = terminals().filter((k) => k.state === "live");
    const blocked = live.filter((k) => k.status === "blocked" || k.status === "error").length;
    const list = agents();
    const done = list.filter((a) => a.status === "done").length;
    const working = list.filter((a) => a.status === "working").length;
    const counter = (id, n, label, color, command) => h_flex().id(id).gap(5).items_center()
      .text_color(n ? color : t.dim)
      .when(n > 0 && Boolean(command), (el) => el.cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click(() => run(command)))
      .child(div().font_semibold().child(String(n))).child(label);
    const g = this.git;
    badge("triage-reply", blocked, "blocked");
    badge("changes", g?.dirty ?? 0, "done");
    const mac = window()?.platform === "macos";
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(counter("c-blocked", blocked, "need you", t.blocked, "triage.next-blocked"))
      .child(counter("c-done", done, "done", t.done, "triage.next-done"))
      .child(counter("c-working", working, "working", t.working, null))
      .when(Boolean(g), (el) => el.child(h_flex().gap(6).items_center()
        .child(svg("mods/workspace-chrome/branch.svg").size(13))
        .child(g.branch)
        .when(g.ahead > 0, (el) => el.child(div().text_color(t.foreground).child(`↑${g.ahead}`)))
        .when(g.behind > 0, (el) => el.child(div().text_color(t.blocked).child(`↓${g.behind}`)))
        .when(g.dirty > 0, (el) => el.child(div().id("dirty").text_color(t.done).cursor_pointer().tooltip("Open Review")
          .on_click(() => reveal({ layout, panes, run }, "changes"))
          .child(`±${g.dirty}`)))))
      .child(div().flex_1())
      .child(div().id("palette").text_color(t.dim).cursor_pointer().on_click(() => run("app.palette")).child(`${mac ? "⌘" : "Ctrl"} Shift P  commands`));
  }
}
