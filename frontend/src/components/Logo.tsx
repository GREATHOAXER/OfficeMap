import type { CSSProperties } from "react";
import styles from "./Logo.module.css";

// Office Map 로고. 심볼은 도면 한 칸(벽·문·자리·강조한 방)을 그린 그림, 글자는 기기 글꼴로 그려 어느 크기에서도 선명하다
const NAVY = "#1b2441";
const ORANGE = "#ff7a3d";

/** 심볼만 (접은 메뉴 등). size: 한 변 px. onDark면 짙은 바탕 위용 흰 선 */
export function LogoSymbol({ size = 32, onDark = false, className }: { size?: number; onDark?: boolean; className?: string }) {
  const ink = onDark ? "#fff" : NAVY;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 152 152"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M83 12H114A26 26 0 0 1 140 38V70H83Z" fill={ORANGE} />
      <rect x="6" y="6" width="140" height="140" rx="32" stroke={ink} strokeWidth="12" />
      <path d="M77 6V76H146" stroke={ink} strokeWidth="12" />
      <path d="M6 76H38" stroke={ink} strokeWidth="12" strokeLinecap="round" />
      <circle cx="41" cy="41" r="11" fill={ink} />
      <circle cx="107" cy="113" r="11" fill={ink} />
    </svg>
  );
}

/** 심볼 + "Office Map" 글자. size: 심볼 높이 px (글자 크기도 여기에 맞춘다) */
export default function Logo({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <span
      className={`${styles.logo} ${className ?? ""}`}
      style={{ "--logo-h": `${size}px` } as CSSProperties}
      role="img"
      aria-label="Office Map"
    >
      <LogoSymbol size={size} />
      <span className={styles.word} aria-hidden="true">
        Office Map
      </span>
    </span>
  );
}
