import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import styles from "@/app/login/login.module.css";
import { LEVELS } from "@/lib/admin";
import { fetchAdmin, fetchLoginInfo, fetchMe } from "@/lib/api";
import { safeNext } from "@/lib/loginRedirect";
import AdminLoginForm from "./AdminLoginForm";
import own from "./adminLogin.module.css";

export const metadata: Metadata = { title: "관리자 로그인 · 오피스 안내" };

export default async function AdminLoginPage({ searchParams }: PageProps<"/admin/login">) {
  const cookieHeader = (await headers()).get("cookie");
  const [admin, user, info, params] = await Promise.all([
    fetchAdmin(cookieHeader),
    fetchMe(cookieHeader),
    fetchLoginInfo(),
    searchParams,
  ]);
  const next = safeNext(params.next, "/admin");
  if (admin) redirect(next);

  const contact = info.support_contact ?? "정보보호팀";
  const notice =
    params.reason === "expired"
      ? `${info.admin_idle_minutes}분 넘게 사용하지 않았거나 권한이 바뀌어 로그아웃되었습니다. 다시 로그인하세요.`
      : params.reason === "logout"
        ? "로그아웃했습니다. 이 브라우저의 관리자 페이지와 직원 화면 로그인이 모두 끝났습니다."
        : null;

  return (
    <div className={styles.page}>
      <section className={`${styles.intro} ${own.intro}`}>
        <strong className={styles.brand}>
          오피스 안내 <span className={own.modeTag}>관리자</span>
        </strong>
        <div className={styles.introBody}>
          <h1 className={styles.headline}>
            사업장·층·좌석 배치를
            <br />
            맡은 범위 안에서 관리합니다.
          </h1>
          <p className={styles.lead}>
            관리자 권한이 있는 직원만 들어올 수 있습니다. 상위 관리자가 바로 아래 관리자를 지정하고, 각자 맡은 범위
            안에서만 편집합니다.
          </p>
          <ol className={own.levels}>
            {LEVELS.map((l) => (
              <li key={l.level}>
                <span className="mono">LEVEL {l.level}</span>
                <strong>{l.name}</strong>
                <span>범위: {l.scope}</span>
              </li>
            ))}
          </ol>
        </div>
        <p className={styles.introFoot}>사내망 전용 · 관리자 로그인은 모두 기록됩니다</p>
      </section>

      <main className={styles.formSide}>
        <div className={styles.formBox}>
          <Image src="/kftc-logo.jpg" alt="금융결제원" width={152} height={48} priority className={styles.logo} />
          <div>
            <h2 className={`${styles.title} ${own.title}`}>
              관리자 로그인 <span className={own.badge}>관리자</span>
            </h2>
            <p className={styles.subtitle}>관리자 권한이 있는 사번과 관리자 비밀번호를 입력하세요</p>
          </div>

          {notice && (
            <p role="status" className={styles.notice}>
              {notice}
            </p>
          )}
          {user && !notice && (
            <p className={styles.notice}>
              직원 화면에 {user.name} {user.rank ?? ""} 계정으로 로그인되어 있어요. 관리자 비밀번호만 입력하세요.
            </p>
          )}

          <AdminLoginForm
            supportContact={contact}
            maxFailedCount={info.max_failed_count}
            next={next}
            knownEmpNo={user?.emp_no ?? null}
          />

          <div className={styles.help}>
            <span className={styles.muted}>관리자 비밀번호 분실·잠금 해제 · {contact}</span>
          </div>

          <aside className={styles.notices} aria-label="안내">
            <p className={styles.noticeEmpty}>
              관리자 비밀번호는 직원 화면 비밀번호와 따로 관리합니다. 로그아웃하면 직원 화면에서도 함께 로그아웃됩니다.
            </p>
            <p className={styles.noticeEmpty}>
              관리자 화면은 {info.admin_idle_minutes}분간 사용하지 않으면 자동 로그아웃됩니다.
            </p>
          </aside>

          <Link href="/login" className={own.back}>
            ← 직원 화면 로그인으로
          </Link>
        </div>
      </main>
    </div>
  );
}
