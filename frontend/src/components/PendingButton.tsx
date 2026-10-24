"use client";

import { useEffect, useState } from "react";
import styles from "./PendingButton.module.css";

type Props = { label: string; primary?: boolean; className?: string };

/**
 * 아직 화면이 없는 작업 버튼. 눌러도 아무 일도 없이 지나가지 않고 "준비 중"이라고 말풍선으로 알려 준다
 * (title 툴팁은 터치·키보드로는 안 보여서). 화면 낭독기에는 "(준비 중)"을 같이 읽힌다
 */
export default function PendingButton({ label, primary = false, className = "" }: Props) {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(() => setShown(false), 2000);
    return () => clearTimeout(timer);
  }, [shown]);

  return (
    <span className={styles.wrap}>
      <button
        type="button"
        className={`${styles.button} ${primary ? styles.primary : ""} ${className}`}
        aria-disabled="true"
        aria-label={`${label} (준비 중)`}
        onClick={() => setShown(true)}
      >
        {label}
      </button>
      {shown && (
        <span role="status" className={styles.bubble}>
          준비 중인 기능이에요
        </span>
      )}
    </span>
  );
}
