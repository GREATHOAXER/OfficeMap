"use client";

import styles from "./admin.module.css";

// 본문을 그리다 API 오류가 나면 이 화면으로 대신한다 (왼쪽 메뉴는 그대로).
// 운영 서버에서는 오류 내용이 화면까지 오지 않아서(오류 번호만) 이유를 볼 곳을 알려 준다
export default function AdminError({ error, retry }: { error: unknown; retry: () => void }) {
  const digest = error instanceof Error && "digest" in error ? String(error.digest) : null;
  return (
    <div className={styles.errorBox} role="alert">
      <strong>화면을 불러오지 못했습니다</strong>
      <p>API 서버가 이 화면의 데이터를 주지 못했어요. 계속되면 서버의 deploy 디렉토리에서 이유를 보세요:</p>
      <code>docker compose logs --tail 50 backend</code>
      <p>새 버전으로 바꾼 직후라면 대개 DB에 새 테이블이 없어서예요. 데이터는 그대로 두고 빠진 것만 넣기:</p>
      <code>docker compose run --rm backend python -m scripts.init_db --upgrade</code>
      {digest && <p className={styles.errorDigest}>오류 번호 {digest}</p>}
      <button type="button" className={styles.btn} onClick={retry}>
        다시 시도
      </button>
    </div>
  );
}
