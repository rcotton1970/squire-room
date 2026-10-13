// Squire first-impressions board. Everything here is public code: the
// Supabase URL and publishable key are meant for browsers; every row and image
// is protected by the database's own rules (row-level security). Images are
// never in this repo: they come from a private bucket through short-lived
// signed links, only for the board's owner or an invited reviewer.
const CFG = {
  url: "https://thjaqvuimqctvvcwpndr.supabase.co",
  key: "sb_publishable_-KemqiZalO4K6DYP9aaDrg_Gf7R_5Sc",
};
const sb = window.supabase.createClient(CFG.url, CFG.key, { auth: { flowType: "pkce", detectSessionInUrl: true, persistSession: true } });
const app = document.getElementById("app");
const q = new URLSearchParams(location.search);
const SLUG = q.get("b") || "squire-logo";
// An invite token stays in this tab (not in history) while Google sign-in happens.
if (q.get("i")) { sessionStorage.setItem(`invite:${SLUG}`, q.get("i")); history.replaceState(null, "", `${location.pathname}?b=${SLUG}`); }
const INVITE = sessionStorage.getItem(`invite:${SLUG}`);

const ENCOURAGE = ["Nice. Next one. Quick gut call.", "Good. Keep going.", "Got it. Next one.", "Great. Gut call on this one.", "Thanks. Almost there."];
const el = (tag, attrs = {}, ...kids) => { const n = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === "class") n.className = v; else if (k.startsWith("on")) n[k] = v; else if (v != null) n.setAttribute(k, v); } for (const k of kids.flat()) if (k != null) n.append(k); return n; };
const show = (...nodes) => { app.textContent = ""; app.append(...nodes); window.scrollTo(0, 0); };
const errBox = (e) => el("p", { class: "err" }, String(e?.message || e));

// ── Coach's voice: never autoplays; Play speaks, Stop stops ──
let voiceOn = false;
function speak(text) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const voices = speechSynthesis.getVoices();
  u.voice = voices.find(v => /Evan|Aaron|Daniel|Google UK English Male|Microsoft Guy/i.test(v.name) && /^en/i.test(v.lang)) || voices.find(v => /^en/i.test(v.lang)) || null;
  u.rate = 1; u.pitch = 1;
  speechSynthesis.speak(u);
}
function playButton(text, label = "▶ Play the brief") {
  const b = el("button", { type: "button" }, label);
  b.onclick = () => { if (speechSynthesis.speaking) { speechSynthesis.cancel(); b.textContent = label; return; } voiceOn = true; speak(text); b.textContent = "■ Stop"; const t = setInterval(() => { if (!speechSynthesis.speaking) { b.textContent = label; clearInterval(t); } }, 400); };
  if (!("speechSynthesis" in window)) b.disabled = true;
  return b;
}

// ── Images: short-lived signed links from the private bucket ──
const urlCache = new Map();
async function imageUrl(path) {
  if (urlCache.has(path)) return urlCache.get(path);
  const { data, error } = await sb.storage.from("board-concepts").createSignedUrl(path, 3600);
  if (error) throw error;
  urlCache.set(path, data.signedUrl); return data.signedUrl;
}

// ── Start ──
async function start() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return signInScreen();
  const me = session.user;
  let { data: board } = await sb.from("boards").select("id, slug, title, brief, status, owners, approved_at").eq("slug", SLUG).maybeSingle();
  if (board?.owners?.includes(me.id)) return board.status === "draft" ? ownerApprove(board) : ownerLive(board);
  if (!board || INVITE) {
    if (!INVITE) return show(el("div", { class: "card" }, el("h1", {}, "This board needs your invite link"), el("p", { class: "muted" }, "Open the link you were sent. Each reviewer has their own."), signedInAs(me)));
    const { error } = await sb.rpc("board_claim", { p_slug: SLUG, p_token: INVITE });
    if (error) return show(el("div", { class: "card" }, el("h1", {}, "Can't open the board"), errBox(error), signedInAs(me)));
    sessionStorage.removeItem(`invite:${SLUG}`);
    ({ data: board } = await sb.from("boards").select("id, slug, title, brief, status, owners, approved_at").eq("slug", SLUG).maybeSingle());
  }
  return reviewer(board, me);
}
const signedInAs = (me) => el("p", { class: "small" }, `Signed in as ${me.email}. `, el("button", { type: "button", onclick: async () => { await sb.auth.signOut(); location.reload(); } }, "Sign out"));

function signInScreen() {
  const b = el("button", { type: "button", class: "primary" }, "Sign in with Google");
  b.onclick = async () => {
    b.disabled = true;
    const { error } = await sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: `${location.origin}${location.pathname}?b=${SLUG}`, queryParams: { prompt: "select_account" } } });
    if (error) { b.disabled = false; b.after(errBox(error)); }
  };
  show(el("div", { class: "card" }, el("h1", {}, "Squire · first impressions"), el("p", { class: "muted" }, "A few minutes, one gut call per logo. Sign in with Google so your answers count once and stay yours."), b,
    el("p", { class: "small" }, INVITE ? "Your invite link is ready; it opens after you sign in." : "Use the link you were sent.")));
}

// ── Reviewer ──
async function reviewer(board, me) {
  const [{ data: rv }, { data: concepts }, { data: mine }, { data: sub }] = await Promise.all([
    sb.from("board_reviewers").select("concept_order, label").eq("board_id", board.id).eq("user_id", me.id).maybeSingle(),
    sb.from("board_concepts").select("id, letter, image_path").eq("board_id", board.id),
    sb.from("board_responses").select("concept_id, score, word, comment").eq("board_id", board.id).eq("user_id", me.id),
    sb.from("board_submissions").select("receipt_hash, submitted_at").eq("board_id", board.id).eq("user_id", me.id).maybeSingle(),
  ]);
  if (!rv) return show(el("div", { class: "card" }, el("h1", {}, "You're not on this board"), el("p", { class: "muted" }, "Open the invite link you were sent."), signedInAs(me)));
  const byId = Object.fromEntries((concepts || []).map(c => [c.id, c]));
  const order = rv.concept_order.map(id => byId[id]).filter(Boolean);
  const answers = Object.fromEntries((mine || []).map(r => [r.concept_id, r]));
  if (sub) return reviewerDone(board, me, sub);
  const intro = () => show(el("div", { class: "card" },
    el("h1", {}, board.title), el("p", { class: "brief" }, board.brief),
    el("div", { class: "row" }, playButton(board.brief), el("button", { type: "button", class: "primary", onclick: () => step(Object.keys(answers).length >= order.length ? order.length : 0) }, Object.keys(answers).length ? "Continue" : "Start")),
    el("p", { class: "small" }, `${order.length} concepts, one at a time, in your own order. You'll see the team's reactions after you submit yours.`), signedInAs(me)));
  const step = async (i, cheer = "") => {
    if (i >= order.length) return review();
    const c = order[i], prev = answers[c.id] || {};
    let score = prev.score || 0;
    const src = await imageUrl(c.image_path).catch(() => "");
    const scoreBtns = [1, 2, 3, 4, 5].map(n => { const b = el("button", { type: "button", "aria-pressed": String(n === score), "aria-label": `Score ${n} of 5` }, String(n)); b.onclick = () => { score = n; scoreBtns.forEach(x => x.setAttribute("aria-pressed", String(x === b))); check(); }; return b; });
    const word = el("input", { type: "text", maxlength: "32", autocomplete: "off", placeholder: "e.g. solid", value: prev.word || "", "aria-label": "One word it makes you feel" });
    const comment = el("textarea", { maxlength: "500", placeholder: "Optional: anything else?", "aria-label": "Optional comment" }); comment.value = prev.comment || "";
    const next = el("button", { type: "button", class: "primary" }, i === order.length - 1 ? "Done: review my answers" : "Next");
    const msg = el("p", { class: "err" });
    const check = () => { next.disabled = !(score && /^\S{1,32}$/.test(word.value.trim())); };
    word.oninput = check; check();
    next.onclick = async () => {
      next.disabled = true; msg.textContent = "";
      const row = { board_id: board.id, user_id: me.id, concept_id: c.id, score, word: word.value.trim(), comment: comment.value.trim() || null, updated_at: new Date().toISOString() };
      const { error } = await sb.from("board_responses").upsert(row, { onConflict: "board_id,user_id,concept_id" });
      if (error) { msg.textContent = error.message; next.disabled = false; return; }
      answers[c.id] = row;
      const line = ENCOURAGE[i % ENCOURAGE.length];
      if (voiceOn && i < order.length - 1) speak(line);
      step(i + 1, i < order.length - 1 ? line : "");
    };
    const back = i > 0 ? el("button", { type: "button", onclick: () => step(i - 1) }, "Back") : null;
    show(el("div", { class: "card concept" },
      el("div", { class: "row" }, el("span", { class: "progress" }, `${i + 1} of ${order.length}`), el("span", { class: "encourage" }, cheer)),
      el("div", { class: "letter" }, `Concept ${c.letter}`),
      el("img", { class: "big", src, alt: `Concept ${c.letter}` }),
      el("div", { class: "tiny-row" }, ...[64, 40, 24].map(px => el("div", { class: "tiny" }, el("img", { src, alt: "", width: px, height: px }), `${px}px`)), el("div", { class: "tiny dark" }, el("img", { src, alt: "", width: 40, height: 40 }), "on dark")),
      el("p", { class: "small" }, "It has to work tiny too: that's the app-icon size."),
      el("div", {}, el("div", { class: "scores" }, scoreBtns), el("div", { class: "scale" }, el("span", {}, "1 · not for me"), el("span", {}, "5 · love it"))),
      el("label", {}, "One word it makes you feel", word),
      el("label", {}, "Comment (optional)", comment, dictateButton(comment)),
      msg, el("div", { class: "row" }, back, next)));
  };
  const review = () => {
    const rows = order.map(c => el("tr", {}, el("td", {}, c.letter), el("td", {}, String(answers[c.id]?.score ?? "—")), el("td", {}, answers[c.id]?.word || "—")));
    const all = order.every(c => answers[c.id]);
    const go = el("button", { type: "button", class: "primary" }, "Submit my answers");
    const msg = el("p", { class: "err" });
    go.disabled = !all;
    go.onclick = async () => {
      go.disabled = true;
      const { data, error } = await sb.rpc("board_submit", { p_board: board.id });
      if (error) { msg.textContent = error.message; go.disabled = false; return; }
      reviewerDone(board, me, { receipt_hash: data, submitted_at: new Date().toISOString() });
    };
    show(el("div", { class: "card" }, el("h1", {}, "Your answers"), el("table", {}, el("tr", {}, el("th", {}, "Concept"), el("th", {}, "Score"), el("th", {}, "Word")), rows),
      el("p", { class: "muted" }, "Once you submit, your answers are final, and you'll see how the team reacted."), msg,
      el("div", { class: "row" }, el("button", { type: "button", onclick: () => step(0) }, "Change something"), go)));
  };
  intro();
}
// Speak a comment instead of typing it (Chrome); only the words are kept, never audio.
function dictateButton(target) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const b = el("button", { type: "button" }, "🎙 Say it");
  b.onclick = () => {
    const r = new SR(); r.lang = navigator.language || "en-US"; r.interimResults = false;
    b.textContent = "Listening…"; b.disabled = true;
    r.onresult = (e) => { const t = [...e.results].map(x => x[0].transcript).join(" ").trim(); target.value = (target.value ? target.value + " " : "") + t; };
    r.onend = () => { b.textContent = "🎙 Say it"; b.disabled = false; };
    try { r.start(); } catch { r.onend(); }
  };
  return el("div", { class: "row" }, b, el("span", { class: "small" }, "only the words are kept"));
}
async function reviewerDone(board, me, sub) {
  const box = el("div", { class: "card" }, el("h1", {}, "Thank you: you're in"), el("p", { class: "ok" }, "Your answers are submitted and final."),
    el("p", { class: "small" }, "Receipt: ", el("span", { class: "receipt" }, sub.receipt_hash)), signedInAs(me));
  show(box, el("div", { class: "card" }, el("h2", {}, "How the team reacted so far"), await resultsList(board, { owner: false })));
}

// ── Results (owner: everything; a reviewer after submitting: the same, without names) ──
async function resultsList(board, { owner }) {
  const [{ data: concepts }, { data: resp }, { data: revs }] = await Promise.all([
    sb.from("board_concepts").select("id, letter, image_path, featured").eq("board_id", board.id),
    sb.from("board_responses").select("concept_id, user_id, score, word, comment").eq("board_id", board.id),
    owner ? sb.from("board_reviewers").select("user_id, label").eq("board_id", board.id) : Promise.resolve({ data: [] }),
  ]);
  const { data: subs } = await sb.from("board_submissions").select("user_id").eq("board_id", board.id);
  const done = new Set((subs || []).map(s => s.user_id));
  const name = Object.fromEntries((revs || []).map(r => [r.user_id, r.label]));
  const counted = (resp || []).filter(r => done.has(r.user_id));       // only submitted answers count
  const list = el("div", { class: "who" });
  const stats = (concepts || []).filter(c => c.featured).sort((a, b) => a.letter.localeCompare(b.letter)).map(c => {
    const rs = counted.filter(r => r.concept_id === c.id);
    const sc = rs.map(r => r.score);
    const avg = sc.length ? sc.reduce((a, b) => a + b, 0) / sc.length : null;
    const sd = sc.length > 1 ? Math.sqrt(sc.reduce((a, b) => a + (b - avg) ** 2, 0) / sc.length) : 0;
    const words = Object.entries(rs.reduce((m, r) => { const w = r.word.toLowerCase(); m[w] = (m[w] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]);
    return { c, rs, avg, sd, min: sc.length ? Math.min(...sc) : null, max: sc.length ? Math.max(...sc) : null, words, comments: rs.filter(r => r.comment) };
  });
  for (const s of stats) {
    const img = el("img", { alt: `Concept ${s.c.letter}` }); imageUrl(s.c.image_path).then(u => { img.src = u; }).catch(() => {});
    list.append(el("div", { class: "res card" }, img, el("div", {},
      el("div", { class: "row" }, el("b", {}, `Concept ${s.c.letter}`), el("span", { class: "avg" }, s.avg == null ? "—" : s.avg.toFixed(1)), el("span", { class: "small" }, s.avg == null ? "no answers yet" : `spread ${s.min}–${s.max} (±${s.sd.toFixed(1)}) · ${s.rs.length} ${s.rs.length === 1 ? "answer" : "answers"}`)),
      el("div", { class: "words" }, s.words.slice(0, 6).map(([w, n]) => el("span", {}, n > 1 ? `${w} ×${n}` : w))),
      s.comments.length ? el("ul", { class: "comments" }, s.comments.map(r => el("li", {}, owner && name[r.user_id] ? `${name[r.user_id]}: ${r.comment}` : r.comment))) : null)));
  }
  list._stats = stats;
  return list;
}

// ── Owner: approve the featured set (nothing is shared before this) ──
async function ownerApprove(board) {
  const { data: cands, error } = await sb.rpc("board_candidates", { p_board: board.id });
  if (error) return show(el("div", { class: "card" }, errBox(error)));
  const picked = new Set();
  const count = el("b", {}, "0 selected");
  const go = el("button", { type: "button", class: "primary", disabled: "" }, "Approve and go live");
  const msg = el("p", { class: "err" });
  const update = () => { count.textContent = `${picked.size} selected`; go.disabled = picked.size < 7 || picked.size > 10; go.textContent = picked.size >= 7 && picked.size <= 10 ? `Approve these ${picked.size} and go live` : "Pick 7 to 10"; };
  const sheet = el("div", { class: "sheet" }, cands.map(c => {
    const img = el("img", { alt: `Candidate ${c.candidate_no}` }); imageUrl(c.image_path).then(u => { img.src = u; }).catch(() => {});
    const card = el("div", { class: "cand", role: "checkbox", "aria-checked": "false", tabindex: "0" }, img, el("div", { class: "no" }, `#${c.candidate_no}`), el("div", { class: "src" }, c.source));
    const toggle = () => { picked.has(c.candidate_no) ? picked.delete(c.candidate_no) : picked.add(c.candidate_no); card.classList.toggle("on", picked.has(c.candidate_no)); card.setAttribute("aria-checked", String(picked.has(c.candidate_no))); update(); };
    card.onclick = toggle; card.onkeydown = (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggle(); } };
    return card;
  }));
  go.onclick = async () => {
    go.disabled = true; msg.textContent = "";
    const { data, error } = await sb.rpc("board_approve", { p_board: board.id, p_candidates: [...picked].sort((a, b) => a - b) });
    if (error) { msg.textContent = error.message; update(); return; }
    location.reload();
  };
  update();
  show(el("div", { class: "card" }, el("h1", {}, "Contact sheet: pick 7–10"), el("p", { class: "muted" }, `${cands.length} candidates. Only you can see this page. Nothing is shared until you approve a set; then each gets a random letter (A, B, C…), and reviewers never see these numbers or notes.`)),
    sheet, el("div", { class: "sticky row" }, count, go, msg));
}

// ── Owner: reviewers, links and results ──
async function ownerLive(board) {
  const [{ data: invites }, { data: revs }, { data: subs }] = await Promise.all([
    sb.from("board_invites").select("id, label, email, claimed_by, claimed_at, revoked_at, created_at").eq("board_id", board.id).order("created_at"),
    sb.from("board_reviewers").select("user_id, label, joined_at").eq("board_id", board.id),
    sb.from("board_submissions").select("user_id, submitted_at, receipt_hash").eq("board_id", board.id),
  ]);
  const done = new Map((subs || []).map(s => [s.user_id, s]));
  const people = el("div", { class: "who" });
  for (const inv of invites || []) {
    const state = inv.revoked_at ? "link revoked" : done.has(inv.claimed_by) ? `finished ${new Date(done.get(inv.claimed_by).submitted_at).toLocaleString()}` : inv.claimed_by ? "joined, not finished" : "link not opened yet";
    const rv = el("button", { type: "button", onclick: async () => { await sb.rpc("board_revoke", { p_invite: inv.id }); location.reload(); } }, "Revoke");
    people.append(el("div", { class: "row" }, el("b", {}, inv.label), el("span", { class: "small" }, `${state}${inv.email ? ` · ${inv.email}` : ""}`), inv.revoked_at || done.has(inv.claimed_by) ? null : rv));
  }
  const label = el("input", { type: "text", placeholder: "Name, e.g. Bill", maxlength: "40" });
  const email = el("input", { type: "text", placeholder: "Their Google email (optional: locks the link to it)" });
  const out = el("div");
  const add = el("button", { type: "button", class: "primary" }, "Make their link");
  add.onclick = async () => {
    if (!label.value.trim()) { label.focus(); return; }
    add.disabled = true;
    const raw = crypto.getRandomValues(new Uint8Array(24)), token = btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))].map(b => b.toString(16).padStart(2, "0")).join("");
    const { error } = await sb.rpc("board_invite", { p_board: board.id, p_label: label.value.trim(), p_token_hash: hash, p_email: email.value.trim() || null });
    add.disabled = false;
    if (error) { out.replaceChildren(errBox(error)); return; }
    const link = `${location.origin}${location.pathname}?b=${board.slug}&i=${token}`;
    const copy = el("button", { type: "button" }, "Copy link");
    copy.onclick = async () => { try { await navigator.clipboard.writeText(link); copy.textContent = "Copied ✓"; } catch { copy.textContent = "Select and copy the link above"; } };
    out.replaceChildren(el("div", { class: "link-box" }, el("b", {}, `${label.value.trim()}'s link (shown once; send it to them privately)`), el("code", {}, link), el("div", { class: "row" }, copy, el("button", { type: "button", onclick: () => location.reload() }, "Done"))));
    label.value = ""; email.value = "";
  };
  const results = await resultsList(board, { owner: true });
  const invited = (invites || []).filter(i => !i.revoked_at).length, finished = (invites || []).filter(i => !i.revoked_at && done.has(i.claimed_by)).length;
  const summaryOut = el("div", { class: "grid" });
  const summarize = el("button", { type: "button", class: finished && finished === invited ? "primary" : "" }, finished === invited && invited ? "▶ Coach's summary" : `Coach's summary (${finished} of ${invited} in so far)`);
  summarize.disabled = !finished;
  summarize.onclick = async () => {
    summarize.disabled = true; summaryOut.replaceChildren(el("p", { class: "muted" }, "Coach is reading the results…"));
    try { const text = await coachSummary(results._stats, { finished, invited }); summaryOut.replaceChildren(el("p", { class: "brief" }, text), playButton(text, "▶ Hear it")); speak(text); }
    catch (e) { summaryOut.replaceChildren(errBox(e)); }
    summarize.disabled = false;
  };
  show(el("div", { class: "card" }, el("h1", {}, board.title), el("p", { class: "muted" }, `Live since ${new Date(board.approved_at || Date.now()).toLocaleDateString()}. ${finished} of ${invited} reviewers finished.`), el("div", { class: "row" }, summarize), summaryOut),
    el("div", { class: "card" }, el("h2", {}, "Reviewers"), people, el("label", {}, "Add a reviewer", label), email, add, out),
    el("div", { class: "card" }, el("h2", {}, "Results (submitted answers only)"), results));
}
// Coach's short summary, through Coach's own server (the Claude key stays there).
async function coachSummary(stats, { finished, invited }) {
  const { data: { session } } = await sb.auth.getSession();
  const lines = stats.map(s => `Concept ${s.c.letter}: average ${s.avg?.toFixed(1) ?? "n/a"} from ${s.rs.length} (scores ${s.rs.map(r => r.score).join(", ")}); words: ${s.words.map(([w, n]) => `${w}${n > 1 ? ` x${n}` : ""}`).join(", ") || "none"}; comments: ${s.comments.map(r => `"${r.comment}"`).join(" ") || "none"}`).join("\n");
  const res = await fetch(`${CFG.url}/functions/v1/claude/v1/messages`, { method: "POST", headers: { "Content-Type": "application/json", apikey: CFG.key, Authorization: `Bearer ${session.access_token}`, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ max_tokens: 600, stream: false, system: "You are Coach, speaking out loud to the founder. Summarize a team's first-impression ratings of logo concepts in about 120 words, plain spoken English, no lists or markdown. Say which concepts led and why (scores and the words people used), where the team disagrees (wide spreads, mixed words), and one honest next step. Concepts are known only by letter; never guess who made or prefers which. Don't invent anything not in the data.",
      messages: [{ role: "user", content: `${finished} of ${invited} reviewers have submitted.\n${lines}` }] }) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error?.message || `Coach couldn't answer (${res.status})`);
  return (j.content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
}

// One start per page load; a sign-in that finishes later (the Google return) starts it once more.
let running = null, startedFor = null;
const go = (session) => { const who = session?.user?.id || "none"; if (running || startedFor === who) return; startedFor = who; running = start().catch(e => show(el("div", { class: "card" }, errBox(e)))).finally(() => { running = null; }); };
sb.auth.getSession().then(({ data }) => go(data.session));
sb.auth.onAuthStateChange((ev, session) => { if (ev === "SIGNED_IN") setTimeout(() => go(session), 0); });
