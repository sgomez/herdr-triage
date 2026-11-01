// Preview and reply for one agent. Every action re-reads the terminal first and refuses
// if its state changed since what's on screen, so nothing answers a request you didn't see.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea } from "gpui-base";
import { agents, terminals, spaces, focused, hc, run, theme, shared, settings, layout } from "herdr";
import { duration } from "./lib.js";
import { shown } from "./layout.js";

const LINES = 40;

const visible = () => shown(layout(), "triage-reply");

const LABEL = { blocked: "Blocked", error: "Error", working: "Working", done: "Done", idle: "Idle" };
const stateOf = (info) => info?.status?.state ?? null;
const parse = (r) => { try { return r.code === 0 ? JSON.parse(r.stdout) : null; } catch { return null; } };

export default class Reply extends View {
  init(_props, cx) {
    this.input = TextareaState.new({ placeholder: "Message to the agent" });
    this.input.set_rows(3);
    this.input.on("submit", (_e, cx) => this.send(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.handle = cx.focus_handle();
    cx.timer.every(2500, (cx) => { if (visible() && this.addr) this.refresh(cx); });
    cx.timer.every(30000, (cx) => cx.notify());
  }

  // The inbox's pick wins until focus moves somewhere else.
  target() {
    const f = focused();
    const here = f?.agent ?? agents().find((a) => a.address === f?.terminal)?.address ?? null;
    const pick = shared("triage.target");
    if (pick && pick !== this.seenPick) { this.seenPick = pick; this.override = pick; this.overrideFocus = here; }
    if (this.override && here !== this.overrideFocus) this.override = null;
    const live = new Set(terminals().filter((k) => k.state === "live").map((k) => k.address));
    if (this.override && live.has(this.override)) return this.override;
    return here;
  }

  refresh(cx) {
    const addr = this.addr;
    if (!addr || this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const [get, read] = await Promise.all([hc(["get", addr, "--json"]), hc(["read", addr, "--lines", String(LINES)])]);
        if (addr !== this.addr) return;
        const info = parse(get);
        if (!info || info.state !== "live") { this.info = info; this.gone = true; return; }
        this.gone = false;
        // A changed state invalidates a warning about the previous one.
        if (this.info && (stateOf(this.info) !== stateOf(info) || this.info.status_ms !== info.status_ms)) this.stale = false;
        this.info = info;
        const lines = read.stdout.replace(/\s+$/, "").split("\n");
        this.screen = lines.slice(-LINES);
      } catch (e) {
        if (addr === this.addr) this.note = `Couldn't read ${addr}: ${e}`;
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  // Fresh state, or null (with a note) if it moved on from what the panel shows.
  async guard() {
    const fresh = parse(await hc(["get", this.addr, "--json"]));
    if (!fresh || fresh.state !== "live") { this.note = "That terminal is no longer live."; return null; }
    if (stateOf(fresh) !== stateOf(this.info) || fresh.status_ms !== this.info?.status_ms) {
      this.info = fresh;
      this.stale = true;
      this.note = "Its state changed while you were looking. Read the screen again before acting.";
      return null;
    }
    return fresh;
  }

  act(cx, work) {
    if (this.busy || !this.addr || !this.info) return;
    this.busy = true;
    this.note = null;
    cx.spawn(async (cx) => {
      try {
        const fresh = await this.guard();
        if (fresh) {
          const r = await work(fresh);
          if (r && r.code !== 0) this.note = (r.stderr || r.stdout).trim() || `Failed (exit ${r.code})`;
        }
      } catch (e) {
        this.note = String(e);
      } finally {
        this.busy = false;
        this.refresh(cx);
        cx.notify();
      }
    });
    cx.notify();
  }

  send(cx) {
    const text = this.input.value().trim();
    if (!text) return;
    this.act(cx, async (fresh) => {
      const blocked = stateOf(fresh) === "blocked";
      const r = await hc(["send", this.addr, text, ...(blocked ? ["--force"] : [])]);
      // The draft stays unless it went through.
      if (r.code === 0) this.input.set_value("");
      return r;
    });
  }

  approve(cx) {
    this.act(cx, (fresh) => (stateOf(fresh) === "blocked" ? hc(["keys", this.addr, "enter"]) : null));
  }

  interrupt(cx) {
    this.act(cx, () => hc(["interrupt", this.addr]));
  }

  button(t, id, label, enabled, primary, onClick) {
    return div().id(id).h(30).px(12).flex().flex_none().items_center().rounded(8).text_size(12)
      .bg(enabled ? (primary ? t.solid : t.raised) : t.raised).text_color(enabled ? (primary ? t.solid_foreground : t.foreground) : t.dim)
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.85)).on_click((_e, cx) => onClick(cx)))
      .child(label);
  }

  render(cx) {
    const t = theme();
    const draft = shared("triage.draft");
    if (draft && draft.at !== this.draftAt) { this.draftAt = draft.at; this.input.set_value(draft.text); }
    const addr = this.target();
    if (addr !== this.addr) {
      this.addr = addr; this.info = null; this.screen = []; this.note = null; this.stale = false; this.gone = false;
      if (addr) this.refresh(cx);
    }
    const frame = v_flex().id("reply").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background)
      .border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle);
    if (!addr) return frame.child(div().p(16).text_color(t.dim).child("Pick an agent in the inbox to see its screen and reply."));

    const k = terminals().find((x) => x.address === addr);
    const a = agents().find((x) => x.address === addr);
    const st = stateOf(this.info) ?? k?.status ?? a?.status ?? null;
    const tab = a && spaces().flatMap((s) => s.tabs.map((tb) => ({ s, tb }))).find((e) => e.tb.id === a.tab);
    const name = a ? `${a.space_name} · ${tab?.tb.named ? tab.tb.name : a.title || a.program?.name}` : k?.name || k?.program?.name || addr;
    const msg = this.info?.status?.msg ?? k?.report?.msg ?? "";
    const blocked = st === "blocked";
    const since = this.info?.status_ms;
    const prog = a?.program ?? k?.program;
    const pic = prog?.icon ? (prog.tint ? svg(prog.icon).size(16).flex_none().text_color(t.foreground) : image(prog.icon).w(16).h(16).flex_none()) : null;
    const color = t[st === "error" ? "blocked" : st] ?? t.dim;
    const hasText = Boolean(this.input.value().trim());
    const mono = settings().font_family ?? "JetBrains Mono";

    return frame
      .child(h_flex().h(42).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(pic), (el) => el.child(pic))
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(name))
        .when(Boolean(st), (el) => el.child(div().flex_none().px(6).h(18).rounded(5).bg(color + "26").text_size(10.5).font_semibold()
          .text_color(color).flex().items_center().child(LABEL[st] ?? st)))
        .when(Boolean(since) && (blocked || st === "error"), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(Date.now() - since))))
        .child(div().id("go").flex_none().px(6).h(22).flex().items_center().rounded(6).text_size(11.5).text_color(t.muted).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Go to its terminal")
          .on_click(() => (a ? run("agent.focus", { terminal: addr }) : run("terminal.peek", { terminal: addr }))).child("Go")))
      .when(Boolean(msg) && (blocked || st === "error"), (el) => el.child(v_flex().flex_none().m(10).mb(0).p(10).gap(4).rounded(8)
        .bg(t.blocked + "14").border_1().border_color(t.blocked + "33")
        .child(div().text_size(11).font_medium().text_color(t.blocked).child(st === "error" ? "Error" : "What it asks"))
        .child(div().text_size(12.5).child(msg))))
      .child(v_flex().id("screen").flex_1().min_h(0).m(10).p(8).rounded(8).bg(t.canvas).overflow_y_scrollbar()
        .font_family(mono).text_size(11).text_color(t.muted)
        .when(this.gone, (el) => el.child(div().text_color(t.dim).child("The terminal has ended.")))
        .when(!this.gone && !this.screen?.length, (el) => el.child(div().text_color(t.dim).child(this.loading ? "Reading…" : "Empty screen")))
        .children((this.screen ?? []).map((line, i) => div().id(`l-${i}`).h(15).flex_none().whitespace_nowrap().truncate().child(line || " "))))
      .when(Boolean(this.note), (el) => el.child(div().px(12).pb(6).text_size(11.5).text_color(this.stale ? t.blocked : t.ansi1).child(this.note)))
      .child(v_flex().flex_none().p(10).pt(0).gap(8)
        .child(div().id("msg").w_full().min_h(64).p(8).rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Textarea.new(this.input).w_full().h(52).text_size(12.5).text_color(t.foreground)))
        .child(h_flex().gap(8).items_center()
          .child(this.button(t, "send", this.busy ? "Sending…" : blocked ? "Answer" : "Send", hasText && !this.busy && !this.gone, true, (cx) => this.send(cx)))
          .when(blocked, (el) => el.child(this.button(t, "approve", "Press Enter", !this.busy, false, (cx) => this.approve(cx))))
          .when(blocked || st === "working", (el) => el.child(this.button(t, "stop", "Interrupt", !this.busy, false, (cx) => this.interrupt(cx))))
          .child(div().flex_1())
          .when(blocked, (el) => el.child(div().text_size(10.5).text_color(t.dim).child("Read the screen first")))));
  }
}
