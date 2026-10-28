import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { fetchLoginInfo, fetchMe } from "@/lib/api";
import { safeNext } from "@/lib/loginRedirect";
import ForgetLoginReason from "./ForgetLoginReason";
import FloorIllustration from "./FloorIllustration";
import LoginForm from "./LoginForm";
import styles from "./login.module.css";
import Logo from "@/components/Logo";

export const metadata: Metadata = { title: "로그인 · Office Map" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const cookieHeader = (await headers()).get("cookie");
  const [user, info, params] = await Promise.all([fetchMe(cookieHeader), fetchLoginInfo(), searchParams]);
  const next = safeNext(params.next, "/");
  if (user) redirect(next);

  const contact = info.support_contact ?? "정보보호팀";
  const back = "다시 로그인하면 보던 화면으로 돌아갑니다.";
  // 왜 로그인 화면으로 왔는지 (lib/loginRedirect.ts LOGOUT_REASONS, 서버 session_end_reason)
  const notices: Record<string, string> = {
    expired: `${info.idle_minutes}분 넘게 사용하지 않아 로그아웃되었습니다. ${back}`,
    max: `로그인한 지 오래되어 로그아웃되었습니다. ${back}`,
    reset: "관리자가 비밀번호를 초기화해서 로그아웃되었습니다. 관리자에게 받은 임시 비밀번호로 로그인하세요.",
    changed: "다른 곳에서 비밀번호를 바꿔서 로그아웃되었습니다. 새 비밀번호로 로그인하세요.",
    locked: `비밀번호를 ${info.max_failed_count}회 잘못 입력해 계정이 잠겼습니다. 잠금 해제 문의: ${contact}`,
    inactive: `로그인할 수 없는 계정이 되어 로그아웃되었습니다. 문의: ${contact}`,
    logout: "로그아웃했습니다.",
  };
  const reason = typeof params.reason === "string" ? params.reason : "";
  const notice = notices[reason] ?? (next !== "/" ? "로그인하면 요청한 화면으로 이동합니다." : null);

  return (
    <div className={styles.page}>
      <section className={styles.intro}>
        <div className={styles.introBody}>
          <h1 className={styles.headline}>
            누가 어디에 앉아 있는지,
            <br />
            지금 찾아가도 되는지.
          </h1>
          <p className={styles.lead}>층별 좌석과 동료의 재실 상태, 회의실 예약을 한 곳에서 확인하세요.</p>
          <FloorIllustration className={styles.illustration} />
        </div>
        <p className={styles.introFoot}>사내망 전용 서비스 · 외부 접속 불가</p>
      </section>

      <main className={styles.formSide}>
        <div className={styles.formBox}>
          <Logo size={36} className={styles.logo} />
          <div>
            <h2 className={styles.title}>로그인</h2>
            <p className={styles.subtitle}>사내 계정으로 로그인하세요</p>
          </div>

          {notice && (
            <p role="status" className={styles.notice}>
              {notice}
            </p>
          )}
          <ForgetLoginReason me="/api/auth/me" />

          <LoginForm
            ssoEnabled={process.env.SSO_ENABLED === "true"}
            supportContact={contact}
            maxFailedCount={info.max_failed_count}
            next={next}
          />

          <aside className={styles.notices} aria-labelledby="notice-heading">
            <strong id="notice-heading" className={styles.noticeHeading}>
              공지
            </strong>
            {info.notices.length > 0 ? (
              <ul className={styles.noticeList}>
                {info.notices.map((notice) => (
                  <li key={notice.id}>{notice.title}</li>
                ))}
              </ul>
            ) : (
              <p className={styles.noticeEmpty}>지금 올라온 공지가 없습니다.</p>
            )}
            <p className={styles.noticeEmpty}>로그인 후 {info.idle_minutes}분간 사용하지 않으면 자동 로그아웃됩니다.</p>
          </aside>
        </div>
      </main>
    </div>
  );
}
