// Squire first-impressions board. Everything here is public code: the
// Supabase URL and publishable key are meant for browsers; every row and image
// is protected by the database's own rules (row-level security). Images are
// never in this repo: they come from a private bucket through short-lived
// signed links, only for the board's owner or an invited reviewer.
export const CFG = {
  url: "https://thjaqvuimqctvvcwpndr.supabase.co",
  key: "sb_publishable_-KemqiZalO4K6DYP9aaDrg_Gf7R_5Sc",
};
export const sb = window.supabase.createClient(CFG.url, CFG.key, { auth: { flowType: "pkce", detectSessionInUrl: true, persistSession: true } });
export const app = document.getElementById("app");
const q = new URLSearchParams(location.search);
export const SLUG = q.get("b") || "squire-logo";
// An invite token stays in this tab (not in history) while Google sign-in happens.
if (q.get("i")) { sessionStorage.setItem(`invite:${SLUG}`, q.get("i")); history.replaceState(null, "", `${location.pathname}?b=${SLUG}`); }
export const INVITE = sessionStorage.getItem(`invite:${SLUG}`);

export const ENCOURAGE = ["Nice. Next one. Quick gut call.", "Good. Keep going.", "Got it. Next one.", "Great. Gut call on this one.", "Thanks. Almost there."];
export const el = (tag, attrs = {}, ...kids) => { const n = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === "class") n.className = v; else if (k.startsWith("on")) n[k] = v; else if (v != null) n.setAttribute(k, v); } for (const k of kids.flat(Infinity)) if (k != null && k !== false) n.append(k); return n; };
export const show = (...nodes) => { app.textContent = ""; app.append(...nodes.filter(Boolean)); window.scrollTo(0, 0); };
export const errBox = (e) => el("p", { class: "err" }, String(e?.message || e));

// ── Coach's voice: never autoplays; Play speaks, Stop stops ──
let voiceOn = false;
export function speak(text) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const voices = speechSynthesis.getVoices();
  u.voice = voices.find(v => /Evan|Aaron|Daniel|Google UK English Male|Microsoft Guy/i.test(v.name) && /^en/i.test(v.lang)) || voices.find(v => /^en/i.test(v.lang)) || null;
  u.rate = 1; u.pitch = 1;
  speechSynthesis.speak(u);
}
export function playButton(text, label = "Hear the brief") {
  const b = el("button", { type: "button" }, label);
  b.onclick = () => { if (speechSynthesis.speaking) { speechSynthesis.cancel(); b.textContent = label; return; } voiceOn = true; speak(text); b.textContent = "Stop"; const t = setInterval(() => { if (!speechSynthesis.speaking) { b.textContent = label; clearInterval(t); } }, 400); };
  if (!("speechSynthesis" in window)) b.disabled = true;
  return b;
}

// ── Images: short-lived signed links from the private bucket ──
const urlCache = new Map();
export async function imageUrl(path) {
  if (urlCache.has(path)) return urlCache.get(path);
  const { data, error } = await sb.storage.from("board-concepts").createSignedUrl(path, 3600);
  if (error) throw error;
  urlCache.set(path, data.signedUrl); return data.signedUrl;
}

export const BOARD_COLS = "id, slug, title, brief, status, owners, approved_at, series, round, parent_board, kind, curator_note, note_approved_at";
const IMAGE_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
export async function uploadImage(board, blob) {
  const ext = IMAGE_TYPES[blob.type];
  if (!ext) throw new Error("Use a PNG, JPEG or WebP image.");
  if (blob.size > 10 * 1024 * 1024) throw new Error("That image is over 10 MB.");
  const path = `${board.id}/${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}.${ext}`;
  const { error } = await sb.storage.from("board-concepts").upload(path, blob, { contentType: blob.type, upsert: false });
  if (error) throw error;
  return path;
}
export const rpc = async (fn, args) => { const { data, error } = await sb.rpc(fn, args); if (error) throw error; return data; };
export const shuffle = (xs) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
export const when = (t) => new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

// Two clicks for anything that locks or closes: the first arms, the second does it.
export function armed(label, armedLabel, run, cls = "") {
  const b = el("button", { type: "button", class: cls }, label);
  let t = null;
  b.onclick = async () => {
    if (!t) { b.textContent = armedLabel; t = setTimeout(() => { t = null; b.textContent = label; }, 5000); return; }
    clearTimeout(t); t = null; b.disabled = true;
    try { await run(); } catch (e) { b.disabled = false; b.textContent = label; b.after(errBox(e)); }
  };
  return b;
}

export async function roundsList(board) {
  const { data } = await sb.from("boards").select("slug, round, status, approved_at, created_at").eq("series", board.series).order("round");
  if (!data || data.length < 2) return null;
  return el("div", { class: "rounds" }, data.map(r => el("a", { href: `?b=${r.slug}`, "aria-current": r.slug === board.slug ? "page" : null },
    `Round ${r.round} · ${r.status === "closed" ? "closed, kept as the record" : r.status}`)));
}


// A concept's caption: an ID and a short name from the owner's private label.
// "Aug team-review deck, concept 1: The Quill Tick (lead candidate)" → #1, "The Quill Tick (lead candidate)".
export function caption(c) {
  const id = c.ref || `#${c.candidate_no}`;
  const label = String(c.label || "");
  const name = label.includes(":") ? label.slice(label.indexOf(":") + 1).trim() : label === c.ref ? "" : label;
  return { id, name };
}
export const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// After the ground is knocked out, drop leftovers: specks, and thin lines
// hugging the edge (a card's border or shadow). Thin lines inside the design stay.
function clean(src) {
  const w = src.width, h = src.height;
  const g = src.getContext("2d", { willReadFrequently: true });
  const im = g.getImageData(0, 0, w, h), d = im.data;
  const lab = new Int32Array(w * h), stack = new Int32Array(w * h);
  const band = 0.08, minArea = Math.max(4, w * h * 0.0005);
  let next = 0, dropped = false;
  for (let start = 0; start < w * h; start++) {
    if (lab[start] || d[start * 4 + 3] <= 24) continue;
    next++; let sp = 0, area = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
    stack[sp++] = start; lab[start] = next;
    const members = [];
    while (sp) {
      const i = stack[--sp]; members.push(i); area++;
      const x = i % w, y = (i - x) / w;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1])
        if (j >= 0 && !lab[j] && d[j * 4 + 3] > 24) { lab[j] = next; stack[sp++] = j; }
    }
    const thinH = y1 - y0 <= 3, thinV = x1 - x0 <= 3;
    const atEdge = (thinH && (y1 < h * band || y0 > h * (1 - band))) || (thinV && (x1 < w * band || x0 > w * (1 - band)));
    if (area < minArea || atEdge) { for (const i of members) d[i * 4 + 3] = 0; dropped = true; }
  }
  if (!dropped) return null;
  g.putImageData(im, 0, 0);
  return src;
}
// The mark itself, not its canvas: crops a concept image to its content and,
// when the ground is light and even (the deck's cream or white), knocks the
// ground out so the mark sits on the page's own paper. Display only: the
// stored original is untouched. A dark or busy ground is cropped, never keyed.
const trims = new Map();
// One pass: crop to content and knock out a light, even ground. Returns a canvas, or null when there's nothing to do.
function trimPass(src) {
  const w = src.width, h = src.height;
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(src, 0, 0);
  const im = g.getImageData(0, 0, w, h), d = im.data;
  const px = (x, y) => { const i = (y * w + x) * 4; return [d[i], d[i + 1], d[i + 2], d[i + 3]]; };
  // Sample just inside each corner, so a card with rounded corners still reads as its own ground.
  const m = Math.max(1, Math.round(Math.min(w, h) * 0.04));
  const corners = [px(m, m), px(w - 1 - m, m), px(m, h - 1 - m), px(w - 1 - m, h - 1 - m)];
  if ([px(1, 1), px(w - 2, 1), px(1, h - 2), px(w - 2, h - 2)].every(p => p[3] < 16) && corners.every(p => p[3] < 16)) {                       // already transparent: crop by alpha
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 24) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return x1 < 0 || (x0 <= 2 && y0 <= 2 && x1 >= w - 3 && y1 >= h - 3) ? null : crop(c, x0, y0, x1, y1);
  }
  const bg = [0, 1, 2].map(i => corners.reduce((a, p) => a + p[i], 0) / 4);
  if (!corners.every(p => p[3] > 200 && Math.hypot(p[0] - bg[0], p[1] - bg[1], p[2] - bg[2]) < 18)) return null;
  if (0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2] <= 190) return null;   // a dark ground is part of the design: leave it
  const dist = (i) => Math.hypot(d[i] - bg[0], d[i + 1] - bg[1], d[i + 2] - bg[2]);
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; if (d[i + 3] > 24 && dist(i) > 30) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
  if (x1 < 0) return null;
  for (let i = 0; i < d.length; i += 4) { const t = dist(i); if (t < 30) d[i + 3] = Math.round(d[i + 3] * Math.max(0, (t - 12) / 18)); }
  g.putImageData(im, 0, 0);
  return crop(c, x0, y0, x1, y1);
}
function crop(c, x0, y0, x1, y1) {
  const out = document.createElement("canvas"); out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
  out.getContext("2d").drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}
// The mark itself, not its canvas: up to three passes, so a white canvas
// holding a cream card holding the mark comes down to the mark. Display only:
// the stored original is untouched. A dark or busy ground is never keyed.
export function trimmedUrl(path) {
  if (!trims.has(path)) trims.set(path, (async () => {
    const url = await imageUrl(path);
    try {
      const bmp = await createImageBitmap(await (await fetch(url)).blob());
      const k = Math.min(1, 1400 / Math.max(bmp.width, bmp.height));
      let cur = document.createElement("canvas"); cur.width = Math.max(1, Math.round(bmp.width * k)); cur.height = Math.max(1, Math.round(bmp.height * k));
      cur.getContext("2d").drawImage(bmp, 0, 0, cur.width, cur.height);
      let changed = false;
      for (let pass = 0; pass < 3; pass++) { const next = trimPass(cur); if (!next) break; cur = next; changed = true; }
      if (changed && clean(cur)) { const again = trimPass(cur); if (again) cur = again; }
      if (!changed) return url;
      const pad = Math.round(Math.max(cur.width, cur.height) * 0.08);
      const out = document.createElement("canvas"); out.width = cur.width + 2 * pad; out.height = cur.height + 2 * pad;
      out.getContext("2d").drawImage(cur, pad, pad);
      const blob = await new Promise(r => out.toBlob(r, "image/png"));
      return URL.createObjectURL(blob);
    } catch { return url; }
  })());
  return trims.get(path);
}
