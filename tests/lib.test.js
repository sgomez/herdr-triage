import { test } from "node:test";
import assert from "node:assert/strict";
import * as inbox from "../mods/triage/lib.js";
import * as issues from "../mods/triage-issues/lib.js";
import * as pr from "../mods/triage-pr/lib.js";
import * as launch from "../mods/triage-launch/lib.js";
import * as status from "../mods/triage-status/lib.js";
import * as history from "../mods/triage-history/lib.js";

const MIN = 60000;

test("duration rounds down to the largest unit", () => {
  assert.equal(inbox.duration(30 * 1000), "<1m");
  assert.equal(inbox.duration(5 * MIN), "5m");
  assert.equal(inbox.duration(90 * MIN), "1h");
  assert.equal(inbox.duration(50 * 60 * MIN), "2d");
});

test("rank orders blocked above done above working above idle", () => {
  const order = ["idle", "working", "blocked", "done", undefined].sort((a, b) => inbox.rank(b) - inbox.rank(a));
  assert.deepEqual(order, ["blocked", "done", "working", "idle", undefined]);
});

test("remote addresses carry their machine", () => {
  assert.equal(inbox.machineOf("vps/t7"), "vps");
  assert.equal(inbox.machineOf("t7"), null);
  assert.equal(inbox.qualify("tb1", "vps"), "vps/tb1");
  assert.equal(inbox.qualify("tb1", null), "tb1");
});

test("titles lose the spinners and marks agents put in front", () => {
  assert.equal(inbox.clean("✳ Fix login"), "Fix login");
  assert.equal(inbox.clean("⠋  Working"), "Working");
  assert.equal(inbox.firstLine("\n  \n  Needs approval\nmore"), "Needs approval");
});

test("linkRefs links #N outside code only", () => {
  const out = issues.linkRefs("See #12, (#3) and o/r#4 &#39; `#5` [#6](x) ## 7\n```\n#8\n```\n- [ ] #9", "B");
  assert.equal(out, "See [#12](B/issues/12), ([#3](B/issues/3)) and o/r#4 &#39; `#5` [#6](x) ## 7\n```\n#8\n```\n- [ ] [#9](B/issues/9)");
});

test("ago reads a timestamp as time since", () => {
  assert.equal(issues.ago(new Date().toISOString()), "now");
  assert.equal(pr.ago(new Date(Date.now() - 3 * 60 * MIN).toISOString()), "3h");
  assert.equal(pr.ago("not a date"), "now");
});

test("checks sort failures first and bucket every conclusion", () => {
  const checks = pr.checksOf({ statusCheckRollup: [
    { name: "lint", conclusion: "SUCCESS" },
    { name: "docs", conclusion: "SKIPPED" },
    { context: "ci/legacy", state: "PENDING", targetUrl: "u" },
    { name: "test", conclusion: "TIMED_OUT", detailsUrl: "d" },
  ] });
  assert.deepEqual(checks.map((c) => [c.name, c.bucket]), [["test", "fail"], ["ci/legacy", "pending"], ["lint", "pass"], ["docs", "skip"]]);
  assert.equal(checks[1].url, "u");
  assert.deepEqual(pr.checksOf(null), []);
});

test("PR state names drafts", () => {
  assert.equal(pr.stateOf({ state: "OPEN", isDraft: true }), "Draft");
  assert.equal(pr.stateOf({ state: "MERGED" }), "Merged");
});

test("mode arguments round-trip through text", () => {
  const args = ["--permission-mode", "auto", "--append-system-prompt", "be brief"];
  assert.equal(launch.argsText(args), '--permission-mode auto --append-system-prompt "be brief"');
  assert.deepEqual(launch.parseArgs(launch.argsText(args)), args);
  assert.deepEqual(launch.parseArgs("  -a 'b c'  "), ["-a", "b c"]);
  assert.deepEqual(launch.parseArgs(""), []);
});

test("templates fill known variables and keep the rest", () => {
  assert.equal(launch.fill("/implement-issue {number} {unknown}", { number: 42 }), "/implement-issue 42 {unknown}");
  assert.equal(launch.fill(undefined, {}), "");
});

test("slugs are short, lowercase and trimmed", () => {
  assert.equal(launch.slugOf("Fix: login TIMEOUT (again)!"), "fix-login-timeout-again");
  assert.ok(launch.slugOf("a ".repeat(60)).length <= 40);
  assert.ok(!launch.slugOf("word ".repeat(20)).endsWith("-"));
});

test("worktrees go where Herdr's own dialog puts them", () => {
  assert.equal(launch.worktreePath("/home/u", "/src/app/.git", "issue-1/fix login"), "/home/u/.herdr/worktrees/app/issue-1-fix-login");
  assert.equal(launch.worktreePath("/home/u", "/src/app.git", "main"), "/home/u/.herdr/worktrees/app.git/main");
});

test("git status: branch, ahead/behind and changed files", () => {
  assert.deepEqual(status.parseStatus("## main...origin/main [ahead 2, behind 1]\n M a.js\n?? b.js\n"), { branch: "main", ahead: 2, behind: 1, dirty: 2 });
  assert.deepEqual(status.parseStatus("## No commits yet on dev\n"), { branch: "dev", ahead: 0, behind: 0, dirty: 0 });
});

test("parseLog reads refs and marks HEAD", () => {
  const [c] = history.parseLog("abc\x1fp1 p2\x1fAna\x1f2026-01-01T00:00:00Z\x1fHEAD -> refs/heads/milestone/m2, refs/remotes/origin/milestone/m2, tag: refs/tags/v1, refs/stash\x1fMerge x\n");
  assert.deepEqual(c.parents, ["p1", "p2"]);
  assert.deepEqual(c.refs, [{ name: "milestone/m2", kind: "local" }, { name: "origin/milestone/m2", kind: "remote" }, { name: "v1", kind: "tag" }]);
  assert.equal(c.head, true);
  assert.equal(c.subject, "Merge x");
});

test("graph opens a lane for a merged branch and closes it at the fork", () => {
  const rows = history.graph([
    { hash: "M", parents: ["A", "B"] },
    { hash: "A", parents: ["R"] },
    { hash: "B", parents: ["R"] },
    { hash: "R", parents: [] },
  ]);
  assert.deepEqual(rows.map((r) => [r.lane, r.color]), [[0, 0], [0, 0], [1, 1], [0, 0]]);
  assert.deepEqual(rows[0], { lane: 0, color: 0, top: [], bottom: [{ lane: 0, color: 0 }], joins: [{ lane: 1, color: 1, dir: "out" }], width: 2 });
  assert.deepEqual(rows[3].joins, [{ lane: 1, color: 1, dir: "in" }]);
  assert.deepEqual(rows[3].top, [{ lane: 0, color: 0 }]);
});

test("graph reuses a freed lane", () => {
  const rows = history.graph([
    { hash: "A", parents: ["B"] },
    { hash: "X", parents: [] },
    { hash: "B", parents: [] },
  ]);
  assert.deepEqual(rows.map((r) => r.lane), [0, 1, 0]);
});

test("parseSubject reads conventional commits and merged pull requests", () => {
  assert.deepEqual(history.parseSubject("feat(api)!: add x"), { type: "feat", scope: "api", breaking: true, text: "add x" });
  assert.deepEqual(history.parseSubject("Merge pull request #16 from o/docs/x"), { pr: 16, text: "docs/x" });
  assert.deepEqual(history.parseSubject("Plain message"), { text: "Plain message" });
});

test("initials, and parseShow splits message from file stats", () => {
  assert.equal(history.initials("Ana Ruiz Gil"), "AG");
  assert.equal(history.initials("dev-bot"), "DB");
  assert.equal(history.initials(""), "?");
  const d = history.parseShow("Title\n\nBody line\n\x1e\n3\t1\tsrc/a.js\n-\t-\timg.png\n");
  assert.equal(d.body, "Body line");
  assert.deepEqual(d.files, [{ path: "src/a.js", add: 3, del: 1 }, { path: "img.png", add: null, del: null }]);
});
