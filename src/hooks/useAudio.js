import { useCallback, useRef } from 'react';
import { audioKey } from '../utils/audioKey';

let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  // Mobile browsers suspend AudioContext until a user gesture resumes it
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

// Pre-recorded audio files. Files live in /public/ so they're served at the
// root URL (`/assets/audio/...`). We only need to enumerate which files exist —
// the URL is derived from the path. Using a non-eager glob avoids fetching a
// JS module per file at startup, which previously exhausted the browser's
// connection pool once the audio set grew past ~1500 files.
// Filenames are produced by scripts/sync-audio.mjs using `audioKey(text, lang)`,
// and looked up here with the same function so the two always match.
const RECORDED_AUDIO = (() => {
  const files = import.meta.glob('/public/assets/audio/*/*.mp3');
  const map = {};
  for (const path in files) {
    const m = path.match(/\/audio\/([^/]+)\/([^/]+)\.mp3$/);
    if (m) map[`${m[1]}:${m[2]}`] = path.replace(/^\/public/, '');
  }
  return map;
})();

// Single persistent <audio> element. iOS Safari only allows playback on a
// media element whose first .play() was triggered by a user gesture — reusing
// one element across word changes (and priming it in primeAudio below) lets
// subsequent .src swaps play without re-locking.
let _recordedAudio = null;
function getRecordedAudio() {
  if (!_recordedAudio) _recordedAudio = new Audio();
  return _recordedAudio;
}

// Deferred-replay slot. On account-switch / OAuth-return / fresh load the
// auto-speak for the first word fires BEFORE any user gesture, so iOS
// blocks it. We stash it here and let an intentional learn-entry gesture
// (check-in OK, guest-mode entry, lang-setup confirm) replay it via
// primeAudio(). Gestures NOT meant to enter learn — tab switches, global
// fallback pointerdown, install-hint — pass `replay: false` so the queued
// word doesn't bleed onto WordList / Settings / Install modals.
let _deferredSpeak = null;

// Set true the first time primeAudio runs the silent-WAV unlock path. The
// shared `_recordedAudio` element only needs that priming once per page
// load; subsequent primeAudio calls must NOT re-run it because doing so
// (`a.pause(); a.currentTime = 0; a.src = silentWav`) would interrupt
// anything currently playing through that element. This matters when two
// primeAudio calls fire from the same gesture — e.g. the global
// pointerdown primer (capture phase) replays a deferred word mp3, then
// handleCheckin's onClick fires primeAudio again and would otherwise stomp
// on the mp3 that just started.
let _primed = false;

function playRecorded(url) {
  const a = getRecordedAudio();
  a.pause();
  a.currentTime = 0;
  a.src = url;
  const p = a.play();
  if (p && typeof p.catch === 'function') {
    p.catch(() => {
      // Likely blocked because audio wasn't unlocked yet — defer and let
      // primeAudio replay it on the next gesture.
      _deferredSpeak = () => {
        const a2 = getRecordedAudio();
        a2.pause();
        a2.currentTime = 0;
        a2.src = url;
        a2.play().catch(() => {});
      };
    });
  }
}

// Call from a user-gesture handler to unlock Web Audio / speechSynthesis /
// the shared <audio> element on iOS Safari. Default `replay: true` also
// drains and plays any queued first-word speak (see _deferredSpeak above);
// pass `replay: false` from gestures that aren't entering learn so the
// queued word doesn't bleed onto other surfaces.
//
// The deferred slot is ALWAYS drained — even on replay:false — so a stale
// word can't sit waiting to play later in the wrong context.
//
// The deferred-replay path and the silent-WAV path are mutually exclusive
// on the shared <audio> element: running both would race (silent WAV's
// async .then resolves after deferred-replay has swapped src and starts
// pausing it).
export function primeAudio({ replay = true } = {}) {
  // primeAudio is only called from user-gesture handlers (global pointerdown
  // primer, tab click, check-in, login, etc.), so getting here means audio
  // is authorized regardless of what `ctx.state` reads on the next tick.
  _audioUnlocked = true;
  try {
    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') ctx.resume();
  } catch {}
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    window.speechSynthesis.speak(u);
    window.speechSynthesis.cancel();
  } catch {}
  // Only drain the deferred slot when this gesture is *meant* to enter
  // learn (handleCheckin / handleLogin / handleLangSetupComplete pass
  // default replay:true). The capture-phase global primer and tab-switch /
  // install-hint gestures pass replay:false and MUST leave the slot intact
  // — otherwise the global primer fires first on the check-in tap and
  // drains the queued first word before handleCheckin's onClick can replay
  // it, and the popup dismiss ends in silence.
  let queued = null;
  if (replay) {
    queued = _deferredSpeak;
    _deferredSpeak = null;
  }
  if (queued) {
    try { queued(); } catch {}
    _primed = true;
  } else if (!_primed) {
    try {
      const a = getRecordedAudio();
      // Tiny 0-duration silent WAV; just enough to satisfy iOS's "first play
      // from gesture" check and unlock the <audio> element for later plays.
      // Do NOT attach a `.then(() => a.pause())` here: the WAV is empty so it
      // ends instantly on its own, and a deferred pause callback would fire
      // asynchronously — potentially AFTER the next playRecorded swaps src to
      // a real word and calls play(), pausing the word mid-playback. That
      // was the "I tapped 打卡, popup sound played, but the word stayed
      // silent" bug.
      a.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
      const p = a.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
      _primed = true;
    } catch {}
  }
}

let _lastSpeak = { text: '', time: 0 };
// Flipped to true the first time primeAudio runs inside a user gesture.
// AudioContext.resume() is async — its promise resolves on a later tick, so
// `audioCtx.state` can still read 'suspended' for a beat AFTER the gesture
// has already authorized playback. Reading raw `state` causes a false
// "locked" verdict in the check-in flow: handleCheckin unlocks audio →
// setCheckinDay(null) → LearningPage's isVisible flips true → its effect
// calls speakCurrent on the same tick → audioStillLocked() still sees
// 'suspended' → speak gets deferred → no replay happens (the slot would
// only fire on a *future* gesture) → user hears silence.
let _audioUnlocked = false;

function audioStillLocked() {
  if (_audioUnlocked) return false;
  return audioCtx ? audioCtx.state === 'suspended' : true;
}

export function speakWord(text, lang = 'en-US') {
  const now = Date.now();
  if (text === _lastSpeak.text && now - _lastSpeak.time < 600) return;
  _lastSpeak = { text, time: now };
  if (audioStillLocked()) {
    // Defer: replay from primeAudio once a gesture unlocks audio.
    _deferredSpeak = () => {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang;
      u.rate = 0.85;
      u.pitch = lang === 'ja-JP' ? 1.0 : 1.1;
      window.speechSynthesis.speak(u);
    };
    return;
  }
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang;
  u.rate = 0.85;
  u.pitch = lang === 'ja-JP' ? 1.0 : 1.1;
  window.speechSynthesis.speak(u);
}

export function speakWordEn(text) {
  speakWord(text, 'en-US');
}

export function speakWordJa(text) {
  speakWord(text, 'ja-JP');
}

export function speakWordZh(text) {
  speakWord(text, 'zh-CN');
}

const TTS_MAP = { en: 'en-US', ja: 'ja-JP', zh: 'zh-CN' };
export function speakWordByLang(text, lang) {
  const key = `${lang}:${audioKey(text, lang)}`;
  const url = RECORDED_AUDIO[key];
  if (url) {
    const now = Date.now();
    if (text === _lastSpeak.text && now - _lastSpeak.time < 600) return;
    _lastSpeak = { text, time: now };
    // Audio is still locked (no user gesture yet — e.g. fresh OAuth return
    // mount before the user has tapped anything). Defer the recorded
    // playback so primeAudio can replay it from the next gesture. Without
    // this, playRecorded would call .play() now: on some browsers the
    // returned promise resolves silently instead of rejecting, so the
    // existing .catch-based fallback never sets _deferredSpeak and the
    // first word stays silent forever.
    if (audioStillLocked()) {
      _deferredSpeak = () => playRecorded(url);
      return;
    }
    window.speechSynthesis.cancel();
    playRecorded(url);
    return;
  }
  speakWord(text, TTS_MAP[lang] || 'en-US');
}

export function playCorrectSound() {
  try {
    const ctx = getAudioCtx();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(523.25, now);
    osc.frequency.setValueAtTime(659.25, now + 0.08);
    osc.frequency.setValueAtTime(783.99, now + 0.16);
    gain.gain.setValueAtTime(0.25, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.35);
    osc.start(now);
    osc.stop(now + 0.35);
  } catch {}
}

export function playWrongSound() {
  try {
    const ctx = getAudioCtx();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(330, now);
    osc.frequency.setValueAtTime(260, now + 0.15);
    gain.gain.setValueAtTime(0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.25);
    osc.start(now);
    osc.stop(now + 0.25);
  } catch {}
}

export function playSlaySound() {
  try {
    const ctx = getAudioCtx();
    const now = ctx.currentTime;

    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.type = 'sawtooth';
    osc1.frequency.setValueAtTime(1200, now);
    osc1.frequency.exponentialRampToValueAtTime(200, now + 0.12);
    gain1.gain.setValueAtTime(0.15, now);
    gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.18);
    osc1.start(now);
    osc1.stop(now + 0.2);

    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.type = 'square';
    osc2.frequency.setValueAtTime(150, now + 0.05);
    osc2.frequency.exponentialRampToValueAtTime(60, now + 0.15);
    gain2.gain.setValueAtTime(0, now);
    gain2.gain.setValueAtTime(0.2, now + 0.05);
    gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.2);
    osc2.start(now + 0.05);
    osc2.stop(now + 0.25);

    const osc3 = ctx.createOscillator();
    const gain3 = ctx.createGain();
    osc3.connect(gain3);
    gain3.connect(ctx.destination);
    osc3.type = 'sine';
    osc3.frequency.setValueAtTime(2400, now + 0.03);
    osc3.frequency.exponentialRampToValueAtTime(800, now + 0.25);
    gain3.gain.setValueAtTime(0.08, now + 0.03);
    gain3.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
    osc3.start(now + 0.03);
    osc3.stop(now + 0.35);
  } catch {}
}

export function useSpeak() {
  const lastWord = useRef('');
  const speak = useCallback((text) => {
    if (!text) return;
    lastWord.current = text;
    speakWord(text);
  }, []);
  return speak;
}
