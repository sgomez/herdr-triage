// Commit history of the focused folder, with its lanes. Clicking a commit shows its message and files.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, focused, exec, run, theme, layout, settings } from "herdr";
import { FORMAT, parseLog, graph, parseSubject, initials, hashOf, parseShow, matches, ago } from "./lib.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const c of node?.children ?? []) { const f = find(c, id); if (f) return f; }
  return null;
}
const visible = () => {
  const root = layout();
  return !find(root, "panel")?.hidden && find(root, "panel-body")?.active === "history";
};

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}

const PAGE = 100, ROW = 28, LANE = 14, LANES = 8, LINE = 2, DOT = 10, FILES = 12;
// Themes' ANSI colors are tuned for text on a terminal, not for lines next to each other.
const PALETTE = {
  dark: ["#6ea8fe", "#c792ea", "#f78c9c", "#f2c46d", "#7fd4a0", "#5fd0e0", "#ffa66b"],
  light: ["#2f6fdb", "#8a4fd1", "#d2445e", "#b07d0b", "#2e9b5f", "#1a8fa3", "#cc6519"],
};
const TYPES = { feat: 4, fix: 2, docs: 0, refactor: 1, perf: 6, test: 3, build: 5, ci: 5, revert: 2 };
const SCOPES = { branch: [], all: ["--branches", "--remotes", "--tags", "HEAD"] };

export default class TriageHistory extends View {
  init(_props, cx) {
    this.limit = PAGE;
    this.scope = localStorage.getItem("scope") === "all" ? "all" : "branch";
    this.shows = {};
    this.query = InputState.new({ placeholder: "Filter by message, author, hash or branch" });
    this.query.on("change", (_e, cx) => cx.notify());
    cx.timer.every(10000, (cx) => { if (visible()) this.load(cx); });
  }

  load(cx) {
    const loc = location(), context = JSON.stringify(loc);
    if (!loc.cwd || this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const [r, s] = await Promise.all([
          exec("git", ["--no-optional-locks", "log", "--date-order", `-n${this.limit}`, `--format=${FORMAT}`, ...SCOPES[this.scope]], loc),
          exec("git", ["--no-optional-locks", "status", "--porcelain"], loc),
        ]);
        if (context !== this.context) return;
        if (r.code !== 0) { this.commits = null; this.error = /not a git repository/i.test(r.stderr ?? "") ? "Not a git repository." : (r.stderr ?? "").trim() || "git log failed."; return; }
        this.error = null;
        this.commits = parseLog(r.stdout);
        this.rows = graph(this.commits);
        this.dirty = s.code === 0 ? s.stdout.split("\n").filter(Boolean).length : 0;
      } catch (e) { this.error = String(e?.message ?? e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  select(cx, c) {
    this.selected = this.selected === c.hash ? null : c.hash;
    if (!this.selected || this.shows[c.hash]) return cx.notify();
    const loc = location();
    cx.spawn(async (cx) => {
      const r = await exec("git", ["--no-optional-locks", "show", "--numstat", "--format=%B%x1e", c.hash], loc);
      this.shows[c.hash] = r.code === 0 ? parseShow(r.stdout) : { body: (r.stderr ?? "").trim(), files: [] };
      cx.notify();
    });
    cx.notify();
  }

  diff(c, path) {
    run("terminal.open", { argv: ["git", "show", "--stat", "--patch", c.hash, ...(path ? ["--", path] : [])], folder: location().cwd, place: "right" });
  }

  // Lines are 2 px divs and curves are rounded corners, so they scale with the zoom like the text does.
  lanes(row, head, width, color, full) {
    const x = (i) => i * LANE + LANE / 2, half = ROW / 2, c = (l) => color(l.color);
    const v = (l, top, h) => div().absolute().left(x(l.lane) - LINE / 2).top(top).w(LINE).h(h).bg(c(l));
    const curve = (j) => {
      const right = j.lane > row.lane, dx = Math.abs(x(j.lane) - x(row.lane)), r = Math.min(half, dx);
      const el = div().absolute().left(right ? x(row.lane) : x(j.lane) - LINE / 2).w(dx + LINE / 2).border_color(c(j));
      const out = j.dir === "out";
      const box = out ? el.top(half - LINE / 2).h(half + LINE / 2).border_t(LINE) : el.top(0).h(half + LINE / 2).border_b(LINE);
      if (right) return out ? box.border_r(LINE).rounded_tr(r) : box.border_r(LINE).rounded_br(r);
      return out ? box.border_l(LINE).rounded_tl(r) : box.border_l(LINE).rounded_bl(r);
    };
    const col = color(row.color);
    const els = full ? row.bottom.map((l) => v(l, 0, 2000)) : [
      ...row.top.map((l) => v(l, 0, half)),
      ...row.bottom.map((l) => v(l, half, half)),
      ...row.joins.map(curve),
      div().absolute().left(x(row.lane) - DOT / 2).top(half - DOT / 2).w(DOT).h(DOT).rounded(DOT)
        .when(head, (el) => el.bg(theme().background).border(2.5).border_color(col))
        .when(!head, (el) => el.bg(col)),
    ];
    return div().relative().flex_none().w(width * LANE).when(!full, (el) => el.h(ROW)).overflow_hidden().children(els);
  }

  chip(text, fg, bg, border) {
    return div().flex_none().max_w(130).truncate().px(5).h(17).flex().items_center().rounded(5).text_size(10.5)
      .text_color(fg).when(Boolean(bg), (el) => el.bg(bg)).when(Boolean(border), (el) => el.border_1().border_color(border)).child(text);
  }

  row(t, c, row, width, color, flat) {
    const s = parseSubject(c.subject), col = color(row.color), merge = c.parents.length > 1;
    const type = s.type ? color(TYPES[s.type] ?? null) : null;
    const avatar = color(hashOf(c.author));
    const open = this.selected === c.hash;
    return h_flex().id(`c-${c.hash}`).h(ROW).flex_none().pr(8).gap(6).items_center().rounded(6).cursor_pointer()
      .when(open, (el) => el.bg(t.selected)).hover((st) => st.bg(open ? t.selected : t.hover))
      .tooltip(`${c.hash.slice(0, 7)} · ${c.author} · ${c.date.slice(0, 16).replace("T", " ")}\n${c.subject}`)
      .on_click((_e, cx) => this.select(cx, c))
      .child(flat ? div().flex_none().ml(4).w(8).h(8).rounded(8).bg(col) : this.lanes(row, c.head, width, color))
      .child(div().flex_none().w(18).h(18).rounded(18).flex().items_center().justify_center().text_size(8.5).font_semibold()
        .bg(`${avatar}33`).text_color(avatar).child(initials(c.author)))
      .children(c.refs.slice(0, 2).map((r) => r.startsWith("tag: ") ? this.chip(r.slice(5), color(3), `${color(3)}26`, null)
        : r.includes("/") ? this.chip(r, col, null, `${col}66`) : this.chip(r, col, `${col}2e`, null)))
      .when(s.pr !== undefined, (el) => el.child(this.chip(`#${s.pr}`, color(0), `${color(0)}26`, null)))
      .when(Boolean(s.type), (el) => el.child(this.chip(`${s.type}${s.breaking ? "!" : ""}`, type ?? t.muted, `${type ?? t.muted}22`, null)))
      .when(Boolean(s.scope), (el) => el.child(div().flex_none().max_w(80).truncate().text_size(11.5).text_color(t.dim).child(s.scope)))
      .child(div().flex_1().min_w(0).truncate().text_color(merge ? t.muted : t.foreground).child(s.pr !== undefined ? `Merge ${s.text}` : s.text))
      .child(div().flex_none().w(28).text_size(10.5).text_color(t.dim).text_right().child(ago(c.date)));
  }

  detail(t, c, row, width, color, flat) {
    const d = this.shows[c.hash];
    const files = d?.files ?? [];
    const button = (id, label, action) => div().id(id).px(8).h(22).flex().items_center().rounded(6).text_size(11.5)
      .bg(t.raised).text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(action).child(label);
    return div().flex().flex_row().flex_none()
      .child(flat ? div().w(16) : this.lanes(row, false, width, color, true))
      .child(v_flex().flex_1().min_w(0).ml(6).mr(8).mb(6).p(10).gap(8).rounded(8).bg(t.surface).border_1().border_color(t.border).text_size(12)
        .child(h_flex().gap(6).text_size(11).text_color(t.dim)
          .child(div().font_semibold().text_color(t.muted).child(c.hash.slice(0, 10)))
          .child(`${c.author} · ${new Date(c.date).toLocaleString()}`))
        .child(div().text_color(t.foreground).child(c.subject))
        .when(Boolean(d?.body), (el) => el.child(div().text_color(t.muted).text_size(11.5).child(d.body)))
        .when(!d, (el) => el.child(div().text_color(t.dim).child("Loading…")))
        .when(files.length > 0, (el) => el.child(v_flex().gap(2)
          .children(files.slice(0, FILES).map((f, i) => h_flex().id(`f-${c.hash}-${i}`).h(20).gap(8).px(4).items_center().rounded(4)
            .cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => this.diff(c, f.path))
            .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(f.path))
            .child(div().flex_none().text_size(11).text_color(color(4)).child(f.add === null ? "bin" : `+${f.add}`))
            .child(div().flex_none().text_size(11).text_color(color(2)).child(f.del === null ? "" : `−${f.del}`))))
          .when(files.length > FILES, (el) => el.child(div().px(4).text_size(11).text_color(t.dim).child(`and ${files.length - FILES} more`)))))
        .child(h_flex().gap(6)
          .child(button(`diff-${c.hash}`, "Open diff", () => this.diff(c)))
          .when(files.length > 0, (el) => el.child(div().text_size(11).text_color(t.dim)
            .child(`${files.length} file${files.length === 1 ? "" : "s"} · +${files.reduce((n, f) => n + (f.add ?? 0), 0)} −${files.reduce((n, f) => n + (f.del ?? 0), 0)}`)))));
  }

  render(cx) {
    const t = theme(), loc = location();
    const context = JSON.stringify(loc);
    if (context !== this.context) { this.context = context; this.commits = null; this.error = null; this.selected = null; this.limit = PAGE; this.load(cx); }
    else if (visible() && !this.commits && !this.error && !this.loading) this.load(cx);
    const palette = PALETTE[settings()?.dark === false ? "light" : "dark"];
    const color = (i) => (i === null ? t.muted : palette[i % palette.length]);
    const query = this.query.value(), flat = query.trim() !== "";
    const width = Math.min(Math.max(1, ...(this.rows ?? []).map((r) => r.width)), LANES);
    const branch = this.commits?.find((c) => c.head)?.refs.find((r) => !r.includes("/") && !r.startsWith("tag: "));
    const chip = (id, label) => div().id(`s-${id}`).px(8).h(22).flex().items_center().rounded(6).text_size(11.5).cursor_pointer()
      .when(this.scope === id, (el) => el.bg(t.raised)).text_color(this.scope === id ? t.foreground : t.muted)
      .on_click((_e, cx) => { if (this.scope !== id) { this.scope = id; localStorage.setItem("scope", id); this.selected = null; this.load(cx); cx.notify(); } })
      .child(label);
    const shown = (this.commits ?? []).map((c, i) => [c, this.rows[i]]).filter(([c]) => matches(c, query));
    return v_flex().id("history").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background)
      .border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(v_flex().flex_none().px(10).pt(8).pb(8).gap(8).border_b(1).border_color(t.border)
        .child(h_flex().h(24).gap(6).items_center()
          .child(svg("mods/workspace-chrome/branch.svg").size(13).flex_none().text_color(t.muted))
          .child(div().min_w(0).truncate().font_semibold().child(branch ?? "Detached HEAD"))
          .child(div().flex_1())
          .child(chip("branch", "Branch")).child(chip("all", "All"))
          .child(div().id("refresh").ml(4).text_size(11).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
            .tooltip("Read the history again").on_click((_e, cx) => this.load(cx)).child(this.loading ? "Loading…" : "Refresh")))
        .child(div().id("query").h(28).px(8).flex().items_center().rounded(7).border_1().border_color(t.border).bg(t.surface).cursor_text()
          .child(Input.new(this.query).w_full().text_size(12).text_color(t.foreground))))
      .when(this.dirty > 0, (el) => el.child(h_flex().id("dirty").flex_none().mx(6).mt(6).h(28).px(10).gap(8).items_center().rounded(7)
        .bg(`${color(3)}1f`).text_size(12).cursor_pointer().hover((s) => s.bg(`${color(3)}33`)).tooltip("Open Review")
        .on_click(() => { run("layout.select", { stack: "panel-body", child: "changes" }); run("layout.show", { id: "panel" }); })
        .child(div().w(DOT).h(DOT).rounded(DOT).border(2).border_color(color(3)))
        .child(div().flex_1().text_color(t.foreground).child("Uncommitted changes"))
        .child(div().text_color(color(3)).font_semibold().child(`±${this.dirty}`))))
      .child(v_flex().id("commits").flex_1().min_h(0).p(6).overflow_y_scrollbar()
        .when(Boolean(this.error), (el) => el.child(div().p(8).text_color(t.dim).child(this.error)))
        .when(!this.error && !this.commits, (el) => el.child(div().p(8).text_color(t.dim).child(loc.cwd ? "Loading…" : "No folder.")))
        .when(Boolean(this.commits), (el) => el
          .when(!shown.length, (el) => el.child(div().p(8).text_color(t.dim).child(flat ? `No commit matches “${query.trim()}” in the last ${this.commits.length}.` : "No commits yet.")))
          .children(shown.flatMap(([c, row]) => [this.row(t, c, row, width, color, flat),
            ...(this.selected === c.hash ? [this.detail(t, c, row, width, color, flat)] : [])]))
          .when(this.commits.length >= this.limit, (el) => el.child(div().id("history-more").mx(8).my(6).h(26).flex().items_center().justify_center().rounded(7)
            .text_size(11.5).text_color(t.muted).bg(t.raised).cursor_pointer().hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => { if (!this.loading) { this.limit += PAGE; this.load(cx); } })
            .child(this.loading ? "Loading…" : "Load more")))));
  }
}
