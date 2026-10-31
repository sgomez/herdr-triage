// Pure helpers, kept apart from main.js so they can be tested outside Herdr.

export function ago(iso) {
  const m = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  if (!(m >= 1)) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

const FAIL = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const SKIP = new Set(["NEUTRAL", "SKIPPED", "STALE"]);
const ORDER = ["fail", "pending", "pass", "skip"];

function check(c) {
  const result = c.conclusion || c.state || "";
  const bucket = FAIL.has(result) ? "fail" : SKIP.has(result) ? "skip" : result === "SUCCESS" ? "pass" : "pending";
  return { name: c.name || c.context || "check", bucket, url: c.detailsUrl || c.targetUrl || null };
}
export const checksOf = (pr) => (pr?.statusCheckRollup ?? []).map(check).sort((a, b) => ORDER.indexOf(a.bucket) - ORDER.indexOf(b.bucket));
export const stateOf = (pr) => (pr.state === "OPEN" && pr.isDraft ? "Draft" : { OPEN: "Open", MERGED: "Merged", CLOSED: "Closed" }[pr.state] ?? pr.state);
