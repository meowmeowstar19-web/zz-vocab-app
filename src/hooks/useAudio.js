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

// Deferred-replay slot. On account-switch / OAuth-return / fresh load, the
// auto-speak for the first word can fire BEFORE the user has produced any
// gesture — so iOS blocks it silently. We stash the attempt here and replay
// it from primeAudio once the user does tap (typically via App's global
// pointerdown primer). Cleared as soon as it fires.
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

// Call once from a user-gesture handler (e.g. the daily check-in button). On
// iOS Safari this unlocks Web Audio, speechSynthesis, and the shared <audio>
// element so subsequent auto-speaks on word change actually play.
export function primeAudio() {
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
  // Two mutually-exclusive paths share the persistent <audio> element:
  //
  //   1. If a `_deferredSpeak` is queued (the first-word auto-speak fired
  //      while audio was still locked), running it now both replays the
  //      missed word AND satisfies iOS's "first .play() must come from a
  //      gesture" rule for the shared <audio> element. No silent WAV needed.
  //
  //   2. Otherwise, prime the <audio> element with a tiny silent WAV so a
  //      future word play (e.g. after a Tab switch) doesn't need a fresh
  //      gesture.
  //
  // Both paths use the SAME `_recordedAudio` element. Running them both
  // would race: the silent WAV's `play()` Promise resolves on a microtask
  // and its `.then` calls `a.pause(); a.currentTime = 0` — which lands
  // AFTER the deferred-replay has already swapped src to the word mp3 and
  // started playing, silencing the word audio. That's the "I tapped 打卡,
  // popup sound played, but the word stayed silent" bug.
  const replay = _deferredSpeak;
  _deferredSpeak = null;
  if (replay) {
    try { replay(); } catch {}
    _primed = true;
  } else if (!_primed) {
    try {
      const a = getRecordedAudio();
      // Tiny silent WAV; just enough to satisfy iOS's "first play from gesture" check.
      a.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
      const p = a.play();
      if (p && typeof p.then === 'function') {
        p.then(() => { try { a.pause(); a.currentTime = 0; } catch {} }).catch(() => {});
      }
      _primed = true;
    } catch {}
  }
}

let _lastSpeak = { text: '', time: 0 };

function audioStillLocked() {
  // Heuristic: if the AudioContext (created at module-load time) is
  // suspended, we haven't received a user gesture yet — TTS will likely
  // fail silently too. Don't *create* the context here; just inspect it.
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
