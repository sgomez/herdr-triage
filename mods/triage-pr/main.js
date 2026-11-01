// Pull requests of the focused folder's repo, the current branch's first, with their checks.
// `gh` and `git` run on that folder's machine.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, exec, theme, layout, window } from "herdr";
import { ago, checksOf, stateOf } from "./lib.js";
import { shown } from "./layout.js";

const visible = () => shown(layout(), "triage-pr");

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}

const PAGE = 30;
const FIELDS = "number,title,state,isDraft,url,reviewDecision,headRefName,statusCheckRollup,updatedAt,author";
// gh calls hit GitHub's rate limit, so results are kept per folder and filter and reused for TTL.
const TTL = 5 * 60000;
const readCache = () => { try { return JSON.parse(localStorage.getItem("cache") ?? "{}"); } catch { return {}; } };
function writeCache(cache, key, entry) {
  cache[key] = { ...entry, at: Date.now() };
  const keys = Object.keys(cache).sort((a, b) => cache[b].at - cache[a].at);
  for (const k of keys.slice(30)) delete cache[k];
  try { localStorage.setItem("cache", JSON.stringify(cache)); } catch {}
}
const REVIEW = { APPROVED: "Approved", CHANGES_REQUESTED: "Changes requested", REVIEW_REQUIRED: "Review required" };

export default class PullRequests extends View {
  init(_props, cx) {
    this.filter = "open";
    this.local = new Set();
    this.cache = readCache();
    cx.timer.every(30000, (cx) => cx.notify());
  }

  load(cx) {
    const { cwd, on } = this.loc ?? {}, context = this.context, key = this.key;
    if (!cwd || this.loading) return;
    this.loading = true;
    const list = ["pr", "list", "--state", "open", "--limit", String(this.limit ?? PAGE), "--json", FIELDS];
    if (this.filter === "mine") list.push("--author", "@me");
    cx.spawn(async (cx) => {
      try {
        const [here, all, heads] = await Promise.all([
          exec("gh", ["pr", "view", "--json", FIELDS], { cwd, on }),
          exec("gh", list, { cwd, on }),
          exec("git", ["for-each-ref", "refs/heads", "--format=%(refname:short)"], { cwd, on }),
        ]);
        if (context !== this.context) return;
        this.loaded = Date.now();
        this.here = here.code === 0 ? JSON.parse(here.stdout) : null;
        this.local = new Set(heads.code === 0 ? heads.stdout.split("\n").filter(Boolean) : []);
        if (all.code !== 0) {
          const err = all.stderr.trim();
          this.list = null;
          this.error = /not a git repository/i.test(err) ? "Not a git repository." : /no git remotes|could not determine/i.test(err) ? "No GitHub remote." : err;
          return;
        }
        this.list = JSON.parse(all.stdout);
        this.error = null;
        writeCache(this.cache, key, { here: this.here, list: this.list, local: [...this.local], limit: this.limit });
        if (this.selected) this.detail = [this.here, ...this.list].find((p) => p?.number === this.selected) ?? this.detail;
      } catch (e) {
        if (context === this.context) this.error = `Couldn't run gh: ${e}`;
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  restore() {
    this.key = JSON.stringify([this.context, this.filter]);
    const c = this.cache[this.key];
    this.here = c?.here ?? null; this.list = c?.list ?? null; this.local = new Set(c?.local ?? []);
    this.loaded = c?.at ?? 0; this.error = null; this.limit = c?.limit ?? PAGE;
  }

  browse(url) {
    if (url) exec(window()?.platform === "macos" ? "open" : "xdg-open", [url]).catch(() => {});
  }

  row(t, pr, key) {
    const checks = checksOf(pr);
    const count = (b) => checks.filter((c) => c.bucket === b).length;
    const state = stateOf(pr);
    const review = REVIEW[pr.reviewDecision];
    const color = { fail: t.ansi1, pending: t.working, pass: t.ansi2 };
    return v_flex().id(`pr-${key}-${pr.number}`).flex_none().px(8).py(5).gap(3).rounded(7)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.selected = pr.number; this.detail = pr; cx.notify(); })
      .child(h_flex().gap(8).items_center()
        .child(div().w(42).flex_none().text_size(11.5).text_color(state === "Draft" ? t.dim : t.ansi2).child(`#${pr.number}`))
        .child(div().flex_1().min_w(0).truncate().child(pr.title))
        .child(div().flex_none().w(28).text_size(10.5).text_color(t.dim).text_right().child(ago(pr.updatedAt))))
      .child(h_flex().pl(50).gap(8).items_center().text_size(10.5).text_color(t.muted)
        .child(div().min_w(0).max_w(160).truncate().child(pr.headRefName))
        .when(this.local.has(pr.headRefName), (el) => el.child(div().flex_none().px(5).h(16).flex().items_center().rounded(4).bg(t.raised).child("local")))
        .when(state === "Draft", (el) => el.child(div().flex_none().text_color(t.dim).child("Draft")))
        .children(["fail", "pending", "pass"].filter((b) => count(b)).map((b) =>
          div().flex_none().text_color(color[b]).child(`${{ fail: "×", pending: "•", pass: "✓" }[b]}${count(b)}`)))
        .when(Boolean(review), (el) => el.child(div().flex_none().truncate().child(review))));
  }

  detailView(t) {
    const pr = this.detail;
    const checks = checksOf(pr);
    const count = (b) => checks.filter((c) => c.bucket === b).length;
    const color = { fail: t.ansi1, pending: t.working, pass: t.ansi2, skip: t.dim };
    const symbol = { fail: "×", pending: "•", pass: "✓", skip: "–" };
    const state = stateOf(pr);
    const stateColor = { Open: t.ansi2, Draft: t.dim, Merged: t.ansi5, Closed: t.ansi1 }[state] ?? t.dim;
    const review = REVIEW[pr.reviewDecision];
    return v_flex().flex_1().min_h(0)
      .child(v_flex().flex_none().p(12).gap(6).border_b(1).border_color(t.border)
        .child(h_flex().gap(8).items_center()
          .child(div().id("back").px(6).h(22).flex().items_center().rounded(6).text_size(11.5).text_color(t.muted).cursor_pointer()
            .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => { this.selected = null; cx.notify(); }).child("← Pull requests"))
          .child(div().flex_1())
          .child(div().flex_none().px(6).h(18).rounded(5).bg(stateColor + "26").text_size(10.5).font_semibold().text_color(stateColor).flex().items_center().child(state)))
        .child(div().id("pr-title").font_semibold().cursor_pointer().hover((s) => s.text_color(t.accent)).on_click(() => this.browse(pr.url))
          .child(`#${pr.number} ${pr.title}`))
        .child(h_flex().gap(8).items_center().text_size(11).text_color(t.dim)
          .child(div().min_w(0).truncate().child(pr.headRefName ?? ""))
          .when(this.local.has(pr.headRefName), (el) => el.child(div().flex_none().px(5).h(16).flex().items_center().rounded(4).bg(t.raised).text_color(t.muted).child("local")))
          .child(div().flex_none().child(`by ${pr.author?.login ?? "?"}`)))
        .child(h_flex().gap(12).text_size(11.5)
          .child(div().text_color(color.fail).child(`${count("fail")} failing`))
          .child(div().text_color(color.pending).child(`${count("pending")} pending`))
          .child(div().text_color(color.pass).child(`${count("pass")} passing`))
          .when(Boolean(review), (el) => el.child(div().text_color(t.muted).child(review)))))
      .child(v_flex().id("checks").flex_1().min_h(0).p(6).overflow_y_scrollbar()
        .when(!checks.length, (el) => el.child(div().p(8).text_color(t.dim).child("No checks.")))
        .children(checks.map((c, i) => h_flex().id(`ck-${i}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7)
          .when(Boolean(c.url), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => this.browse(c.url)))
          .child(div().w(12).flex_none().text_color(color[c.bucket]).child(symbol[c.bucket]))
          .child(div().flex_1().min_w(0).truncate().text_color(c.bucket === "skip" ? t.dim : t.foreground).child(c.name)))));
  }

  render(cx) {
    const t = theme();
    const loc = location(), context = JSON.stringify(loc);
    if (context !== this.context) {
      this.context = context; this.loc = loc; this.selected = null; this.restore();
    }
    if (visible() && !this.loading && Date.now() - (this.loaded ?? 0) > TTL) this.load(cx);
    const frame = v_flex().id("pr").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background)
      .border_1().border_color(t.border).text_color(t.foreground).text_size(13);
    if (this.selected && this.detail) return frame.child(this.detailView(t));

    const here = this.here?.state === "OPEN" ? this.here : null;
    const rest = (this.list ?? []).filter((p) => p.number !== here?.number);
    const chip = (id, label) => div().id(`f-${id}`).px(8).h(22).flex().items_center().rounded(6).text_size(11.5).cursor_pointer()
      .when(this.filter === id, (el) => el.bg(t.raised)).text_color(this.filter === id ? t.foreground : t.muted)
      .on_click((_e, cx) => { if (this.filter !== id) { this.filter = id; this.restore(); cx.notify(); } }).child(label);
    const section = (label) => div().px(8).pt(10).pb(4).text_size(10.5).font_semibold().text_color(t.dim).child(label);

    return frame
      .child(h_flex().h(42).flex_none().px(10).gap(4).items_center().border_b(1).border_color(t.border)
        .child(chip("open", "Open")).child(chip("mine", "Mine"))
        .child(div().flex_1())
        .child(div().id("pr-refresh").text_size(11).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => this.load(cx)).child(this.loading ? "Loading…" : "Refresh")))
      .child(v_flex().id("list").flex_1().min_h(0).p(6).overflow_y_scrollbar()
        .when(Boolean(here), (el) => el.child(section("This branch")).child(this.row(t, here, "here")))
        .when(Boolean(this.error), (el) => el.child(div().p(8).text_color(t.dim).child(this.error)))
        .when(!this.error && !this.list, (el) => el.child(div().p(8).text_color(t.dim).child(loc.cwd ? "Loading…" : "No folder.")))
        .when(Boolean(this.list), (el) => el
          .when(Boolean(here), (el) => el.child(section(this.filter === "mine" ? "Mine" : "Open")))
          .when(!rest.length, (el) => el.child(div().p(8).text_color(t.dim).child(this.filter === "mine" ? "No open pull requests of yours." : "No other open pull requests.")))
          .children(rest.map((p) => this.row(t, p, "list")))
          .when(this.list.length >= this.limit, (el) => el.child(div().id("pr-more").mx(8).my(6).h(26).flex().items_center().justify_center().rounded(7)
            .text_size(11.5).text_color(t.muted).bg(t.raised).cursor_pointer().hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => { if (!this.loading) { this.limit += PAGE; this.load(cx); } })
            .child(this.loading ? "Loading…" : "Load more")))));
  }
}
