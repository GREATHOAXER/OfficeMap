import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { applyModeText, canEditPlan, canManage, LEVELS, PLAN_LABEL, ROLE_TASKS } from "@/lib/admin";
import { type Admin, type AdminFloor, type AdminSite, ApiError, fetchAdmin, fetchAdminOverview } from "@/lib/api";
import { kstDate } from "@/lib/dates";
import styles from "./admin.module.css";

// 아직 화면이 없는 작업 버튼. 눌리지 않고, 마우스를 올리면 준비 중이라고 알려 준다
function Pending({ label, primary = false }: { label: string; primary?: boolean }) {
  return (
    <button
      type="button"
      className={`${styles.btn} ${primary ? styles.pri : ""}`}
      disabled
      title={`${label} · 준비 중`}
      aria-label={`${label} (준비 중)`}
    >
      {label}
    </button>
  );
}

/** 관리자 첫 화면 (디자인 ④ 사업장·층·권한): 사업장별 층 현황, 관리자 권한 체계와 관리자 목록 */
export default async function AdminHomePage() {
  const cookieHeader = (await headers()).get("cookie");
  let data;
  try {
    const [admin, overview] = await Promise.all([fetchAdmin(cookieHeader), fetchAdminOverview(cookieHeader)]);
    if (!admin) redirect("/admin/login?reason=expired");
    data = { admin, overview };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/admin/login?reason=expired");
    throw error;
  }
  const { admin, overview } = data;
  const { summary } = overview;
  const isCompany = admin.role === "COMPANY_ADMIN";

  const stats = [
    { label: "재직 직원", value: `${summary.employees}명` },
    { label: "좌석 배정", value: `${summary.occupied}/${summary.seats}` },
    { label: "회의실", value: `${summary.rooms}개` },
    { label: "오늘 회의실 예약", value: `${summary.reservations_today}건` },
    { label: "처리 대기 요청", value: `${summary.pending_requests}건` },
    { label: "관리자", value: `${summary.admins}명` },
  ];

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>사업장·층·권한 관리</h1>
          <span className={styles.roleBadge}>{admin.role_label}</span>
        </div>
        {isCompany && (
          <div className={styles.headerActions}>
            <Pending label="조직도 동기화" />
            <Pending label="사업장 추가" primary />
          </div>
        )}
      </header>

      <div className={styles.main}>
        <p className={styles.myScope}>
          <strong>내 관리 범위</strong>
          {admin.grants.map((g) => (
            <span key={g.id}>
              {g.label} · {g.scope}
            </span>
          ))}
          <span className={styles.muted}>조회는 전체 · 편집은 맡은 범위 안에서만</span>
        </p>

        <ul className={styles.stats} aria-label="전체 현황">
          {stats.map((s) => (
            <li key={s.label}>
              <span>{s.label}</span>
              <strong className="mono">{s.value}</strong>
            </li>
          ))}
        </ul>

        {overview.sites.map((site) => (
          <SiteSection key={site.id} site={site} admin={admin} />
        ))}

        <section className={styles.section} aria-labelledby="levels-title">
          <div className={styles.sectionHead}>
            <h2 id="levels-title">관리자 권한 체계</h2>
            <span className={styles.muted}>
              상위 관리자가 바로 아래 관리자를 지정 · 각자 맡은 범위 안에서만 편집 · 조회는 전 직원 가능
            </span>
            {admin.role !== "ZONE_ADMIN" && (
              <span className={styles.sectionAction}>
                <Pending label="권한 부여" primary />
              </span>
            )}
          </div>
          <ol className={styles.levels}>
            {LEVELS.map((l) => {
              const mine = admin.grants.some((g) => g.role === l.role);
              return (
                <li key={l.level} data-mine={mine || undefined}>
                  <span className="mono">
                    LEVEL {l.level}
                    {mine && <span className={styles.mineTag}>내 권한</span>}
                  </span>
                  <strong>{l.name}</strong>
                  <span>범위: {l.scope}</span>
                  <span className={styles.muted}>{l.tasks}</span>
                </li>
              );
            })}
          </ol>

          <div className={styles.tableCard}>
            <table className={styles.table}>
              <caption className="visually-hidden">관리자 목록</caption>
              <thead>
                <tr>
                  <th scope="col">사용자</th>
                  <th scope="col">부서</th>
                  <th scope="col">역할</th>
                  <th scope="col">관리 범위</th>
                  <th scope="col">가능 작업</th>
                  <th scope="col">변경 반영</th>
                  <th scope="col">지정한 사람</th>
                  <th scope="col">
                    <span className="visually-hidden">편집</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {overview.grants.map((g) => {
                  const me = g.employee.emp_no === admin.emp_no;
                  return (
                    <tr key={g.id} data-me={me || undefined}>
                      <td>
                        <strong>{g.employee.name}</strong> {g.employee.rank}
                        {me && <span className={styles.mineTag}>나</span>}
                      </td>
                      <td>{g.employee.department}</td>
                      <td>
                        <span className={styles.chip}>{g.label}</span>
                      </td>
                      <td>{g.scope}</td>
                      <td>{ROLE_TASKS[g.role]}</td>
                      <td>{applyModeText(g)}</td>
                      <td>{g.granted_by ?? "—"}</td>
                      <td className={styles.actions}>{canManage(admin, g) && <Pending label="편집" />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <p className={styles.foot}>
          관리자 화면은 {admin.idle_minutes}분간 사용하지 않으면 자동 로그아웃됩니다. 좌석 배치 편집 · 도면 편집 · 권한
          부여는 다음 단계에서 연결합니다.
        </p>
      </div>
    </div>
  );
}

function SiteSection({ site, admin }: { site: AdminSite; admin: Admin }) {
  const seats = site.floors.reduce((n, f) => n + f.seats, 0);
  const occupied = site.floors.reduce((n, f) => n + f.occupied, 0);
  const editPlan = canEditPlan(admin, site.id);

  return (
    <section className={styles.site} aria-labelledby={`site-${site.id}`}>
      <div className={styles.siteHead}>
        <span className={styles.chip}>{site.kind}</span>
        <h2 id={`site-${site.id}`}>{site.name}</h2>
        {site.address && <span className={styles.muted}>{site.address}</span>}
        <div className={styles.siteMeta}>
          <span>
            층 <strong className="mono">{site.floors.length}</strong>
          </span>
          <span>
            좌석 배정{" "}
            <strong className="mono">
              {occupied}/{seats}
            </strong>
          </span>
          <span>
            담당 <strong>{site.admins.join(", ") || "—"}</strong>
          </span>
        </div>
        {editPlan && <Pending label="+ 층 추가" />}
      </div>
      <div className={styles.tableScroll}>
        <table className={styles.table}>
          <caption className="visually-hidden">{site.name} 층별 현황</caption>
          <thead>
            <tr>
              <th scope="col" className={styles.colFloor}>
                층
              </th>
              <th scope="col">입주 부서 · 팀 (도면 색상)</th>
              <th scope="col" className={styles.colSeats}>
                좌석 배정
              </th>
              <th scope="col" className={styles.colAdmin}>
                층 관리자
              </th>
              <th scope="col" className={styles.colPlan}>
                도면
              </th>
              <th scope="col" className={styles.colUpdated}>
                최종 수정
              </th>
              <th scope="col" className={styles.colActions}>
                <span className="visually-hidden">작업</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {site.floors.map((floor) => (
              <FloorRow key={floor.id} floor={floor} editPlan={editPlan} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** editPlan: 사업장 전체를 맡았다 (모든 층이 내 범위라 층마다 "내 관리" 표시는 하지 않는다) */
function FloorRow({ floor, editPlan }: { floor: AdminFloor; editPlan: boolean }) {
  const admins = floor.floor_admins.join(", ");
  const mark = !editPlan && floor.in_scope;
  return (
    <tr data-scope={mark || undefined}>
      <th scope="row">
        <strong className="mono">{floor.name}</strong>
        {mark && (
          <span className={styles.scopeTag}>{floor.in_scope === "ALL" ? "내 관리" : "내 구역"}</span>
        )}
      </th>
      <td>
        {floor.zones.length > 0 ? (
          floor.zones.map((z) => (
            <span key={z.code} className={styles.team} data-color={z.color_key}>
              {z.name}
            </span>
          ))
        ) : (
          <span className={styles.muted}>{floor.description ?? "—"} · 팀 구역 없음</span>
        )}
      </td>
      <td className="mono">{floor.seats ? `${floor.occupied}/${floor.seats}` : "—"}</td>
      <td>
        {admins || <span className={styles.muted}>미지정</span>}
        {floor.zone_admins > 0 && <span className={styles.muted}> 외 구역 {floor.zone_admins}</span>}
      </td>
      <td>
        <span className={styles.plan} data-plan={floor.plan}>
          <i aria-hidden="true" />
          {PLAN_LABEL[floor.plan]}
        </span>
      </td>
      <td className={`mono ${styles.updated}`}>
        {floor.plan_updated_at ? `${kstDate(floor.plan_updated_at).slice(5)} ${floor.plan_updated_by ?? ""}` : "—"}
      </td>
      <td className={styles.actions}>
        {floor.in_scope ? (
          <>
            {editPlan && <Pending label="도면 관리" />}
            <Pending label={floor.in_scope === "ALL" ? "배치 편집" : "내 구역 배치"} primary />
          </>
        ) : (
          <span className={styles.muted}>조회만</span>
        )}
      </td>
    </tr>
  );
}
