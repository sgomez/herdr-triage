// Agent launcher (dialog, props { space, folder, issue }) and its settings (panel block, props { settings }).
// Config: what the person saved here, else the settings block's layout props.defaults, else BUILTIN.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { spaces, run, theme, shared, setShared, knownAgents, closeOverlay, props, exec, layout } from "herdr";
import { argsText, parseArgs, slugOf, fill, worktreePath } from "./lib.js";

const BUILTIN = {
  templates: [
    { name: "Read issue", text: "Work on GitHub issue #{number} in {repo}: {title}\nRead it first with `gh issue view {number} --comments`, including its sub-issues." },
  ],
  modes: {
    claude: [
      { name: "Auto", args: ["--permission-mode", "auto"] },
      { name: "Plan", args: ["--permission-mode", "plan"] },
      { name: "Ask", args: [] },
      { name: "Accept edits", args: ["--permission-mode", "acceptEdits"] },
    ],
    codex: [
      { name: "Read only", args: ["--sandbox", "read-only"] },
      { name: "Ask", args: ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"] },
    ],
  },
  branch: "issue-{number}-{slug}",
};

function find(node, test) {
  if (!node || typeof node !== "object") return null;
  if (test(node)) return node;
  for (const c of node.children ?? []) {
    const f = find(c, test);
    if (f) return f;
  }
  return null;
}

const layoutDefaults = () => find(layout(), (n) => n.content?.mod === "triage-launch")?.content?.props?.defaults ?? null;
const config = () => shared("triage.launch") ?? layoutDefaults() ?? BUILTIN;

const base = () => layoutDefaults() ?? BUILTIN;
const SAMPLE = { number: 1615, title: "Fix login timeout", repo: "owner/repo", url: "https://github.com/owner/repo/issues/1615", slug: "fix-login-timeout" };
const VARS = ["number", "title", "repo", "url", "slug", "branch"];

async function git(cwd, args, on) {
  const r = await exec("git", args, { cwd, on });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? r.stdout ?? "").trim() };
}

export default class TriageLaunch extends View {
  init(_props, cx) {
    const p = props();
    if (p?.settings) return this.initSettings(cx);
    this.task = TextareaState.new({ placeholder: "First message to the agent (optional)" });
    this.task.set_rows(5);
    this.branch = InputState.new({ placeholder: "Branch for the new worktree" });
    const issue = p?.issue;
    const last = shared("triage.launch.last") ?? {};
    this.where = issue ? "worktree" : "checkout";
    this.template = issue ? Math.min(last.template ?? 0, config().templates.length - 1) : -1;
    this.agentKey = last.agent ?? null;
    this.modeByAgent = last.modes ?? {};
    if (issue) {
      this.branch.set_value(fill(config().branch, this.vars()));
      this.applyTemplate();
    }
  }

  space() {
    const id = props()?.space;
    return spaces().find((s) => (id ? s.id === id : s.active));
  }

  vars() {
    const i = props()?.issue ?? {};
    const repo = /github\.com\/([^/]+\/[^/]+)/.exec(i.url ?? "")?.[1] ?? "";
    return { number: i.number ?? "", title: i.title ?? "", url: i.url ?? "", repo, slug: slugOf(i.title), branch: this.branch?.value().trim() ?? "" };
  }

  applyTemplate() {
    const tpl = config().templates[this.template];
    if (tpl) this.task.set_value(fill(tpl.text, this.vars()));
  }

  loadAgents(cx) {
    if (this.agents || this.loadingAgents) return;
    this.loadingAgents = true;
    cx.spawn(async (cx) => {
      try { this.agents = (await knownAgents({ on: this.space()?.machine })).filter((a) => a.installed); } catch { this.agents = []; }
      if (!this.agents.some((a) => a.key === this.agentKey)) this.agentKey = this.agents[0]?.key ?? null;
      cx.notify();
    });
  }

  launch(cx) {
    const s = this.space(), agent = this.agents?.find((a) => a.key === this.agentKey);
    if (!s || !agent || this.busy) return;
    const modes = config().modes?.[agent.key] ?? [];
    const mode = modes.find((m) => m.name === this.modeByAgent[agent.key]) ?? modes[0];
    const argv = [...agent.run, ...(mode?.args ?? [])];
    const task = this.task.value().trim() || undefined;
    const folder = props()?.folder || s.folder || undefined;
    const issue = props()?.issue;
    setShared("triage.launch.last", { agent: agent.key, modes: { ...this.modeByAgent, [agent.key]: mode?.name }, template: Math.max(this.template, 0) });
    if (this.where === "checkout") {
      run("tab.new", { space: s.id, folder, argv, task, name: issue ? `#${issue.number}` : undefined });
      closeOverlay(props().overlay);
      return;
    }
    const branch = this.branch.value().trim();
    if (!branch) { this.error = "Name the branch."; cx.notify(); return; }
    this.busy = true; this.error = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const on = s.machine ?? undefined;
        const common = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"], on);
        if (!common.ok) throw new Error(common.err || "Not a git repository.");
        const main = common.out.endsWith("/.git") ? common.out.slice(0, -5) : common.out;
        const home = (await exec("sh", ["-c", 'printf %s "$HOME"'], { on })).stdout?.trim();
        if (!home) throw new Error("Couldn't find the home folder.");
        const path = worktreePath(home, common.out, branch);
        const exists = await git(main, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], on);
        const add = await git(main, ["worktree", "add", ...(exists.ok ? [path, branch] : ["-b", branch, path])], on);
        if (!add.ok) throw new Error(add.err || "git worktree add failed.");
        run("space.new", { folder: path, machine: s.machine ?? undefined, argv, task });
        closeOverlay(props().overlay);
      } catch (e) {
        this.error = e.message ?? String(e);
      } finally { this.busy = false; cx.notify(); }
    });
  }

  chip(t, id, label, on, act) {
    return div().id(id).px(8).h(24).flex().flex_none().items_center().rounded(6).text_size(12).cursor_pointer()
      .when(on, (el) => el.bg(t.selected)).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { act(); cx.notify(); }).child(label);
  }

  button(t, id, label, enabled, onClick, primary) {
    return div().id(id).h(28).px(12).flex().flex_none().items_center().rounded(7).text_size(12)
      .bg(primary && enabled ? t.solid : t.raised).text_color(!enabled ? t.dim : primary ? t.solid_foreground : t.foreground)
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.85)).on_click((_e, cx) => onClick(cx)))
      .child(label);
  }

  field(t, id, child) {
    return div().id(id).w_full().p(8).rounded(8).border_1().border_color(t.border).cursor_text()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(child);
  }

  initSettings(cx) {
    this.sel = null;
    const field = (state, apply) => state.on("change", (_e, cx) => { if (!this.filling) { apply(state.value()); cx.notify(); } });
    this.tplName = InputState.new({ placeholder: "Name" });
    this.tplText = TextareaState.new({ placeholder: "First message. Use the variables below.", rows: 6 });
    this.modeName = InputState.new({ placeholder: "Name" });
    this.modeArgs = InputState.new({ placeholder: "Extra arguments, e.g. --permission-mode plan" });
    this.branchPattern = InputState.new({ value: config().branch ?? "" });
    this.json = TextareaState.new({ rows: 14 });
    field(this.tplName, (v) => this.edit((c) => { c.templates[this.sel.i].name = v; }));
    field(this.tplText, (v) => this.edit((c) => { c.templates[this.sel.i].text = v; }));
    field(this.modeName, (v) => this.edit((c) => { c.modes[this.sel.agent][this.sel.i].name = v; }));
    field(this.modeArgs, (v) => this.edit((c) => { c.modes[this.sel.agent][this.sel.i].args = parseArgs(v); }));
    field(this.branchPattern, (v) => this.edit((c) => { c.branch = v; }));
    cx.spawn(async (cx) => {
      try { this.agents = await knownAgents({ on: spaces().find((s) => s.active)?.machine }); } catch { this.agents = []; }
      cx.notify();
    });
  }

  // Every change is saved at once, as the person's own copy of the config.
  edit(change) {
    const c = JSON.parse(JSON.stringify(config()));
    c.templates ??= []; c.modes ??= {};
    change(c);
    setShared("triage.launch", c);
  }

  fillEditor(sel) {
    this.sel = sel;
    this.filling = true;
    const c = config();
    if (sel?.kind === "tpl") { this.tplName.set_value(c.templates[sel.i].name ?? ""); this.tplText.set_value(c.templates[sel.i].text ?? ""); }
    if (sel?.kind === "mode") { const m = c.modes[sel.agent][sel.i]; this.modeName.set_value(m.name ?? ""); this.modeArgs.set_value(argsText(m.args)); }
    this.filling = false;
  }

  resetSection(key) {
    this.edit((c) => { c[key] = JSON.parse(JSON.stringify(base()[key] ?? (key === "branch" ? "" : key === "modes" ? {} : []))); });
    this.fillEditor(null);
    if (key === "branch") { this.filling = true; this.branchPattern.set_value(config().branch ?? ""); this.filling = false; }
  }

  settingsView(t) {
    const c = config();
    const templates = c.templates ?? [], modes = c.modes ?? {};
    const keys = [...new Set([...(this.agents ?? []).filter((a) => a.installed).map((a) => a.key), ...Object.keys(modes)])];
    const nameOf = (k) => this.agents?.find((a) => a.key === k)?.name ?? k;
    this.agentTab = keys.includes(this.agentTab) ? this.agentTab : keys[0];
    const small = (id, label, act, tip) => div().id(id).flex_none().px(6).h(22).flex().items_center().rounded(5).text_size(11.5).text_color(t.dim).cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).when(Boolean(tip), (el) => el.tooltip(tip))
      .on_click((_e, cx) => { cx.stop_propagation(); act(cx); cx.notify(); }).child(label);
    const section = (title, resetKey, ...kids) => v_flex().gap(6).pb(14)
      .child(h_flex().items_center().child(div().flex_1().text_size(12).font_semibold().child(title))
        .child(small(`reset-${resetKey}`, "Reset to defaults", () => this.resetSection(resetKey))))
      .children(kids);
    const item = (id, selected, isDefault, title, sub, onPick, onDefault, onDelete) => h_flex().id(id).px(8).py(6).gap(8).items_center().rounded(7).cursor_pointer()
      .bg(selected ? t.selected : t.raised).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { onPick(); cx.notify(); })
      .child(div().id(`${id}-star`).flex_none().w(14).text_color(isDefault ? t.done : t.dim).cursor_pointer().tooltip(isDefault ? "Default" : "Make default")
        .on_click((_e, cx) => { cx.stop_propagation(); onDefault(); cx.notify(); }).child(isDefault ? "★" : "☆"))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_size(12.5).child(title || "Untitled"))
        .when(Boolean(sub), (el) => el.child(div().truncate().text_size(11).text_color(t.dim).child(sub))))
      .child(small(`${id}-del`, "×", onDelete, "Delete"));
    const toFront = (list, i) => [list[i], ...list.filter((_, j) => j !== i)];
    const label = (text) => div().text_size(11).text_color(t.dim).child(text);

    const tplSel = this.sel?.kind === "tpl" && templates[this.sel.i] ? this.sel.i : null;
    const tplEditor = tplSel === null ? null : v_flex().gap(6).p(10).rounded(8).border_1().border_color(t.border)
      .child(label("Name")).child(this.field(t, "tpl-name", Input.new(this.tplName).w_full().text_size(12.5).text_color(t.foreground)))
      .child(label("Message")).child(this.field(t, "tpl-text", Textarea.new(this.tplText).w_full().text_size(12.5).text_color(t.foreground)))
      .child(h_flex().gap(4).flex_wrap().items_center().child(label("Insert"))
        .children(VARS.map((v) => small(`var-${v}`, `{${v}}`, () => {
          // set_value doesn't fire "change", so save here.
          const text = `${this.tplText.value()}{${v}}`;
          this.tplText.set_value(text);
          this.edit((c) => { c.templates[this.sel.i].text = text; });
        }))))
      .child(label("Preview"))
      .child(div().p(8).rounded(6).bg(t.background).text_size(12).text_color(t.muted).whitespace_normal()
        .child(fill(templates[tplSel].text, { ...SAMPLE, branch: fill(c.branch, SAMPLE) })));

    const agentModes = modes[this.agentTab] ?? [];
    const modeSel = this.sel?.kind === "mode" && this.sel.agent === this.agentTab && agentModes[this.sel.i] ? this.sel.i : null;
    const modeEditor = modeSel === null ? null : v_flex().gap(6).p(10).rounded(8).border_1().border_color(t.border)
      .child(label("Name")).child(this.field(t, "mode-name", Input.new(this.modeName).w_full().text_size(12.5).text_color(t.foreground)))
      .child(label("Arguments")).child(this.field(t, "mode-args", Input.new(this.modeArgs).w_full().text_size(12.5).text_color(t.foreground)))
      .child(div().text_size(11).text_color(t.dim).truncate().child(`Runs: ${nameOf(this.agentTab)} ${argsText(agentModes[modeSel].args)}`));

    return v_flex().size_full().min_h(0).bg(t.background).text_size(12.5).text_color(t.foreground)
      .child(v_flex().id("settings").flex_1().min_h(0).p(12).overflow_y_scrollbar()
        .child(section("Templates", "templates",
          div().text_size(11.5).text_color(t.muted).whitespace_normal().child("First message when you start an agent on an issue. ★ is the default."),
          ...templates.map((tp, i) => item(`tpl-${i}`, tplSel === i, i === 0, tp.name, (tp.text ?? "").split("\n")[0],
            () => this.fillEditor(tplSel === i ? null : { kind: "tpl", i }),
            () => { this.edit((c) => { c.templates = toFront(c.templates, i); }); this.fillEditor(null); },
            () => { this.edit((c) => { c.templates.splice(i, 1); }); this.fillEditor(null); })),
          ...(tplEditor ? [tplEditor] : []),
          h_flex().child(small("tpl-add", "+ Template", () => {
            this.edit((c) => { c.templates.push({ name: "New template", text: "" }); });
            this.fillEditor({ kind: "tpl", i: config().templates.length - 1 });
          }))))
        .child(section("Modes", "modes",
          div().text_size(11.5).text_color(t.muted).whitespace_normal().child("Permission modes per agent: the extra arguments it starts with. ★ is the default."),
          h_flex().gap(4).flex_wrap().children(this.agents == null ? [label("Loading agents…")] : keys.map((k) => div().id(`at-${k}`).px(8).h(24).flex().items_center().rounded(6).text_size(12).cursor_pointer()
            .when(k === this.agentTab, (el) => el.bg(t.selected)).text_color(k === this.agentTab ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { this.agentTab = k; this.fillEditor(null); cx.notify(); }).child(nameOf(k)))),
          ...(this.agentTab && !agentModes.length ? [div().text_size(11.5).text_color(t.dim).child(`No modes: ${nameOf(this.agentTab)} starts with no extra arguments.`)] : []),
          ...agentModes.map((m, i) => item(`mode-${this.agentTab}-${i}`, modeSel === i, i === 0, m.name, argsText(m.args) || "no extra arguments",
            () => this.fillEditor(modeSel === i ? null : { kind: "mode", agent: this.agentTab, i }),
            () => { const k = this.agentTab; this.edit((c) => { c.modes[k] = toFront(c.modes[k], i); }); this.fillEditor(null); },
            () => { const k = this.agentTab; this.edit((c) => { c.modes[k].splice(i, 1); if (!c.modes[k].length) delete c.modes[k]; }); this.fillEditor(null); })),
          ...(modeEditor ? [modeEditor] : []),
          ...(this.agentTab ? [h_flex().child(small("mode-add", "+ Mode", () => {
            const k = this.agentTab;
            this.edit((c) => { (c.modes[k] ??= []).push({ name: "New mode", args: [] }); });
            this.fillEditor({ kind: "mode", agent: k, i: config().modes[k].length - 1 });
          }))] : [])))
        .child(section("Worktree branch", "branch",
          this.field(t, "branch-pattern", Input.new(this.branchPattern).w_full().text_size(12.5).text_color(t.foreground)),
          div().text_size(11).text_color(t.dim).truncate().child(`e.g. ${fill(c.branch, SAMPLE) || "—"}`)))
        .child(v_flex().gap(6)
          .child(small("json-toggle", `${this.showJson ? "▾" : "▸"} Advanced: JSON`, () => {
            this.showJson = !this.showJson;
            if (this.showJson) this.json.set_value(JSON.stringify(config(), null, 2));
            this.jsonError = null;
          }))
          .when(Boolean(this.showJson), (el) => el
            .child(div().text_size(11.5).text_color(t.muted).whitespace_normal().child("To copy your settings or paste someone else's."))
            .child(this.field(t, "json", Textarea.new(this.json).w_full().text_size(12).font_family("JetBrains Mono").text_color(t.foreground)))
            .when(Boolean(this.jsonError), (el) => el.child(div().text_size(11.5).text_color(t.ansi1).child(this.jsonError)))
            .child(h_flex().child(this.button(t, "json-apply", "Apply", true, (cx) => {
              try {
                const next = JSON.parse(this.json.value());
                if (!Array.isArray(next.templates) || typeof next.modes !== "object") throw new Error("Needs \"templates\" (a list) and \"modes\" (an object).");
                setShared("triage.launch", next);
                this.jsonError = null; this.fillEditor(null);
                this.filling = true; this.branchPattern.set_value(next.branch ?? ""); this.filling = false;
              } catch (e) { this.jsonError = e.message; }
              cx.notify();
            }, true))))));
  }

  render(cx) {
    const t = theme();
    if (props()?.settings) return this.settingsView(t);
    this.loadAgents(cx);
    const c = config(), issue = props()?.issue, s = this.space();
    const agent = this.agents?.find((a) => a.key === this.agentKey);
    const modes = agent ? c.modes?.[agent.key] ?? [] : [];
    const mode = modes.find((m) => m.name === this.modeByAgent[agent?.key]) ?? modes[0];
    const label = (text) => div().w(64).flex_none().pt(4).text_size(11.5).text_color(t.dim).child(text);
    const line = (name, ...kids) => h_flex().gap(4).items_start().child(label(name)).child(h_flex().flex_1().min_w(0).gap(4).flex_wrap().items_center().children(kids));
    return v_flex().size_full().p(16).gap(12).bg(t.popover).text_size(12.5).text_color(t.foreground)
      .child(div().font_semibold().truncate().child(issue ? `Start agent on #${issue.number} · ${issue.title}` : `New agent in ${s?.name ?? "this space"}`))
      .child(line("Agent", ...(this.agents == null ? [div().text_color(t.dim).child("Loading…")]
        : this.agents.length ? this.agents.map((a) => this.chip(t, `ag-${a.key}`, a.name, a.key === this.agentKey, () => { this.agentKey = a.key; }))
        : [div().text_color(t.dim).child("No agents installed.")])))
      .when(modes.length > 0, (el) => el.child(line("Mode", ...modes.map((m) => this.chip(t, `md-${m.name}`, m.name, m === mode, () => { this.modeByAgent = { ...this.modeByAgent, [agent.key]: m.name }; })))))
      .child(line("Where",
        this.chip(t, "w-checkout", "This checkout", this.where === "checkout", () => { this.where = "checkout"; }),
        this.chip(t, "w-worktree", "New worktree", this.where === "worktree", () => { this.where = "worktree"; })))
      .when(this.where === "worktree", (el) => el.child(line("Branch", this.field(t, "branch", Input.new(this.branch).w_full().text_size(12.5).text_color(t.foreground)))))
      .when(Boolean(issue) && c.templates.length > 1, (el) => el.child(line("Template", ...c.templates.map((tp, i) => this.chip(t, `tp-${i}`, tp.name, i === this.template, () => { this.template = i; this.applyTemplate(); })))))
      .child(line("Task", this.field(t, "task", Textarea.new(this.task).w_full().text_size(12.5).text_color(t.foreground))))
      .when(Boolean(this.error), (el) => el.child(div().text_size(11.5).text_color(t.ansi1).whitespace_normal().child(this.error)))
      .child(div().flex_1())
      .child(h_flex().gap(6).justify_end()
        .child(this.button(t, "cancel", "Cancel", true, () => closeOverlay(props().overlay)))
        .child(this.button(t, "launch", this.busy ? "Creating worktree…" : "Launch", Boolean(agent) && !this.busy, (cx) => this.launch(cx), true)));
  }
}
