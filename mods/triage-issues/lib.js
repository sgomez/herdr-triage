// Pure helpers, kept apart from main.js so they can be tested outside Herdr.

// GitHub links #123 when showing an issue; the raw markdown doesn't. Code is left alone.
export function linkRefs(md, base) {
  return md.split(/(```[\s\S]*?```|`[^`\n]*`)/).map((part, i) => (i % 2 ? part
    : part.replace(/(^|[^\w&\/#\[])#(\d+)\b/g, (_m, pre, n) => `${pre}[#${n}](${base}/issues/${n})`))).join("");
}

export function ago(iso) {
  const m = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  if (!(m >= 1)) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
