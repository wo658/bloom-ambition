import { LANGS, pickVoice, setLang, t, toggleVoice } from "./lang";

// 상단 막대 옆의 언어 선택과 음성 안내 켜기. 상태는 lang.ts에 있고, 뷰어가 useLang으로 구독한다.
export default function LangBar({ lang, voiceOn, translating }: { lang: string; voiceOn: boolean; translating: boolean }) {
  const canSpeak = !!pickVoice();
  return (
    <div className="lang-bar">
      <select value={lang} aria-label="Language" onChange={(e) => setLang(e.target.value)}>
        {LANGS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
      </select>
      {translating && <span className="lang-busy">{t("번역 중…")}</span>}
      <button className={`voice ${voiceOn && canSpeak ? "on" : ""}`} disabled={!canSpeak} aria-pressed={voiceOn}
        title={canSpeak ? t("음성 안내") : t("이 언어는 음성이 없어요")} onClick={toggleVoice}>
        🗣️
      </button>
    </div>
  );
}
