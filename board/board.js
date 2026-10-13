// Squire first-impressions board. Everything here is public code: the
// Supabase URL and publishable key are meant for browsers; every row and image
// is protected by the database's own rules (row-level security). Images are
// never in this repo: they come from a private bucket through short-lived
// signed links, only for the board's owner or an invited reviewer.
import { CFG, sb, app, SLUG, INVITE, ENCOURAGE, el, show, errBox, speak, playButton, imageUrl, trimmedUrl, BOARD_COLS, uploadImage, rpc, shuffle, when, armed, roundsList, caption } from "./core.js";
import { ownerCull } from "./cull.js";
import { ownerConstitution, ballot, ballotResults, voteAsPartner } from "./constitution.js";
import { createDock } from "./dock.js";
import { setupCoach, NEUTRAL, teamSummary } from "./coach.js";
setupCoach({ url: CFG.url, key: CFG.key, session: async () => (await sb.auth.getSession()).data.session });
let voiceOn = false;

// ── Start ──
async function start() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return signInScreen();
  const me = session.user;
  let { data: board } = await sb.from("boards").select(BOARD_COLS).eq("slug", SLUG).maybeSingle();
  const view = new URLSearchParams(location.search).get("view");
  if (board?.owners?.includes(me.id) && board.kind === "constitution") {
    if (view === "ballot") { const { data: rv } = await sb.from("board_reviewers").select("user_id").eq("board_id", board.id).eq("user_id", me.id).maybeSingle(); return ballot(board, me, { preview: board.status === "draft" || !rv || new URLSearchParams(location.search).has("preview"), signedInAs: signedInAs(me) }); }
    return board.status === "draft" ? ownerConstitution(board, me) : ownerLive(board);
  }
  if (board?.owners?.includes(me.id)) return board.kind === "brand" ? (new URLSearchParams(location.search).get("view") === "shelves" ? ownerBrand(board) : ownerCull(board, { cropper, brand: true })) : board.status === "draft" ? ownerCull(board, { cropper }) : ownerLive(board);
  if (!board || INVITE) {
    if (!INVITE) return show(plainPage("This board needs your invite link", el("p", {}, "Open the link you were sent. Each reviewer has their own."), signedInAs(me)));
    const { error } = await sb.rpc("board_claim", { p_slug: SLUG, p_token: INVITE });
    if (error) return show(plainPage("This link didn't open the board", errBox(error), signedInAs(me)));
    sessionStorage.removeItem(`invite:${SLUG}`);
    ({ data: board } = await sb.from("boards").select(BOARD_COLS).eq("slug", SLUG).maybeSingle());
  }
  return board?.kind === "constitution" ? ballot(board, me, { signedInAs: signedInAs(me) }) : reviewer(board, me);
}
const signedInAs = (me) => el("p", { class: "sub signed" }, `Signed in as ${me.email}. `, el("button", { type: "button", class: "link", onclick: async () => { await sb.auth.signOut(); location.reload(); } }, "Sign out"));
const plainPage = (title, ...kids) => el("section", { class: "plain" }, el("h1", {}, title), ...kids);

function signInScreen() {
  const b = el("button", { type: "button", class: "primary" }, "Sign in with Google");
  b.onclick = async () => {
    b.disabled = true;
    const { error } = await sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: `${location.origin}${location.pathname}?b=${SLUG}`, queryParams: { prompt: "select_account" } } });
    if (error) { b.disabled = false; b.after(errBox(error)); }
  };
  const cc = /constitution/.test(SLUG);
  show(plainPage(cc ? "Squire Constitution ballot" : "Squire logo review", el("p", { class: "lede" }, cc ? "One vote per card. Sign in with Google so your votes count once and stay yours." : "A few minutes, one gut call per logo. Sign in with Google so your answers count once and stay yours."), b,
    el("p", { class: "sub" }, INVITE ? "Your invite link is ready. It opens after you sign in." : "Use the link you were sent.")));
}

// ── Reviewer: blind, one concept at a time, in their own random order. Coach stays neutral. ──
async function reviewer(board, me) {
  const [{ data: rv }, { data: concepts }, { data: mine }, { data: sub }] = await Promise.all([
    sb.from("board_reviewers").select("concept_order, label").eq("board_id", board.id).eq("user_id", me.id).maybeSingle(),
    sb.from("board_concepts").select("id, letter, image_path").eq("board_id", board.id),
    sb.from("board_responses").select("concept_id, score, word, comment").eq("board_id", board.id).eq("user_id", me.id),
    sb.from("board_submissions").select("receipt_hash, submitted_at").eq("board_id", board.id).eq("user_id", me.id).maybeSingle(),
  ]);
  if (!rv) return show(plainPage("You're not on this board", el("p", {}, "Open the invite link you were sent."), signedInAs(me)));
  const byId = Object.fromEntries((concepts || []).map(c => [c.id, c]));
  const order = rv.concept_order.map(id => byId[id]).filter(Boolean);
  const answers = Object.fromEntries((mine || []).map(r => [r.concept_id, r]));
  const first = (rv.label || "").split(" ")[0];
  const dock = createDock({ mode: "reviewer", key: `${board.id}:${me.id}`, hello: null });     // the welcome sits in the page, not over the brief
  dock.say(NEUTRAL.welcome(first));
  dock.offer({ text: "The brief is what Rick wants you to keep in mind.", actions: [{ label: "Read the brief", done: false, run: async () => dock.say(board.brief) }] });
  if (sub) return reviewerDone(board, me, sub, dock);
  const answered = () => order.filter(c => answers[c.id]).length;
  const intro = () => show(el("section", { class: "review-intro" },
    el("h1", {}, board.title),
    el("p", { class: "lede" }, `Give each of these ${order.length} concepts a quick gut call. You'll see them one at a time, in your own random order. There are no wrong answers.`),
    el("div", { class: "record" }, el("p", { class: "sub" }, "The brief"), el("p", {}, board.brief)),
    el("div", { class: "row" }, el("button", { type: "button", class: "primary", onclick: () => step(answered() >= order.length ? order.length : answered()) }, answered() ? "Continue" : "Start"), playButton(board.brief)),
    el("p", { class: "coach-line" }, NEUTRAL.welcome(first)),
    signedInAs(me)));
  const step = async (i, cheer = "") => {
    if (i >= order.length) return review();
    const c = order[i];
    const src = await trimmedUrl(c.image_path).catch(() => "");
    show(conceptView({ letter: c.letter, src, i, total: order.length, cheer, prev: answers[c.id] || {}, done: order.map(x => Boolean(answers[x.id])),
      onBack: i > 0 ? () => step(i - 1) : null,
      onNext: async ({ score, word, comment }) => {
        const row = { board_id: board.id, user_id: me.id, concept_id: c.id, score, word, comment, updated_at: new Date().toISOString() };
        const { error } = await sb.from("board_responses").upsert(row, { onConflict: "board_id,user_id,concept_id" });
        if (error) return error.message;
        answers[c.id] = row;
        const line = NEUTRAL.cheer[Math.min(NEUTRAL.cheer.length - 1, Math.floor((i + 1) / Math.max(1, order.length) * NEUTRAL.cheer.length))];
        if (voiceOn && i < order.length - 1) speak(line);
        step(i + 1, i < order.length - 1 ? line : "");
      } }));
  };
  const review = () => {
    const all = order.every(c => answers[c.id]);
    const go = el("button", { type: "button", class: "primary" }, "Submit my answers");
    const msg = el("p", { class: "err" });
    go.disabled = !all;
    go.onclick = async () => {
      go.disabled = true;
      const { data, error } = await sb.rpc("board_submit", { p_board: board.id });
      if (error) { msg.textContent = error.message; go.disabled = false; return; }
      reviewerDone(board, me, { receipt_hash: data, submitted_at: new Date().toISOString() }, dock);
    };
    show(el("section", { class: "review-check" }, el("h1", {}, "Your answers"),
      el("table", { class: "answers" }, el("thead", {}, el("tr", {}, el("th", {}, "Concept"), el("th", {}, "Strength"), el("th", {}, "Word"))),
        el("tbody", {}, order.map((c, i) => el("tr", {}, el("td", {}, el("button", { type: "button", class: "link", onclick: () => step(i) }, c.letter)), el("td", {}, String(answers[c.id]?.score ?? "Not yet")), el("td", {}, answers[c.id]?.word || ""))))),
      el("p", {}, "Once you submit, your answers are final."), msg,
      el("div", { class: "row" }, go, el("button", { type: "button", onclick: () => step(0) }, "Change something"))));
  };
  intro();
}

// One concept, as a reviewer sees it (also used by "Preview as reviewer").
function conceptView({ letter, src, i, total, cheer = "", prev = {}, onNext, onBack, banner = null, done = null }) {
  let score = prev.score || 0;
  const scoreBtns = [1, 2, 3, 4, 5].map(n => { const b = el("button", { type: "button", "aria-pressed": String(n === score), "aria-label": `${n} of 5` }, String(n)); b.onclick = () => { score = n; scoreBtns.forEach(x => x.setAttribute("aria-pressed", String(x === b))); check(); }; return b; });
  const word = el("input", { type: "text", maxlength: "32", autocomplete: "off", placeholder: "e.g. steady", value: prev.word || "", "aria-label": "One word it makes you feel" });
  const comment = el("textarea", { maxlength: "500", placeholder: "Optional", "aria-label": "Anything else? (optional)" }); comment.value = prev.comment || "";
  const next = el("button", { type: "button", class: "primary" }, i === total - 1 ? "Review my answers" : "Next concept");
  const msg = el("p", { class: "err" });
  const check = () => { next.disabled = !(score && /^\S{1,32}$/.test(word.value.trim())); };
  word.oninput = check; check();
  next.onclick = async () => {
    next.disabled = true; msg.textContent = "";
    const err = await onNext({ score, word: word.value.trim(), comment: comment.value.trim() || null });
    if (err) { msg.textContent = err; next.disabled = false; }
  };
  const back = onBack ? el("button", { type: "button", class: "link", onclick: onBack }, "Back") : null;
  const dots = el("ol", { class: "dots", "aria-label": `${i + 1} of ${total}` }, Array.from({ length: total }, (_, n) => el("li", { class: n === i ? "now" : (done ? done[n] : n < i) ? "done" : "" })));
  return el("section", { class: "concept" }, banner,
    el("div", { class: "concept-top" }, el("span", { class: "sub" }, `${i + 1} of ${total}`), dots, el("span", { class: "encourage", role: "status" }, cheer)),
    el("div", { class: "concept-body" },
      el("div", { class: "concept-art" }, el("p", { class: "letter", "aria-label": `Concept ${letter}` }, letter), el("div", { class: "sheet big" }, el("img", { src, alt: `Concept ${letter}` })),
        el("p", { class: "at-size" }, "At app-icon size ", el("span", { class: "minis" }, el("span", { class: "mini" }, el("img", { src, alt: "" })), el("span", { class: "mini m40" }, el("img", { src, alt: "" })), el("span", { class: "mini ink" }, el("img", { src, alt: "" }))))),
      el("div", { class: "concept-form" },
        el("fieldset", { class: "strength" }, el("legend", {}, "How strong is it?"), el("div", { class: "scores" }, scoreBtns), el("div", { class: "scale" }, el("span", {}, "Weak"), el("span", {}, "Strong"))),
        el("label", {}, "One word it makes you feel", word),
        el("label", {}, "Anything else? (optional)", comment, dictateButton(comment)),
        msg, el("div", { class: "row" }, next, back))));
}
// Speak a comment instead of typing it (Chrome); only the words are kept, never audio.
function dictateButton(target) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const b = el("button", { type: "button", class: "link" }, "Say it instead");
  b.onclick = () => {
    const r = new SR(); r.lang = navigator.language || "en-US"; r.interimResults = false;
    b.textContent = "Listening…"; b.disabled = true;
    r.onresult = (e) => { const t = [...e.results].map(x => x[0].transcript).join(" ").trim(); target.value = (target.value ? target.value + " " : "") + t; };
    r.onend = () => { b.textContent = "Say it instead"; b.disabled = false; };
    try { r.start(); } catch { r.onend(); }
  };
  return el("span", { class: "dictate" }, b, el("span", { class: "sub" }, " Only the words are kept."));
}
async function reviewerDone(board, me, sub, dock) {
  dock?.say(NEUTRAL.wait);
  show(el("section", { class: "plain" }, el("h1", {}, "Thanks. Your answers are in."),
    el("p", { class: "lede" }, "They\u2019re final, and they count once. Rick will share how the team reacted once everyone has answered."),
    el("details", { class: "details" }, el("summary", {}, "Details"), el("p", { class: "sub" }, `Submitted ${new Date(sub.submitted_at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}. Your receipt, which proves your answers weren\u2019t changed after you sent them:`), el("p", { class: "receipt" }, sub.receipt_hash)),
    signedInAs(me)));
}

// ── Results: one row per concept; a dot per reviewer on a 1 to 5 line shows agreement at a glance ──
async function resultsList(board, { owner }) {
  const [{ data: concepts }, { data: resp }, { data: revs }, cands] = await Promise.all([
    sb.from("board_concepts").select("id, letter, image_path, featured").eq("board_id", board.id),
    sb.from("board_responses").select("concept_id, user_id, score, word, comment").eq("board_id", board.id),
    owner ? sb.from("board_reviewers").select("user_id, label").eq("board_id", board.id) : Promise.resolve({ data: [] }),
    owner ? rpc("board_candidates", { p_board: board.id }).catch(() => []) : Promise.resolve([]),
  ]);
  const { data: subs } = await sb.from("board_submissions").select("user_id").eq("board_id", board.id);
  const done = new Set((subs || []).map(s => s.user_id));
  const name = Object.fromEntries((revs || []).map(r => [r.user_id, r.label]));
  const capOf = Object.fromEntries((cands || []).map(c => [c.id, caption(c)]));
  const counted = (resp || []).filter(r => done.has(r.user_id));       // only submitted answers count
  const stats = (concepts || []).filter(c => c.featured).sort((a, b) => a.letter.localeCompare(b.letter)).map(c => {
    const rs = counted.filter(r => r.concept_id === c.id);
    const sc = rs.map(r => r.score);
    const avg = sc.length ? sc.reduce((a, b) => a + b, 0) / sc.length : null;
    const sd = sc.length > 1 ? Math.sqrt(sc.reduce((a, b) => a + (b - avg) ** 2, 0) / sc.length) : 0;
    const words = Object.entries(rs.reduce((m, r) => { const w = r.word.toLowerCase(); m[w] = (m[w] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]);
    return { c, rs, avg, sd, min: sc.length ? Math.min(...sc) : null, max: sc.length ? Math.max(...sc) : null, words, comments: rs.filter(r => r.comment) };
  });
  const list = el("div", { class: "results" });
  for (const s of (owner ? [...stats].sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1)) : stats)) {
    const img = el("img", { alt: `Concept ${s.c.letter}` }); trimmedUrl(s.c.image_path).then(u => { img.src = u; }).catch(() => {});
    const cap = owner && capOf[s.c.id] ? `${capOf[s.c.id].id} ${capOf[s.c.id].name}` : null;
    const strip = el("div", { class: "strip", role: "img", "aria-label": s.rs.length ? `Scores: ${s.rs.map(r => r.score).join(", ")}` : "No answers yet" },
      el("span", { class: "end" }, "1"), el("span", { class: "line" }, [1, 2, 3, 4, 5].map(n => el("span", { class: "col", style: `--at:${(n - 1) / 4}` }, s.rs.filter(r => r.score === n).map(() => el("i", {}))))), el("span", { class: "end" }, "5"));
    const row = el("details", { class: "rrow" },
      el("summary", {}, el("span", { class: "thumb" }, img),
        el("span", { class: "rname" }, el("b", {}, cap ? `${cap}` : `Concept ${s.c.letter}`), cap ? el("span", { class: "sub" }, ` was ${s.c.letter}`) : null),
        el("span", { class: "avg" }, s.avg == null ? "" : Number.isInteger(s.avg) ? String(s.avg) : s.avg.toFixed(1)), strip,
        el("span", { class: "words" }, s.words.slice(0, 4).map(([w, n]) => (n > 1 ? `${w} ×${n}` : w)).join(", "))),
      s.comments.length ? el("ul", { class: "comments" }, s.comments.map(r => el("li", {}, owner && name[r.user_id] ? `${name[r.user_id]}: ${r.comment}` : r.comment))) : el("p", { class: "sub" }, "No comments."));
    list.append(row);
  }
  if (!stats.length) list.append(el("p", { class: "sub" }, "No results yet."));
  list._stats = stats;
  return list;
}

// ── Owner: the private brand board. Featured · Reviewed · Archive, grouped by family. ──
const SHELVES = [["featured", "Featured"], ["reviewed", "Reviewed"], ["archive", "Archive"]];
const shelfOf = (c) => (c.archived_at ? "archive" : c.shelf || "reviewed");
let brandSeq = 0;      // only the latest render may draw: a slow, older one never overwrites a newer tab
async function ownerBrand(board, ui = { tab: "featured", picked: new Set(), sent: null }) {
  const seq = ++brandSeq;
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

  if (seq !== brandSeq) return;
  const tabBar = el("div", { class: "tabs", role: "tablist" }, SHELVES.map(([k, n]) => el("button", { type: "button", role: "tab", "aria-selected": String(ui.tab === k), onclick: () => again(k) }, `${n} (${cands.filter(c => shelfOf(c) === k).length})`)));
  show(el("div", { class: "card" }, el("h1", {}, board.title), el("p", { class: "muted" }, "Private: only you see this board. Uncommented images sit in Archive, still visible. Nothing is ever deleted. ", el("a", { href: `?b=${board.slug}` }, "Back to the cull")),
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

// ── Owner: the board is live (or closed). Reviewers, links, results; Coach's read once everyone is in. ──
async function ownerLive(board) {
  const me = (await sb.auth.getSession()).data.session?.user || {};
  const [{ data: invites }, { data: subs }] = await Promise.all([
    sb.from("board_invites").select("id, label, email, claimed_by, claimed_at, revoked_at, created_at").eq("board_id", board.id).order("created_at"),
    sb.from("board_submissions").select("user_id, submitted_at, receipt_hash").eq("board_id", board.id),
  ]);
  const done = new Map((subs || []).map(s => [s.user_id, s]));
  const people = el("ul", { class: "people" });
  for (const inv of invites || []) {
    const state = inv.revoked_at ? "Link revoked" : done.has(inv.claimed_by) ? `Finished ${new Date(done.get(inv.claimed_by).submitted_at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}` : inv.claimed_by ? "Joined, not finished" : "Link not opened yet";
    const rv = el("button", { type: "button", class: "link", onclick: async () => { await sb.rpc("board_revoke", { p_invite: inv.id }); location.reload(); } }, "Revoke");
    people.append(el("li", {}, el("b", {}, inv.label), el("span", { class: "sub" }, `${state}${inv.email ? `, ${inv.email}` : ""}`), inv.revoked_at || done.has(inv.claimed_by) ? null : rv));
  }
  const label = el("input", { type: "text", placeholder: "Name, e.g. Bill", maxlength: "40", "aria-label": "Reviewer's name" });
  const email = el("input", { type: "text", placeholder: "Their Google email (optional; locks the link to it)", "aria-label": "Reviewer's Google email" });
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
    copy.onclick = async () => { try { await navigator.clipboard.writeText(link); copy.textContent = "Copied"; } catch { copy.textContent = "Select and copy the link above"; } };
    out.replaceChildren(el("div", { class: "link-box" }, el("p", {}, `${label.value.trim()}'s link. It's shown once; send it to them privately.`), el("code", {}, link), el("div", { class: "row" }, copy, el("button", { type: "button", class: "link", onclick: () => location.reload() }, "Done"))));
    label.value = ""; email.value = "";
  };
  const cc = board.kind === "constitution";
  const results = cc ? await ballotResults(board) : await resultsList(board, { owner: true });
  const invited = (invites || []).filter(i => !i.revoked_at).length, finished = (invites || []).filter(i => !i.revoked_at && done.has(i.claimed_by)).length;
  const allIn = invited > 0 && finished === invited;
  const read = el("div", { class: "coach-read" });
  if (cc) read.append(el("p", { class: "sub" }, invited ? `${finished} of ${invited} ${invited === 1 ? "partner has" : "partners have"} sent their votes.` : "Make a link for each partner below."),
    el("div", { class: "row" }, (invites || []).some(i => i.claimed_by === me.id) ? el("a", { class: "button", href: `?b=${board.slug}&view=ballot` }, done.has(me.id) ? "Your ballot (sent)" : "Your own ballot") : armed("Vote as a partner", "Makes your own link and opens it. Tap again", () => voteAsPartner(board)),
      el("a", { class: "button", href: `?b=${board.slug}&view=ballot&preview=1` }, "Preview the ballot")));
  else if (allIn) {
    const b = el("button", { type: "button", class: "primary" }, "Coach's read");
    b.onclick = async () => {
      b.disabled = true; read.replaceChildren(el("p", { class: "sub" }, "Coach is reading the results…"));
      try { const text = await teamSummary(results._stats, { finished, invited }); read.replaceChildren(el("p", { class: "record-text" }, text), playButton(text, "Hear it")); }
      catch (e) { read.replaceChildren(errBox(e)); b.disabled = false; }
    };
    read.append(b);
  } else read.append(el("p", { class: "sub" }, invited ? `${finished} of ${invited} ${invited === 1 ? "reviewer has" : "reviewers have"} submitted. Coach will summarize once everyone has.` : "Invite reviewers below. Coach will summarize once everyone has answered."));
  const closed = board.status === "closed";
  const opened = (invites || []).some(i => i.claimed_by);
  const { data: newer } = await sb.from("boards").select("slug, round").eq("parent_board", board.id).maybeSingle();
  const changes = el("div", { class: "changes" });
  if (newer) changes.append(el("p", {}, "This round is closed and kept as the record. ", el("a", { href: `?b=${newer.slug}` }, `Go to round ${newer.round}`)));
  else if (!opened && !closed) changes.append(armed("Back to draft", "Nobody has opened a link yet. Tap again to unlock", async () => { await rpc("board_unlock", { p_board: board.id }); location.reload(); }), el("span", { class: "sub" }, "Works only until a reviewer opens their link."));
  else changes.append(armed(`Start round ${board.round + 1}`, `Closes round ${board.round}; its answers are kept. Tap again`, async () => { const slug = await rpc("board_new_round", { p_board: board.id }); location.href = `?b=${slug}`; }),
    el("span", { class: "sub" }, opened ? "The set is locked because a reviewer has opened a link. To change it, start a new round; this round's answers stay as the record." : ""));
  // Coach on the live board: neutral until everyone's in.
  const dock = createDock({ mode: "reviewer", key: `${board.id}:live`, hello: null });
  dock.say(cc ? `The ballot is open, so the cards and my lines are locked. ${finished} of ${invited} sent so far.` : allIn ? "Everyone's in. Tap \"Coach's read\" for where the team agrees and disagrees." : `I'm keeping quiet on the concepts until everyone has answered. ${finished} of ${invited} so far.`);
  show(el("header", { class: "top" }, el("div", { class: "title" }, el("h1", {}, board.title),
      el("p", { class: "sub" }, closed ? `Round ${board.round}, closed.` : `Round ${board.round}, live since ${new Date(board.approved_at || Date.now()).toLocaleDateString(undefined, { day: "numeric", month: "short" })}.`), await roundsList(board)),
      invited ? el("div", { class: "counter" }, el("span", { class: "num" }, String(finished)), el("p", {}, `of ${invited} ${cc ? (invited === 1 ? "partner" : "partners") : invited === 1 ? "reviewer" : "reviewers"} finished.`)) : el("div", { class: "counter" }, el("p", {}, cc ? "No partners yet." : "No reviewers yet."))),
    el("section", { class: "results-sec" }, el("div", { class: "sec-head" }, el("h2", {}, cc ? "Votes" : "Results"), el("p", { class: "sub" }, cc ? "Sent ballots only. Open a card for comments, by name." : "Submitted answers only. Open a row for comments, by name.")), read, finished ? results : null),
    closed ? null : el("section", { class: "people-sec" }, el("h2", {}, cc ? "Partners" : "Reviewers"), people, el("div", { class: "invite" }, label, email, add), out),
    el("section", { class: "brief-sec" }, el("h2", {}, cc ? "The note they read" : "The brief they read"), el("div", { class: "record" }, el("p", {}, board.brief))),
    changes);
}

// One start per page load; a sign-in that finishes later (the Google return) starts it once more.
let running = null, startedFor = null;
const go = (session) => { const who = session?.user?.id || "none"; if (running || startedFor === who) return; startedFor = who; running = start().catch(e => show(el("div", { class: "card" }, errBox(e)))).finally(() => { running = null; }); };
sb.auth.getSession().then(({ data }) => go(data.session));
sb.auth.onAuthStateChange((ev, session) => { if (ev === "SIGNED_IN") setTimeout(() => go(session), 0); });
