import { useEffect } from "react";
import { closePdf, demoName, openPdf, useCurrentStep, usePdfPage } from "./bridge";
import { useT } from "./lang";

// 원본 설명서 PDF를 브라우저 내장 뷰어로 띄운다. #page=N으로 해당 쪽부터 연다.
export default function PdfViewer() {
  const page = usePdfPage();
  const step = useCurrentStep();
  const { t } = useT();

  useEffect(() => {
    if (page == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePdf();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [page]);

  return (
    <>
      <button className="pdf-launcher" onClick={() => openPdf()} title={t("원본 설명서 PDF 보기")}>
        {t("📄 원본 PDF")}
      </button>
      {page != null && (
        <div className="pdf-backdrop" onClick={closePdf}>
          <section className="pdf-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={t("원본 PDF")}>
            <header>
              <b>{t("원본 설명서")}</b>
              {step && step.page !== page && (
                <button onClick={() => openPdf(step.page)}>{t("지금 단계 쪽({n}쪽)으로", { n: step.page })}</button>
              )}
              <a href={`/pdf/${demoName}.pdf`} target="_blank" rel="noreferrer">{t("새 탭에서 열기")}</a>
              <button className="close" onClick={closePdf} aria-label={t("닫기")}>✕</button>
            </header>
            {/* key로 쪽이 바뀔 때 iframe을 다시 그려야 #page가 적용된다. */}
            <iframe key={page} src={`/pdf/${demoName}.pdf#page=${page}&view=FitH`} title={t("원본 설명서 PDF")} />
          </section>
        </div>
      )}
    </>
  );
}
