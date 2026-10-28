import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import styles from "@/app/login/login.module.css";
import PasswordForm from "@/app/password/PasswordForm";
import own from "@/app/password/password.module.css";
import LogoutButton from "@/components/LogoutButton";
import { fetchAdmin } from "@/lib/api";
import { safeNext } from "@/lib/loginRedirect";
import Logo from "@/components/Logo";

export const metadata: Metadata = {
  title: "관리자 비밀번호 변경 · 오피스 안내",
};

/**
 * 관리자 비밀번호 변경 (직원 화면 비밀번호와 따로). 권한을 받으며 임시 비밀번호를 받은 관리자는
 * 관리자 페이지의 다른 화면에 가기 전에 여기로 온다. 관리자 계정 메뉴의 "관리자 비밀번호 변경"으로도 온다
 */
export default async function AdminPasswordPage({ searchParams }: PageProps<"/admin/password">) {
  const next = safeNext((await searchParams).next, "/admin");
  const admin = await fetchAdmin((await headers()).get("cookie"));
  if (!admin) redirect("/admin/login");
  const forced = admin.must_change_password;

  return (
    <main className={own.page}>
      <div className={`${styles.formBox} ${own.box}`}>
        <Logo size={36} className={styles.logo} />
        <div>
          <h1 className={styles.title}>{forced ? "관리자 비밀번호 정하기" : "관리자 비밀번호 변경"}</h1>
          <p className={styles.subtitle}>
            {admin.name} {admin.rank ?? admin.role_label} · <span className="mono">{admin.emp_no}</span>
          </p>
        </div>
        {forced && (
          <p role="status" className={own.forced}>
            관리자 권한을 받으며 임시 비밀번호로 로그인했어요. 새 관리자 비밀번호를 정해야 관리자 페이지를 쓸 수 있어요.
            직원 화면 비밀번호와는 따로예요.
          </p>
        )}
        <PasswordForm empNo={admin.emp_no} forced={forced} next={next} kind="admin" />
        {forced ? (
          <LogoutButton
            className={own.logout}
            endpoint="/api/admin/auth/logout"
            redirectTo="/admin/login?reason=logout"
          />
        ) : (
          <Link href="/admin" className={own.back}>
            ← 바꾸지 않고 돌아가기
          </Link>
        )}
      </div>
    </main>
  );
}
