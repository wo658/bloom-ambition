import { useEffect } from "react";
import { closePdf, demoName, openPdf, useCurrentStep, usePdfPage } from "./bridge";

// 원본 설명서 PDF를 브라우저 내장 뷰어로 띄운다. #page=N으로 해당 쪽부터 연다.
export default function PdfViewer() {
  const page = usePdfPage();
  const step = useCurrentStep();

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
      <button className="pdf-launcher" onClick={() => openPdf()} title="원본 설명서 PDF 보기">
        📄 원본 PDF
      </button>
      {page != null && (
        <div className="pdf-backdrop" onClick={closePdf}>
          <section className="pdf-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="원본 PDF">
            <header>
              <b>원본 설명서</b>
              {step && step.page !== page && (
                <button onClick={() => openPdf(step.page)}>지금 단계 쪽({step.page}쪽)으로</button>
              )}
              <a href={`/pdf/${demoName}.pdf`} target="_blank" rel="noreferrer">새 탭에서 열기</a>
              <button className="close" onClick={closePdf} aria-label="닫기">✕</button>
            </header>
            {/* key로 쪽이 바뀔 때 iframe을 다시 그려야 #page가 적용된다. */}
            <iframe key={page} src={`/pdf/${demoName}.pdf#page=${page}&view=FitH`} title="원본 설명서 PDF" />
          </section>
        </div>
      )}
    </>
  );
}
