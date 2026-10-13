// Coach's voice on the board page: the same voice as the Coach extension (the
// Squire voice service, ElevenLabs behind Coach's own server, so no key is on
// this page), falling back to this computer's voice. Listening uses Chrome's
// speech recognition. Whenever voice can't work, it says why in one line
// (permission, setting or service) instead of going quiet.
import { CFG, sb } from "./core.js";

const reasons = {
  autoplay: "Chrome blocks sound until you click this page once. Click anywhere and I'll say it.",
  noSynth: "This browser has no voice output, so I can only write. Try Chrome.",
  synthFailed: "This computer's voice didn't play (check the system volume and Chrome's sound setting for this site).",
  limit: "The Coach voice is at today's limit, so I'm using this computer's voice.",
  service: "The Coach voice service didn't answer, so I'm using this computer's voice.",
  signedOut: "The Coach voice needs you signed in, so I'm using this computer's voice.",
  micBlocked: "The microphone is blocked for this site: click the lock icon left of the address, allow Microphone, then tap the mic.",
  noMic: "No microphone found. Plug one in or check System Settings → Sound → Input, then tap the mic.",
  noSR: "This browser can't listen (no speech recognition). Use Chrome, or type to me.",
  heardNothing: null,
};

export function createVoice({ onState = () => {}, onNotice = () => {}, onClear = () => {} } = {}) {
  let audio = null, pausedUntil = 0, unlocked = navigator.userActivation?.hasBeenActive || false, pending = null, ear = null;
  const said = new Set();
  let lastProblem = null;
  const notice = (key, extra = "") => { const t = reasons[key]; if (!t) return; lastProblem = key; if (said.has(key) && key !== "micBlocked" && key !== "noMic") return; said.add(key); onNotice(t + extra, key); };
  const unlock = () => { unlocked = true; if (pending) { const p = pending; pending = null; speak(p.text).then(p.done); } };
  for (const ev of ["pointerdown", "keydown", "touchstart"]) window.addEventListener(ev, unlock, { capture: true });

  async function premium(text) {
    if (Date.now() < pausedUntil) return null;
    const s = (await sb.auth.getSession()).data.session;
    if (!s) { notice("signedOut"); return null; }
    let res;
    try { res = await fetch(`${CFG.url}/functions/v1/voice`, { method: "POST", headers: { Authorization: `Bearer ${s.access_token}`, apikey: CFG.key, "Content-Type": "application/json" }, body: JSON.stringify({ text: text.slice(0, 1200) }) }); }
    catch { pausedUntil = Date.now() + 60_000; notice("service"); return null; }
    if (!res.ok) { const why = await res.json().catch(() => ({})); pausedUntil = Date.now() + (res.status === 429 ? 30 * 60_000 : 60_000); notice(res.status === 429 || /cap|limit/.test(why.reason || "") ? "limit" : "service"); return null; }
    return URL.createObjectURL(await res.blob());
  }
  const browserVoice = (text) => new Promise((resolve) => {
    if (!("speechSynthesis" in window)) { notice("noSynth"); return resolve(false); }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const voices = speechSynthesis.getVoices();
    u.voice = voices.find(v => /Evan|Aaron|Daniel|Google UK English Male|Microsoft Guy/i.test(v.name) && /^en/i.test(v.lang)) || voices.find(v => /^en/i.test(v.lang)) || null;
    u.onend = () => resolve(true);
    u.onerror = (e) => { if (e.error === "not-allowed") { unlocked = false; resolve("blocked"); } else { if (e.error !== "interrupted" && e.error !== "canceled") notice("synthFailed"); resolve(false); } };
    speechSynthesis.speak(u);
  });

  // Speaks, resolving when it's done. If sound is blocked until a click, it waits for that click.
  async function speak(text) {
    stop();
    if (!text) return;
    if (!unlocked) { notice("autoplay"); return new Promise(done => { pending = { text, done }; }); }
    onState("speaking");
    try {
      const url = await premium(text);
      if (url) {
        audio = new Audio(url);
        const r = await new Promise((resolve) => { audio.onended = () => resolve(true); audio.onerror = () => resolve(false); audio.play().catch(e => resolve(e.name === "NotAllowedError" ? "blocked" : false)); });
        URL.revokeObjectURL(url);
        if (r === "blocked") { unlocked = false; onState("idle"); notice("autoplay"); return new Promise(done => { pending = { text, done }; }); }
        if (r) { if (lastProblem === "autoplay") { lastProblem = null; said.delete("autoplay"); onClear("autoplay"); } return; }
      }
      const b = await browserVoice(text);
      if (b === true && lastProblem === "autoplay") { lastProblem = null; said.delete("autoplay"); onClear("autoplay"); }
      if (b === "blocked") { onState("idle"); notice("autoplay"); return new Promise(done => { pending = { text, done }; }); }
    } finally { if (!pending) onState("idle"); }
  }
  function stop() { if (audio) { audio.pause(); audio = null; } if ("speechSynthesis" in window) speechSynthesis.cancel(); }

  // One utterance: resolves with what was said ("" if nothing).
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  function listen() {
    if (!SR) { notice("noSR"); return Promise.resolve(""); }
    return new Promise((resolve) => {
      ear?.abort?.();
      const r = ear = new SR(); r.lang = navigator.language || "en-US"; r.interimResults = false; r.maxAlternatives = 1;
      let text = "";
      onState("listening"); lastProblem = null;
      r.onresult = (e) => { text = [...e.results].map(x => x[0].transcript).join(" ").trim(); };
      r.onerror = (e) => { if (e.error === "not-allowed" || e.error === "service-not-allowed") notice("micBlocked"); else if (e.error === "audio-capture") notice("noMic"); };
      r.onend = () => { if (ear === r) ear = null; onState("idle"); resolve(text); };
      try { r.start(); } catch { onState("idle"); resolve(""); }
    });
  }
  const stopListening = () => { ear?.abort?.(); ear = null; };
  return { speak, stop, listen, stopListening, get canListen() { return Boolean(SR); }, get unlocked() { return unlocked; }, get lastProblem() { return lastProblem; } };
}

// What Rick says back, as a board command (or null for a question to Coach).
export function command(t) {
  const s = String(t || "").toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;
  if (/^(stop|that's (it|enough)|enough|pause|quiet|we're done|done for now|end)( for now)?( please)?$/.test(s)) return "stop";
  if (/^(next|next one|skip|skip (this|it|this one|that one)|move on|pass)( please)?$/.test(s)) return "next";
  if (/^(back|go back|previous|previous one|last one)( please)?$/.test(s)) return "back";
  if (/^(repeat|say (that|it) again|again|what was that)( please)?$/.test(s)) return "repeat";
  if (/^(show (me )?(all|everything)|all cards|clear (the )?filters?)( please)?$/.test(s)) return "all";
  if (/(walk me through|go through|take|let's do|show me|start with)( the)? open|^(yes|yeah|yep|sure|ok|okay|let's go|go ahead|one at a time|do it)\b/.test(s)) return "walk";
  return null;
}
