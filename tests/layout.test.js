import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { shown, revealing, reveal, stackTabs } from "../mods/triage/layout.js";

const triage = JSON.parse(readFileSync("layouts/triage.json", "utf8"));
const panel = (root) => JSON.parse(JSON.stringify(root));
const node = (root, id) => root.id === id ? root : (root.children ?? []).map((c) => node(c, id)).find(Boolean);

test("every copy of layout.js is the same", () => {
  const copies = readdirSync("mods").filter((m) => existsSync(`mods/${m}/layout.js`)).map((m) => readFileSync(`mods/${m}/layout.js`, "utf8"));
  assert.ok(copies.length > 1);
  for (const c of copies) assert.equal(c, copies[0]);
});

test("shown follows the stack's active tab and hidden ancestors", () => {
  assert.equal(shown(triage, "triage-reply"), true);
  assert.equal(shown(triage, "triage-history"), false);
  const hidden = panel(triage);
  node(hidden, "panel").hidden = true;
  assert.equal(shown(hidden, "triage-reply"), false);
  assert.equal(shown({ id: "root", type: "row", children: [] }, "triage-history"), true);
});

test("revealing selects the tab and shows only hidden ancestors", () => {
  assert.deepEqual(revealing(triage, "changes"), [["layout.select", { stack: "panel-body", child: "changes" }]]);
  const hidden = panel(triage);
  node(hidden, "panel").hidden = true;
  assert.deepEqual(revealing(hidden, "changes"), [["layout.show", { id: "panel" }], ["layout.select", { stack: "panel-body", child: "changes" }]]);
  assert.equal(revealing({ id: "root", type: "row", children: [] }, "changes"), null);
});

test("stackTabs lists the side panel's own tabs", () => {
  assert.deepEqual(stackTabs(triage, (m) => m.startsWith("triage-")), ["reply", "history", "pr", "issues", "worktrees", "settings"]);
});

test("reveal runs the layout steps, else focuses or opens the mod's pane", () => {
  const calls = [];
  const run = (cmd, args) => calls.push([cmd, args]);
  const empty = () => ({ id: "root", type: "row", children: [] });
  reveal({ layout: () => triage, panes: () => [], run }, "changes");
  reveal({ layout: empty, panes: () => [{ pane: "p1", mod: "changes" }], run }, "changes");
  reveal({ layout: empty, panes: () => [], run }, "changes");
  assert.deepEqual(calls, [
    ["layout.select", { stack: "panel-body", child: "changes" }],
    ["pane.focus", { pane: "p1" }],
    ["pane.split", { direction: "right", mod: "changes" }],
  ]);
});
