import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import PendingButton from "@/components/PendingButton";
import { applyModeText, canEditPlan, canManage, canManageSite, LEVELS, PLAN_LABEL, ROLE_TASKS } from "@/lib/admin";
import { type Admin, type AdminFloor, type AdminSite, ApiError, fetchAdmin, fetchAdminOverview } from "@/lib/api";
import { kstDate } from "@/lib/dates";
import styles from "./admin.module.css";

// 아직 화면이 없는 작업 버튼 (누르면 "준비 중" 말풍선)
const Pending = PendingButton;

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

  // 전사 관리자는 전체 숫자, 그 아래 단계는 내 관리 범위 안의 숫자 (재직 직원·관리자 수는 전사만)
  const scoped = summary.scope !== "ALL";
  const stats = [
    ...(scoped
      ? []
      : [
          {
            label: "재직 직원",
            value: `${summary.employees}명`,
            note: summary.unseated ? `자리 없음 ${summary.unseated}명` : "모두 자리 있음",
          },
        ]),
    {
      label: "개인석 배정",
      value: `${summary.occupied}/${summary.seats}`,
      note: `빈 개인석 ${summary.seats - summary.occupied}석`,
    },
    ...(summary.flex > 0 ? [{ label: "자율석", value: `${summary.flex}석`, note: "그날 누구나 (배정 안 함)" }] : []),
    { label: scoped ? "회의실 (맡은 층)" : "회의실", value: `${summary.rooms}개` },
    { label: scoped ? "오늘 예약 (맡은 층)" : "오늘 회의실 예약", value: `${summary.reservations_today}건` },
    {
      label: summary.scope === "ZONES" ? "승인 기다리는 내 요청" : "내가 승인할 요청",
      value: `${summary.pending_requests}건`,
      note: summary.scope === "ZONES" ? "층 관리자가 승인하면 반영" : "구역 관리자가 올린 배치 변경",
    },
    ...(scoped ? [] : [{ label: "관리자", value: `${summary.admins}명` }]),
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
          <span className={styles.muted}>현황은 전체를 보고, 편집은 맡은 범위 안에서만 해요</span>
        </p>

        <p className={styles.readyNote}>
          좌석 배치 편집과 도면 편집이 열렸어요. 점선 버튼(층 추가 · 권한 부여 등)은 다음 단계에서 열려요.
        </p>

        <ul className={styles.stats} aria-label={scoped ? "내 관리 범위 현황" : "전체 현황"}>
          {stats.map((s) => (
            <li key={s.label}>
              <span>{s.label}</span>
              <strong className="mono">{s.value}</strong>
              {s.note && <span className={styles.statNote}>{s.note}</span>}
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
              상위 관리자가 바로 아래 관리자를 지정 · 각자 맡은 범위 안에서만 편집 · 좌석·도면 조회는 직원 화면에서 누구나
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
                      <td data-label="사용자">
                        <strong>{g.employee.name}</strong> {g.employee.rank}
                        {me && <span className={styles.mineTag}>나</span>}
                      </td>
                      <td data-label="부서">{g.employee.department}</td>
                      <td data-label="역할">
                        <span className={styles.chip}>{g.label}</span>
                      </td>
                      <td data-label="관리 범위">{g.scope}</td>
                      <td data-label="가능 작업">{ROLE_TASKS[g.role]}</td>
                      <td data-label="변경 반영">{applyModeText(g)}</td>
                      <td data-label="지정한 사람">{g.granted_by ?? "—"}</td>
                      <td className={styles.actions}>{canManage(admin, g) && <Pending label="편집" />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <p className={styles.foot}>관리자 화면은 {admin.idle_minutes}분간 사용하지 않으면 자동 로그아웃됩니다.</p>
      </div>
    </div>
  );
}

function SiteSection({ site, admin }: { site: AdminSite; admin: Admin }) {
  const seats = site.floors.reduce((n, f) => n + f.seats, 0);
  const occupied = site.floors.reduce((n, f) => n + f.occupied, 0);
  const siteWide = canManageSite(admin, site.id);

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
            개인석 배정{" "}
            <strong className="mono">
              {occupied}/{seats}
            </strong>
          </span>
          <span>
            담당 <strong>{site.admins.join(", ") || "—"}</strong>
          </span>
        </div>
        {siteWide && <Pending label="+ 층 추가" />}
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
                개인석 배정
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
              <FloorRow
                key={floor.id}
                floor={floor}
                siteWide={siteWide}
                editPlan={canEditPlan(admin, { id: floor.id, siteId: site.id })}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** siteWide: 사업장 전체를 맡았다 (모든 층이 내 범위라 층마다 "내 관리" 표시는 하지 않는다)
 *  editPlan: 이 층 도면을 고칠 수 있다 (층 관리자 이상) */
function FloorRow({ floor, siteWide, editPlan }: { floor: AdminFloor; siteWide: boolean; editPlan: boolean }) {
  const admins = floor.floor_admins.join(", ");
  const mark = !siteWide && floor.in_scope;
  return (
    <tr data-scope={mark || undefined}>
      <th scope="row" data-label="층">
        <strong className="mono">{floor.name}</strong>
        {mark && (
          <span className={styles.scopeTag}>{floor.in_scope === "ALL" ? "내 관리" : "내 구역"}</span>
        )}
      </th>
      <td data-label="입주 팀">
        {floor.zones.length > 0 ? (
          floor.zones.map((z) => (
            <span
              key={z.code}
              className={styles.team}
              data-color={z.color_key}
              title={z.department_active ? undefined : "조직도에서 없어진 부서의 구역이에요"}
            >
              {z.name}
              {!z.department_active && " (폐지된 부서)"}
            </span>
          ))
        ) : (
          <span className={styles.muted}>{floor.description ?? "—"} · 팀 구역 없음</span>
        )}
      </td>
      <td data-label="개인석 배정">
        {floor.seats ? <span className="mono">{`${floor.occupied}/${floor.seats}`}</span> : "—"}
        {floor.flex > 0 && <span className={styles.subLine}>자율석 {floor.flex}</span>}
      </td>
      <td data-label="층 관리자">
        {admins || <span className={styles.muted}>미지정</span>}
        {floor.zone_admins > 0 && <span className={styles.subLine}>구역 관리자 {floor.zone_admins}명</span>}
      </td>
      <td data-label="도면">
        <span className={styles.plan} data-plan={floor.plan}>
          <i aria-hidden="true" />
          {PLAN_LABEL[floor.plan]}
        </span>
      </td>
      <td data-label="최종 수정" className={`mono ${styles.updated}`}>
        {floor.plan_updated_at ? `${kstDate(floor.plan_updated_at).slice(5)} ${floor.plan_updated_by ?? ""}` : "—"}
      </td>
      <td className={styles.actions}>
        <div className={styles.actionRow}>
          {floor.in_scope ? (
            <>
              {editPlan && (
                <Link href={`/admin/plans?floor=${floor.id}`} className={styles.btn}>
                  도면 관리
                </Link>
              )}
              {floor.seats + floor.flex > 0 ? (
                <Link href={`/admin/seating?floor=${floor.id}`} className={`${styles.btn} ${styles.pri}`}>
                  {floor.in_scope === "ALL" ? "배치 편집" : "내 구역 배치"}
                </Link>
              ) : (
                <span className={styles.muted}>좌석 없음</span>
              )}
            </>
          ) : (
            <span className={styles.muted}>조회만</span>
          )}
        </div>
      </td>
    </tr>
  );
}
