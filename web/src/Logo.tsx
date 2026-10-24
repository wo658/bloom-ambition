// Stepcast 마크: 계단 세 칸이 모여 재생 버튼이 된다(public/favicon.svg와 같은 그림).
export function LogoMark({ size = 16 }: { size?: number }) {
  return (
    <svg className="logo-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="8" fill="var(--accent)" />
      <g fill="#fff">
        <rect x="8.5" y="8" width="4.5" height="16" rx="1.2" />
        <rect x="14.5" y="10.75" width="4.5" height="10.5" rx="1.2" />
        <rect x="20.5" y="13.5" width="4.5" height="5" rx="1.2" />
      </g>
    </svg>
  );
}
