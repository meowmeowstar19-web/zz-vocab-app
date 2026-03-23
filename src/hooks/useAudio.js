import { useCallback, useRef } from 'react';

let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

export function speakWord(text, lang = 'en-US') {
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
