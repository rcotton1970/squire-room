// The constitution board: Rick's working copy of the Constitution, one card per
// piece of the text (CC-01, CC-02, …), and the partner ballot.
//
// Owner: every card in reading order with its part, status and tags; what Coach
// says on it (wording Rick approved) and Coach's own take (labelled as Coach's,
// never as his ruling). Changes to cards, and to what Coach says, are made by
// telling Coach in the side panel, by voice or text: each one waits on an
// Approve card there and is logged to constitution/ADOPTION-LOG.md.
//
// Partners: one card at a time in their own random order, blind. Coach says
// only the neutral lines Rick approved, and nothing else.
import { sb, el, show, errBox, rpc, armed, when, shuffle } from "./core.js";
import { createDock } from "./dock.js";
import { cardTake, ballotNote } from "./coach.js";
import { createVoice, command } from "./voice.js";

const STATUS = { proposed: "Proposed", open: "Open question", agreed: "Agreed", adopted: "Adopted", parked: "Parked" };
// An open decision is anything not yet decided (proposed or an open question); settled is agreed or adopted.
const UNDECIDED = ["proposed", "open"], SETTLED = ["agreed", "adopted"];
const n = (k, one, many = `${one}s`) => `${k === 0 ? "no" : k} ${k === 1 ? one : many}`;
export function greeting({ name, cards, hour = new Date().getHours() }) {
  const open = cards.filter(c => UNDECIDED.includes(c.card_status)).length, settled = cards.filter(c => SETTLED.includes(c.card_status)).length, parked = cards.filter(c => c.card_status === "parked").length;
  const hi = `${hour < 12 ? "Morning" : hour < 18 ? "Afternoon" : "Evening"}${name ? ` ${name}` : ""}.`;
  if (!open) return { text: `${hi} Every card here is settled${parked ? `, apart from ${n(parked, "parked one")}` : ""}. Nothing's waiting on you.`, open };
  const rest = settled ? `The other ${settled} ${settled === 1 ? "is" : "are"} already settled.` : "None are settled yet.";
  return { text: `${hi} You've got ${n(open, "open decision")} here. ${rest}${parked ? ` ${parked} ${parked === 1 ? "is" : "are"} parked.` : ""} Want to take the open ones one at a time?`, open };
}
const VOTES = [["adopt", "Adopt"], ["amend", "Amend"], ["reject", "Reject"], ["abstain", "Abstain"]];
const DIRECTION = /^\s*(please\s+)?(add|edit|change|merge|move|re-?tag|tag|untag|set|mark|rename|rewrite|say|make (your|the)|don'?t take|do not take|archive|restore|put)\b/i;
const short = (t, n = 0) => (n && t.length > n ? `${t.slice(0, n).replace(/\s+\S*$/, "")}…` : t);

const coachMark = () => {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("aria-hidden", "true"); s.setAttribute("class", "cmark");
  s.innerHTML = '<path d="M5 3.5h10l4 4v13H5z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M15 3.5v4h4z" fill="#F64B19"/>';
  return s;
};
// The card's text as the record: paragraphs kept, **bold** shown plain.
const recordText = (t) => String(t || "").split(/\n{2,}/).map(p => el("p", {}, p.replace(/\*\*(.+?)\*\*/g, "$1")));

// ── Owner: the working copy ──
export async function ownerConstitution(board, me = {}) {
  const S = { cards: [], events: [], part: "", status: "", tag: "", focus: null, open: new Set(), note: board.curator_note || "", walk: null, toldHow: false, quietTries: 0 };
  const load = async () => {
    [S.cards, { data: S.events }] = await Promise.all([rpc("board_candidates", { p_board: board.id }),
      sb.from("board_events").select("at, action, summary").eq("board_id", board.id).order("at", { ascending: false }).limit(40)]);
  };
  await load();
  const byId = (id) => S.cards.find(c => c.id === id);
  const active = () => S.cards.filter(c => !c.archived_at).sort((a, b) => a.sort_order - b.sort_order);
  const shown = () => active().filter(c => (!S.part || c.family === S.part) && (!S.status || (S.status === "undecided" ? UNDECIDED.includes(c.card_status) : c.card_status === S.status)) && (!S.tag || (c.tags || []).includes(S.tag)));
  const refOf = (id) => byId(id)?.ref || "";

  const dock = createDock({ mode: "owner", key: `${board.id}:cc`, hello: null,
    context: () => { const c = byId(S.focus); return c ? { name: c.ref, hasTake: Boolean(c.coach_take) } : {}; },
    onAsk: (q) => heard(q, { typed: true }), onMic: () => { voice.stop(); converse(); } });
  // Coach talks: every line is written in the panel and spoken aloud.
  const voice = createVoice({ onState: (st) => dock.state(st), onNotice: (t) => dock.voiceNote(t), onClear: () => dock.voiceNote("") });
  const talk = (text) => { dock.say(text); return voice.speak(text); };
  // Listen for one reply and act on it; keeps the conversation going while Rick is walking the cards.
  async function converse() {
    const said = await voice.listen();
    if (!said) { if (S.walk && ++S.quietTries < 2) return converse(); S.quietTries = 0; if (S.walk && !voice.lastProblem) dock.voiceNote("I didn't hear anything, so I've stopped listening. Tap the mic to carry on."); return; }
    S.quietTries = 0;
    return heard(said);
  }
  async function heard(q, { typed = false } = {}) {
    if (!q) return;
    const cmd = command(q);
    dock.asked(q);
    if (DIRECTION.test(q) && !cmd) { await talk("I make changes from the Coach side panel, so each one gets an Approve card and a line in the adoption log. Say it there, the same words work."); return; }
    if (cmd === "walk") return startWalk();
    if (cmd === "stop") { S.walk = null; await talk("Okay, stopping here. Tap the mic when you want to pick it up."); return; }
    if (cmd === "all") { S.walk = null; S.status = ""; S.part = ""; S.tag = ""; render(); await talk(`Showing all ${active().length} cards.`); return; }
    if (cmd && !S.walk) { await talk("Say \u201cwalk me through the open ones\u201d and I'll take you card by card."); return typed ? null : converse(); }
    if (cmd === "next") return step(1);
    if (cmd === "back") return step(-1);
    if (cmd === "repeat") return present();
    await askTake(q, byId(S.focus), { asked: true });
    if (S.walk && !typed) return converse();
  }
  // The walk: filter to open decisions and go card to card, reading Coach's take on each.
  async function startWalk() {
    const list = active().filter(c => UNDECIDED.includes(c.card_status));
    if (!list.length) { await talk("There's nothing open. Every card is settled or parked."); return; }
    S.status = "undecided"; S.part = ""; S.tag = ""; S.walk = { ids: list.map(c => c.id), i: 0 };
    return present();
  }
  async function step(d) {
    const w = S.walk; if (!w) return;
    const i = w.i + d;
    if (i < 0) { await talk("That's the first one."); return converse(); }
    if (i >= w.ids.length) { S.walk = null; await talk(`That's all ${w.ids.length} open ${w.ids.length === 1 ? "decision" : "decisions"}. Tap the mic if you want to go round again.`); return; }
    w.i = i; return present();
  }
  async function present() {
    const w = S.walk, c = byId(w.ids[w.i]);
    S.focus = c.id; dock.refreshAbout(); render();
    document.getElementById(c.ref)?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    let take = c.coach_take;
    if (!take) {
      const stop = dock.thinking(`Reading ${c.ref}…`);
      try { take = (await cardTake({ card: c, others: active().filter(x => x.id !== c.id) })).take; await rpc("board_coach_words", { p_concept: c.id, p_kind: "take", p_text: take, p_neutral: false }); c.coach_take = take; render(); }
      catch (e) { take = null; dock.error(`I couldn't read it just now (${e.message || "no answer"}).`); }
      finally { stop(); }
    }
    const how = S.toldHow ? "" : " Say next, back, or ask me anything about it.";
    S.toldHow = true;
    await talk(`${w.i + 1} of ${w.ids.length}. ${c.ref}, ${c.label.replace(/^(Pillar|Rail) (\d\d): /, "$1 $2, ")}.${take ? ` My take: ${take}` : ""}${how}`);
    if (S.walk === w) return converse();
  }
  async function askTake(question, c = byId(S.focus), { asked = false } = {}) {
    if (!c) { if (!asked) dock.asked(question || "Your take?"); await talk("Tap a card first, then ask me about it."); return; }
    if (!asked) dock.asked(question || `Your honest take on ${c.ref}?`);
    const stop = dock.thinking(`Reading ${c.ref}…`);
    try {
      const r = await cardTake({ card: c, question, others: active().filter(x => x.id !== c.id) });
      stop();
      if (!question) { await rpc("board_coach_words", { p_concept: c.id, p_kind: "take", p_text: r.take, p_neutral: false }); await load(); render(); }
      await talk(r.take);
    } catch (e) { stop(); dock.error(`Coach couldn't answer. ${e.message || ""}`.trim()); }
  }

  const counts = () => Object.keys(STATUS).map(k => [k, active().filter(c => c.card_status === k).length]).filter(([, n]) => n);
  const options = (list, cur, all) => [el("option", { value: "" }, all), ...list.map(([v, t]) => el("option", { value: v, ...(v === cur ? { selected: "" } : {}) }, t))];

  function cardView(c) {
    const isOpen = S.open.has(c.id), long = (c.description || "").length > 420;
    const toggle = long ? el("button", { type: "button", class: "link", "aria-expanded": String(isOpen), onclick: (e) => { e.stopPropagation(); isOpen ? S.open.delete(c.id) : S.open.add(c.id); render(); } }, isOpen ? "Show less" : "Read all") : null;
    return el("article", { class: `cc-card${S.focus === c.id ? " focus" : ""}`, id: c.ref, tabindex: "0", onclick: (e) => { if (e.target.closest("button,a,summary")) return; S.focus = c.id; dock.refreshAbout(); render(); } },
      el("div", { class: "cc-no", "aria-hidden": "true" }, c.ref.replace("CC-", "")),
      el("div", { class: "cc-main" },
        el("header", { class: "cc-head" }, el("h3", {}, el("span", { class: "cc-ref" }, c.ref), " ", c.label),
          el("p", { class: "cc-meta" }, el("span", { class: `st ${c.card_status}` }, STATUS[c.card_status] || c.card_status), c.family ? ` · ${c.family}` : "", (c.tags || []).length ? el("span", { class: "tags" }, (c.tags || []).map(t => el("span", { class: "tag" }, t))) : null)),
        el("div", { class: `cc-text${long && !isOpen ? " clamp" : ""}` }, recordText(c.description)), toggle,
        c.notes ? el("p", { class: "cc-note" }, el("b", {}, "Your note: "), c.notes) : null,
        c.coach_line ? el("div", { class: "coach-says" }, coachMark(), el("div", {},
          el("p", { class: "who" }, "Coach says ", el("span", { class: "sub" }, c.coach_line_neutral ? "· your approved wording · on the partner ballot" : "· your approved wording · kept off the ballot (it takes a side)")),
          el("p", {}, c.coach_line))) : null,
        c.coach_take ? el("div", { class: "coach-take" }, coachMark(), el("div", {},
          el("p", { class: "who" }, "Coach’s take ", el("span", { class: "sub" }, "· Coach’s own view, not your ruling")), el("p", {}, c.coach_take),
          el("button", { type: "button", class: "link", onclick: () => { S.focus = c.id; dock.open(); askTake(null, c); } }, "Ask again"))) :
          el("button", { type: "button", class: "link take-btn", onclick: () => { S.focus = c.id; dock.open(); askTake(null, c); } }, "Coach’s honest take")));
  }

  function noteBox() {
    const area = el("textarea", { rows: "6", maxlength: "2000", "aria-label": "Curator's Note", placeholder: "What partners read before they vote: what this is and how to vote. Keep your own position out of it." }); area.value = S.note;
    const status = el("p", { class: "sub" }, board.note_approved_at && area.value === board.curator_note ? `Approved ${when(board.note_approved_at)}. Partners read it first.` : board.curator_note ? "Draft saved." : "Not written yet.");
    const msg = el("p", { class: "err" });
    const run = (p) => p.catch(e => { msg.textContent = e.message || String(e); });
    const draft = el("button", { type: "button" }, board.curator_note ? "Redraft with Coach" : "Draft with Coach");
    draft.onclick = () => run((async () => { draft.disabled = true; status.textContent = "Coach is drafting a neutral note…"; area.value = await ballotNote({ board, cards: active() }); S.note = area.value;
      await rpc("board_curator_note", { p_board: board.id, p_note: area.value, p_approve: false }); board.curator_note = area.value; board.note_approved_at = null; status.textContent = "Draft by Coach. Edit it, then approve."; draft.disabled = false; check(); })().finally(() => { draft.disabled = false; }));
    const save = el("button", { type: "button", onclick: () => run(rpc("board_curator_note", { p_board: board.id, p_note: area.value, p_approve: false }).then(() => { S.note = board.curator_note = area.value; board.note_approved_at = null; status.textContent = "Draft saved."; })) }, "Save draft");
    const approve = el("button", { type: "button", class: "primary", onclick: () => run(rpc("board_curator_note", { p_board: board.id, p_note: area.value, p_approve: true }).then(() => { S.note = board.curator_note = area.value; board.note_approved_at = new Date().toISOString(); render(); })) }, "Approve the note");
    const check = () => { approve.disabled = area.value.trim().split(/\s+/).filter(Boolean).length < 12; approve.title = approve.disabled ? "Write at least a couple of sentences first." : ""; };
    area.oninput = () => { S.note = area.value; check(); };
    check();
    return el("section", { class: "cc-note-sec" }, el("h2", {}, "Curator’s Note"), el("p", { class: "sub" }, "Partners read it first, as your note. Coach drafts it neutral; you edit and approve."), area, el("div", { class: "row" }, draft, save, approve, status), msg);
  }

  function ballotBox() {
    const ready = Boolean(board.note_approved_at && board.curator_note === S.note);
    const n = active().length;
    return el("section", { class: "cc-ballot-sec" }, el("h2", {}, "Partner ballot"),
      el("p", {}, `${n} cards go on it, every one not archived. Each partner votes Adopt, Amend, Reject or Abstain on every card, blind, in their own order. On the ballot Coach says only the lines marked "on the partner ballot" above, nothing else.`),
      el("div", { class: "row" }, el("a", { class: "button", href: `?b=${board.slug}&view=ballot` }, "Preview the ballot"),
        ready ? armed("Open the partner ballot", `Locks all ${n} cards and Coach's lines. Tap again`, async () => { await rpc("board_ballot_open", { p_board: board.id }); location.href = `?b=${board.slug}`; }, "primary")
          : el("span", { class: "sub" }, "Approve the Curator’s Note first.")));
  }

  function render() {
    const parts = [...new Set(active().map(c => c.family).filter(Boolean))];
    const tags = [...new Set(active().flatMap(c => c.tags || []))].sort();
    const arch = S.cards.filter(c => c.archived_at);
    const list = shown();
    const entry = (c) => el("li", {}, el("a", { href: `#${c.ref}`, onclick: () => { S.focus = c.id; } }, el("span", { class: "n" }, c.ref.replace("CC-", "")), " ", short(c.label.replace(/^(Pillar|Rail) \d\d: /, ""), 34)));
    const contents = el("nav", { class: "cc-contents", "aria-label": "Contents" }, parts.map(p => el("div", {}, el("p", { class: "p" }, p), el("ol", {}, active().filter(c => c.family === p).map(entry)))));
    show(
      el("header", { class: "top" }, el("div", { class: "title" }, el("h1", {}, board.title),
          el("p", { class: "sub" }, `${active().length} cards in reading order${arch.length ? `, ${arch.length} archived` : ""}. Private: only you see this board.`)),
        el("div", { class: "counter" }, el("p", { class: "cc-tally" }, counts().map(([k, n]) => el("span", {}, el("b", {}, String(n)), ` ${STATUS[k].toLowerCase()}`))))),
      el("p", { class: "cc-how" }, coachMark(), el("span", {}, "To add, edit, merge, re-tag, re-status or move a card, or to change what Coach says, tell Coach in the side panel by voice or text. Each change waits on an Approve card there and goes into ", el("b", {}, "constitution/ADOPTION-LOG.md"), ".")),
      el("div", { class: "cc-filters row" },
        el("label", {}, "Part", el("select", { onchange: (e) => { S.part = e.target.value; render(); } }, options(parts.map(p => [p, p]), S.part, "All parts"))),
        el("label", {}, "Status", el("select", { onchange: (e) => { S.status = e.target.value; S.walk = null; render(); } }, options([["undecided", "Open decisions (proposed or open)"], ...Object.entries(STATUS)], S.status, "Any status"))),
        tags.length ? el("label", {}, "Tag", el("select", { onchange: (e) => { S.tag = e.target.value; render(); } }, options(tags.map(t => [t, t]), S.tag, "Any tag"))) : null,
        list.length !== active().length ? el("p", { class: "sub" }, `${list.length} of ${active().length} shown`) : null),
      el("div", { class: "cc-layout" }, contents,
        el("div", { class: "cc-docket" }, list.length ? list.map(cardView) : el("p", { class: "sub" }, "No card matches those filters."),
          arch.length ? el("details", { class: "cc-archive" }, el("summary", {}, `Archive (${arch.length})`),
            el("ul", {}, arch.map(c => el("li", {}, el("b", {}, c.ref), ` ${c.label}. `, el("span", { class: "sub" }, `${c.merged_into ? `Merged into ${refOf(c.merged_into)}` : "Archived"} ${when(c.archived_at)}.`))))) : null)),
      noteBox(), ballotBox(),
      el("details", { class: "cc-history" }, el("summary", {}, "History"), el("ul", {}, (S.events || []).map(e => el("li", {}, el("span", { class: "sub" }, new Date(e.at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })), ` ${e.summary}`)))));
    if (S.focus) document.getElementById(byId(S.focus)?.ref || "")?.classList.add("focus");
  }
  render();
  // Coach speaks first, every time the board opens: the real counts, then an offer.
  const g = greeting({ name: String(me.user_metadata?.full_name || me.user_metadata?.name || "").split(" ")[0], cards: active() });
  dock.open({ focus: false });
  talk(g.text).then(() => (g.open ? converse() : null));
}

// ── The partner ballot (and Rick's preview of it) ──
export async function ballot(board, me, { preview = false, signedInAs = null } = {}) {
  const cards = await rpc("board_ballot", { p_board: board.id });
  const [{ data: mine }, { data: sub }] = preview ? [{ data: [] }, { data: null }] : await Promise.all([
    sb.from("board_votes").select("concept_id, vote, comment").eq("board_id", board.id).eq("user_id", me.id),
    sb.from("board_submissions").select("receipt_hash, submitted_at").eq("board_id", board.id).eq("user_id", me.id).maybeSingle()]);
  const order = preview ? shuffle(cards) : cards;
  const votes = Object.fromEntries((mine || []).map(v => [v.concept_id, v]));
  const dock = createDock({ mode: "reviewer", key: `${board.id}:${me.id}:ballot`, hello: null });     // Coach speaks only Rick's approved, neutral lines
  const bar = preview ? el("p", { class: "preview-bar" }, "Preview: this is what a partner sees, in a fresh random order. Nothing is saved. ", el("a", { href: `?b=${board.slug}` }, "Back to the board")) : null;
  const note = board.status === "draft" ? board.curator_note : board.brief;
  if (sub) return done(sub);
  const answered = () => order.filter(c => votes[c.id]).length;

  function intro() {
    show(bar, el("section", { class: "review-intro ballot-intro" }, el("h1", {}, board.title),
      el("p", { class: "lede" }, `${order.length} cards. Vote on each one: Adopt, Amend (you'd sign it with changes; say which), Reject, or Abstain. You'll see them one at a time, in your own random order. Nobody sees your votes until you've sent them, and you see nobody's until then.`),
      note ? el("div", { class: "record" }, el("p", { class: "sub" }, "Rick’s note"), recordText(note)) : null,
      el("div", { class: "row" }, el("button", { type: "button", class: "primary", onclick: () => step(Math.min(answered(), order.length)) }, answered() ? "Continue" : "Start")),
      signedInAs));
  }
  function step(i) {
    if (i >= order.length) return review();
    const c = order[i], prev = votes[c.id] || {};
    let pick = prev.vote || null;
    const comment = el("textarea", { rows: "3", maxlength: "1000", "aria-label": "Comment", placeholder: "Optional. For Amend, say what you'd change." }); comment.value = prev.comment || "";
    const msg = el("p", { class: "err" });
    const next = el("button", { type: "button", class: "primary" }, i === order.length - 1 ? "Review my votes" : "Next card");
    const check = () => { next.disabled = !pick || (pick === "amend" && !comment.value.trim()); next.title = pick === "amend" && !comment.value.trim() ? "Say what you'd change." : ""; };
    const group = el("div", { class: "votes", role: "radiogroup", "aria-label": `Your vote on ${c.ref}` }, VOTES.map(([v, t]) => {
      const b = el("button", { type: "button", role: "radio", class: "vote", "aria-checked": String(pick === v), onclick: () => { pick = v; group.querySelectorAll(".vote").forEach(x => x.setAttribute("aria-checked", String(x.dataset.v === pick))); check(); } }, t);
      b.dataset.v = v; return b; }));
    comment.oninput = check; check();
    next.onclick = async () => {
      next.disabled = true;
      if (!preview) { const { error } = await sb.rpc("board_vote", { p_board: board.id, p_concept: c.id, p_vote: pick, p_comment: comment.value }); if (error) { msg.textContent = error.message; next.disabled = false; return; } }
      votes[c.id] = { concept_id: c.id, vote: pick, comment: comment.value };
      step(i + 1);
    };
    if (c.coach_line) dock.say(c.coach_line);
    show(bar, el("section", { class: "ballot-card" },
      el("div", { class: "progress", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(order.length), "aria-valuenow": String(i + 1), "aria-label": `Card ${i + 1} of ${order.length}` },
        el("span", { style: `width:${((i + 1) / order.length) * 100}%` })),
      el("p", { class: "sub" }, `${i + 1} of ${order.length}${c.part ? ` · ${c.part}` : ""}`),
      el("h1", {}, el("span", { class: "cc-ref" }, c.ref), " ", c.title),
      el("div", { class: "cc-text record-text" }, recordText(c.body)),
      c.coach_line ? el("div", { class: "coach-says" }, coachMark(), el("div", {}, el("p", { class: "who" }, "Coach"), el("p", {}, c.coach_line))) : null,
      group, comment, msg,
      el("div", { class: "row" }, i > 0 ? el("button", { type: "button", onclick: () => step(i - 1) }, "Back") : null, next)));
  }
  function review() {
    const all = order.every(c => votes[c.id]);
    const go = el("button", { type: "button", class: "primary" }, preview ? "Submit (preview: nothing is sent)" : "Send my votes");
    const msg = el("p", { class: "err" });
    go.disabled = !all;
    go.onclick = async () => {
      if (preview) { location.href = `?b=${board.slug}`; return; }
      go.disabled = true;
      const { data, error } = await sb.rpc("board_ballot_submit", { p_board: board.id });
      if (error) { msg.textContent = error.message; go.disabled = false; return; }
      done({ receipt_hash: data, submitted_at: new Date().toISOString() });
    };
    const name = Object.fromEntries(VOTES);
    show(bar, el("section", { class: "review-check" }, el("h1", {}, "Your votes"),
      el("div", { class: "tablewrap" }, el("table", { class: "answers" }, el("thead", {}, el("tr", {}, el("th", {}, "Card"), el("th", {}, "Vote"), el("th", {}, "Comment"))),
        el("tbody", {}, order.map((c, i) => el("tr", {}, el("td", {}, el("button", { type: "button", class: "link", onclick: () => step(i) }, `${c.ref} ${short(c.title, 40)}`)), el("td", {}, name[votes[c.id]?.vote] || "Not yet"), el("td", {}, short(votes[c.id]?.comment || "", 60))))))),
      el("p", {}, "Once you send them, your votes are final."), msg,
      el("div", { class: "row" }, go, el("button", { type: "button", onclick: () => step(0) }, "Change something"))));
  }
  function done(s) {
    show(el("section", { class: "plain" }, el("h1", {}, "Thanks. Your votes are in."),
      el("p", { class: "lede" }, "They’re final, and they count once. Everyone’s votes show once you’ve all sent yours."),
      el("details", { class: "details" }, el("summary", {}, "Details"), el("p", { class: "sub" }, `Sent ${new Date(s.submitted_at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}. Your receipt, which proves your votes weren’t changed after you sent them:`), el("p", { class: "receipt" }, s.receipt_hash)),
      signedInAs));
  }
  intro();
}

// ── Owner, once the ballot is open: votes per card (sent ballots only), comments by name ──
export async function ballotResults(board) {
  const [cards, { data: votes }, { data: revs }, { data: subs }] = await Promise.all([
    rpc("board_candidates", { p_board: board.id }),
    sb.from("board_votes").select("concept_id, user_id, vote, comment").eq("board_id", board.id),
    sb.from("board_reviewers").select("user_id, label").eq("board_id", board.id),
    sb.from("board_submissions").select("user_id").eq("board_id", board.id)]);
  const sent = new Set((subs || []).map(s => s.user_id));
  const name = Object.fromEntries((revs || []).map(r => [r.user_id, r.label]));
  const counted = (votes || []).filter(v => sent.has(v.user_id));
  const list = el("div", { class: "results cc-results" });
  for (const c of cards.filter(x => x.featured).sort((a, b) => a.sort_order - b.sort_order)) {
    const vs = counted.filter(v => v.concept_id === c.id);
    const n = Object.fromEntries(VOTES.map(([k]) => [k, vs.filter(v => v.vote === k).length]));
    list.append(el("details", { class: "rrow" },
      el("summary", {}, el("span", { class: "rname" }, el("b", {}, c.ref), ` ${short(c.label, 48)}`),
        el("span", { class: "tally", "aria-label": VOTES.map(([k, t]) => `${n[k]} ${t.toLowerCase()}`).join(", ") }, VOTES.map(([k, t]) => el("span", { class: `t ${k}` }, el("b", {}, String(n[k])), ` ${t.toLowerCase()}`)))),
      vs.filter(v => v.comment).length ? el("ul", { class: "comments" }, vs.filter(v => v.comment).map(v => el("li", {}, `${name[v.user_id] || "A partner"} (${v.vote}): ${v.comment}`))) : el("p", { class: "sub" }, "No comments.")));
  }
  if (!sent.size) list.append(el("p", { class: "sub" }, "No ballots sent yet."));
  return list;
}

// Rick votes too: his own link, made and opened in one go (one link, one person, like everyone's).
export async function voteAsPartner(board) {
  const raw = crypto.getRandomValues(new Uint8Array(24)), token = btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))].map(b => b.toString(16).padStart(2, "0")).join("");
  await rpc("board_invite", { p_board: board.id, p_label: "Rick", p_token_hash: hash, p_email: null });
  await rpc("board_claim", { p_slug: board.slug, p_token: token });
  location.href = `?b=${board.slug}&view=ballot`;
}
