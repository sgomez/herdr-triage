// Where a mod sits in the shown layout, so it works in any layout, not only triage.
// Mods can't import each other, so each one that needs this has its own copy.

// The nodes from the root down to the first that passes test, or null.
export function pathTo(node, test) {
  if (!node) return null;
  if (test(node)) return [node];
  for (const c of node.children ?? []) { const p = pathTo(c, test); if (p) return [node, ...p]; }
  return null;
}

const holds = (mod) => (n) => n.content?.mod === mod;

// A mod with no block in the layout is in a pane or tab of its own, so it counts as shown.
export function shown(root, mod) {
  const path = pathTo(root, holds(mod));
  return !path || path.every((n, i) => !n.hidden && (n.type !== "stack" || (n.active ?? n.children?.[0]?.id) === path[i + 1]?.id));
}

// The layout commands that bring a mod's block into view, or null if the layout has none.
export function revealing(root, mod) {
  const path = pathTo(root, holds(mod));
  return path && path.slice(1).flatMap((n, i) => (path[i].type === "stack"
    ? [["layout.select", { stack: path[i].id, child: n.id }]]
    : n.hidden ? [["layout.show", { id: n.id }]] : []));
}

// Brings a mod into view: its tab if the layout has one, else its pane, opened on the right if none.
// Takes the herdr module so this file also loads outside Herdr, for the tests.
export function reveal({ layout, panes, run }, mod) {
  const steps = revealing(layout(), mod);
  if (steps) return steps.forEach(([cmd, args]) => run(cmd, args));
  const pane = panes().find((p) => p.mod === mod);
  run(pane ? "pane.focus" : "pane.split", pane ? { pane: pane.pane } : { direction: "right", mod });
}

// Ids of the stack tabs whose block shows a mod that passes test.
export function stackTabs(root, test) {
  const ids = [];
  const walk = (n) => {
    if (n.type === "stack") for (const c of n.children ?? []) if (c.content?.mod && test(c.content.mod)) ids.push(c.id);
    (n.children ?? []).forEach(walk);
  };
  if (root) walk(root);
  return ids;
}
