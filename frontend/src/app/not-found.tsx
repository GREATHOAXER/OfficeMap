import Link from "next/link";
import { headers } from "next/headers";
import styles from "./not-found.module.css";

// 없는 주소: 영어 기본 화면 대신 돌아갈 곳을 알려 준다.
// 직원 화면과 관리자 페이지는 서로 링크하지 않으므로, 보던 쪽의 첫 화면으로만 안내한다
export default async function NotFound() {
  const path = (await headers()).get("x-pathname") ?? "";
  const admin = path.startsWith("/admin");
  return (
    <main className={styles.page}>
      <div className={styles.box}>
        <p className={`mono ${styles.code}`}>404</p>
        <h1>찾는 화면이 없습니다</h1>
        <p>주소가 바뀌었거나 아직 만들지 않은 화면입니다.</p>
        <div className={styles.links}>
          <Link href={admin ? "/admin" : "/"} className={styles.primary}>
            {admin ? "관리자 첫 화면으로" : "자리·재실 현황으로"}
          </Link>
        </div>
      </div>
    </main>
  );
}
