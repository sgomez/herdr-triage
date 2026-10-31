// Inbox: a fixed "Needs you" band, then spaces and tabs in their own stable order.
// Pins and snoozes live in shared state so the snooze popup (another copy) can write them.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, spaces, run, hc, exec, layout, window, theme, shared, setShared, setAgentOrder, openOverlay, closeOverlay, props, nextCommand } from "herdr";
import { rank, machineOf, qualify, clean, firstLine, duration } from "./lib.js";

const ICON = (n) => `mods/workspace-chrome/${n}.svg`;

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

// Shape as well as color, so states read without telling hues apart.
function mark(t, status) {
  if (status === "working") return svg(ICON("spinner")).size(12).mx(1).flex_none().text_color(t.working).spin(900);
  if (status === "blocked" || status === "error")
    return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked)
      .flex().items_center().justify_center().child(status === "error" ? "×" : "!");
  if (status === "done") return div().size(8).mx(3).flex_none().rounded(4).bg(t.done);
  if (status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
  return div().size(7).mx(3).flex_none();
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const f = find(child, id); if (f) return f; }
  return null;
}

// Same rule as workspace-chrome: the rail is a width, so its toggle and ours agree.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;
function toggleSidebar() {
  if (!narrow()) setShared("sidebar.width", find(layout(), "sidebar")?.size?.px);
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 300) : window()?.platform === "macos" ? 76 : 44 });
}

const SNOOZES = () => {
  const now = new Date();
  const at = (days, hour) => { const d = new Date(now); d.setDate(d.getDate() + days); d.setHours(hour, 0, 0, 0); return d.getTime(); };
  return [
    { id: "1h", label: "1 hour", until: now.getTime() + 3600000 },
    ...(now.getHours() < 17 ? [{ id: "tarde", label: "This evening (18:00)", until: at(0, 18) }] : []),
    { id: "manana", label: "Tomorrow (9:00)", until: at(1, 9) },
  ];
};

function showReply(addr) {
  setShared("triage.target", addr);
  run("layout.select", { stack: "panel-body", child: "reply" });
  run("layout.show", { id: "panel" });
}

export default class Triage extends View {
  init(_props, cx) {
    if (props()?.snooze || props()?.newSpace) return;
    // The shipped tabs mod only restores the side panel on tabs listed here.
    const panels = shared("workspace.panels") ?? ["files", "changes"];
    const missing = ["reply", "history", "pr", "issues", "settings"].filter((p) => !panels.includes(p));
    if (missing.length) setShared("workspace.panels", [...panels, ...missing]);
    this.folded = new Set(["snoozed", "archived"]);
    // When each terminal entered its current state; status_ms can lag, so we keep our own.
    this.since = JSON.parse(localStorage.getItem("since") ?? "{}");
    this.machines = [];
    this.repos = {};
    const loadMachines = () => cx.spawn(async (cx) => {
      try {
        const r = await hc(["machine", "ls", "--json"]);
        if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary && m.state === "connected").map((m) => m.name);
      } catch {}
      cx.notify();
    });
    loadMachines();
    cx.timer.every(30000, (cx) => { loadMachines(); cx.notify(); });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "next-blocked" && this.needs?.[0]) this.pick(this.needs[0].address);
        if (c === "next-done") {
          const d = this.order?.find((addr) => agents().find((a) => a.address === addr)?.status === "done");
          if (d) run("agent.focus", { terminal: d });
        }
        cx.notify();
      }
    });
  }

  // Which repo a space's folder belongs to, and whether it is that repo's main checkout.
  repoOf(cx, s) {
    const key = `${s.machine ?? ""}|${s.folder}`;
    if (!s.folder || key in this.repos) return this.repos[key];
    this.repos[key] = null;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"], { cwd: s.folder, on: s.machine });
        const [common, top] = r.stdout.trim().split("\n");
        if (r.code === 0) this.repos[key] = { id: `${s.machine ?? ""}|${common}`, main: common === `${top}/.git` };
      } catch {}
      cx.notify();
    });
    return null;
  }

  pick(addr) {
    run("agent.focus", { terminal: addr });
    showReply(addr);
  }

  track(live, now) {
    let dirty = false;
    for (const k of live) {
      const s = k.status ?? "none";
      if (this.since[k.address]?.s === s) continue;
      const reported = typeof k.status_ms === "number" && k.status_ms <= now ? k.status_ms : now;
      this.since[k.address] = { s, at: this.since[k.address] ? now : reported };
      dirty = true;
    }
    if (!dirty) return;
    const listed = new Set(live.map((k) => k.address));
    for (const [a, v] of Object.entries(this.since)) if (!listed.has(a) && now - v.at > 7 * 86400000) delete this.since[a];
    localStorage.setItem("since", JSON.stringify(this.since));
  }

  snoozeMenu(t) {
    const tab = props().snooze;
    const close = () => closeOverlay(props().overlay);
    const item = (id, label, act) => h_flex().id(id).h(30).px(8).rounded(7).items_center().text_color(t.foreground)
      .hover((el) => el.bg(t.hover)).on_click(() => { act(); close(); }).child(label);
    const snoozed = shared("triage.snoozed") ?? {};
    return v_flex().w_full().p(5).bg(t.popover).text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Snooze until"))
      .children(SNOOZES().map((s) => item(`sn-${s.id}`, s.label, () => setShared("triage.snoozed", { ...snoozed, [tab]: s.until }))))
      .when(tab in snoozed, (el) => el.child(item("sn-off", "Wake now", () => {
        const { [tab]: _, ...rest } = snoozed;
        setShared("triage.snoozed", rest);
      })));
  }

  newSpaceMenu(t) {
    const close = () => closeOverlay(props().overlay);
    const item = (id, ic, label, act) => h_flex().id(id).h(30).px(8).gap(8).rounded(7).items_center().text_color(t.foreground)
      .hover((el) => el.bg(t.hover)).on_click(() => { act(); close(); }).child(svg(ICON(ic)).size(13).flex_none()).child(div().truncate().child(label));
    return v_flex().w_full().p(5).bg(t.popover).text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("New space on"))
      .child(item("ns-local", "monitor", "This computer", () => run("space.new")))
      .children(props().newSpace.map((m) => item(`ns-${m}`, "server", m, () => run("space.new", { machine: m }))));
  }

  render(cx) {
    const t = theme();
    if (props()?.snooze) return this.snoozeMenu(t);
    if (props()?.newSpace) return this.newSpaceMenu(t);
    const now = Date.now();
    const sps = spaces();
    const ags = agents();
    const agentBy = new Map(ags.map((a) => [a.address, a]));
    const live = terminals().filter((k) => k.state === "live");
    const termBy = new Map(live.map((k) => [k.address, k]));
    this.track(live, now);
    const sinceOf = (addr) => this.since[addr]?.at ?? now;

    const tabsById = new Map(sps.flatMap((s) => s.tabs.map((tb) => [tb.id, { tab: tb, space: s }])));
    // Sub-agents carry no labels: their place is their nearest labelled ancestor's.
    const placeOf = (k) => {
      for (let n = k, i = 0; n && i < 8; n = termBy.get(n.parent), i++) {
        const m = machineOf(n.address);
        const tab = qualify(n.labels?.["herdr.tab"], m);
        if (tab && tabsById.has(tab)) return tabsById.get(tab);
      }
      return null;
    };

    // The band: everyone blocked or failed, here or remote, pane or not; longest waiting first.
    // Seen: hidden from the band until the terminal's state changes again.
    const seen = shared("triage.seen") ?? {};
    const blocked = live.filter((k) => k.status === "blocked" || k.status === "error")
      .map((k) => ({ k, place: placeOf(k), wait: now - sinceOf(k.address), address: k.address }))
      .sort((a, b) => b.wait - a.wait);
    const isSeen = (n) => seen[n.address] === sinceOf(n.address);
    const needs = blocked.filter((n) => !isSeen(n));
    const seenNeeds = blocked.filter(isSeen);
    const keptSeen = Object.fromEntries(seenNeeds.map((n) => [n.address, seen[n.address]]));
    if (Object.keys(keptSeen).length !== Object.keys(seen).length) setShared("triage.seen", keptSeen);
    this.needs = needs;

    let pins = shared("triage.pins") ?? [];
    let snoozed = shared("triage.snoozed") ?? {};
    // A block wakes a snoozed tab, and so does its time.
    const awake = Object.keys(snoozed).filter((id) => !tabsById.has(id) || snoozed[id] <= now || tabsById.get(id).tab.status === "blocked");
    if (awake.length) {
      snoozed = Object.fromEntries(Object.entries(snoozed).filter(([id]) => !awake.includes(id)));
      setShared("triage.snoozed", snoozed);
    }
    const knownTabs = sps.length && pins.filter((id) => tabsById.has(id));
    if (knownTabs && knownTabs.length !== pins.length) { pins = knownTabs; setShared("triage.pins", pins); }

    const order = [...blocked.map((n) => n.address)];
    const kidsOf = (addr) => live.filter((k) => k.parent === addr);

    const tabTitle = (tab, lead) => {
      if (tab.named) return tab.name;
      const live = clean(lead?.title);
      const telling = live && live !== lead?.program?.name && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@");
      return telling ? live : lead?.program?.name ?? tab.name;
    };

    const actions = (tab, space) => {
      const isPinned = pins.includes(tab.id);
      const btn = (id, ic, tip, act) => div().id(id).flex_none().p(3).rounded(4).text_color(t.dim).cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
        .on_click((_e, cx) => { cx.stop_propagation(); act(); this.hovered = null; cx.notify(); })
        .child(svg(ICON(ic)).size(13));
      return h_flex().gap(1).flex_none()
        .child(btn(`pin-${tab.id}`, isPinned ? "pin-off" : "pin", isPinned ? "Unpin" : "Pin to the top",
          () => setShared("triage.pins", isPinned ? pins.filter((p) => p !== tab.id) : [...pins, tab.id])))
        .child(btn(`snz-${tab.id}`, "clock", "Snooze",
          () => openOverlay({ mod: "triage", kind: "popup", width: 200, height: 150, props: { snooze: tab.id } })))
        .child(btn(`arc-${tab.id}`, tab.settled ? "square" : "archive", tab.settled ? "Unarchive" : "Archive",
          () => run(tab.settled ? "tab.unsettle" : "tab.settle", { id: tab.id })));
    };

    const subRows = (addr, depth) => kidsOf(addr).flatMap((k) => {
      const st = k.status === "done" ? "idle" : k.status;
      order.push(k.address);
      return [h_flex().id(`sub-${k.address}`).h(24).flex_none().pl(28 + depth * 14).pr(8).gap(7).items_center().rounded(7)
        .text_size(12).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click(() => run("terminal.peek", { terminal: k.address }))
        .child(div().text_color(t.input).child("└"))
        .child(icon(k.program, 13, t.foreground) ?? div().w(13).flex_none())
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(k.name || k.template || k.program?.name || k.address))
        .child(mark(t, st)), ...subRows(k.address, depth + 1)];
    });

    const tabRows = (tab, space, withSpace) => {
      const mine = ags.filter((a) => a.tab === tab.id);
      const lead = mine[0];
      const focusedTab = space.active && tab.active;
      const unread = mine.some((a) => a.status === "done");
      const when = tab.changed_at ? now - tab.changed_at : null;
      const name = tabTitle(tab, lead);
      const row = h_flex().id(`tab-${tab.id}`).h(30).flex_none().px(8).gap(8).items_center().rounded(8).cursor_pointer()
        .when(focusedTab, (el) => el.bg(t.selected))
        .hover((s) => s.bg(t.hover))
        .on_hover((on, cx) => { if (on) this.hovered = tab.id; else if (this.hovered === tab.id) this.hovered = null; cx.notify(); })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: tab.id, space: space.id } } }); })
        .on_click(() => {
          if (lead) this.pick(lead.address);
          else { run("space.select", { id: space.id }); run("tab.select", { id: tab.id }); }
        })
        .child(icon(lead?.program, 15, t.foreground) ?? svg(ICON("terminal")).size(14).flex_none().text_color(t.dim))
        .child(h_flex().flex_1().min_w(0).gap(5)
          .child(div().min_w(0).truncate().text_color(lead && lead.status !== "idle" ? t.foreground : t.muted)
            .when(unread, (el) => el.font_semibold()).child(name))
          .when(withSpace, (el) => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`· ${space.name}`))))
        .when(this.hovered === tab.id, (el) => el.child(actions(tab, space)))
        .when(this.hovered !== tab.id && when !== null && Boolean(tab.status), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(when))))
        .child(mark(t, tab.status));
      const rows = [row];
      if (mine.length > 1) {
        for (const a of mine) {
          order.push(a.address);
          rows.push(h_flex().id(`ag-${a.address}`).h(26).flex_none().pl(28).pr(8).gap(7).items_center().rounded(7).text_size(12.5)
            .cursor_pointer().when(a.focused, (el) => el.bg(t.raised)).hover((s) => s.bg(t.hover))
            .on_click(() => this.pick(a.address))
            .child(icon(a.program, 13, t.foreground) ?? div())
            .child(div().flex_1().min_w(0).truncate().text_color(t.muted).when(a.status === "done", (el) => el.font_semibold()).child(clean(a.title) || a.program?.name || a.address))
            .child(mark(t, a.status)));
          rows.push(...subRows(a.address, 1));
        }
      } else if (lead) {
        order.push(lead.address);
        rows.push(...subRows(lead.address, 0));
      }
      return rows;
    };

    const header = (id, label, count, color, foldable = true) => {
      const open = !this.folded.has(id);
      return h_flex().id(`h-${id}`).px(8).pt(10).h(32).flex_none().gap(6).items_center().text_size(11).font_medium()
        .cursor_pointer().hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { if (!foldable) return; open ? this.folded.add(id) : this.folded.delete(id); cx.notify(); })
        .child(div().min_w(0).truncate().text_color(color ?? t.dim).child(label))
        .when(count !== null, (el) => el.child(div().text_color(t.dim).child(String(count))))
        .child(div().flex_1())
        .when(foldable, (el) => el.child(svg(ICON(open ? "chevron-down" : "chevron-right")).size(11).flex_none().text_color(t.dim)));
    };

    const all = sps.flatMap((s) => s.tabs.map((tab) => ({ tab, space: s })));
    const isSnoozed = ({ tab }) => tab.id in snoozed;
    const pinned = pins.map((id) => tabsById.get(id)).filter((e) => e && !e.tab.settled && !isSnoozed(e));
    const later = all.filter((e) => isSnoozed(e) && !e.tab.settled);
    const archived = all.filter((e) => e.tab.settled);

    const list = [];
    if (pinned.length) {
      list.push(header("pinned", "Pinned", null, null, false));
      for (const e of pinned) list.push(...tabRows(e.tab, e.space, true));
    }
    // Worktrees hang under their repo's main checkout, when it is open too.
    const restOf = (s) => s.tabs.filter((tab) => !tab.settled && !pins.includes(tab.id) && !(tab.id in snoozed));
    const repo = new Map(sps.map((s) => [s.id, this.repoOf(cx, s)]));
    const mainOf = new Map(sps.filter((s) => repo.get(s.id)?.main).map((s) => [repo.get(s.id).id, s]));
    const parentOf = (s) => { const r = repo.get(s.id); return r && !r.main ? mainOf.get(r.id) : null; };
    const worktrees = (p) => sps.filter((s) => parentOf(s) === p);
    const worstOf = (list) => list.flatMap(restOf).reduce((m, tab) => ((rank(tab.status) > rank(m)) ? tab.status : m), null);

    const spaceHeader = (s, open, worst, label, extra) => h_flex().id(`sp-${s.id}`).px(8).pt(10).h(32).flex_none().gap(6).items_center().text_size(11.5).font_medium()
      .cursor_pointer().hover((el) => el.text_color(t.foreground))
      .on_hover((on, cx) => { if (on) this.hoveredSpace = s.id; else if (this.hoveredSpace === s.id) this.hoveredSpace = null; cx.notify(); })
      .on_click((_e, cx) => { open ? this.folded.add(s.id) : this.folded.delete(s.id); cx.notify(); })
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: s.id } } }); })
      .child(div().min_w(0).truncate().text_color(s.active ? t.foreground : t.muted).child(label))
      .when(label === s.name && Boolean(s.branch), (el) => el.child(div().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(s.branch)))
      .when(Boolean(s.machine) && label === s.name, (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child(s.machine)))
      .when(Boolean(extra), (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(extra)))
      .child(div().flex_1())
      .when(this.hoveredSpace === s.id, (el) => el.child(div().id(`new-${s.id}`).flex_none().p(3).rounded(4).text_color(t.dim).cursor_pointer()
        .hover((st) => st.bg(t.hover).text_color(t.foreground)).tooltip("New in this space")
        // new-menu reads the active space as it opens, so wait for the switch: else it lists this machine's agents.
        .on_click((_e, cx) => {
          cx.stop_propagation();
          run("space.select", { id: s.id });
          cx.spawn(async (cx) => {
            for (let i = 0; i < 40 && !spaces().find((x) => x.id === s.id)?.active; i++) await cx.sleep(25);
            openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 });
          });
        })
        .child(svg(ICON("plus")).size(13))))
      .when(!open && worst && worst !== "idle", (el) => el.child(mark(t, worst)))
      .child(svg(ICON(open ? "chevron-down" : "chevron-right")).size(11).flex_none().text_color(t.dim));

    for (const s of sps) {
      if (parentOf(s)) continue;
      const open = !this.folded.has(s.id);
      const kids = worktrees(s);
      list.push(spaceHeader(s, open, worstOf([s, ...kids]), s.name, !open && kids.length ? `+${kids.length} worktree${kids.length > 1 ? "s" : ""}` : null));
      if (!open) continue;
      for (const tab of restOf(s)) list.push(...tabRows(tab, s, false));
      if (kids.length) list.push(v_flex().flex_none().ml(14).pl(4).border_l(1).border_color(t.border).children(kids.flatMap((w) => {
        const wOpen = !this.folded.has(w.id);
        return [spaceHeader(w, wOpen, worstOf([w]), w.branch || w.name, null), ...(wOpen ? restOf(w).flatMap((tab) => tabRows(tab, w, false)) : [])];
      })));
    }
    for (const [id, label, items] of [["snoozed", "Snoozed", later], ["archived", "Archived", archived]]) {
      if (!items.length) continue;
      list.push(header(id, label, items.length));
      if (!this.folded.has(id)) for (const e of items) list.push(...tabRows(e.tab, e.space, true));
    }
    this.order = order;
    setAgentOrder(order);

    const bandRow = (n) => {
      const where = n.place ? `${n.place.space.name} · ${tabTitle(n.place.tab, agentBy.get(n.address) ?? ags.find((a) => a.tab === n.place.tab.id))}` : n.address;
      const who = n.k.parent ? (n.k.name || n.k.program?.name || n.address) : null;
      const msg = firstLine(n.k.report?.msg);
      const wasSeen = isSeen(n);
      const hover = this.hoveredNeed === n.address;
      const toggle = div().id(`seen-${n.address}`).flex_none().p(3).rounded(4).text_color(t.dim).cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(wasSeen ? "Back to Needs you" : "Mark as seen")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          const { [n.address]: _, ...rest } = shared("triage.seen") ?? {};
          setShared("triage.seen", wasSeen ? rest : { ...rest, [n.address]: sinceOf(n.address) });
          this.hoveredNeed = null; cx.notify();
        })
        .child(svg(ICON(wasSeen ? "x" : "check")).size(13));
      return v_flex().id(`need-${n.address}`).flex_none().px(10).py(7).gap(3).rounded(8).cursor_pointer()
        .when(!wasSeen, (el) => el.bg(t.blocked + "14").border_1().border_color(t.blocked + "33").hover((s) => s.bg(t.blocked + "24")))
        .when(wasSeen, (el) => el.hover((s) => s.bg(t.hover)))
        .on_hover((on, cx) => { if (on) this.hoveredNeed = n.address; else if (this.hoveredNeed === n.address) this.hoveredNeed = null; cx.notify(); })
        .on_click(() => this.pick(n.address))
        .child(h_flex().gap(7).items_center()
          .child(mark(t, n.k.status))
          .child(div().flex_1().min_w(0).truncate().text_color(wasSeen ? t.muted : t.foreground).font_medium().child(where))
          .when(Boolean(machineOf(n.address)), (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child(machineOf(n.address))))
          .when(hover, (el) => el.child(toggle))
          .when(!hover, (el) => el.child(div().flex_none().text_size(11).text_color(wasSeen ? t.dim : t.blocked).child(duration(n.wait)))))
        .child(div().pl(21).truncate().text_size(11.5).text_color(t.muted)
          .child(`${n.k.status === "error" ? "Error" : "Blocked"}${who ? ` · ${who}` : ""}${msg ? ` — ${msg}` : ""}`));
    };

    if (narrow()) {
      const cell = (id, tip, pic, status, act, selected) => h_flex().id(id).h(28).flex_none().gap(3).items_center().justify_center().rounded(7).cursor_pointer()
        .when(Boolean(selected), (el) => el.bg(t.selected)).hover((st) => st.bg(t.hover)).tooltip(tip).on_click(act)
        .child(pic).child(mark(t, status));
      const tabCell = (tab, sp) => {
        const lead = ags.find((a) => a.tab === tab.id);
        return cell(`r-${tab.id}`, `${sp.name} · ${tabTitle(tab, lead)}`, icon(lead?.program, 14, t.foreground) ?? svg(ICON("terminal")).size(13).flex_none().text_color(t.dim),
          tab.status, () => { if (lead) this.pick(lead.address); else { run("space.select", { id: sp.id }); run("tab.select", { id: tab.id }); } }, sp.active && tab.active);
      };
      const sep = (id) => div().id(id).flex_none().h(1).mx(6).my(5).bg(t.border);
      return v_flex().size_full().min_h(0).bg(t.chrome).border_t(1).border_color(t.border).text_size(13)
        .child(v_flex().id("rail").flex_1().min_h(0).px(4).pt(8).gap(2).overflow_y_scrollbar()
          .children(needs.map((n) => cell(`rn-${n.address}`, `${n.place ? n.place.space.name : n.address} — ${n.k.status === "error" ? "Error" : "Blocked"}`,
            icon(n.k.program, 14, t.foreground) ?? div(), n.k.status, () => this.pick(n.address))))
          .children(sps.flatMap((sp) => { const tabs = restOf(sp); return tabs.length ? [sep(`rs-${sp.id}`), ...tabs.map((tab) => tabCell(tab, sp))] : []; })))
        .child(h_flex().id("expand").h(28).flex_none().justify_center().items_center().text_color(t.dim).cursor_pointer()
          .hover((st) => st.text_color(t.foreground)).tooltip("Expand sidebar").on_click(toggleSidebar).child("»"));
    }

    return v_flex().size_full().min_h(0).bg(t.chrome).border_t(1).border_color(t.border).text_size(13)
      .child(v_flex().flex_none().px(8).pt(10).pb(8).gap(5).border_b(1).border_color(t.border)
        .child(h_flex().px(4).h(18).gap(6).items_center().text_size(11.5).font_medium()
          .child(div().text_color(needs.length ? t.blocked : t.dim).child("Needs you"))
          .when(needs.length > 0, (el) => el.child(div().text_color(t.dim).child(String(needs.length)))))
        .when(!needs.length, (el) => el.child(div().px(4).text_size(12).text_color(t.dim).child(seenNeeds.length ? "Nobody new." : "Nobody. All moving.")))
        .child(v_flex().id("needs").max_h(260).gap(5).overflow_y_scrollbar().children(needs.map(bandRow))
          .when(seenNeeds.length > 0, (el) => el.child(h_flex().id("seen-toggle").px(4).h(20).gap(5).items_center().text_size(11).text_color(t.dim).cursor_pointer()
            .hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => { this.showSeen = !this.showSeen; cx.notify(); })
            .child(svg(ICON(this.showSeen ? "chevron-down" : "chevron-right")).size(11))
            .child(`Seen ${seenNeeds.length}`)))
          .when(this.showSeen, (el) => el.children(seenNeeds.map(bandRow)))))
      .child(h_flex().flex_none().h(31).pl(12).pr(8).pt(4).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .child("Spaces")
        .child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
          .hover((st) => st.bg(t.hover).text_color(t.foreground)).tooltip("New space")
          .on_click(() => this.machines.length
            ? openOverlay({ mod: "triage", kind: "popup", width: 200, height: 70 + 30 * this.machines.length, props: { newSpace: this.machines } })
            : run("space.new"))
          .child(svg(ICON("plus")).size(14))))
      .child(v_flex().id("inbox").flex_1().min_h(0).px(8).pb(8).overflow_y_scrollbar().children(list)
        .when(!all.length, (el) => el.child(div().p(8).text_size(12).text_color(t.dim).child("No spaces yet."))));
  }
}
