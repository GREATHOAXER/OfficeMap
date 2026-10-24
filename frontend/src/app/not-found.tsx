import Link from "next/link";
import styles from "./not-found.module.css";

// 없는 주소: 영어 기본 화면 대신 돌아갈 곳을 알려 준다
export default function NotFound() {
  return (
    <main className={styles.page}>
      <div className={styles.box}>
        <p className={`mono ${styles.code}`}>404</p>
        <h1>찾는 화면이 없습니다</h1>
        <p>주소가 바뀌었거나 아직 만들지 않은 화면입니다.</p>
        <div className={styles.links}>
          <Link href="/" className={styles.primary}>
            자리·재실 현황으로
          </Link>
          <Link href="/admin">관리자 페이지로</Link>
        </div>
      </div>
    </main>
  );
}
