// 다국어와 음성 안내. 번역은 "한국어 원문 → 번역" 사전에서 찾는다. 미리 만든 사전(/i18n-ui.json, <demo>/i18n.json —
// pipeline/translate.py)에 없는 문구는 처음 보일 때 /api/translate로 번역해 저장한다(개발 서버는 i18n.json, 배포는 브라우저).
// 음성은 브라우저 내장 Web Speech API로 읽는다.
import { useEffect, useSyncExternalStore } from "react";

// voice는 Web Speech API 언어 코드. 주요 언어 10개(모두 맥 기본 음성이 있다).
export const LANGS = [
  { id: "ko", label: "한국어", voice: "ko-KR" },
  { id: "en", label: "English", voice: "en-US" },
  { id: "ja", label: "日本語", voice: "ja-JP" },
  { id: "zh-CN", label: "简体中文", voice: "zh-CN" },
  { id: "zh-TW", label: "繁體中文", voice: "zh-TW" },
  { id: "es", label: "Español", voice: "es-ES" },
  { id: "fr", label: "Français", voice: "fr-FR" },
  { id: "de", label: "Deutsch", voice: "de-DE" },
  { id: "vi", label: "Tiếng Việt", voice: "vi-VN" },
  { id: "id", label: "Bahasa Indonesia", voice: "id-ID" },
];

// 기본은 한국어. ?lang=en처럼 링크로만 바꿔 열 수 있고, 고른 언어는 새로 고치면 한국어로 돌아간다.
let lang = new URLSearchParams(location.search).get("lang") ?? "ko";
let voiceOn = false;
let base = "";
let loaded = false;
let pending = 0;
const CACHE = "i18n-cache";
const cache: Record<string, Record<string, string>> = JSON.parse(localStorage.getItem(CACHE) ?? "{}");
let dict: Record<string, Record<string, string>> = structuredClone(cache);
let version = 0;
const listeners = new Set<() => void>();
const emit = () => { version++; listeners.forEach((l) => l()); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const getJson = (url: string) => fetch(url).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
const merge = (d: Record<string, Record<string, string>>) => {
  for (const [l, m] of Object.entries(d)) dict[l] = { ...dict[l], ...m };
};
// 크롬은 음성 목록을 늦게 채운다. 채워지면 음성 버튼 상태를 다시 그린다.
speechSynthesis.addEventListener?.("voiceschanged", emit);

// 번역이 없는 문구를 모았다가 60개씩 나눠 동시에 번역을 요청한다. 한 번 물은 문구는 실패해도 다시 묻지 않는다.
const asked = new Set<string>();
let queue: string[] = [];
let timer = 0;
function want(ko: string) {
  const key = `${lang}\n${ko}`;
  if (!loaded || lang === "ko" || dict[lang]?.[ko] !== undefined || asked.has(key)) return;
  asked.add(key);
  queue.push(ko);
  clearTimeout(timer);
  timer = window.setTimeout(flush, 50);
}

function flush() {
  const l = lang;
  for (let i = 0; i < queue.length; i += 60) {
    const texts = queue.slice(i, i + 60);
    pending++;
    fetch("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lang: l, texts, save: `${base}/i18n.json` }),
    })
      .then((r) => (r.ok ? r.json() : {}))
      .then((got: Record<string, string>) => {
        merge({ [l]: got });
        cache[l] = { ...cache[l], ...got };
        localStorage.setItem(CACHE, JSON.stringify(cache));
      })
      .catch(() => {})
      .finally(() => { pending--; emit(); });
  }
  queue = [];
  emit();
}

export function t(ko: string, vars?: Record<string, string | number>): string {
  let s = lang === "ko" ? ko : dict[lang]?.[ko];
  if (s === undefined) { want(ko); s = ko; }
  for (const [k, v] of Object.entries(vars ?? {})) s = s.replace(`{${k}}`, String(v));
  return s;
}

// 키 이름이 _ko로 끝나는 값을 모은다(translate.py의 korean_strings와 같다).
function koStrings(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((v) => koStrings(v, out));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k.endsWith("_ko")) (Array.isArray(v) ? v : [v]).forEach((x) => typeof x === "string" && x.trim() && out.push(x));
      else koStrings(v, out);
    }
  }
  return out;
}

// 미리 만든 사전을 읽어 오고, 언어를 고르면 설명서 문구 중 번역이 없는 것을 미리 요청한다.
export function useLang(dir: string, scene?: unknown) {
  useEffect(() => {
    base = dir;
    Promise.all([getJson("/i18n-ui.json"), getJson(`${dir}/i18n.json`)]).then(([u, d]) => {
      merge(u);
      merge(d);
      loaded = true;
      emit();
    });
  }, [dir]);
  useSyncExternalStore(subscribe, () => version);
  useEffect(() => { if (scene && loaded && lang !== "ko") koStrings(scene).forEach(want); }, [scene, version]); // eslint-disable-line react-hooks/exhaustive-deps
  return { lang, voiceOn, translating: pending > 0 };
}

// 지금 언어의 음성 코드(음성 인식·합성에 쓴다).
export const voiceCode = () => LANGS.find((l) => l.id === lang)?.voice ?? "ko-KR";

export const isVoiceOn = () => voiceOn;
export const getLang = () => lang;

// 언어가 바뀌면 다시 그려야 하는 곳(뷰어 밖의 위젯 등)에서 쓴다.
export function useT() {
  useSyncExternalStore(subscribe, () => version);
  return { t, lang };
}

export function setLang(id: string) {
  lang = id;
  emit();
}

export function toggleVoice() {
  voiceOn = !voiceOn;
  if (!voiceOn) speechSynthesis.cancel();
  emit();
}

// 지금 언어로 읽을 음성. 맥은 en-US에 장난 음성(Bubbles·Bad News 등)과 기계음(Eddy·Flo 등)도 있어서 뺀다.
const ODD = /albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley|fred|junior|kathy|ralph/i;
export function pickVoice(): SpeechSynthesisVoice | undefined {
  const code = LANGS.find((l) => l.id === lang)?.voice ?? "ko-KR";
  const all = speechSynthesis.getVoices().filter((v) => !ODD.test(v.name));
  const norm = (v: SpeechSynthesisVoice) => v.lang.replace("_", "-");
  const same = all.filter((v) => norm(v) === code);
  const near = same.length ? same : all.filter((v) => norm(v).split("-")[0] === code.split("-")[0]);
  return near.find((v) => /premium|enhanced|siri|google/i.test(v.name)) ?? near[0];
}

// 음성이 켜져 있으면 text를 지금 언어로 읽는다. 크롬은 긴 문장을 중간에 끊으므로 줄마다 나눠 읽는다.
export function useSpeak(text: string) {
  useEffect(() => {
    speechSynthesis.cancel();
    const voice = pickVoice();
    if (!voiceOn || !text || !voice) return;
    for (const line of text.split("\n").filter((l) => l.trim())) {
      const u = new SpeechSynthesisUtterance(line);
      u.voice = voice;
      u.lang = voice.lang;
      speechSynthesis.speak(u);
    }
  }, [text, version]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => speechSynthesis.cancel(), []);
}

// 자동 재생: ms가 지나고 읽던 음성까지 끝나면 fn을 부른다. 정리 함수를 돌려준다.
export function afterSpeech(ms: number, fn: () => void) {
  let poll = 0;
  const timer = setTimeout(() => {
    poll = window.setInterval(() => {
      if (speechSynthesis.speaking || speechSynthesis.pending) return;
      clearInterval(poll);
      fn();
    }, 200);
  }, ms);
  return () => { clearTimeout(timer); clearInterval(poll); };
}
