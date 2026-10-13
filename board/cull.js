// The owner's board while it's a draft: fast cull first, then the Curator's
// Note, then send to the team. Keep and archive are saved as you go; every
// action (yours or Coach's) is logged and can be undone. Nothing is deleted.
import { el, show, errBox, sb, rpc, imageUrl, prefetchUrls, trimmedUrl, uploadImage, when, armed, roundsList, caption, prefersReducedMotion } from "./core.js";
import { createDock } from "./dock.js";
import { take, check24, curatorNote } from "./coach.js";

const AIM_MIN = 7, AIM_MAX = 10;
const isTyping = (t) => t && (t.closest("input, textarea, select, [contenteditable=true]"));
const phone = () => window.matchMedia("(max-width: 640px)").matches;
const fmtTime = (t) => new Date(t).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });

// brand: the private brand board (hundreds of concepts in families, Rick's own
// comments on each; it never goes live itself, its kept set is sent to a team board).
export async function ownerCull(board, { cropper, brand = false } = {}) {
  const S = {
    cands: [], events: [], view: "cull", focus: null, selected: new Set(), takes: {}, recent: new Map(), loupe: false,
    one: phone(), closed: false, toast: null, undoStack: [], family: "", base: 0,
  };
  // Images load as they come into view (a brand board has hundreds), trimmed to the mark.
  const done = new Map();           // path → trimmed url, once known
  const seen = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { seen.unobserve(e.target); const p = e.target.dataset.path; trimmedUrl(p).then(u => { done.set(p, u); e.target.src = u; }).catch(() => {}); }
  }, { rootMargin: "600px 0px" });
  const imgFor = (path, alt = "") => {
    if (!path) return el("div", { class: "noimg" }, "Image missing");
    const i = el("img", { alt, decoding: "async", "data-path": path });
    if (done.has(path)) i.src = done.get(path); else seen.observe(i);
    return i;
  };
  const minis = (c) => el("span", { class: "minis", "aria-label": "At 24px, on paper and on ink" },
    el("span", { class: "mini" }, imgFor(c.image_path)), el("span", { class: "mini ink" }, imgFor(c.image_path)));

  async function load() {
    S.cands = await rpc("board_candidates", { p_board: board.id });
    if (!S.base) { S.base = brand ? S.cands.filter(c => !c.archived_at).length : S.cands.length; prefetchUrls(S.cands.map(c => c.image_path)).catch(() => {}); }
    const { data } = await sb.from("board_events").select("id, at, actor, action, concepts, summary, undone_at").eq("board_id", board.id).order("at", { ascending: false }).limit(200);
    S.events = data || [];
    for (const c of S.cands) if (c.coach_take && !S.takes[c.id]) S.takes[c.id] = c.coach_take;
    if (!S.focus || !S.cands.some(c => c.id === S.focus && !c.archived_at)) S.focus = (active().find(c => !c.kept) || active()[0])?.id || null;
  }
  // Brand families run newest work first (the manifest is in the order things were made).
  const famRank = () => { const r = {}; for (const c of S.cands) { const f = c.family || ""; r[f] = Math.max(r[f] ?? 0, c.candidate_no); } return r; };
  // What's on screen: everything not archived, in the chosen family (brand board), in order.
  const active = () => {
    const rank = brand && !S.family ? famRank() : null;
    return S.cands.filter(c => (!c.archived_at || S.recent.has(c.id)) && (!S.family || (c.family || "") === S.family))
      .sort((a, b) => (rank ? (rank[b.family || ""] - rank[a.family || ""]) || String(a.family).localeCompare(String(b.family)) : 0) || a.sort_order - b.sort_order);
  };
  const archived = () => S.cands.filter(c => c.archived_at);
  const keptList = () => S.cands.filter(c => c.kept && !c.archived_at).sort((a, b) => a.sort_order - b.sort_order);
  const byId = (id) => S.cands.find(c => c.id === id);
  const nameOf = (c) => { const { id, name } = caption(c); return name ? `${id} ${name}` : id; };

  // ── Actions: every one goes through the log, so it can be undone ──
  async function cull(action, ids, { actor = "owner", summary = null, advance = true } = {}) {
    if (!ids.length) return;
    const list = ids.map(byId).filter(Boolean);
    const what = list.length === 1 ? nameOf(list[0]) : `${list.length} concepts`;
    const verb = { keep: "Kept", unkeep: "Cleared", archive: "Archived", restore: "Restored" }[action];
    const text = summary || `${verb} ${what}.`;
    if (actor === "owner") dock?.quiet();
    // Show it at once and move on (fast culling); the save follows right behind, in order.
    const now = new Date().toISOString();
    for (const c of list) {
      if (action === "keep") { c.kept = true; c.archived_at = null; }
      if (action === "unkeep") c.kept = false;
      if (action === "archive") { c.archived_at = c.archived_at || now; c.kept = false; }
      if (action === "restore") c.archived_at = null;
    }
    if (action === "archive") for (const id of ids) { clearTimeout(S.recent.get(id)); S.recent.set(id, setTimeout(() => { S.recent.delete(id); render(); }, 6000)); }
    if (advance && ids.length === 1 && ids[0] === S.focus) step(1, { skipDecided: true });
    S.selected.clear();
    render();
    // The undo entry is recorded the moment the save lands, so Z right after X always undoes the X.
    const saved = (S.chain = (S.chain || Promise.resolve()).catch(() => {}).then(() => rpc("board_cull", { p_board: board.id, p_action: action, p_concepts: ids, p_actor: actor, p_summary: text }))
      .then(ev => { if (ev) S.undoStack.push(ev); return ev; }));
    try {
      const ev = await saved;
      await load(); render();
      if (!ev) return toast("Already that way. Nothing changed.");
      toast(text, ev);
    } catch (e) { await load(); render(); throw e; }
  }
  async function undo(ev) {
    await (S.chain || Promise.resolve()).catch(() => {});        // let any save in flight land first
    ev = ev || S.undoStack.at(-1) || S.events.find(e => !e.undone_at && ["keep", "unkeep", "archive", "restore"].includes(e.action))?.id;
    if (!ev) return toast("Nothing to undo.");
    const e = S.events.find(x => x.id === ev);
    await rpc("board_undo", { p_event: ev });
    S.undoStack = S.undoStack.filter(x => x !== ev);
    for (const id of e?.concepts || []) { clearTimeout(S.recent.get(id)); S.recent.delete(id); }
    await load(); render();
    toast(`Undid: ${e ? e.summary.replace(/\.$/, "").replace(/^./, m => m.toLowerCase()) : "the last action"}.`);
  }
  const run = (p) => p.catch(e => toast(e.message || String(e)));

  // ── Focus and selection ──
  function step(d, { skipDecided = false } = {}) {
    const list = active().filter(c => !c.archived_at || c.id === S.focus);
    if (!list.length) return;
    let i = list.findIndex(c => c.id === S.focus);
    for (let n = 0; n < list.length; n++) {
      i = (i + d + list.length) % list.length;
      if (!skipDecided || (!list[i].kept && !list[i].archived_at)) break;
    }
    S.focus = list[i].id;
  }
  // Arrows move to the nearest tile in that direction on screen (rows can break at family headings).
  function moveGrid(dx, dy) {
    const tiles = [...document.querySelectorAll(".grid-cull .tile")];
    const cur = tiles.find(t => t.dataset.id === S.focus);
    if (!cur) { S.focus = tiles[0]?.dataset.id || S.focus; return; }
    if (dx) { const i = tiles.indexOf(cur) + dx; if (tiles[i]) S.focus = tiles[i].dataset.id; return; }
    const r = cur.getBoundingClientRect(), cx = r.left + r.width / 2;
    let best = null, bestD = Infinity;
    for (const t of tiles) {
      const q = t.getBoundingClientRect();
      const ahead = dy > 0 ? q.top > r.top + 4 : q.top < r.top - 4;
      if (!ahead) continue;
      const d = Math.abs(q.top - r.top) * 4 + Math.abs(q.left + q.width / 2 - cx);
      if (d < bestD) { bestD = d; best = t; }
    }
    if (best) S.focus = best.dataset.id;
  }
  const targets = () => (S.selected.size ? [...S.selected] : S.focus ? [S.focus] : []);

  // ── Render ──
  function render() {
    const kept = keptList().length, undecided = S.cands.filter(c => !c.archived_at && !c.kept).length;
    const allCount = S.base || S.cands.length;
    const inAim = kept >= AIM_MIN && kept <= AIM_MAX;
    const started = kept || S.events.some(e => !e.undone_at);
    const counter = el("div", { class: "counter" },
      el("span", { class: "num" }, String(started ? kept : allCount)),
      el("p", {}, !started ? `\u2192 aiming for ${AIM_MIN}\u2013${AIM_MAX}`
        : inAim ? `kept of ${allCount}. Ready to close.`
        : kept > AIM_MAX ? `kept of ${allCount}. Aim is ${AIM_MAX} at most.`
        : `kept of ${allCount}, aiming for ${AIM_MIN}\u2013${AIM_MAX}.`),
      el("button", { type: "button", class: inAim && S.view === "cull" ? "primary" : "primary reserve", "aria-hidden": inAim && S.view === "cull" ? null : "true", tabindex: inAim && S.view === "cull" ? null : "-1", title: undecided ? `The ${undecided} undecided stay on the board, unsent.` : null, onclick: () => closeCull() }, "Close the cull"));
    const nav = el("nav", { class: "views", "aria-label": "Board" }, [["cull", "Cull"], ["note", "Note"], ["archive", `Archive (${archived().length})`], ["history", "History"]]
      .map(([k, n]) => el("button", { type: "button", "aria-current": S.view === k ? "page" : null, onclick: () => { S.view = k; S.loupe = false; render(); } }, n)));
    const header = el("header", { class: "top" },
      el("div", { class: "title" }, el("h1", {}, board.title),
        el("p", { class: "sub" }, brand ? "Private. Only you can see this board. " : `Round ${board.round} draft. Only you can see this page.`, brand ? el("a", { href: `?b=${board.slug}&view=shelves` }, "Shelves view") : null),
        brand ? missingNote() : null),
      nav, counter);
    const views = { cull: cullView, note: noteView, archive: archiveView, history: historyView };
    show(header, rail(), views[S.view](), S.view === "cull" ? keysLine() : null, selectionBar(), S.loupe ? loupe() : null);
    document.querySelector(`[data-id="${S.focus}"]`)?.focus({ preventScroll: !S.focusScroll });
    S.focusScroll = false;
    dock?.refreshAbout();
    if (S.toast) document.body.append(S.toast);
  }

  // The tally rail: every concept at true 24px. Kept rise, archived sink, a bracket marks 7 to 10.
  function rail() {
    const kept = keptList(), undecided = S.cands.filter(c => !c.archived_at && !c.kept).sort((a, b) => a.sort_order - b.sort_order), arch = archived();
    // The brand board has hundreds: its rail shows what you've kept against the aim, and counts the rest.
    const slots = brand ? kept.map(c => [c, "up"]) : [...kept.map(c => [c, "up"]), ...undecided.map(c => [c, ""]), ...arch.map(c => [c, "down"])];
    const r = el("div", { class: `rail${S.closed ? " closed" : ""}`, role: "img", "aria-label": `${kept.length} kept, ${undecided.length} undecided, ${arch.length} archived` },
      el("div", { class: "aim", style: `--from:${AIM_MIN - 1};--span:${AIM_MAX - AIM_MIN + 1}` }, el("span", {}, "aim")),
      el("div", { class: "slots" }, slots.map(([c, cls]) => el("button", { type: "button", tabindex: "-1", class: `slot ${cls}${c.id === S.focus ? " at" : ""}`, title: nameOf(c), onclick: () => { if (!c.archived_at) { S.focus = c.id; S.view = "cull"; S.focusScroll = true; render(); } } }, imgFor(c.image_path)))),
      el("div", { class: "rule", style: `--kept:${kept.length}` }),
      brand ? el("p", { class: "rail-rest" }, `${undecided.length} undecided, ${arch.length} archived`) : null);
    return el("div", { class: "rail-wrap" }, r);
  }

  function tile(c) {
    const { id, name } = caption(c);
    const gone = Boolean(c.archived_at);
    const sel = S.selected.has(c.id);
    const box = el("input", { type: "checkbox", class: "pick", "aria-label": `Select ${id}`, tabindex: "-1" }); box.checked = sel;
    box.onclick = (e) => { e.stopPropagation(); sel ? S.selected.delete(c.id) : S.selected.add(c.id); render(); };
    const t = el("figure", { class: `tile${c.kept ? " kept" : ""}${gone ? " gone" : ""}${sel ? " selected" : ""}${c.id === S.focus ? " focus" : ""}`, tabindex: "0", "data-id": c.id, "aria-label": `${id} ${name}${c.kept ? ", kept" : ""}${gone ? ", archived" : ""}` },
      box,
      el("div", { class: "sheet" }, imgFor(c.image_path, `${id} ${name}`),
        c.id === S.focus && !gone ? el("div", { class: "tile-acts" },
          el("button", { type: "button", onclick: (e) => { e.stopPropagation(); run(cull(c.kept ? "unkeep" : "keep", [c.id])); } }, c.kept ? "Clear" : "Keep"),
          el("button", { type: "button", onclick: (e) => { e.stopPropagation(); run(cull("archive", [c.id])); } }, "Archive"),
          el("button", { type: "button", onclick: (e) => { e.stopPropagation(); S.loupe = true; render(); } }, "Look closer")) : null),
      el("figcaption", {}, el("span", { class: "cid" }, id, c.starred ? el("span", { class: "starmark", "aria-label": "starred" }, " \u2605") : null), el("span", { class: "cname" }, name)),
      c.kept ? el("p", { class: "kept-mark" }, "Kept") : null,
      gone ? el("p", { class: "gone-mark" }, "Archived. ", el("button", { type: "button", class: "link", onclick: (e) => { e.stopPropagation(); run(undo(S.events.find(x => !x.undone_at && x.action === "archive" && x.concepts.includes(c.id))?.id)); } }, "Undo")) : null);
    t.onclick = () => { if (gone) return; S.focus = c.id; render(); };
    t.ondblclick = () => { if (!gone) { S.focus = c.id; S.loupe = true; render(); } };
    // Tap and hold selects (phones have no Space bar).
    let hold = null;
    t.addEventListener("pointerdown", (e) => { if (e.pointerType !== "mouse") hold = setTimeout(() => { S.selected.has(c.id) ? S.selected.delete(c.id) : S.selected.add(c.id); hold = "done"; render(); }, 450); });
    t.addEventListener("pointerup", () => { if (hold !== "done") clearTimeout(hold); hold = null; });
    t.addEventListener("pointerleave", () => { if (hold !== "done") clearTimeout(hold); });
    return t;
  }

  function cullView() {
    const list = active();
    if (!S.cands.length) return el("section", { class: "empty" }, el("p", {}, "No concepts yet."), uploadButton());
    const toggle = el("div", { class: "seg", role: "group", "aria-label": "Layout" },
      el("button", { type: "button", "aria-pressed": String(S.one), onclick: () => { S.one = true; render(); } }, "One"),
      el("button", { type: "button", "aria-pressed": String(!S.one), onclick: () => { S.one = false; render(); } }, "Grid"));
    const fam = brand ? familyPicker() : null;
    const tools = phone() || fam ? el("div", { class: "cull-tools" }, fam, phone() ? toggle : null) : null;
    if (S.one && phone()) return el("section", { class: "cull one" }, fam, oneCard(toggle));
    if (!list.length) return el("section", { class: "empty" }, fam, el("p", {}, S.family ? "Nothing left undecided in this family." : "Everything is archived. Restore some from Archive."), uploadButton());
    const cells = [];
    let last = null;
    for (const c of list) {
      if (brand && !S.family && (c.family || "") !== last) { last = c.family || ""; cells.push(el("h2", { class: "fam-head" }, last || "No family", el("span", { class: "sub" }, ` ${list.filter(x => (x.family || "") === last).length}`))); }
      cells.push(tile(c));
    }
    return el("section", { class: "cull" }, tools, el("div", { class: "grid-cull" }, cells), el("div", { class: "cull-foot" }, uploadButton()));
  }
  function familyPicker() {
    const rank = famRank();
    const fams = [...new Set(S.cands.filter(c => !c.archived_at).map(c => c.family || ""))].sort((a, b) => rank[b] - rank[a]);
    const sel = el("select", { "aria-label": "Family", class: "fam-pick" }, el("option", { value: "" }, `All families (${S.cands.filter(c => !c.archived_at).length})`),
      fams.map(f => { const o = el("option", { value: f }, `${f || "No family"} (${S.cands.filter(c => !c.archived_at && (c.family || "") === f).length})`); if (f === S.family) o.selected = true; return o; }));
    sel.onchange = () => { S.family = sel.value; S.focus = active().find(c => !c.kept)?.id || active()[0]?.id || null; render(); window.scrollTo(0, 0); };
    return sel;
  }
  function missingNote() {
    const miss = S.cands.filter(c => c.image_missing);
    if (!miss.length) return null;
    return el("details", { class: "missing-note" }, el("summary", {}, `${miss.length} have no image yet`),
      el("p", { class: "sub" }, miss.map(c => c.ref || `#${c.candidate_no}`).join(", ")));
  }

  // Phone: one concept at a time; swipe right to keep, left to archive.
  function oneCard(toggle = null) {
    const list = active().filter(c => !c.archived_at);
    const c = byId(S.focus) && !byId(S.focus).archived_at ? byId(S.focus) : list[0];
    if (!c) return el("p", { class: "empty" }, "Everything is archived. Restore some from Archive.");
    S.focus = c.id;
    const { id, name } = caption(c);
    const keepEdge = el("span", { class: "edge keep", "aria-hidden": "true" }, "Keep"), archEdge = el("span", { class: "edge archive", "aria-hidden": "true" }, "Archive");
    const card = el("div", { class: `swipe${c.kept ? " kept" : ""}`, "data-id": c.id, tabindex: "0" }, el("div", { class: "sheet" }, imgFor(c.image_path, `${id} ${name}`)), archEdge, keepEdge);
    let x0 = null, dx = 0;
    card.addEventListener("pointerdown", (e) => { x0 = e.clientX; dx = 0; card.setPointerCapture(e.pointerId); card.classList.add("dragging"); });
    card.addEventListener("pointermove", (e) => {
      if (x0 == null) return;
      dx = e.clientX - x0;
      const p = Math.min(1, Math.abs(dx) / (card.offsetWidth * 0.3));
      card.style.transform = prefersReducedMotion() ? "" : `translateX(${dx}px)`;
      keepEdge.style.opacity = dx > 0 ? String(p) : "0"; archEdge.style.opacity = dx < 0 ? String(p) : "0";
    });
    const end = () => {
      if (x0 == null) return; x0 = null; card.classList.remove("dragging");
      if (Math.abs(dx) > card.offsetWidth * 0.3) { navigator.vibrate?.(10); run(cull(dx > 0 ? "keep" : "archive", [c.id])); return; }
      card.style.transform = ""; keepEdge.style.opacity = archEdge.style.opacity = "0";
    };
    card.addEventListener("pointerup", end); card.addEventListener("pointercancel", end);
    const i = list.indexOf(c);
    return el("div", { class: "one-wrap" },
      el("div", { class: "one-pos" }, el("span", {}, `${i + 1} of ${list.length}`), toggle),
      card,
      el("p", { class: "one-cap" }, el("span", { class: "cid" }, id), el("span", { class: "cname" }, name)),
      el("p", { class: "one-minis" }, "At 24px ", minis(c)),
      el("div", { class: "one-acts" },
        el("button", { type: "button", onclick: () => run(cull("archive", [c.id])) }, "Archive"),
        el("button", { type: "button", onclick: () => run(undo()) }, "Undo"),
        el("button", { type: "button", class: "primary", onclick: () => run(cull(c.kept ? "unkeep" : "keep", [c.id])) }, c.kept ? "Clear" : "Keep")),
      el("div", { class: "one-nav" },
        el("button", { type: "button", class: "link", onclick: () => { step(-1); render(); } }, "Previous"),
        el("button", { type: "button", class: "link", onclick: () => { S.loupe = true; render(); } }, "Look closer"),
        el("button", { type: "button", class: "link", onclick: () => { step(1); render(); } }, "Next")));
  }

  // Look closer: large, and at the sizes that matter, on paper and on ink.
  function loupe() {
    const c = byId(S.focus); if (!c) return null;
    const { id, name } = caption(c);
    const list = active().filter(x => !x.archived_at);
    const sizes = [16, 24, 32, 64];
    const notes = el("textarea", { placeholder: "A private note (only you see it; Coach uses it for the Curator's Note)", maxlength: "1000", "aria-label": "Private note" }); notes.value = c.notes || "";
    notes.onchange = () => run(rpc("board_label", { p_concept: c.id, p_label: c.label, p_notes: notes.value }).then(load).then(() => toast("Note saved.")));
    const replace = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp", class: "file" });
    replace.onchange = () => run(uploadImage(board, replace.files[0]).then(p => rpc("board_replace_image", { p_concept: c.id, p_image_path: p })).then(load).then(render));
    const closeL = () => { S.loupe = false; render(); };
    const d = el("div", { class: "loupe", role: "dialog", "aria-modal": "true", "aria-label": `${id} ${name}` },
      el("div", { class: "loupe-head" }, el("h2", {}, el("span", { class: "cid" }, id), " ", name), el("span", { class: "sub" }, `${list.indexOf(c) + 1} of ${list.length}`), el("button", { type: "button", class: "link", onclick: closeL }, "Close")),
      el("div", { class: "loupe-body" },
        el("div", { class: "loupe-img sheet" }, imgFor(c.image_path, `${id} ${name}`)),
        el("div", { class: "loupe-side" },
          el("h3", {}, "At real sizes"),
          el("table", { class: "sizes" }, el("tr", {}, el("th", {}, ""), el("th", {}, "On paper"), el("th", {}, "On ink")),
            sizes.map(px => el("tr", {}, el("td", {}, `${px}px`), el("td", {}, el("span", { class: "sz", style: `--px:${px}px` }, imgFor(c.image_path))), el("td", {}, el("span", { class: "sz ink", style: `--px:${px}px` }, imgFor(c.image_path)))))),
          el("h3", {}, "In a row of app icons"),
          el("div", { class: "homerow" }, el("span", { class: "ph" }), el("span", { class: "ph" }), el("span", { class: "app" }, imgFor(c.image_path)), el("span", { class: "ph" })),
          brand ? el("div", { class: "brand-facts" },
            c.description ? el("p", {}, c.description) : null,
            el("p", { class: "sub" }, [c.family, c.shelf === "featured" ? "Featured" : null, c.source && /: /.test(c.source) ? c.source.replace(/^BRAND-MANIFEST\.md: /, "") : null].filter(Boolean).join(". ")),
            c.comments ? el("div", { class: "record" }, el("p", { class: "sub" }, "Your comments"), el("p", {}, c.comments)) : el("p", { class: "sub" }, "No comments from you on this one."),
            c.coach_line ? el("div", { class: "coach-says" }, el("p", { class: "who" }, "Coach says ", el("span", { class: "sub" }, "· your approved wording")), el("p", {}, c.coach_line)) : null,
            c.coach_take ? el("div", { class: "coach-take" }, el("p", { class: "who" }, "Coach\u2019s take ", el("span", { class: "sub" }, "· Coach\u2019s own view, not your ruling")), el("p", {}, c.coach_take)) : null,
            el("button", { type: "button", class: "small", onclick: () => run(rpc("board_curate", { p_concept: c.id, p_shelf: null, p_starred: !c.starred, p_family: null }).then(load).then(render)) }, c.starred ? "Unstar" : "Star")) : null,
          notes,
          el("div", { class: "row" }, el("label", { class: "button small" }, "Replace image", replace), cropper ? el("button", { type: "button", class: "small", onclick: () => cropper(board, c, async () => { await load(); S.loupe = true; render(); }) }, "Crop") : null))),
      el("div", { class: "loupe-foot" },
        el("button", { type: "button", class: "link", onclick: () => { step(-1); render(); } }, "Previous"),
        el("button", { type: "button", onclick: () => run(cull("archive", [c.id])) }, "Archive"),
        el("button", { type: "button", class: "primary", onclick: () => run(cull(c.kept ? "unkeep" : "keep", [c.id])) }, c.kept ? "Clear keep" : "Keep"),
        el("button", { type: "button", class: "link", onclick: () => { dock.open(); askCoach(null); } }, "Ask Coach about this one"),
        el("button", { type: "button", class: "link", onclick: () => { step(1); render(); } }, "Next")));
    d.addEventListener("click", (e) => { if (e.target === d) closeL(); });
    return d;
  }

  function keysLine() {
    return el("p", { class: "keys", "aria-hidden": "true" }, [["K", "keep"], ["X", "archive"], ["U", "clear"], ["Z", "undo"], ["Space", "select"], ["Enter", "look closer"], ["?", "all keys"]]
      .map(([k, w]) => el("span", {}, el("kbd", {}, k), ` ${w}`)));
  }
  function selectionBar() {
    if (!S.selected.size) return null;
    const n = S.selected.size;
    return el("div", { class: "selbar", role: "region", "aria-label": "Selection" }, el("span", {}, `${n} selected.`),
      el("button", { type: "button", onclick: () => run(cull("archive", [...S.selected], { advance: false })) }, `Archive ${n}`),
      el("button", { type: "button", onclick: () => run(cull("keep", [...S.selected], { advance: false })) }, `Keep ${n}`),
      el("button", { type: "button", class: "link", onclick: () => { S.selected.clear(); render(); } }, "Clear"));
  }
  function uploadButton() {
    const f = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp", multiple: "", class: "file" });
    f.onchange = () => run((async () => { for (const x of f.files) { const p = await uploadImage(board, x); await rpc("board_add_concept", { p_board: board.id, p_image_path: p, p_label: x.name.replace(/\.[^.]+$/, "").slice(0, 80) }); } await load(); render(); toast(`Added ${f.files.length === 1 ? "1 concept" : `${f.files.length} concepts`}.`); })());
    return el("label", { class: "button small" }, "Add concepts", f);
  }

  // ── Archive and History ──
  function archiveView() {
    const list = archived().sort((a, b) => String(b.archived_at).localeCompare(a.archived_at));
    if (!list.length) return el("section", { class: "empty" }, el("p", {}, "Nothing archived yet. Anything you archive lands here with its date, ready to restore."));
    const days = [...new Set(list.map(c => c.archived_at.slice(0, 10)))];
    const by = (c) => { const e = S.events.find(x => x.action === "archive" && !x.undone_at && x.concepts.includes(c.id)); return e?.actor === "coach" ? "by Coach, with your OK" : "by you"; };
    return el("section", { class: "ledger" }, days.map(d => {
      const rows = list.filter(c => c.archived_at.startsWith(d));
      return el("div", { class: "day" }, el("div", { class: "day-head" }, el("h2", {}, when(d + "T12:00:00")), el("button", { type: "button", class: "link", onclick: () => run(cull("restore", rows.map(c => c.id), { advance: false })) }, "Restore all from this day")),
        rows.map(c => { const { id, name } = caption(c); return el("div", { class: "lrow" }, el("span", { class: "thumb" }, imgFor(c.image_path, id)), minis(c), el("span", { class: "lname" }, el("span", { class: "cid" }, id), " ", name), el("span", { class: "sub" }, `Archived ${fmtTime(c.archived_at)} ${by(c)}`), el("button", { type: "button", onclick: () => run(cull("restore", [c.id], { advance: false })) }, "Restore")); }));
    }));
  }
  function historyView() {
    if (!S.events.length) return el("section", { class: "empty" }, el("p", {}, "No actions yet. Every keep, archive and undo is listed here."));
    return el("section", { class: "ledger" }, el("ol", { class: "history" }, S.events.map(e => el("li", { class: e.undone_at ? "undone" : "" },
      el("span", { class: "sub" }, fmtTime(e.at)), el("span", {}, e.summary), el("span", { class: "sub" }, e.actor === "coach" ? "Coach, with your OK" : "You"),
      e.undone_at ? el("span", { class: "sub" }, `Undone ${new Date(e.undone_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`) : ["keep", "unkeep", "archive", "restore"].includes(e.action) ? el("button", { type: "button", class: "link", onclick: () => run(undo(e.id)) }, "Undo") : el("span", {})))));
  }

  // ── Closing the cull, and the Curator's Note ──
  function closeCull() {
    S.closed = true; S.view = "cull"; render();
    setTimeout(() => { S.view = "note"; render(); }, prefersReducedMotion() ? 0 : 1100);
  }
  function noteView() {
    const kept = keptList();
    if (kept.length < AIM_MIN || kept.length > AIM_MAX) return el("section", { class: "empty" }, el("p", {}, `Keep ${AIM_MIN} to ${AIM_MAX} concepts to write the note. ${kept.length} kept now.`), el("button", { type: "button", onclick: () => { S.view = "cull"; render(); } }, "Back to the cull"));
    const area = el("textarea", { class: "note-text", "aria-label": "Curator's Note", placeholder: "Coach can draft this for you; then make it yours." });
    area.value = board.curator_note || "";
    const status = el("p", { class: "sub" }, board.note_approved_at ? `Approved ${fmtTime(board.note_approved_at)}. This is the team's brief.` : board.curator_note ? "Draft saved." : "Not written yet.");
    const msg = el("p", { class: "err" });
    const draft = el("button", { type: "button", class: board.curator_note ? "" : "primary" }, board.curator_note ? "Redraft with Coach" : "Ask Coach to draft it");
    draft.onclick = () => run((async () => {
      draft.disabled = true; status.textContent = "Coach is writing the note…";
      try { const r = await curatorNote({ kept, srcOf: (c) => trimmedUrl(c.image_path), brief: board.brief, takes: S.takes }); area.value = r.note; if (r.aside) dock.say(r.aside); status.textContent = "Draft by Coach. Edit it, then approve."; checkNote(); draft.textContent = "Redraft with Coach"; draft.className = ""; await rpc("board_curator_note", { p_board: board.id, p_note: area.value, p_approve: false }); board.curator_note = area.value; board.note_approved_at = null; }
      finally { draft.disabled = false; }
    })());
    const save = el("button", { type: "button", onclick: () => run(rpc("board_curator_note", { p_board: board.id, p_note: area.value, p_approve: false }).then(() => { board.curator_note = area.value; board.note_approved_at = null; status.textContent = "Draft saved."; })) }, "Save draft");
    const approve = el("button", { type: "button", class: "primary" }, "Approve the note");
    const count = el("span", { class: "sub" });
    // Approve only a finished note: some words, ending a sentence (a cut-off draft can't become the brief).
    const checkNote = () => { const t = area.value.trim(), n = t ? t.split(/\s+/).length : 0; count.textContent = n ? `${n} words` : ""; approve.disabled = n < 20 || !/[.!?\u201D")]$/.test(t) || t.length > 2000; approve.title = approve.disabled ? (t.length > 2000 ? "The brief can be at most 2000 characters." : "Finish the note (at least 20 words, ending a sentence) to approve it.") : ""; };
    area.oninput = checkNote; checkNote();
    approve.onclick = () => run(rpc("board_curator_note", { p_board: board.id, p_note: area.value, p_approve: true }).then(() => { board.curator_note = area.value; board.brief = area.value; board.note_approved_at = new Date().toISOString(); render(); }));
    const sendBox = board.note_approved_at && area.value === board.curator_note
      ? (brand ? brandSend(kept, area.value)
        : el("div", { class: "send" }, el("p", {}, "Sending locks the set and this note. Reviewers see one concept at a time, with random letters."),
          el("div", { class: "row" }, armed("Send to the team", "Tap again to send and lock", async () => { await rpc("board_go_live", { p_board: board.id }); location.reload(); }, "primary"), el("button", { type: "button", class: "link", onclick: () => { board.note_approved_at = null; render(); } }, "Keep editing"))))
      : null;
    return el("section", { class: "note" },
      el("div", { class: "note-head" }, el("h2", {}, "Curator\u2019s Note"), el("div", { class: "row" }, status, count), el("div", { class: "row" }, draft, save, sendBox ? null : approve)),
      el("div", { class: "note-kept" }, el("p", { class: "sub" }, `${kept.length} kept`), el("div", { class: "double-rule" }),
        el("div", { class: "kept-strip" }, kept.map(c => { const { id, name } = caption(c); return el("figure", {}, el("span", { class: "thumb" }, imgFor(c.image_path, id)), el("figcaption", {}, el("span", { class: "cid" }, id), " ", name)); }))),
      area, msg, sendBox,
      el("p", { class: "sub" }, "The approved note is what reviewers read first, in place of the old brief. ", el("button", { type: "button", class: "link", onclick: () => { S.closed = false; S.view = "cull"; render(); } }, "Reopen the cull")));
  }

  // Brand board: hand the kept set and the note to a team board's draft. Nothing goes live here;
  // the team board letters them blind and locks only when Rick sends it to the team from there.
  function brandSend(kept, note) {
    const box = el("div", { class: "send" }, el("p", { class: "sub" }, "Finding your team board…"));
    sb.from("boards").select("id, slug, title, status, round, owners, kind").eq("kind", "first-impressions").order("created_at").then(async ({ data }) => {
      const me = (await sb.auth.getUser()).data.user;
      const t = (data || []).filter(b => b.owners?.includes(me.id) && b.status === "draft").at(-1);
      if (!t) return box.replaceChildren(el("p", {}, "Your team logo board is live, so its set is locked. Start a new round there, then send these."));
      const there = await rpc("board_candidates", { p_board: t.id }).catch(() => []);
      const others = there.filter(c => !c.archived_at && !kept.some(k => k.id === c.sent_from)).length;
      box.replaceChildren(
        el("p", {}, `Send these ${kept.length} and this note to ${t.title}${t.round > 1 ? ` (round ${t.round})` : ""}. They land in its draft; nothing goes to the team until you send it from there.`),
        others ? el("p", { class: "sub" }, `${t.title} already holds ${others} other concepts in its draft. These are added alongside them; archive the old ones there if you want only these.`) : null,
        el("div", { class: "row" }, armed(`Send ${kept.length} to ${t.title}`, "Tap again to send", async () => {
          const slug = await rpc("board_send", { p_brand: board.id, p_target: t.id, p_concepts: kept.map(c => c.id) });
          await rpc("board_curator_note", { p_board: t.id, p_note: note, p_approve: true });
          location.href = `?b=${slug}`;
        }, "primary"), el("button", { type: "button", class: "link", onclick: () => { board.note_approved_at = null; render(); } }, "Keep editing")));
    }).catch(e => box.replaceChildren(errBox(e)));
    return box;
  }

  // ── Toast with Undo ──
  function toast(text, ev = null) {
    S.toast?.remove();
    const t = el("div", { class: "toast", role: "status" }, el("span", {}, text), ev ? el("button", { type: "button", class: "link", onclick: () => run(undo(ev)) }, "Undo") : null);
    S.toast = t; document.body.append(t);
    clearTimeout(toast.t); toast.t = setTimeout(() => { if (S.toast === t && !ev) { t.remove(); S.toast = null; } }, 4000);
  }

  // ── Keyboard ──
  function help() {
    const d = el("div", { class: "loupe keysheet", role: "dialog", "aria-modal": "true", "aria-label": "Keys" },
      el("div", { class: "loupe-head" }, el("h2", {}, "Keys"), el("button", { type: "button", class: "link", onclick: () => d.remove() }, "Close")),
      el("dl", {}, [["K", "Keep"], ["X", "Archive"], ["U", "Clear the decision"], ["Z", "Undo (again for the one before)"], ["Arrows", "Move"], ["Space", "Select (for bulk)"], ["Enter", "Look closer"], ["Esc", "Close or clear the selection"], ["C or /", "Open Coach"], ["?", "This sheet"]].map(([k, v]) => [el("dt", {}, el("kbd", {}, k)), el("dd", {}, v)])));
    d.addEventListener("click", (e) => { if (e.target === d) d.remove(); });
    document.body.append(d);
  }
  const onKey = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || S.view !== "cull" && !["Escape"].includes(e.key)) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !isTyping(e.target)) { e.preventDefault(); run(undo()); }
      return;
    }
    const k = e.key;
    const map = {
      k: () => run(cull("keep", targets(), { advance: !S.selected.size })),
      x: () => run(cull("archive", targets(), { advance: !S.selected.size })),
      u: () => run(cull("unkeep", targets().filter(id => byId(id)?.kept), { advance: false })),
      z: () => run(undo()),
      ArrowRight: () => { S.loupe || S.one && phone() ? step(1) : moveGrid(1, 0); S.focusScroll = true; render(); },
      ArrowLeft: () => { S.loupe || S.one && phone() ? step(-1) : moveGrid(-1, 0); S.focusScroll = true; render(); },
      ArrowDown: () => { moveGrid(0, 1); S.focusScroll = true; render(); },
      ArrowUp: () => { moveGrid(0, -1); S.focusScroll = true; render(); },
      " ": () => { if (S.focus) { S.selected.has(S.focus) ? S.selected.delete(S.focus) : S.selected.add(S.focus); render(); } },
      Enter: () => { if (S.focus) { S.loupe = true; render(); } },
      Escape: () => { if (document.querySelector(".keysheet")) document.querySelector(".keysheet").remove(); else if (S.loupe) { S.loupe = false; render(); } else if (S.selected.size) { S.selected.clear(); render(); } },
      "?": help, c: () => dock.open(), "/": () => dock.open(),
    };
    const f = map[k.length === 1 ? k.toLowerCase() : k] || map[k];
    if (f) { e.preventDefault(); f(); }
  };
  document.addEventListener("keydown", onKey);

  // ── Coach ──
  async function askCoach(question) {
    const c = byId(S.focus);
    const label = c ? nameOf(c) : null;
    dock.asked(question || (label ? `Your honest take on ${label}?` : "Your honest take?"));
    const stop = dock.thinking(c ? `Looking at ${caption(c).id}…` : "Thinking…");
    try {
      const r = await take({ question, concept: c ? { ...c, label: caption(c).name, comments: c.comments || null } : null, src: c?.image_path ? await trimmedUrl(c.image_path) : null, kept: keptList().length, total: S.cands.length });
      stop();
      if (c) S.takes[c.id] = r.take;
      // On the brand board Coach's take is kept (Coach in the side panel can re-word it, on an Approve card).
      if (c && brand && !question) rpc("board_coach_words", { p_concept: c.id, p_kind: "take", p_text: r.take.slice(0, 1200), p_neutral: false }).then(() => { const x = byId(c.id); if (x) { x.coach_take = r.take; x.coach_take_at = new Date().toISOString(); } }).catch(() => {});
      dock.say(r.take, { verdicts: r.verdicts });
      if (c && !c.archived_at && !c.kept && r.call === "archive") dock.offer({ text: `Archive ${caption(c).id}?`, actions: [
        { label: "Archive it", primary: true, run: async () => { if (byId(c.id)?.archived_at) return "Already archived."; await cull("archive", [c.id], { actor: "coach", summary: `Archived ${nameOf(c)} on Coach\u2019s suggestion.`, advance: false }); return `Archived ${caption(c).id}. Undo is in the corner and in History.`; } },
        { label: "Not now", run: async () => "Left as it is." }] });
      if (c && !c.kept && r.call === "keep") dock.offer({ text: `Keep ${caption(c).id}?`, actions: [
        { label: "Keep it", primary: true, run: async () => { if (byId(c.id)?.kept) return "Already kept."; await cull("keep", [c.id], { actor: "coach", summary: `Kept ${nameOf(c)} on Coach\u2019s suggestion.`, advance: false }); return `Kept ${caption(c).id}.`; } },
        { label: "Not now", run: async () => "Left as it is." }] });
    } catch (e) { stop(); dock.error(`Coach couldn't answer. Your culling is saved. ${e.message || ""}`.trim()); }
  }
  // The 24px check, offered (never applied) once per board per day.
  async function offer24({ manual = false } = {}) {
    // On the brand board, check what's on screen (one family), at most 48 at a time.
    const pool = (brand ? active().filter(c => !c.archived_at) : S.cands.filter(c => !c.archived_at)).filter(c => c.image_path && !c.kept).slice(0, 48);
    if (!pool.length) return;
    if (brand && manual && !S.family) dock.say(`Checking the first ${pool.length} on screen. Pick a family to check that family.`);
    const stop = manual ? dock.thinking("Checking every concept at 24px…") : () => {};
    try {
      const { fail, why } = await check24(pool, (c) => trimmedUrl(c.image_path));
      stop();
      // Count only what "Do it" would actually archive now (the board may have moved on while Coach looked).
      const failing = fail.map(n => S.cands.find(c => c.candidate_no === n)).filter(c => c && !c.archived_at && !c.kept);
      if (!failing.length) { if (manual) dock.say("Everything still undecided holds up at 24px."); return; }
      const left = S.cands.filter(c => !c.archived_at).length - failing.length;
      const n = failing.length;
      const warn = left < AIM_MIN ? ` That would leave ${left} on the board, under your ${AIM_MIN}\u2013${AIM_MAX} aim; a mark can be fixed for small sizes later.` : "";
      dock.offer({ text: `${n} of these fail at 24px. Archive ${n === 1 ? "it" : "them"}?${warn}`, actions: [
        { label: "Do it", primary: true, run: async () => {
          const still = failing.map(c => byId(c.id)).filter(c => c && !c.archived_at && !c.kept);
          if (!still.length) return "Nothing left to archive: those are already decided.";
          await cull("archive", still.map(c => c.id), { actor: "coach", summary: `Archived ${still.length} that fail at 24px (Coach\u2019s suggestion).`, advance: false });
          return `Archived ${still.length}. Undo is in the corner and in History.`; } },
        { label: "Show me which", done: false, run: async () => {
          failing.forEach(c => S.selected.add(c.id)); S.view = "cull"; render();
          dock.say(failing.map(c => `${caption(c).id}: ${why[c.candidate_no] || "doesn\u2019t survive at 24px"}`).join("\n")); } },
        { label: "Not now", run: async () => "Left as they are." }] });
    } catch (e) { stop(); if (manual) dock.error(`Coach couldn't run the 24px check. ${e.message || ""}`.trim()); }
  }

  const dock = createDock({ mode: "owner", key: board.id, context: () => { const c = byId(S.focus); return c ? { name: nameOf(c), hasTake: Boolean(S.takes[c.id]) } : {}; },
    onAsk: (q) => { if (q && /24\s*px|app icon|icon size/i.test(q) && !/this one|this concept/i.test(q)) { dock.asked(q); offer24({ manual: true }); } else askCoach(q); } });

  await load(); render();
  const rounds = await roundsList(board);
  if (rounds) document.querySelector(".top .title")?.append(rounds);
  // Coach looks once a day, quietly: a badge on the dock, never a pop-up.
  try {
    const k = `coach-24:${board.id}:${new Date().toISOString().slice(0, 10)}`;
    if (!brand && !localStorage.getItem(k) && S.cands.filter(c => !c.archived_at && !c.kept).length >= 8) { localStorage.setItem(k, "1"); setTimeout(() => offer24(), 2500); }
  } catch { /* private window: skip the daily look */ }
}
