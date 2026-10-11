import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./datadir.js";

const DIR = path.join(DATA_DIR, "companion");
const MAX_TOTAL_CHARS = 2800;
const MAX_ITEM_CHARS = 900;
const CATEGORIES = ["user_life", "character_life", "interactions"];

function safeId(value) {
  return String(value || "default").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "default";
}
function fileFor(roleId) { return path.join(DIR, `${safeId(roleId)}.json`); }
function blank() { return { user_life: [], character_life: [], interactions: [], updated_at: null }; }
function readState(roleId) {
  try { return { ...blank(), ...JSON.parse(fs.readFileSync(fileFor(roleId), "utf8")) }; }
  catch { return blank(); }
}
function writeState(roleId, state) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(fileFor(roleId), JSON.stringify(state, null, 2));
}
function cleanText(value) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, MAX_ITEM_CHARS); }
function categoryFor(type) {
  if (type === "character_summary" || type === "character_life") return "character_life";
  if (type === "user_activity" || type === "interaction") return "interactions";
  return "user_life";
}
function bounded(state, maxChars = MAX_TOTAL_CHARS) {
  const all = CATEGORIES.flatMap(category => (state[category] || []).map(item => ({ ...item, category })))
    .sort((a,b) => String(b.created_at).localeCompare(String(a.created_at)));
  let used = 0; const keep = new Set();
  for (const item of all) {
    const n = item.text.length + 40;
    if (used + n > maxChars && keep.size) continue;
    used += n; keep.add(item.id);
  }
  for (const category of CATEGORIES) state[category] = (state[category] || []).filter(x => keep.has(x.id)).slice(-20);
  return state;
}
export function appendCompanionContext(roleId, payload, maxChars = MAX_TOTAL_CHARS) {
  const text = cleanText(payload?.text);
  if (!text) return readState(roleId);
  const state = readState(roleId), category = categoryFor(payload?.type);
  state[category].push({
    id: String(payload?.id || crypto.randomUUID()), text,
    actor: String(payload?.actor || (category === "character_life" ? "character" : "user")),
    source: String(payload?.source || "companion"), origin: String(payload?.origin || "companion_ui"),
    created_at: String(payload?.createdAt || new Date().toISOString())
  });
  state.updated_at = new Date().toISOString();
  writeState(roleId, bounded(state, Math.max(800, Math.min(Number(maxChars)||MAX_TOTAL_CHARS, 6000))));
  return state;
}
export function getCompanionContext(roleId) { return readState(roleId); }
export function clearCompanionContext(roleId) { try { fs.rmSync(fileFor(roleId), { force:true }); } catch {} return blank(); }
export function renderCompanionContext(roleId) {
  const state = readState(roleId), sections = [];
  const labels = { user_life:"USER LIFE CONTEXT", character_life:"CHARACTER LIFE CONTEXT", interactions:"INTERACTION CONTEXT" };
  for (const category of CATEGORIES) {
    const items = state[category] || [];
    if (items.length) sections.push(`${labels[category]}\n${items.map(x=>`- ${x.text}`).join("\n")}`);
  }
  if (!sections.length) return "";
  return `<Companion_Context>\nThe following is optional background awareness from Companion. Use it naturally only when relevant. You do not need to mention or acknowledge it merely because it is present, and you may ignore it entirely.\n\n${sections.join("\n\n")}\n</Companion_Context>`;
}
export function injectCompanionContext(messages, roleId) {
  const content = renderCompanionContext(roleId);
  return content ? [{ role:"system", content }, ...messages] : messages;
}
