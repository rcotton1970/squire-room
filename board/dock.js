// Coach, docked bottom-right: collapsed by default, never in the way.
// Owner mode: honest takes on request, suggestions as one-tap chips.
// Reviewer mode: neutral; a welcome, the brief, encouragement only.
import { el, speak } from "./core.js";

const MARK = () => {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("aria-hidden", "true");
  s.innerHTML = '<path d="M5 3.5h10l4 4v13H5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="miter"/><path d="M15 3.5v4h4z" fill="#F64B19"/><path d="M8.5 15.5c1.4 1 4.6 1 5.6-.3.9-1.2-.2-2.2-2.1-2.6-1.8-.4-3-1.3-2.2-2.6.9-1.4 4-1.3 5.2-.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>';
  return s;
};
const MIC = () => {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("aria-hidden", "true");
  s.innerHTML = '<rect x="9" y="3" width="6" height="11" rx="3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>';
  return s;
};

const VERDICT_ROWS = [["trust", "Trust"], ["record", "A record"], ["human", "Human intent"], ["at24", "Works at 24px"]];

export function createDock({ mode = "owner", key = "board", hello = "I'm here. Cull fast; ask me anything, or tap me for my honest take.", context = () => ({}), onAsk = null }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const log = el("div", { class: "dock-log", "aria-live": "polite" });
  const about = el("span", { class: "dock-about" });
  const input = el("input", { type: "text", placeholder: "Ask about this concept…", "aria-label": "Ask Coach", maxlength: "400", autocomplete: "off" });
  const send = el("button", { type: "submit", class: "dock-send" }, "Ask");
  const micIn = SR ? el("button", { type: "button", class: "dock-mic small", "aria-label": "Ask out loud" }, MIC()) : null;
  const form = mode === "owner" ? el("form", { class: "dock-ask" }, input, micIn, send) : null;
  const closeBtn = el("button", { type: "button", class: "dock-close", "aria-label": "Close Coach" }, "Close");
  const action = el("div", { class: "dock-action", hidden: "" });     // a pending suggestion: pinned, never scrolled away
  const panel = el("section", { class: "dock-panel", role: "dialog", "aria-label": "Coach", hidden: "" },
    el("header", { class: "dock-head" }, el("b", {}, "Coach"), about, closeBtn), log, action, form);
  const badge = el("span", { class: "dock-dot", hidden: "", "aria-label": "Coach has something for you" });
  const markBtn = el("button", { type: "button", class: "dock-mark", "aria-label": "Coach", "aria-expanded": "false" }, MARK(), badge);
  const micBtn = SR && mode === "owner" ? el("button", { type: "button", class: "dock-mic", "aria-label": "Ask Coach out loud" }, MIC()) : null;
  const firstVisit = (() => { try { return !localStorage.getItem(`coach-hello:${key}`); } catch { return true; } })();
  const helloLine = hello && firstVisit ? el("p", { class: "dock-hello" }, hello) : null;
  if (helloLine) setTimeout(() => helloLine.classList.add("fade"), window.matchMedia("(max-width: 640px)").matches ? 7000 : 15000);
  const root = el("aside", { class: `dock ${mode}`, "aria-label": "Coach" }, panel, helloLine, el("div", { class: "dock-bar" }, micBtn, markBtn));
  document.body.append(root);

  let pending = 0, spoke = false;
  const quietHello = () => { if (helloLine) { helloLine.remove(); try { localStorage.setItem(`coach-hello:${key}`, "1"); } catch { /* private window */ } } };
  const isOpen = () => !panel.hidden;
  const setBadge = () => { badge.hidden = !pending || isOpen(); };
  const refreshAbout = () => { const c = context(); about.textContent = c?.name ? `On ${c.name}` : ""; input.placeholder = c?.name ? `Ask about ${c.name}…` : "Ask Coach…"; };
  function open({ ask = false } = {}) {
    quietHello(); refreshAbout();
    panel.hidden = false; markBtn.setAttribute("aria-expanded", "true"); root.classList.add("open"); pending = 0; setBadge();
    if (ask && onAsk && context()?.name && !context()?.hasTake) onAsk(null);
    else if (form) input.focus({ preventScroll: true });
  }
  function close() { panel.hidden = true; markBtn.setAttribute("aria-expanded", "false"); root.classList.remove("open"); setBadge(); markBtn.focus({ preventScroll: true, focusVisible: false }); }
  markBtn.onclick = () => (isOpen() ? close() : open({ ask: mode === "owner" }));
  closeBtn.onclick = close;
  panel.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
  if (form) form.onsubmit = (e) => { e.preventDefault(); const t = input.value.trim(); if (!t || !onAsk) return; input.value = ""; onAsk(t); };
  if (form) form.addEventListener("keydown", (e) => e.stopPropagation());   // typing never triggers cull keys

  // Speak a question; the answer is read back (only when asked out loud).
  const listen = () => {
    const r = new SR(); r.lang = navigator.language || "en-US"; r.interimResults = false;
    root.classList.add("listening");
    r.onresult = (e) => { const t = [...e.results].map(x => x[0].transcript).join(" ").trim(); if (t && onAsk) { spoke = true; onAsk(t); } };
    r.onend = () => root.classList.remove("listening");
    try { r.start(); } catch { r.onend(); }
  };
  if (micBtn) micBtn.onclick = () => { open(); listen(); };
  if (micIn) micIn.onclick = listen;

  const entry = (...kids) => { const n = el("div", { class: "dock-entry" }, ...kids); log.append(n); log.scrollTop = log.scrollHeight; return n; };
  return {
    root, open, close, isOpen, refreshAbout, quiet: quietHello,
    // You asked: shown small, above the answer.
    asked(text) { entry(el("p", { class: "dock-q" }, text)); },
    thinking(text) { const n = entry(el("p", { class: "dock-wait" }, text)); return () => n.remove(); },
    // Coach's answer; verdicts as word rows (never colour alone).
    say(text, { verdicts = null } = {}) {
      const rows = verdicts ? el("dl", { class: "verdicts" }, VERDICT_ROWS.filter(([k]) => verdicts[k]).map(([k, n]) => [el("dt", {}, n), el("dd", { class: String(verdicts[k]).toLowerCase() }, String(verdicts[k]))])) : null;
      entry(el("p", {}, text), rows);
      if (spoke) { speak(text); spoke = false; }
      if (!isOpen()) { pending++; setBadge(); }
    },
    error(text) { entry(el("p", { class: "dock-err" }, text)); },
    // A suggestion Coach can act on: one tap, always reversible.
    // Shown pinned above the input until answered; then it moves into the log with what happened.
    offer({ text, actions }) {
      const row = el("div", { class: "chips" });
      const err = el("p", { class: "dock-err" });
      action.replaceChildren(el("p", {}, text), row, err); action.hidden = false;
      for (const a of actions) {
        const b = el("button", { type: "button", class: a.primary ? "chip primary" : "chip" }, a.label);
        b.onclick = async () => {
          row.querySelectorAll("button").forEach(x => { x.disabled = true; }); err.textContent = "";
          try {
            const after = await a.run();
            if (a.done === false) { row.querySelectorAll("button").forEach(x => { x.disabled = false; }); return; }
            action.hidden = true; action.textContent = "";
            entry(el("p", {}, text), el("p", { class: "dock-done" }, after || a.label));
          } catch (e) { row.querySelectorAll("button").forEach(x => { x.disabled = false; }); err.textContent = e.message || String(e); }
        };
        row.append(b);
      }
      if (!isOpen()) { pending++; setBadge(); }
    },
    clear() { log.textContent = ""; },
  };
}
