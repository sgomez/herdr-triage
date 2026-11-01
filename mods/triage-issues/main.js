// GitHub issues of the focused folder's repo, with the ones the focused terminal mentions first.
// Handing an issue to an agent only fills the Reply draft, so it still goes through its checks.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, TextView } from "gpui-base";
import { spaces, panes, focused, exec, hc, run, theme, layout, window, setShared, openOverlay } from "herdr";
import { linkRefs, ago } from "./lib.js";
import { shown, reveal } from "./layout.js";

const visible = () => shown(layout(), "triage-issues");

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, terminal: f?.agent ?? f?.terminal ?? null };
}

const LIST = "number,title,state,labels,assignees,updatedAt,subIssuesSummary";
// gh calls hit GitHub's rate limit, so results are kept per folder and filter and reused for TTL.
const TTL = 5 * 60000;
const readCache = () => { try { return JSON.parse(localStorage.getItem("cache") ?? "{}"); } catch { return {}; } };
function writeCache(cache, key, entry) {
  cache[key] = { ...entry, at: Date.now() };
  const keys = Object.keys(cache).sort((a, b) => cache[b].at - cache[a].at);
  for (const k of keys.slice(30)) delete cache[k];
  try { localStorage.setItem("cache", JSON.stringify(cache)); } catch {}
}
const PAGE = 30;
const VIEW = "number,title,state,body,labels,assignees,url,author,comments";

export default class Issues extends View {
  init(_props, cx) {
    this.filter = "open";
    this.refs = [];
    this.extras = {};
    this.comment = TextareaState.new({ placeholder: "Comment" });
    this.comment.set_rows(3);
    this.label = InputState.new({ placeholder: "Add label" });
    this.label.on("submit", (_e, cx) => this.addLabel(cx));
    this.cache = readCache();
    cx.timer.every(30000, (cx) => cx.notify());
    cx.timer.every(5000, (cx) => { if (visible()) this.scan(cx); });
  }

  gh(args) {
    const { cwd, on } = this.loc;
    return exec("gh", args, { cwd, on });
  }

  load(cx) {
    if (!this.loc?.cwd || this.loading) return;
    const context = this.context, key = this.key;
    const args = ["issue", "list", "--json", LIST, "--limit", String(this.limit ?? PAGE)];
    if (this.filter === "mine") args.push("--assignee", "@me");
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const r = await this.gh(args);
        if (context !== this.context) return;
        this.loaded = Date.now();
        if (r.code !== 0) {
          const err = r.stderr.trim();
          this.list = null;
          this.error = /not a git repository/i.test(err) ? "Not a git repository." : /no git remotes|could not determine/i.test(err) ? "No GitHub remote." : err;
          return;
        }
        this.list = JSON.parse(r.stdout);
        this.error = null;
        writeCache(this.cache, key, { list: this.list, limit: this.limit });
      } catch (e) {
        if (context === this.context) this.error = `Couldn't run gh: ${e}`;
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  // `#123` on the focused terminal's screen; ones outside the list are looked up once.
  scan(cx) {
    const addr = this.loc?.terminal, context = this.context;
    if (!addr || this.scanning) return;
    this.scanning = true;
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["read", addr, "--lines", "200"]);
        if (context !== this.context || r.code !== 0) return;
        const seen = [...new Set([...r.stdout.matchAll(/(?<![\w/&])#(\d{1,6})\b/g)].map((m) => Number(m[1])))].reverse().slice(0, 8);
        if (JSON.stringify(seen) !== JSON.stringify(this.refs)) { this.refs = seen; cx.notify(); }
        for (const n of seen) {
          if (n in this.extra || this.list?.some((i) => i.number === n)) continue;
          this.extra[n] = null;
          const v = await this.gh(["issue", "view", String(n), "--json", LIST]);
          if (context !== this.context) return;
          // PR numbers and dead references fail here and stay hidden.
          this.extra[n] = v.code === 0 ? JSON.parse(v.stdout) : false;
          cx.notify();
        }
      } catch {} finally { this.scanning = false; }
    });
  }

  restore() {
    this.key = JSON.stringify([this.context, this.filter]);
    const c = this.cache[this.key];
    this.list = c?.list ?? null; this.loaded = c?.at ?? 0; this.error = null; this.limit = c?.limit ?? PAGE;
  }

  open(cx, n, from) {
    this.history = from ? [...(this.history ?? []), from] : [];
    this.selected = n;
    this.detail = null;
    this.confirmClose = false;
    this.note = null;
    this.fetch(cx);
  }

  fetch(cx) {
    const n = this.selected, context = this.context;
    cx.spawn(async (cx) => {
      try {
        const r = await this.gh(["issue", "view", String(n), "--json", VIEW]);
        if (context !== this.context || n !== this.selected) return;
        if (r.code === 0) this.detail = JSON.parse(r.stdout);
        else if (this.history?.length) {
          // Most likely a pull request: GitHub's own page shows either.
          this.browse(this.pending);
          this.selected = this.history.pop();
          this.fetch(cx);
          return;
        } else this.note = r.stderr.trim();
      } catch (e) { this.note = String(e); }
      cx.notify();
    });
  }

  act(cx, args, after) {
    if (this.busy) return;
    this.busy = true;
    this.note = null;
    cx.spawn(async (cx) => {
      try {
        const r = await this.gh(args);
        if (r.code !== 0) this.note = (r.stderr || r.stdout).trim() || `Failed (exit ${r.code})`;
        else { after?.(); this.fetch(cx); this.load(cx); }
      } catch (e) { this.note = String(e); }
      finally { this.busy = false; cx.notify(); }
    });
    cx.notify();
  }

  addLabel(cx) {
    const name = this.label.value().trim();
    if (name && this.selected) this.act(cx, ["issue", "edit", String(this.selected), "--add-label", name], () => this.label.set_value(""));
  }

  handOff(d) {
    setShared("triage.draft", { at: Date.now(), text: `Work on issue #${d.number}: ${d.title}\n${d.url}` });
    reveal({ layout, panes, run }, "triage-reply");
  }

  // Issues of this repo open here; everything else in the browser.
  markdown(cx, d, id, text) {
    const base = d.url.replace(/\/issues\/\d+$/, "");
    return TextView.markdown(id, linkRefs(text, base)).w_full().selectable()
      .on_link_click((url, cx) => {
        const n = url.startsWith(`${base}/issues/`) ? Number(/^\/issues\/(\d+)/.exec(url.slice(base.length))?.[1]) : NaN;
        if (!n) return this.browse(url);
        this.pending = url;
        this.open(cx, n, d.number);
      });
  }

  browse(url) {
    if (url) exec(window()?.platform === "macos" ? "open" : "xdg-open", [url]).catch(() => {});
  }

  button(t, id, label, enabled, onClick, tone) {
    return div().id(id).h(26).px(10).flex().flex_none().items_center().rounded(7).text_size(11.5)
      .bg(tone === "primary" && enabled ? t.solid : t.raised)
      .text_color(!enabled ? t.dim : tone === "primary" ? t.solid_foreground : tone === "danger" ? t.ansi1 : t.foreground)
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.85)).on_click((_e, cx) => onClick(cx)))
      .child(label);
  }

  row(t, cx, i, onScreen) {
    const sub = i.subIssuesSummary?.total ? i.subIssuesSummary : null;
    const labels = i.labels ?? [];
    return v_flex().id(`is-${onScreen ? "s" : "l"}-${i.number}`).flex_none().px(8).py(5).gap(3).rounded(7)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.open(cx, i.number))
      .child(h_flex().gap(8).items_center()
        .child(div().w(42).flex_none().text_size(11.5).text_color(i.state === "OPEN" ? t.ansi2 : t.ansi5).child(`#${i.number}`))
        .child(div().flex_1().min_w(0).truncate().child(i.title))
        .when(i.assignees?.length > 0, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(i.assignees.map((a) => a.login).join(", "))))
        .child(div().flex_none().w(28).text_size(10.5).text_color(t.dim).text_right().child(ago(i.updatedAt))))
      .when(Boolean(sub) || labels.length > 0, (el) => el.child(h_flex().pl(50).gap(6).items_center().text_size(10.5)
        .when(Boolean(sub), (el) => el.child(h_flex().flex_none().gap(5).items_center().text_color(sub?.completed === sub?.total ? t.ansi2 : t.muted)
          .child(div().w(36).h(4).rounded(2).bg(t.raised).child(div().h_full().rounded(2).bg(t.ansi2).w(36 * (sub?.percentCompleted ?? 0) / 100)))
          .child(`${sub?.completed}/${sub?.total}`)))
        .children(labels.slice(0, 2).map((l) => div().flex_none().max_w(120).truncate().px(5).h(16).flex().items_center().rounded(4).bg(`#${l.color}33`).text_color(t.foreground).child(l.name)))
        .when(labels.length > 2, (el) => el.child(div().text_color(t.dim).child(`+${labels.length - 2}`)))));
  }

  detailView(t, cx) {
    const d = this.detail;
    const back = div().id("back").px(6).h(22).flex().items_center().rounded(6).text_size(11.5).text_color(t.muted).cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => {
        if (this.history?.length) { this.selected = this.history.pop(); this.detail = null; this.note = null; this.fetch(cx); }
        else { this.selected = null; cx.notify(); }
      }).child(this.history?.length ? `← #${this.history.at(-1)}` : "← Issues");
    if (!d) return v_flex().flex_1().p(12).gap(8).child(back).child(div().text_color(t.dim).child(this.note ?? "Loading…"));
    const open = d.state === "OPEN";
    return v_flex().flex_1().min_h(0)
      .child(v_flex().flex_none().p(12).gap(6).border_b(1).border_color(t.border)
        .child(h_flex().gap(8).items_center().child(back).child(div().flex_1())
          .child(div().text_size(11).text_color(open ? t.ansi2 : t.ansi5).child(open ? "Open" : "Closed")))
        .child(div().id("title").font_semibold().cursor_pointer().hover((s) => s.text_color(t.accent)).on_click(() => this.browse(d.url))
          .child(`#${d.number} ${d.title}`))
        .child(h_flex().flex_wrap().gap(6).items_center().text_size(11)
          .child(div().text_color(t.dim).child(`by ${d.author?.login ?? "?"}`))
          .children(d.labels.map((l) => h_flex().id(`lb-${l.name}`).px(6).h(18).gap(4).items_center().rounded(5)
            .bg(`#${l.color}33`).child(l.name)
            .child(div().id(`rm-${l.name}`).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
              .on_click((_e, cx) => this.act(cx, ["issue", "edit", String(d.number), "--remove-label", l.name])).child("×"))))
          .child(div().text_color(t.muted).child(d.assignees.length ? `→ ${d.assignees.map((a) => a.login).join(", ")}` : "Unassigned"))))
      .child(v_flex().id("body").flex_1().min_h(0).p(12).gap(10).overflow_y_scrollbar().text_size(12.5)
        .child(d.body ? this.markdown(cx, d, `md-${d.number}`, d.body) : div().text_color(t.dim).child("No description."))
        .children(d.comments.slice(-5).map((c, i) => v_flex().id(`cm-${i}`).gap(3).pt(8).border_t(1).border_color(t.border)
          .child(div().text_size(11).text_color(t.dim).child(`${c.author?.login ?? "?"} · ${ago(c.createdAt)}`))
          .child(this.markdown(cx, d, `md-${d.number}-${i}`, c.body ?? "")))))
      .when(Boolean(this.note), (el) => el.child(div().px(12).pb(6).text_size(11.5).text_color(t.ansi1).child(this.note)))
      .child(v_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("comment").w_full().p(8).rounded(8).border_1().border_color(t.border).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Textarea.new(this.comment).w_full().h(52).text_size(12.5).text_color(t.foreground)))
        .child(h_flex().gap(6).items_center().flex_wrap()
          .child(this.button(t, "send-comment", "Comment", !this.busy, (cx) => {
            const body = this.comment.value().trim();
            if (body) this.act(cx, ["issue", "comment", String(d.number), "--body", body], () => this.comment.set_value(""));
          }, "primary"))
          .child(this.button(t, "assign", "Assign me", !this.busy, (cx) => this.act(cx, ["issue", "edit", String(d.number), "--add-assignee", "@me"])))
          .child(this.button(t, "start", "Start agent", true, () => openOverlay({ mod: "triage-launch", kind: "dialog", width: 560, height: 470,
            props: { space: spaces().find((s) => s.active)?.id, folder: this.loc?.cwd, issue: { number: d.number, title: d.title, url: d.url } } }), "primary"))
          .child(this.button(t, "hand", "Hand to agent", true, () => this.handOff(d)))
          .child(div().flex_1())
          .child(open
            ? this.button(t, "close", this.confirmClose ? "Confirm close" : "Close", !this.busy, (cx) => {
                if (!this.confirmClose) { this.confirmClose = true; cx.notify(); return; }
                this.confirmClose = false;
                this.act(cx, ["issue", "close", String(d.number)]);
              }, "danger")
            : this.button(t, "reopen", "Reopen", !this.busy, (cx) => this.act(cx, ["issue", "reopen", String(d.number)]))))
        .child(div().id("label").w_full().h(28).px(8).flex().items_center().rounded(7).border_1().border_color(t.border).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Input.new(this.label).w_full().text_size(12).text_color(t.foreground))));
  }

  render(cx) {
    const t = theme();
    const loc = location(), context = JSON.stringify([loc.cwd, loc.on]);
    if (context !== this.context) {
      this.context = context; this.extra = this.extras[context] ??= {}; this.selected = null;
      this.loc = loc; this.restore();
    }
    if (visible() && !this.loading && Date.now() - (this.loaded ?? 0) > TTL) this.load(cx);
    if (loc.terminal !== this.loc?.terminal) { this.loc = loc; this.refs = []; this.scan(cx); }
    const frame = v_flex().id("issues").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background)
      .border_1().border_color(t.border).text_color(t.foreground).text_size(13);
    if (this.selected) return frame.child(this.detailView(t, cx));

    const byNumber = new Map((this.list ?? []).map((i) => [i.number, i]));
    const onScreen = this.refs.map((n) => byNumber.get(n) ?? this.extra[n]).filter(Boolean);
    const chip = (id, label) => div().id(`f-${id}`).px(8).h(22).flex().items_center().rounded(6).text_size(11.5).cursor_pointer()
      .when(this.filter === id, (el) => el.bg(t.raised)).text_color(this.filter === id ? t.foreground : t.muted)
      .on_click((_e, cx) => { if (this.filter !== id) { this.filter = id; this.restore(); cx.notify(); } }).child(label);
    const section = (label) => div().px(8).pt(10).pb(4).text_size(10.5).font_semibold().text_color(t.dim).child(label);

    return frame
      .child(h_flex().h(42).flex_none().px(10).gap(4).items_center().border_b(1).border_color(t.border)
        .child(chip("open", "Open")).child(chip("mine", "Mine"))
        .child(div().flex_1())
        .child(div().id("refresh").text_size(11).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => this.load(cx)).child(this.loading ? "Loading…" : "Refresh")))
      .child(v_flex().id("list").flex_1().min_h(0).p(6).overflow_y_scrollbar()
        .when(onScreen.length > 0, (el) => el.child(section("On screen")).children(onScreen.map((i) => this.row(t, cx, i, true))))
        .when(Boolean(this.error), (el) => el.child(div().p(8).text_color(t.dim).child(this.error)))
        .when(!this.error && !this.list, (el) => el.child(div().p(8).text_color(t.dim).child(loc.cwd ? "Loading…" : "No folder.")))
        .when(Boolean(this.list), (el) => el
          .when(onScreen.length > 0, (el) => el.child(section(this.filter === "mine" ? "Assigned to me" : "Open")))
          .when(!this.list.length, (el) => el.child(div().p(8).text_color(t.dim).child("No issues.")))
          .children(this.list.map((i) => this.row(t, cx, i, false)))
          .when(this.list.length >= this.limit, (el) => el.child(div().id("issues-more").mx(8).my(6).h(26).flex().items_center().justify_center().rounded(7)
            .text_size(11.5).text_color(t.muted).bg(t.raised).cursor_pointer().hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => { if (!this.loading) { this.limit += PAGE; this.load(cx); } })
            .child(this.loading ? "Loading…" : "Load more")))));
  }
}
