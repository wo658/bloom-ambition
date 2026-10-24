import { useEffect, useState } from "react";
import KitGuide from "./KitGuide";
import type { KitGuideData } from "./kitTypes";

// ?demo=<이름> 으로 web/public/demo/<이름>/ 의 키트 가이드를 연다.
export default function KitRoot({ demo }: { demo: string }) {
  const base = `/demo/${demo}`;
  const [guide, setGuide] = useState<KitGuideData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${base}/scene.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(setGuide)
      .catch(() => setError(`${base}/scene.json을 찾지 못했어요. pipeline/run.sh로 먼저 만들어 주세요.`));
  }, [base]);

  if (error) return <div className="kit-loading">{error}</div>;
  if (!guide) return <div className="kit-loading">불러오는 중…</div>;
  return <KitGuide demo={demo} guide={guide} pageUrl={(page) => `${base}/pages/page-${String(page).padStart(2, "0")}.png`} />;
}
