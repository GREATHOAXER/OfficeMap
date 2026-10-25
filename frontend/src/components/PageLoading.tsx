import styles from "./PageLoading.module.css";

/** 메뉴로 옮겨 갈 때 다음 화면의 데이터를 받는 동안 바로 보이는 자리 (각 화면의 loading.tsx).
 *  머리줄은 실제 화면(직원·관리자 화면 공통: 위아래 12px·좌우 24px, 제목 18px)과 같은 자리에 둬서 내용이 와도 제목이 움직이지 않는다.
 *  같은 화면 안에서 주소의 ?floor=·?date=만 바꾸는 화면(자리 현황·회의실·도면 편집·좌석 배치)에는 두지 않는다:
 *  층·날짜를 바꿀 때마다 화면 전체가 이 자리로 깜빡인다 */
export default function PageLoading({ title, rows = 3 }: { title: string; rows?: number }) {
  return (
    <div role="status">
      <div className={styles.header}>
        <p className={styles.title}>{title}</p>
        <span className="visually-hidden">불러오는 중…</span>
      </div>
      <div className={styles.body} aria-hidden="true">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className={styles.block} />
        ))}
      </div>
    </div>
  );
}
