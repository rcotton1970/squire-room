// Coach on the board page. Talks through Coach's own server (the Claude key
// stays there; the signed-in owner's session is the only credential). Coach
// looks at the actual images, including each one rendered at 24px.
//
// Owner side: honest takes on request, a 24px check that can offer to archive
// what fails, and the Curator's Note draft. Reviewer side: neutral by design.

export const BRIEF_TESTS = "1) trust: would you hand this mark your record? 2) a record you can count on: steady, durable, not trendy. 3) human intent: does it feel made by a person with a point of view, not generated. 4) works at 24px: still recognizable as an app icon.";
const VOICE = "You are Coach, Rick's coach, looking at logo concepts for Squire (a coach that keeps a trustworthy record of your growth; its question is 'can I trust this?'). Be honest, short and direct. No flattery, no hedging filler, no lists unless asked. Judge against the brief: " + BRIEF_TESTS + " Refer to concepts by their number (#4). Never invent what isn't visible.";

let cfg = null, getSession = null;
export function setupCoach({ url, key, session }) { cfg = { url, key }; getSession = session; }

// Typographic quotes and apostrophes in everything Coach writes.
export const typeset = (t) => String(t)
  .replace(/(^|[\s(\[\u2014-])"/g, "$1\u201C").replace(/"/g, "\u201D")
  .replace(/(^|[\s(\[\u2014-])'/g, "$1\u2018").replace(/'/g, "\u2019");

async function ask({ system, content, maxTokens = 500, json = false }) {
  const s = await getSession();
  if (!s) throw new Error("Sign in first.");
  // A reply that hits the length cap is retried once with more room; never shown cut off.
  for (const cap of [maxTokens, Math.min(4000, maxTokens * 2)]) {
    const res = await fetch(`${cfg.url}/functions/v1/claude/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: cfg.key, Authorization: `Bearer ${s.access_token}`, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ max_tokens: cap, stream: false, system, messages: [{ role: "user", content }] }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j?.error?.message || `Coach couldn't answer (${res.status}).`);
    const text = (j.content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    if (j.stop_reason !== "max_tokens") return json ? text : typeset(text);
  }
  throw new Error("Coach's answer ran too long. Try again.");
}

// ── Images: the concept as seen large, and at real app-icon size ──
const bitmaps = new Map();
async function bitmap(url) {
  if (!bitmaps.has(url)) bitmaps.set(url, fetch(url).then(r => r.blob()).then(b => createImageBitmap(b)));
  return bitmaps.get(url);
}
function canvasPng(c) { return c.toDataURL("image/png").split(",")[1]; }
function fit(bmp, size, bg = "#fff") {
  const c = document.createElement("canvas"); c.width = c.height = size;
  const g = c.getContext("2d"); g.fillStyle = bg; g.fillRect(0, 0, size, size);
  const k = Math.min(size / bmp.width, size / bmp.height);
  g.imageSmoothingQuality = "high";
  g.drawImage(bmp, (size - bmp.width * k) / 2, (size - bmp.height * k) / 2, bmp.width * k, bmp.height * k);
  return c;
}
// A 24px render, shown 4x with hard pixels, so Coach sees exactly what survives.
function at24(bmp) {
  const small = fit(bmp, 24), big = document.createElement("canvas"); big.width = big.height = 96;
  const g = big.getContext("2d"); g.imageSmoothingEnabled = false; g.drawImage(small, 0, 0, 96, 96);
  return big;
}
const img = (b64) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: b64 } });

// Honest take on one concept, or an open question about the board.
export async function take({ question, concept, src, kept = 0, total = 0 }) {
  const content = [];
  if (concept && src) {
    const bmp = await bitmap(src);
    content.push({ type: "text", text: `#${concept.candidate_no}${concept.label ? ` (Rick's label: ${concept.label})` : ""}, large:` }, img(canvasPng(fit(bmp, 512))),
      { type: "text", text: "The same mark at 24px (shown 4x, hard pixels):" }, img(canvasPng(at24(bmp))));
  }
  content.push({ type: "text", text: `${kept} kept so far of ${total}.${concept?.notes ? ` Rick's note on it: "${concept.notes}".` : ""}${concept?.comments ? ` What Rick said about it when it was made (his words): "${String(concept.comments).slice(0, 700)}".` : ""}\nRick asks: ${question || "What's your honest take on this one?"}\n` +
    (concept ? `Reply with JSON only: {"take":"2 or 3 sentences, under 60 words: what works, what doesn't, and your call","verdicts":{"trust":"Strong|Holds|Shaky|Fails","record":"Strong|Holds|Shaky|Fails","human":"Strong|Holds|Shaky|Fails","at24":"Strong|Holds|Shaky|Fails"},"call":"keep|archive|unsure"}` : `Answer in 2 or 3 sentences, under 60 words, plain text.`) });
  const text = await ask({ system: VOICE, content, maxTokens: 700, json: Boolean(concept) });
  if (!concept) return { take: text };
  try { const j = JSON.parse(text.match(/\{[\s\S]*\}/)[0]); return { take: typeset(String(j.take || "")), verdicts: j.verdicts || null, call: j.call || null }; }
  catch { return { take: typeset(text) }; }
}

// The 24px check: one contact sheet of every concept at 24px; Coach names the ones that don't survive.
export async function check24(concepts, srcOf) {
  const cols = 6, cell = 120, rows = Math.ceil(concepts.length / cols);
  const sheet = document.createElement("canvas"); sheet.width = cols * cell; sheet.height = rows * cell;
  const g = sheet.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, sheet.width, sheet.height);
  g.font = "600 14px system-ui, sans-serif"; g.fillStyle = "#222"; g.imageSmoothingEnabled = false;
  for (const [i, c] of concepts.entries()) {
    const x = (i % cols) * cell, y = Math.floor(i / cols) * cell;
    try { g.drawImage(at24(await bitmap(await srcOf(c))), x + 12, y + 8, 96, 96); } catch { /* unreadable image: Coach is told below */ }
    g.fillText(`#${c.candidate_no}`, x + 12, y + 116);
  }
  const text = await ask({ system: VOICE + " Reply with JSON only.", maxTokens: 800, json: true, content: [
    { type: "text", text: "Each cell is one concept rendered at 24px (shown 4x with hard pixels), labelled by number. Which concepts fail as a 24px app icon (the mark is unrecognizable, turns to mush, text unreadable, or strokes too thin to see)? Be strict: a wordmark whose letters can't be read at this size fails." },
    img(canvasPng(sheet)),
    { type: "text", text: `Numbers on the sheet: ${concepts.map(c => `#${c.candidate_no}`).join(", ")}.\nReply exactly as JSON: {"fail":[numbers],"why":{"<number>":"<5 to 9 words>"}}` },
  ] });
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("Coach's 24px check came back unreadable.");
  const j = JSON.parse(m[0]);
  const known = new Set(concepts.map(c => c.candidate_no));
  const num = (x) => Number(String(x).replace(/[^0-9]/g, ""));          // "#4", "4" and 4 all mean concept 4
  const fail = [...new Set((j.fail || []).map(num).filter(n => known.has(n)))];
  const why = Object.fromEntries(Object.entries(j.why || {}).map(([k, v]) => [num(k), v]));
  return { fail, why };
}

// The Curator's Note: why each kept concept made the cut, what it says about Squire, open questions.
export async function curatorNote({ kept, srcOf, brief, takes = {} }) {
  const content = [{ type: "text", text: `Rick has culled his board to these ${kept.length} concepts. The team will see them blind, by random letter, so in the note refer to each one by a short visual description (e.g. "the ink quill"), never by number or by Rick's private label.` }];
  for (const c of kept) {
    content.push({ type: "text", text: `#${c.candidate_no}${c.notes ? `; Rick's note: "${c.notes}"` : ""}${takes[c.id] ? `; your earlier take: "${takes[c.id]}"` : ""}` });
    try { content.push(img(canvasPng(fit(await bitmap(await srcOf(c)), 320)))); } catch { /* skip unreadable */ }
  }
  content.push({ type: "text", text: `Current brief for the team: "${brief}".\nWrite the Curator's Note that becomes the team's brief, in Rick's voice (first person, plain, warm, direct), under 230 words, no markdown headings or bullets:\n- one opening line on what Squire needs a mark to do (trust; a record you can count on; human intent; works at 24px);\n- one short sentence per kept concept: why it made the cut and what it says about Squire, described visually;\n- end with two or three open questions for the team.\nDon't rank them or reveal which Rick prefers. The note goes to the team exactly as written, so it holds nothing addressed to Rick.\nReply with JSON only: {"note":"the note itself: plain text, no title, no markdown, paragraphs separated by a blank line","aside":"anything you want to tell Rick privately about the set (one or two sentences), or empty"}` });
  const text = await ask({ system: VOICE, content, maxTokens: 2000, json: true });
  let note = text, aside = "";
  try { const j = JSON.parse(text.match(/\{[\s\S]*\}/)[0]); note = String(j.note || ""); aside = String(j.aside || ""); } catch { /* plain text came back: clean it below */ }
  // Never let a heading, markdown or a note-to-Rick into the team's brief.
  note = note.replace(/^\s*(#+\s*)?\**\s*curator.s note\s*\**\s*:?\s*$/gim, "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/^#+\s*/gm, "").replace(/\n{3,}/g, "\n\n").trim();
  return { note: typeset(note), aside: typeset(aside.trim()) };
}

// Reviewer side: neutral. Welcome and encouragement only; never an opinion on a concept.
export const NEUTRAL = {
  welcome: (name) => `${name ? `Hi ${name}. ` : ""}I'm Coach. I'll keep you company, but the calls are yours: go with your gut, one concept at a time.`,
  cheer: ["Got it. First instinct is fine.", "Keep the pace.", "You're halfway.", "Steady. Next one.", "Last few."],
  wait: "I'll share what the team thinks once everyone has answered.",
};

// After everyone has submitted: where the team agrees and disagrees.
export async function teamSummary(stats, { finished, invited }) {
  const lines = stats.map(s => `Concept ${s.c.letter}: average ${s.avg?.toFixed(1) ?? "n/a"} from ${s.rs.length} (scores ${s.rs.map(r => r.score).join(", ")}); words: ${s.words.map(([w, n]) => `${w}${n > 1 ? ` x${n}` : ""}`).join(", ") || "none"}; comments: ${s.comments.map(r => `"${r.comment}"`).join(" ") || "none"}`).join("\n");
  return ask({ system: "You are Coach, speaking to the founder. Summarize a team's blind first-impression ratings of logo concepts in about 90 words, plain spoken English, no lists or markdown. Lead with where the team agrees (clear leaders and clear misses, with the words people used), then where it disagrees (wide spreads, mixed words), then one honest next step. Concepts are known only by letter. Don't invent anything not in the data.",
    content: [{ type: "text", text: `${finished} of ${invited} reviewers have submitted.\n${lines}` }], maxTokens: 600 });
}
