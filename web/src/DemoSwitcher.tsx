import "./demoSwitcher.css";

// 볼 수 있는 설명서 목록. demo가 없으면 가구 3D 뷰어(/), 있으면 키트 2D 가이드(/?demo=<이름>).
const DEMOS = [
  { demo: null, name: "IKEA KALLAX 2x2", kind: "가구 · 3D 조립", thumb: "/demo/pages/page-01.png" },
  { demo: "eduard-82212", name: "Eduard 제로센 21형", kind: "프라모델 · 2D 가이드", thumb: "/demo/eduard-82212/pages/page-01.png" },
];

// 사이드바 맨 위의 설명서 전환 메뉴. 링크라서 새 탭으로도 열 수 있다.
export default function DemoSwitcher({ current }: { current: string | null }) {
  return (
    <div className="demo-switcher">
      <span className="demo-switcher-label">설명서</span>
      <div className="demo-switcher-list">
        {DEMOS.map((d) => {
          const on = d.demo === current;
          return (
            <a key={d.demo ?? "furniture"} className={on ? "on" : ""} aria-current={on ? "page" : undefined}
              href={d.demo ? `/?demo=${d.demo}` : "/"}>
              <img src={d.thumb} alt="" />
              <span className="demo-switcher-text">
                <b>{d.name}</b>
                <small>{d.kind}</small>
              </span>
              {on && <span className="demo-switcher-check" aria-hidden>✓</span>}
            </a>
          );
        })}
      </div>
    </div>
  );
}
