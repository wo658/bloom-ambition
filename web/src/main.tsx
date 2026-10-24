import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import KitRoot from "./KitRoot";
import PdfViewer from "./PdfViewer";
import "./style.css";
import "./widgets.css";

// ?intro가 있으면 심사위원용 오프닝을 먼저 보여 주고 가구 3D 뷰어 1단계로 넘어간다.
// 오프닝 파일(글꼴·스타일 포함)은 이때만 불러온다.
const Opening = lazy(() => import("./opening/Opening"));

// ?demo=<이름>이 있으면 키트 3D 조립, 없으면 가구 3D 뷰어.
const params = new URLSearchParams(location.search);
const demo = params.get("demo");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {demo ? <KitRoot demo={demo} /> : params.has("intro") ? <Suspense fallback={null}><Opening /></Suspense> : <App />}
    <PdfViewer />
  </StrictMode>,
);
