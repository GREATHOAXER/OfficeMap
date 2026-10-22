"use client";

import styles from "./office.module.css";

// 본문을 그리다 API 오류가 나면 이 화면으로 대신한다 (왼쪽 메뉴는 그대로)
export default function AppError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className={styles.errorBox} role="alert">
      <strong>화면을 불러오지 못했습니다</strong>
      <p>API 서버(uvicorn)가 켜져 있는지 확인한 뒤 다시 시도하세요.</p>
      <button type="button" onClick={reset}>
        다시 시도
      </button>
    </div>
  );
}
