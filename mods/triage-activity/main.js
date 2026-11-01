// A vertical icon bar that switches the tabs of a stack, like VS Code's activity bar.
// props: { stack: "<stack id>" }. The stack itself needs no header.
// A mod shows a count on its icon with setShared("badge.<mod>", { count, tone }), tone a theme color.

import { View, div, svg } from "gpui-kit";
import { v_flex } from "gpui-base";
import { layout, run, props, theme, shared } from "herdr";

const ICONS = {
  "triage-reply": "mods/triage-activity/reply.svg",
  changes: "mods/workspace-chrome/git-compare.svg",
  "triage-history": "mods/workspace-chrome/clock.svg",
  "triage-pr": "mods/triage-activity/pr.svg",
  "triage-issues": "mods/triage-activity/issues.svg",
  files: "mods/workspace-chrome/files.svg",
};
const SETTINGS = "mods/workspace-chrome/settings.svg";

function find(node, id) {
  if (!node) return null;
  if (node.id === id) return node;
  for (const c of node.children ?? []) { const n = find(c, id); if (n) return n; }
  return null;
}

export default class TriageActivity extends View {
  render() {
    const t = theme(), id = props()?.stack ?? "panel-body";
    const stack = find(layout(), id);
    const tabs = stack?.children ?? [], active = stack?.active ?? tabs[0]?.id;
    const settings = (c) => Boolean(c.content?.props?.settings);
    const button = (c) => {
      const on = c.id === active, icon = settings(c) ? SETTINGS : ICONS[c.content?.mod];
      const badge = shared(`badge.${c.content?.mod}`);
      return div().id(`act-${c.id}`).relative().w(40).h(40).flex().items_center().justify_center()
        .border_l(2).border_color(on ? t.accent : t.chrome).text_color(on ? t.foreground : t.dim)
        .cursor_pointer().hover((s) => s.text_color(t.foreground)).tooltip(c.title ?? c.id)
        .on_click(() => run("layout.select", { stack: id, child: c.id }))
        .child(icon ? svg(icon).size(18) : div().text_size(13).font_semibold().child((c.title ?? c.id)[0].toUpperCase()))
        .when(badge?.count > 0, (el) => el.child(div().absolute().top(5).right(4).min_w(15).h(15).px(4).rounded_full()
          .flex().items_center().justify_center().bg(t[badge.tone] ?? t.accent).text_color(t.background)
          .text_size(9.5).font_semibold().child(badge.count > 99 ? "99+" : String(badge.count))));
    };
    return v_flex().size_full().bg(t.chrome).border_l(1).border_color(t.border).py(4)
      .children(tabs.filter((c) => !settings(c)).map(button))
      .child(div().flex_1())
      .children(tabs.filter(settings).map(button));
  }
}
