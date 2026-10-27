"use client";

import styles from "./office.module.css";

// 본문을 그리다 API 오류가 나면 이 화면으로 대신한다 (왼쪽 메뉴는 그대로).
// 운영 서버에서는 오류 내용이 화면까지 오지 않는다 (오류 번호만: 관리자가 서버 로그에서 찾는다)
export default function AppError({ error, retry }: { error: unknown; retry: () => void }) {
  const digest = error instanceof Error && "digest" in error ? String(error.digest) : null;
  return (
    <div className={styles.errorBox} role="alert">
      <strong>화면을 불러오지 못했습니다</strong>
      <p>잠시 뒤 다시 시도해 주세요. 계속되면 관리자에게 알려 주세요.</p>
      {digest && <p className={styles.errorDigest}>오류 번호 {digest}</p>}
      <button type="button" onClick={retry}>
        다시 시도
      </button>
    </div>
  );
}
