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
  let { data: board } = await sb.from("boards").select(BOARD_COLS).eq("slug", SLUG).maybeSingle();
  if (board?.owners?.includes(me.id)) return board.kind === "brand" ? ownerBrand(board) : board.status === "draft" ? ownerDraft(board) : ownerLive(board);
  if (!board || INVITE) {
    if (!INVITE) return show(el("div", { class: "card" }, el("h1", {}, "This board needs your invite link"), el("p", { class: "muted" }, "Open the link you were sent. Each reviewer has their own."), signedInAs(me)));
    const { error } = await sb.rpc("board_claim", { p_slug: SLUG, p_token: INVITE });
    if (error) return show(el("div", { class: "card" }, el("h1", {}, "Can't open the board"), errBox(error), signedInAs(me)));
    sessionStorage.removeItem(`invite:${SLUG}`);
    ({ data: board } = await sb.from("boards").select(BOARD_COLS).eq("slug", SLUG).maybeSingle());
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
    const c = order[i];
    const src = await imageUrl(c.image_path).catch(() => "");
    show(conceptView({ letter: c.letter, src, i, total: order.length, cheer, prev: answers[c.id] || {},
      onBack: i > 0 ? () => step(i - 1) : null,
      onNext: async ({ score, word, comment }) => {
        const row = { board_id: board.id, user_id: me.id, concept_id: c.id, score, word, comment, updated_at: new Date().toISOString() };
        const { error } = await sb.from("board_responses").upsert(row, { onConflict: "board_id,user_id,concept_id" });
        if (error) return error.message;
        answers[c.id] = row;
        const line = ENCOURAGE[i % ENCOURAGE.length];
        if (voiceOn && i < order.length - 1) speak(line);
        step(i + 1, i < order.length - 1 ? line : "");
      } }));
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
// One concept, as a reviewer sees it (also used by the owner's "Preview as reviewer").
function conceptView({ letter, src, i, total, cheer = "", prev = {}, onNext, onBack, banner = null }) {
  let score = prev.score || 0;
  const scoreBtns = [1, 2, 3, 4, 5].map(n => { const b = el("button", { type: "button", "aria-pressed": String(n === score), "aria-label": `Score ${n} of 5` }, String(n)); b.onclick = () => { score = n; scoreBtns.forEach(x => x.setAttribute("aria-pressed", String(x === b))); check(); }; return b; });
  const word = el("input", { type: "text", maxlength: "32", autocomplete: "off", placeholder: "e.g. solid", value: prev.word || "", "aria-label": "One word it makes you feel" });
  const comment = el("textarea", { maxlength: "500", placeholder: "Optional: anything else?", "aria-label": "Optional comment" }); comment.value = prev.comment || "";
  const next = el("button", { type: "button", class: "primary" }, i === total - 1 ? "Done: review my answers" : "Next");
  const msg = el("p", { class: "err" });
  const check = () => { next.disabled = !(score && /^\S{1,32}$/.test(word.value.trim())); };
  word.oninput = check; check();
  next.onclick = async () => {
    next.disabled = true; msg.textContent = "";
    const err = await onNext({ score, word: word.value.trim(), comment: comment.value.trim() || null });
    if (err) { msg.textContent = err; next.disabled = false; }
  };
  const back = onBack ? el("button", { type: "button", onclick: onBack }, "Back") : null;
  return el("div", { class: "card concept" }, banner,
    el("div", { class: "row" }, el("span", { class: "progress" }, `${i + 1} of ${total}`), el("span", { class: "encourage" }, cheer)),
    el("div", { class: "letter" }, `Concept ${letter}`),
    el("img", { class: "big", src, alt: `Concept ${letter}` }),
    el("div", { class: "tiny-row" }, ...[64, 40, 24].map(px => el("div", { class: "tiny" }, el("img", { src, alt: "", width: px, height: px }), `${px}px`)), el("div", { class: "tiny dark" }, el("img", { src, alt: "", width: 40, height: 40 }), "on dark")),
    el("p", { class: "small" }, "It has to work tiny too: that's the app-icon size."),
    el("div", {}, el("div", { class: "scores" }, scoreBtns), el("div", { class: "scale" }, el("span", {}, "1 · not for me"), el("span", {}, "5 · love it"))),
    el("label", {}, "One word it makes you feel", word),
    el("label", {}, "Comment (optional)", comment, dictateButton(comment)),
    msg, el("div", { class: "row" }, back, next));
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

// ── Owner: draft mode. Nothing is shared while a board is a draft. ──
const BOARD_COLS = "id, slug, title, brief, status, owners, approved_at, series, round, parent_board, kind";
const IMAGE_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
async function uploadImage(board, blob) {
  const ext = IMAGE_TYPES[blob.type];
  if (!ext) throw new Error("Use a PNG, JPEG or WebP image.");
  if (blob.size > 10 * 1024 * 1024) throw new Error("That image is over 10 MB.");
  const path = `${board.id}/${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}.${ext}`;
  const { error } = await sb.storage.from("board-concepts").upload(path, blob, { contentType: blob.type, upsert: false });
  if (error) throw error;
  return path;
}
const rpc = async (fn, args) => { const { data, error } = await sb.rpc(fn, args); if (error) throw error; return data; };
const shuffle = (xs) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const when = (t) => new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

// Two clicks for anything that locks or closes: the first arms, the second does it.
function armed(label, armedLabel, run, cls = "") {
  const b = el("button", { type: "button", class: cls }, label);
  let t = null;
  b.onclick = async () => {
    if (!t) { b.textContent = armedLabel; t = setTimeout(() => { t = null; b.textContent = label; }, 5000); return; }
    clearTimeout(t); t = null; b.disabled = true;
    try { await run(); } catch (e) { b.disabled = false; b.textContent = label; b.after(errBox(e)); }
  };
  return b;
}

async function roundsList(board) {
  const { data } = await sb.from("boards").select("slug, round, status, approved_at, created_at").eq("series", board.series).order("round");
  if (!data || data.length < 2) return null;
  return el("div", { class: "rounds" }, data.map(r => el("a", { href: `?b=${r.slug}`, "aria-current": r.slug === board.slug ? "page" : null },
    `Round ${r.round} · ${r.status === "closed" ? "closed, kept as the record" : r.status}`)));
}

async function ownerDraft(board, ui = { tab: "concepts", picked: new Set() }) {
  const cands = await rpc("board_candidates", { p_board: board.id });
  const active = cands.filter(c => !c.archived_at), archived = cands.filter(c => c.archived_at);
  for (const id of [...ui.picked]) if (!active.some(c => c.id === id)) ui.picked.delete(id);
  const again = (tab = ui.tab) => ownerDraft(board, { ...ui, tab }).catch(e => show(el("div", { class: "card" }, errBox(e))));
  const msg = el("p", { class: "err" });
  const act = async (run) => { msg.textContent = ""; try { await run(); await again(); } catch (e) { msg.textContent = e.message || String(e); } };

  // Concepts: upload, replace, crop, reorder, label, notes, archive
  const upload = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp", multiple: "", class: "file" });
  upload.onchange = () => act(async () => {
    for (const f of upload.files) { const path = await uploadImage(board, f); await rpc("board_add_concept", { p_board: board.id, p_image_path: path, p_label: f.name.replace(/\.[^.]+$/, "").slice(0, 80) }); }
  });
  const move = (c, to) => act(async () => {
    const ids = active.map(x => x.id).filter(id => id !== c.id);
    ids.splice(Math.max(0, Math.min(ids.length, to)), 0, c.id);
    await rpc("board_reorder", { p_board: board.id, p_concepts: ids });
  });
  const card = (c, i) => {
    const img = el("img", { alt: c.label }); imageUrl(c.image_path).then(u => { img.src = u; }).catch(() => {});
    const label = el("input", { type: "text", maxlength: "80", value: c.label, "aria-label": `Private label for #${c.candidate_no}` });
    const notes = el("textarea", { maxlength: "1000", placeholder: "Notes (only you see these)", "aria-label": `Notes for #${c.candidate_no}` }); notes.value = c.notes || "";
    const saved = el("span", { class: "small" });
    const save = async () => { try { await rpc("board_label", { p_concept: c.id, p_label: label.value, p_notes: notes.value }); saved.textContent = "Saved ✓"; } catch (e) { saved.textContent = e.message; } };
    label.onchange = save; notes.onchange = save;
    const pick = el("input", { type: "checkbox", "aria-label": `Include #${c.candidate_no} when going live` }); pick.checked = ui.picked.has(c.id);
    pick.onchange = () => { pick.checked ? ui.picked.add(c.id) : ui.picked.delete(c.id); card.classList.toggle("on", pick.checked); updateLive(); };
    const replace = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp", class: "file" });
    replace.onchange = () => act(async () => { const path = await uploadImage(board, replace.files[0]); await rpc("board_replace_image", { p_concept: c.id, p_image_path: path }); });
    const card = el("div", { class: `cand edit${ui.picked.has(c.id) ? " on" : ""}` }, img,
      el("div", { class: "row" }, el("label", { class: "pick" }, pick, `#${c.candidate_no}`), el("span", { class: "small" }, `${i + 1} of ${active.length}`)),
      label, notes, saved,
      el("div", { class: "row tools" },
        el("button", { type: "button", disabled: i === 0 ? "" : null, onclick: () => move(c, 0), title: "Move to the top" }, "Top"),
        el("button", { type: "button", disabled: i === 0 ? "" : null, onclick: () => move(c, i - 1), "aria-label": "Move up" }, "↑"),
        el("button", { type: "button", disabled: i === active.length - 1 ? "" : null, onclick: () => move(c, i + 1), "aria-label": "Move down" }, "↓")),
      el("div", { class: "row tools" },
        el("label", { class: "button" }, "Replace", replace),
        el("button", { type: "button", onclick: () => cropper(board, c, again) }, "Crop"),
        c.original_path && c.original_path !== c.image_path ? el("button", { type: "button", onclick: () => act(() => rpc("board_replace_image", { p_concept: c.id, p_image_path: c.original_path })) }, "Use original") : null,
        el("button", { type: "button", onclick: () => act(() => rpc("board_archive", { p_concept: c.id, p_archive: true })) }, "Archive")),
      el("p", { class: "small src" }, c.source));
    return card;
  };
  const conceptsTab = el("div", { class: "grid" },
    el("div", { class: "row" }, el("label", { class: "button primary" }, "＋ Upload images", upload), el("span", { class: "small" }, "PNG, JPEG or WebP. Replacing or cropping keeps the original.")),
    active.length ? el("div", { class: "sheet wide" }, active.map(card)) : el("p", { class: "muted" }, "No concepts yet. Upload some."));

  // Archive: everything removed, with dates; nothing is ever deleted
  const archiveTab = el("div", { class: "grid" }, archived.length ? el("div", { class: "sheet" }, archived.map(c => {
    const img = el("img", { alt: c.label }); imageUrl(c.image_path).then(u => { img.src = u; }).catch(() => {});
    return el("div", { class: "cand archived" }, img, el("b", {}, `#${c.candidate_no} · ${c.label}`), el("span", { class: "small" }, `Archived ${when(c.archived_at)}`),
      c.notes ? el("p", { class: "small" }, c.notes) : null,
      el("button", { type: "button", onclick: () => act(() => rpc("board_archive", { p_concept: c.id, p_archive: false })) }, "Restore"));
  })) : el("p", { class: "muted" }, "Nothing archived. Archived concepts land here with the date, and can be restored."));

  // Preview: exactly what a reviewer sees, blind-lettered, in a random order; nothing is saved
  const previewSet = () => (ui.picked.size ? active.filter(c => ui.picked.has(c.id)) : active);
  const preview = el("button", { type: "button" }, "Preview as reviewer");
  preview.onclick = () => previewBoard(board, previewSet(), again);

  // Go live
  const count = el("b", {});
  const live = el("div", { class: "row" });
  const updateLive = () => {
    const n = ui.picked.size;
    count.textContent = `${n} selected`;
    preview.textContent = n ? `Preview these ${n} as a reviewer` : "Preview as reviewer";
    const ok = n >= 7 && n <= 10;
    live.replaceChildren(ok ? armed(`Go live with these ${n}`, "Locks the set. Tap again to go live", async () => {
      const nos = active.filter(c => ui.picked.has(c.id)).map(c => c.candidate_no);
      await rpc("board_approve", { p_board: board.id, p_candidates: nos });
      location.reload();
    }, "primary") : el("span", { class: "small" }, "Tick 7 to 10 to go live"));
  };
  updateLive();

  const tabs = [["concepts", `Concepts (${active.length})`, conceptsTab], ["archive", `Archive (${archived.length})`, archiveTab]];
  const tabBar = el("div", { class: "tabs", role: "tablist" }, tabs.map(([k, name]) => el("button", { type: "button", role: "tab", "aria-selected": String(ui.tab === k), onclick: () => again(k) }, name)));
  show(el("div", { class: "card" }, el("h1", {}, board.title), el("p", { class: "muted" }, `Round ${board.round} · draft. Only you can see this page. Nothing is shared until you go live; then each concept gets a random letter, and reviewers never see your labels, notes or numbers.`),
      await roundsList(board), newBoardButton()),
    tabBar, (tabs.find(t => t[0] === ui.tab) || tabs[0])[2], msg,
    el("div", { class: "sticky row" }, count, preview, live));
}

// ── Owner: the private brand board. Featured · Reviewed · Archive, grouped by family. ──
const SHELVES = [["featured", "Featured"], ["reviewed", "Reviewed"], ["archive", "Archive"]];
const shelfOf = (c) => (c.archived_at ? "archive" : c.shelf || "reviewed");
async function ownerBrand(board, ui = { tab: "featured", picked: new Set(), sent: null }) {
  const cands = await rpc("board_candidates", { p_board: board.id });
  const me = (await sb.auth.getUser()).data.user;
  for (const id of [...ui.picked]) if (!cands.some(c => c.id === id && !c.archived_at && c.image_path)) ui.picked.delete(id);
  const again = (tab = ui.tab) => ownerBrand(board, { ...ui, tab }).catch(e => show(el("div", { class: "card" }, errBox(e))));
  const msg = el("p", { class: "err" });
  const act = async (run) => { msg.textContent = ""; try { await run(); ui.sent = null; await again(); } catch (e) { msg.textContent = e.message || String(e); } };
  const active = cands.filter(c => !c.archived_at).sort((a, b) => a.sort_order - b.sort_order);
  const missing = cands.filter(c => c.image_missing);

  const upload = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp", multiple: "", class: "file" });
  upload.onchange = () => act(async () => { for (const f of upload.files) { const p = await uploadImage(board, f); await rpc("board_add_concept", { p_board: board.id, p_image_path: p, p_label: f.name.replace(/\.[^.]+$/, "").slice(0, 80) }); } });

  // Moving within what you see (same shelf and family): rebuild the whole order once.
  const moveWithin = (c, group, to) => act(async () => {
    const ids = active.map(x => x.id).filter(id => id !== c.id);
    const others = group.filter(x => x.id !== c.id);
    const anchor = to === "top" ? others[0] : to === "up" ? others[Math.max(0, group.indexOf(c) - 1)] : others[Math.min(others.length - 1, group.indexOf(c))];
    let at = ids.indexOf(anchor.id) + (to === "down" ? 1 : 0);
    ids.splice(at, 0, c.id);
    await rpc("board_reorder", { p_board: board.id, p_concepts: ids });
  });
  const moveTo = (c, shelf) => act(async () => {
    if (shelf === "archive") return rpc("board_archive", { p_concept: c.id, p_archive: true });
    if (c.archived_at) await rpc("board_archive", { p_concept: c.id, p_archive: false });
    await rpc("board_curate", { p_concept: c.id, p_shelf: shelf, p_starred: null, p_family: null });
  });

  const card = (c, group, i) => {
    const archived = Boolean(c.archived_at);
    const imgBox = c.image_path ? (() => { const img = el("img", { alt: c.ref || c.label }); imageUrl(c.image_path).then(u => { img.src = u; }).catch(() => {}); return img; })()
      : el("div", { class: "missing" }, "Image missing");
    const star = el("button", { type: "button", class: `star${c.starred ? " on" : ""}`, "aria-pressed": String(c.starred), "aria-label": c.starred ? "Unstar" : "Star", disabled: archived ? "" : null,
      onclick: () => act(() => rpc("board_curate", { p_concept: c.id, p_shelf: null, p_starred: !c.starred, p_family: null })) }, c.starred ? "★" : "☆");
    const notes = el("textarea", { maxlength: "1000", placeholder: "Add a note", "aria-label": `Notes for ${c.ref || c.label}` }); notes.value = c.notes || "";
    const saved = el("span", { class: "small" });
    notes.onchange = async () => { try { await rpc("board_label", { p_concept: c.id, p_label: c.label, p_notes: notes.value }); saved.textContent = "Saved ✓"; } catch (e) { saved.textContent = e.message; } };
    const family = el("input", { type: "text", maxlength: "60", value: c.family || "", placeholder: "Family", "aria-label": `Family for ${c.ref || c.label}` });
    family.onchange = () => act(() => rpc("board_curate", { p_concept: c.id, p_shelf: null, p_starred: null, p_family: family.value }));
    const shelf = el("select", { "aria-label": "Move to tab" }, SHELVES.map(([k, n]) => { const o = el("option", { value: k }, n); if (k === shelfOf(c)) o.selected = true; return o; }));
    shelf.onchange = () => moveTo(c, shelf.value);
    const file = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp", class: "file" });
    file.onchange = () => act(async () => { const p = await uploadImage(board, file.files[0]); await rpc("board_replace_image", { p_concept: c.id, p_image_path: p }); });
    const pick = el("input", { type: "checkbox", "aria-label": `Select ${c.ref || c.label}`, disabled: archived || !c.image_path ? "" : null }); pick.checked = ui.picked.has(c.id);
    pick.onchange = () => { pick.checked ? ui.picked.add(c.id) : ui.picked.delete(c.id); node.classList.toggle("on", pick.checked); updateBar(); };
    const node = el("article", { class: `bcard${ui.picked.has(c.id) ? " on" : ""}${c.image_missing ? " flag" : ""}`, id: `card-${c.ref || c.id}` }, imgBox,
      el("div", { class: "row head" }, el("label", { class: "pick" }, pick), el("b", { class: "ref" }, c.ref || `#${c.candidate_no}`), el("span", { class: `chip ${shelfOf(c)}` }, SHELVES.find(s => s[0] === shelfOf(c))[1]), star),
      c.description ? el("p", { class: "desc" }, c.description) : null,
      el("div", { class: "comments-v" }, el("span", { class: "small" }, "Your comments"), c.comments ? el("blockquote", {}, c.comments) : el("p", { class: "small" }, "No comments")),
      archived ? el("p", { class: "small" }, `Archived ${when(c.archived_at)}`) : null,
      c.image_missing ? el("p", { class: "err" }, "Image missing: add it with “Add image”.") : null,
      notes, saved,
      el("div", { class: "row tools" }, shelf, family),
      el("div", { class: "row tools" },
        archived ? null : el("button", { type: "button", disabled: i === 0 ? "" : null, onclick: () => moveWithin(c, group, "top") }, "Top"),
        archived ? null : el("button", { type: "button", disabled: i === 0 ? "" : null, onclick: () => moveWithin(c, group, "up"), "aria-label": "Move up" }, "↑"),
        archived ? null : el("button", { type: "button", disabled: i === group.length - 1 ? "" : null, onclick: () => moveWithin(c, group, "down"), "aria-label": "Move down" }, "↓"),
        el("label", { class: "button" }, c.image_path ? "Replace" : "Add image", file),
        c.original_path && c.original_path !== c.image_path ? el("button", { type: "button", onclick: () => act(() => rpc("board_replace_image", { p_concept: c.id, p_image_path: c.original_path })) }, "Use original") : null),
      );
    return node;
  };

  const inTab = cands.filter(c => shelfOf(c) === ui.tab).sort((a, b) => (a.archived_at && b.archived_at ? String(b.archived_at).localeCompare(a.archived_at) : a.sort_order - b.sort_order));
  const families = [...new Set(inTab.map(c => c.family || ""))].sort((a, b) => (a === "") - (b === "") || a.localeCompare(b));
  const tabBody = inTab.length ? el("div", { class: "grid" }, families.map(f => { const group = inTab.filter(c => (c.family || "") === f);
      return el("section", { class: "family grid" }, el("h2", {}, `${f || "No family"} `, el("span", { class: "small" }, String(group.length))), el("div", { class: "sheet wide" }, group.map((c, i) => card(c, group, i)))); }))
    : el("p", { class: "muted" }, ui.tab === "archive" ? "Nothing archived. Uncommented images land here, still visible." : `Nothing on ${SHELVES.find(s => s[0] === ui.tab)[1]} yet.`);

  // Preview and send
  const count = el("b", {});
  const preview = el("button", { type: "button" }, "Preview as reviewer");
  preview.onclick = () => previewBoard({ ...board, title: "Squire · first impressions", brief: "Go with your gut. There are no wrong answers." }, active.filter(c => ui.picked.has(c.id)), again);
  const sendBox = el("div", { class: "row" });
  const { data: teamBoards } = await sb.from("boards").select("id, slug, title, status, round, owners, kind").eq("kind", "first-impressions").order("created_at");
  const targets = (teamBoards || []).filter(b => b.owners?.includes(me.id) && b.status === "draft");
  const updateBar = () => {
    const n = ui.picked.size;
    count.textContent = `${n} selected`;
    preview.disabled = !n;
    if (ui.sent) return sendBox.replaceChildren(el("span", { class: "ok" }, `Sent ✓ `), el("a", { href: `?b=${ui.sent}` }, "Open the team logo board"));
    if (!targets.length) return sendBox.replaceChildren(el("span", { class: "small" }, "The team logo board is live (locked). Start a new round there to send more."));
    const target = el("select", { "aria-label": "Team board" }, targets.map(b => el("option", { value: b.id }, `${b.title} · round ${b.round}`)));
    sendBox.replaceChildren(...[targets.length > 1 ? target : null, n ? armed(`Send ${n} to the team logo board`, "Adds them to its draft (blind letters when it goes live). Tap again", async () => {
      ui.sent = await rpc("board_send", { p_brand: board.id, p_target: targets.length > 1 ? target.value : targets[0].id, p_concepts: [...ui.picked] });
      ui.picked.clear(); await again();
    }, "primary") : el("span", { class: "small" }, "Select cards to preview or send")].filter(Boolean));
  };
  updateBar();

  const tabBar = el("div", { class: "tabs", role: "tablist" }, SHELVES.map(([k, n]) => el("button", { type: "button", role: "tab", "aria-selected": String(ui.tab === k), onclick: () => again(k) }, `${n} (${cands.filter(c => shelfOf(c) === k).length})`)));
  show(el("div", { class: "card" }, el("h1", {}, board.title), el("p", { class: "muted" }, "Private: only you see this board. Uncommented images sit in Archive, still visible. Nothing is ever deleted."),
      missing.length ? el("div", { class: "flag-box" }, el("b", {}, `Image missing (${missing.length}): `), missing.flatMap((c, i) => [i ? ", " : "", el("a", { href: `#card-${c.ref || c.id}`, onclick: (e) => { e.preventDefault(); again(shelfOf(c)).then(() => document.getElementById(`card-${c.ref || c.id}`)?.scrollIntoView({ block: "center" })); } }, c.ref || `#${c.candidate_no}`)])) : null,
      el("div", { class: "row" }, el("label", { class: "button" }, "＋ Upload images", upload), el("span", { class: "small" }, "New images start on Reviewed."))),
    tabBar, tabBody, msg,
    el("div", { class: "sticky row" }, count, preview, sendBox));
}

// Crop with four sliders; saves a new image (the original is kept)
async function cropper(board, c, done) {
  const blob = await (await fetch(await imageUrl(c.image_path))).blob();
  const bmp = await createImageBitmap(blob);
  const cut = { left: 0, right: 0, top: 0, bottom: 0 };
  const canvas = el("canvas", { class: "crop", width: String(bmp.width), height: String(bmp.height), "aria-label": "Crop preview" });
  const draw = () => {
    const g = canvas.getContext("2d"); g.clearRect(0, 0, bmp.width, bmp.height); g.drawImage(bmp, 0, 0);
    const x = bmp.width * cut.left / 100, y = bmp.height * cut.top / 100, w = bmp.width * (1 - (cut.left + cut.right) / 100), h = bmp.height * (1 - (cut.top + cut.bottom) / 100);
    g.fillStyle = "rgba(30,34,38,.55)"; g.fillRect(0, 0, bmp.width, y); g.fillRect(0, y + h, bmp.width, bmp.height - y - h); g.fillRect(0, y, x, h); g.fillRect(x + w, y, bmp.width - x - w, h);
    return { x, y, w, h };
  };
  const sliders = ["left", "right", "top", "bottom"].map(k => {
    const r = el("input", { type: "range", min: "0", max: "45", value: "0", "aria-label": `Trim ${k}` });
    r.oninput = () => { cut[k] = Number(r.value); draw(); };
    return el("label", {}, `Trim ${k}`, r);
  });
  const msg = el("p", { class: "err" });
  const save = el("button", { type: "button", class: "primary" }, "Save crop");
  save.onclick = async () => {
    save.disabled = true;
    try {
      const { x, y, w, h } = draw();
      const out = el("canvas", { width: String(Math.round(w)), height: String(Math.round(h)) });
      out.getContext("2d").drawImage(bmp, x, y, w, h, 0, 0, Math.round(w), Math.round(h));
      const png = await new Promise(r => out.toBlob(r, "image/png"));
      const path = await uploadImage(board, png);
      await rpc("board_replace_image", { p_concept: c.id, p_image_path: path });
      await done("concepts");
    } catch (e) { msg.textContent = e.message || String(e); save.disabled = false; }
  };
  draw();
  show(el("div", { class: "card" }, el("h1", {}, `Crop: ${c.label}`), canvas, el("div", { class: "crop-grid" }, sliders), msg,
    el("div", { class: "row" }, el("button", { type: "button", onclick: () => done("concepts") }, "Cancel"), save)));
}

// The reviewer's screens, run locally: letters and order are drawn fresh each time, nothing is saved
async function previewBoard(board, set, back) {
  const order = shuffle(set).map((c, i) => ({ ...c, letter: String.fromCharCode(65 + i) }));
  const shuffled = shuffle(order);
  const answers = {};
  const banner = () => el("div", { class: "preview-bar row" }, el("b", {}, "Preview: what a reviewer sees. Nothing is saved."), el("button", { type: "button", onclick: () => back() }, "Exit preview"));
  const intro = () => show(el("div", { class: "card" }, banner(), el("h1", {}, board.title), el("p", { class: "brief" }, board.brief),
    el("div", { class: "row" }, playButton(board.brief), el("button", { type: "button", class: "primary", onclick: () => step(0) }, "Start")),
    el("p", { class: "small" }, `${shuffled.length} concepts, one at a time, in your own order. You'll see the team's reactions after you submit yours.`)));
  const step = async (i, cheer = "") => {
    if (i >= shuffled.length) return show(el("div", { class: "card" }, banner(), el("h1", {}, "Your answers"),
      el("table", {}, el("tr", {}, el("th", {}, "Concept"), el("th", {}, "Score"), el("th", {}, "Word")), shuffled.map(c => el("tr", {}, el("td", {}, c.letter), el("td", {}, String(answers[c.id]?.score ?? "—")), el("td", {}, answers[c.id]?.word || "—")))),
      el("p", { class: "muted" }, "Here a reviewer submits. In preview, nothing is sent."), el("div", { class: "row" }, el("button", { type: "button", onclick: () => previewBoard(board, set, back) }, "Preview again (new order)"), el("button", { type: "button", class: "primary", onclick: () => back() }, "Back to the draft"))));
    const c = shuffled[i];
    const src = await imageUrl(c.image_path).catch(() => "");
    show(conceptView({ letter: c.letter, src, i, total: shuffled.length, cheer, prev: answers[c.id] || {}, banner: banner(),
      onBack: i > 0 ? () => step(i - 1) : null,
      onNext: async (v) => { answers[c.id] = v; step(i + 1, i < shuffled.length - 1 ? ENCOURAGE[i % ENCOURAGE.length] : ""); } }));
  };
  intro();
}

// A new board (e.g. the brand board); you own it, it starts as a draft
function newBoardButton() {
  const b = el("button", { type: "button", class: "link" }, "＋ New board");
  b.onclick = () => {
    const title = el("input", { type: "text", maxlength: "120", placeholder: "e.g. Squire brand board" });
    const slug = el("input", { type: "text", maxlength: "40", placeholder: "e.g. squire-brand" });
    const brief = el("textarea", { maxlength: "2000", placeholder: "What reviewers read first" });
    title.oninput = () => { if (!slug.dataset.touched) slug.value = title.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40); };
    slug.oninput = () => { slug.dataset.touched = "1"; };
    const msg = el("p", { class: "err" });
    const make = el("button", { type: "button", class: "primary" }, "Make the board");
    make.onclick = async () => {
      make.disabled = true; msg.textContent = "";
      try { await rpc("board_create", { p_slug: slug.value.trim(), p_title: title.value.trim(), p_brief: brief.value.trim() }); location.href = `?b=${slug.value.trim()}`; }
      catch (e) { msg.textContent = /slug|unique|check/i.test(e.message) ? "That web name is taken or not allowed (3–40 lowercase letters, numbers, dashes)." : e.message; make.disabled = false; }
    };
    b.replaceWith(el("div", { class: "grid new-board" }, el("label", {}, "Title", title), el("label", {}, "Web name", slug), el("label", {}, "Brief", brief), msg, el("div", { class: "row" }, el("button", { type: "button", onclick: () => location.reload() }, "Cancel"), make)));
  };
  return b;
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
  const closed = board.status === "closed";
  const opened = (invites || []).some(i => i.claimed_by);
  const { data: newer } = await sb.from("boards").select("slug, round").eq("parent_board", board.id).maybeSingle();
  const changes = el("div", { class: "grid" });
  if (newer) changes.append(el("p", { class: "muted" }, "This round is closed and kept as the record. ", el("a", { href: `?b=${newer.slug}` }, `Go to round ${newer.round}`)));
  else if (!opened && !closed) changes.append(el("div", { class: "row" }, armed("Back to draft", "Nobody has opened a link yet. Tap again to unlock", async () => { await rpc("board_unlock", { p_board: board.id }); location.reload(); }),
    el("span", { class: "small" }, "Works only until a reviewer opens their link.")));
  else changes.append(el("div", { class: "row" }, armed(`Start round ${board.round + 1}`, `Closes round ${board.round} (answers kept). Tap again`, async () => { const slug = await rpc("board_new_round", { p_board: board.id }); location.href = `?b=${slug}`; }),
    el("span", { class: "small" }, opened ? "The set is locked: a reviewer has opened a link. To change it, start a new round; this round's answers stay as the record." : "")));
  show(el("div", { class: "card" }, el("h1", {}, board.title), el("p", { class: "muted" }, closed ? `Round ${board.round} · closed. ${finished} of ${invited} reviewers finished.` : `Round ${board.round} · live since ${new Date(board.approved_at || Date.now()).toLocaleDateString()}. ${finished} of ${invited} reviewers finished.`),
      el("div", { class: "row" }, summarize), summaryOut, changes, await roundsList(board)),
    closed ? null : el("div", { class: "card" }, el("h2", {}, "Reviewers"), people, el("label", {}, "Add a reviewer", label), email, add, out),
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
