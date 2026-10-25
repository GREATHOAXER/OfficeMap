import styles from "./PageLoading.module.css";

/** 메뉴로 옮겨 갈 때 다음 화면의 데이터를 받는 동안 바로 보이는 자리 (각 화면의 loading.tsx).
 *  같은 화면 안에서 주소의 ?floor=·?date=만 바꾸는 화면(자리 현황·회의실·도면 편집·좌석 배치)에는 두지 않는다:
 *  층·날짜를 바꿀 때마다 화면 전체가 이 자리로 깜빡인다 */
export default function PageLoading({ title, rows = 3 }: { title: string; rows?: number }) {
  return (
    <div className={styles.wrap} role="status">
      <p className={styles.title}>{title}</p>
      <span className="visually-hidden">불러오는 중…</span>
      <div className={styles.head} aria-hidden="true" />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={styles.block} aria-hidden="true" />
      ))}
    </div>
  );
}
