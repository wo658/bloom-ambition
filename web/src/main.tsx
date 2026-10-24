import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import KitRoot from "./KitRoot";
import PdfViewer from "./PdfViewer";
import "./style.css";
import "./widgets.css";

// ?demo=<이름>이 있으면 키트 3D 조립, 없으면 가구 3D 뷰어.
const demo = new URLSearchParams(location.search).get("demo");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {demo ? <KitRoot demo={demo} /> : <App />}
    <PdfViewer />
  </StrictMode>,
);
