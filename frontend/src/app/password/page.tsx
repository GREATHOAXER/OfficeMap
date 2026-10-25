import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import styles from "@/app/login/login.module.css";
import LogoutButton from "@/components/LogoutButton";
import { fetchMe } from "@/lib/api";
import { safeNext } from "@/lib/loginRedirect";
import PasswordForm from "./PasswordForm";
import own from "./password.module.css";

export const metadata: Metadata = { title: "비밀번호 변경 · 오피스 안내" };

/**
 * 비밀번호 변경. 임시 비밀번호로 로그인하면 다른 화면에 가기 전에 여기로 온다 (바꾸기 전에는 못 나간다).
 * 계정 메뉴의 "비밀번호 변경"으로도 온다
 */
export default async function PasswordPage({ searchParams }: PageProps<"/password">) {
  const next = safeNext((await searchParams).next, "/");
  const cookieHeader = (await headers()).get("cookie");
  const user = await fetchMe(cookieHeader);
  if (!user) redirect("/login");
  const forced = user.must_change_password;

  return (
    <main className={own.page}>
      <div className={`${styles.formBox} ${own.box}`}>
        <Image src="/kftc-logo.jpg" alt="금융결제원" width={152} height={48} priority className={styles.logo} />
        <div>
          <h1 className={styles.title}>{forced ? "새 비밀번호 정하기" : "비밀번호 변경"}</h1>
          <p className={styles.subtitle}>
            {user.name} {user.rank} · <span className="mono">{user.emp_no}</span>
          </p>
        </div>
        {forced && (
          <p role="status" className={own.forced}>
            지금은 임시 비밀번호로 로그인한 상태입니다. 새 비밀번호를 정해야 서비스를 쓸 수 있어요.
          </p>
        )}
        <PasswordForm empNo={user.emp_no} forced={forced} next={next} />
        {forced ? (
          // 바꾸기 전에는 다른 화면에 못 가니, 다른 계정으로 들어가려면 여기서 로그아웃한다
          <LogoutButton className={own.logout} redirectTo="/login?reason=logout" />
        ) : (
          <Link href="/" className={own.back}>
            ← 바꾸지 않고 돌아가기
          </Link>
        )}
      </div>
    </main>
  );
}
