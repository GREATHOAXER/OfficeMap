import Image from "next/image";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ShieldIcon } from "@/components/icons";
import { fetchLoginInfo, fetchMe } from "@/lib/api";
import { safeNext } from "@/lib/loginRedirect";
import FloorIllustration from "./FloorIllustration";
import LoginForm from "./LoginForm";
import styles from "./login.module.css";

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const cookieHeader = (await headers()).get("cookie");
  const [user, info, params] = await Promise.all([fetchMe(cookieHeader), fetchLoginInfo(), searchParams]);
  const next = safeNext(params.next, "/");
  if (user) redirect(next);

  const contact = info.support_contact ?? "정보보호팀";
  const notice =
    params.reason === "expired"
      ? `${info.idle_minutes}분 넘게 사용하지 않아 로그아웃되었습니다. 다시 로그인하면 보던 화면으로 돌아갑니다.`
      : params.reason === "logout"
        ? "로그아웃했습니다. 이 브라우저의 직원 화면과 관리자 페이지 로그인이 모두 끝났습니다."
        : next !== "/"
          ? "로그인하면 요청한 화면으로 이동합니다."
          : null;

  return (
    <div className={styles.page}>
      <section className={styles.intro}>
        <strong className={styles.brand}>오피스 안내</strong>
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
          <Image
            src="/kftc-logo.jpg"
            alt="금융결제원"
            width={152}
            height={48}
            priority
            className={styles.logo}
          />
          <div>
            <h2 className={styles.title}>로그인</h2>
            <p className={styles.subtitle}>사내 계정으로 로그인하세요</p>
          </div>

          {notice && (
            <p role="status" className={styles.notice}>
              {notice}
            </p>
          )}

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
            <p className={styles.noticeEmpty}>
              로그인 후 {info.idle_minutes}분간 사용하지 않으면 자동 로그아웃됩니다.
            </p>
          </aside>

          <Link href="/admin/login" className={styles.adminLink}>
            <ShieldIcon size={18} />
            <span>
              <strong>관리자 페이지</strong>
              <span>관리자 권한이 있는 직원 · 관리자 비밀번호로 따로 로그인</span>
            </span>
            <span aria-hidden="true">→</span>
          </Link>
        </div>
      </main>
    </div>
  );
}
