import Image from "next/image";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { fetchLoginInfo, fetchMe } from "@/lib/api";
import FloorIllustration from "./FloorIllustration";
import LoginForm from "./LoginForm";
import styles from "./login.module.css";

export default async function LoginPage() {
  const cookieHeader = (await headers()).get("cookie");
  const [user, info] = await Promise.all([fetchMe(cookieHeader), fetchLoginInfo()]);
  if (user) redirect("/");

  const contact = info.support_contact ?? "정보보호팀";

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
          <p className={styles.lead}>
            서울 본사와 분당 센터의 층별 좌석과 동료의 재실 상태를 한 곳에서 확인하세요.
          </p>
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

          <LoginForm
            ssoEnabled={process.env.SSO_ENABLED === "true"}
            supportContact={contact}
            maxFailedCount={info.max_failed_count}
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
        </div>
      </main>
    </div>
  );
}
