import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { fetchMe } from "@/lib/api";
import LogoutButton from "./LogoutButton";
import styles from "./home.module.css";

// 로그인 뒤 첫 화면. 자리·재실 현황 화면이 생기면 이 자리를 대체한다
export default async function HomePage() {
  const user = await fetchMe((await headers()).get("cookie"));
  if (!user) redirect("/login");

  return (
    <main className={styles.page}>
      <section className={styles.card} aria-labelledby="welcome">
        <div className={styles.avatar} aria-hidden="true">
          {user.name.slice(-2)}
        </div>
        <div className={styles.who}>
          <h1 id="welcome" className={styles.name}>
            {user.name} {user.rank}
          </h1>
          <p className={styles.meta}>
            {user.department} · {user.role === "ADMIN" ? "관리자" : "직원"} ·{" "}
            <span className="mono">{user.emp_no}</span>
          </p>
        </div>
        <p className={styles.message}>로그인되었습니다. 자리·재실 현황 화면은 다음 단계에서 이어서 만듭니다.</p>
        {user.must_change_password && (
          <p className={styles.notice} role="status">
            임시 비밀번호로 로그인했습니다. 비밀번호 변경 화면이 생기면 로그인 직후 그 화면으로 이동합니다.
          </p>
        )}
        <LogoutButton className={styles.logout} />
      </section>
    </main>
  );
}
