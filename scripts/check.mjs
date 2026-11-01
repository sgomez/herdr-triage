// Static checks that don't need Herdr: valid JSON, syntax, and every mod and icon the layout uses exists.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

// Shipped with Herdr, so not in this repo.
const SHIPPED = new Set(["changes", "files", "menu", "new-menu", "pane", "tabs", "workspace-chrome"]);
const ICONS = new Set(["archive", "branch", "check", "chevron-down", "chevron-right", "clock", "files", "git-compare", "monitor", "pin", "pin-off", "plus", "server", "settings", "spinner", "square", "terminal", "x"]);

const errors = [];
const json = (path) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch (e) { errors.push(`${path}: ${e.message}`); return null; } };

const mods = readdirSync("mods");
for (const m of mods) {
  const meta = json(`mods/${m}/mod.json`);
  if (meta && meta.place !== "none") errors.push(`mods/${m}/mod.json: "place" must be "none", or Herdr places it on its own`);
  for (const f of readdirSync(`mods/${m}`).filter((f) => f.endsWith(".js"))) {
    try { execFileSync(process.execPath, ["--check", `mods/${m}/${f}`], { stdio: "pipe" }); }
    catch (e) { errors.push(String(e.stderr)); }
  }
  const src = readdirSync(`mods/${m}`).filter((f) => f.endsWith(".js")).map((f) => readFileSync(`mods/${m}/${f}`, "utf8")).join("\n");
  for (const [, name] of src.matchAll(/mod: "([\w-]+)"/g)) if (!mods.includes(name) && !SHIPPED.has(name)) errors.push(`mods/${m}: opens unknown mod "${name}"`);
  for (const [, icon] of src.matchAll(/mods\/workspace-chrome\/([\w-]+)\.svg/g)) if (!ICONS.has(icon)) errors.push(`mods/${m}: icon "${icon}" isn't in workspace-chrome`);
  for (const [, icon] of src.matchAll(/ICON\("([\w-]+)"\)/g)) if (!ICONS.has(icon)) errors.push(`mods/${m}: icon "${icon}" isn't in workspace-chrome`);
}

for (const f of readdirSync("layouts").filter((f) => f.endsWith(".json"))) {
  const layout = json(`layouts/${f}`);
  const ids = new Set();
  const walk = (n) => {
    if (!n) return;
    if (ids.has(n.id)) errors.push(`layouts/${f}: duplicate id "${n.id}"`);
    ids.add(n.id);
    const mod = n.content?.mod;
    if (mod && !mods.includes(mod) && !SHIPPED.has(mod)) errors.push(`layouts/${f}: unknown mod "${mod}"`);
    (n.children ?? []).forEach(walk);
  };
  walk(layout);
}

if (!existsSync("RECIPE.md")) errors.push("RECIPE.md is missing");
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
console.log(`ok: ${mods.length} mods, ${readdirSync("layouts").filter((f) => f.endsWith(".json")).length} layout`);
