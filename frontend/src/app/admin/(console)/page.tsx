import { headers } from "next/headers";
import type { ReactNode } from "react";
import Link from "next/link";
import {
  applyModeText,
  canEditPlan,
  canGrant,
  canManage,
  canManageSite,
  isCompanyWide,
  LEVELS,
  PLAN_LABEL,
  ROLE_TASKS,
} from "@/lib/admin";
import {
  type Admin,
  type AdminFloor,
  type AdminGrant,
  type AdminOverview,
  type AdminSite,
  ApiError,
  fetchAdmin,
  fetchAdminOverview,
  fetchApprovals,
} from "@/lib/api";
import { kstDate, shortDate } from "@/lib/dates";
import { redirectToAdminLogin } from "@/lib/expiredRedirect";
import ApprovalInbox from "./ApprovalInbox";
import { GrantButton, GrantEditButton, type GrantPreset } from "./GrantActions";
import { FloorButton, SiteButton } from "./SiteActions";
import SiteFold from "./SiteFold";
import styles from "./admin.module.css";
import { zoneColorVars } from "@/lib/zoneColors";

/** 관리자 첫 화면 (디자인 ④ 사업장·층·권한): 사업장별 층 현황, 관리자 권한 체계와 관리자 목록 */
export default async function AdminHomePage() {
  const cookieHeader = (await headers()).get("cookie");
  let data;
  try {
    const [admin, overview, approvals] = await Promise.all([
      fetchAdmin(cookieHeader),
      fetchAdminOverview(cookieHeader),
      fetchApprovals(cookieHeader),
    ]);
    if (!admin) return redirectToAdminLogin();
    data = { admin, overview, approvals: approvals.requests };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return redirectToAdminLogin();
    throw error;
  }
  const { admin, overview, approvals } = data;
  const { summary } = overview;
  // 최종·전사 관리자: 사업장·층 추가와 조직도
  const isCompany = isCompanyWide(admin);
  // 층 관리자 이상: 구역 관리자가 올린 요청을 승인·반려한다 (구역 관리자는 내 요청이 있을 때만 승인함이 보인다)
  const reviewer = admin.grants.some((g) => g.role !== "ZONE_ADMIN");

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
      // 사용 중지(고장·수리) 자리는 빈 자리가 아니다 (좌석 수에서도 빠져 있다)
      note: `빈 개인석 ${summary.seats - summary.occupied}석${
        summary.out_of_service ? ` · 사용 중지 ${summary.out_of_service}석` : ""
      }`,
    },
    ...(summary.flex > 0 ? [{ label: "자율석", value: `${summary.flex}석`, note: "그날 누구나 (배정 안 함)" }] : []),
    { label: scoped ? "회의실 (맡은 층)" : "회의실", value: `${summary.rooms}개` },
    { label: scoped ? "오늘 예약 (맡은 층)" : "오늘 회의실 예약", value: `${summary.reservations_today}건` },
    {
      label: summary.scope === "ZONES" ? "승인 기다리는 내 요청" : "내가 승인할 요청",
      value: `${summary.pending_requests}건`,
      note: summary.scope === "ZONES" ? "층 관리자가 승인하면 반영" : "구역 관리자가 올린 배치 변경",
      href: reviewer || approvals.length > 0 ? "#approvals" : undefined,
    },
    ...(scoped ? [] : [{ label: "관리자", value: `${summary.admins}명` }]),
  ];

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>사업장·층·권한 관리</h1>
          <span className={styles.roleBadge}>{admin.role_label}</span>
        </div>
        {isCompany && (
          <div className={styles.headerActions}>
            <Link href="/admin/org" className={styles.btn}>
              조직도 관리
            </Link>
            <Link href="/admin/personnel" className={styles.btn}>
              인사이동
            </Link>
            <SiteButton />
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
          <span className={styles.muted}>
            {isCompany ? "모든 사업장을 보고 관리해요" : "맡은 사업장·층만 보이고, 그 안에서만 편집해요"}
          </span>
        </p>

        {admin.role === "SUPER_ADMIN" && (
          <p className={styles.readyNote}>
            최종 관리자(admin)로 들어왔어요. 1~4단계 관리자를 지정·편집하고 모든 관리 작업을 할 수 있어요. 처음
            비밀번호를 쓰고 있다면 왼쪽 아래 계정 메뉴의 &ldquo;관리자 비밀번호 변경&rdquo;으로 바꿔 두세요.
          </p>
        )}

        <ul className={styles.stats} aria-label={scoped ? "내 관리 범위 현황" : "전체 현황"}>
          {stats.map((s) => (
            <li key={s.label}>
              <span>{s.label}</span>
              <strong className="mono">{s.value}</strong>
              {s.note && <span className={styles.statNote}>{s.note}</span>}
              {"href" in s && s.href && (
                <a className={styles.statLink} href={s.href}>
                  승인함 보기 ↓
                </a>
              )}
            </li>
          ))}
        </ul>

        {(reviewer || approvals.length > 0) && <ApprovalInbox requests={approvals} reviewer={reviewer} />}

        {overview.unseated_teams.length > 0 && <UnseatedNotice teams={overview.unseated_teams} />}

        {/* 사업장이 여럿이면 접어 두고, 사업장 이름을 누르면 그 사업장의 층이 펼쳐진다 */}
        {overview.sites.map((site) => (
          <SiteSection
            key={site.id}
            site={site}
            admin={admin}
            isCompany={isCompany}
            defaultOpen={overview.sites.length === 1}
            acting={overview.acting_floor_admin}
          />
        ))}

        <section className={styles.section} aria-labelledby="levels-title">
          <div className={styles.sectionHead}>
            <h2 id="levels-title">관리자 권한 체계</h2>
            <span className={styles.muted}>
              상위 관리자가 맡은 범위 안의 아래 단계 관리자를 지정·편집 · 각자 맡은 범위 안에서만 편집 · 좌석·도면
              조회는 직원 화면에서 누구나
            </span>
            {canGrant(admin) && (
              <span className={styles.sectionAction}>
                <GrantButton />
              </span>
            )}
          </div>
          <ol className={styles.levels}>
            {LEVELS.map((l) => {
              const mine = admin.grants.some((g) => g.role === l.role);
              return (
                <li key={l.level} data-mine={mine || undefined}>
                  <span className="mono">
                    {l.level === 0 ? "최종" : `LEVEL ${l.level}`}
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
                        {g.account.locked && (
                          <span className={styles.accountTag} data-tone="danger">
                            잠김
                          </span>
                        )}
                        {g.account.temporary_password && <span className={styles.accountTag}>첫 로그인 전</span>}
                      </td>
                      <td data-label="부서">{g.employee.department ?? "—"}</td>
                      <td data-label="역할">
                        <span className={styles.chip}>{g.label}</span>
                      </td>
                      <td data-label="관리 범위">{g.scope}</td>
                      <td data-label="가능 작업">{ROLE_TASKS[g.role]}</td>
                      <td data-label="변경 반영">{applyModeText(g)}</td>
                      <td data-label="지정한 사람">{g.granted_by ?? "—"}</td>
                      <td className={styles.actions}>
                        {canManage(admin, g) && (
                          <GrantEditButton grant={g} canReset={canResetPassword(admin, g, overview.grants)} />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <p className={styles.foot}>관리자 화면은 {admin.idle_minutes}분간 사용하지 않으면 자동 로그아웃됩니다.</p>
      </div>
    </main>
  );
}

/** 미배치 인원 알림: 인사이동·신규 입사로 자리가 없는 사람이 어느 팀(층)에 몇 명인지. 그 층 좌석 배치 편집으로 바로 간다 */
function UnseatedNotice({ teams }: { teams: AdminOverview["unseated_teams"] }) {
  const total = teams.reduce((n, t) => n + t.people, 0);
  return (
    <section className={styles.unseated} aria-labelledby="unseated-title">
      <div className={styles.sectionHead}>
        <h2 id="unseated-title">
          미배치 인원 <span className={styles.unseatedCount}>{total}명</span>
        </h2>
        <span className={styles.muted}>
          재직 중인데 자리가 없는 사람이에요 (인사이동·신규 입사). 좌석 배치 편집의 &ldquo;미배치 인원&rdquo;에서
          자리를 정해 주세요
        </span>
      </div>
      <ul className={styles.unseatedList}>
        {teams.map((t) => (
          <li key={t.department}>
            <span className={styles.unseatedTeam}>
              <strong>{t.department}</strong> <span className="mono">{t.people}명</span>
            </span>
            {t.floors.length > 0 ? (
              <span className={styles.unseatedActions}>
                {t.floors.map((f) => (
                  <Link key={f.id} href={`/admin/seating?floor=${f.id}`} className={styles.btn}>
                    {f.label} 배치 편집
                  </Link>
                ))}
              </span>
            ) : (
              <span className={styles.muted}>팀 구역이 아직 없어요 · 좌석 배치 편집에서 팀 구역을 먼저 만들어요</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** 그 사람의 관리자 비밀번호를 초기화할 수 있나: 그 사람의 권한을 모두 내가 다룰 수 있을 때 (서버와 같은 규칙) */
function canResetPassword(admin: Admin, target: AdminGrant, all: AdminGrant[]) {
  if (target.employee.emp_no === admin.emp_no) return false;
  return all.filter((g) => g.employee_id === target.employee_id).every((g) => canManage(admin, g));
}

/** 이 층에서 "+ 지정"으로 바로 줄 수 있는 권한: 층 관리자(사업장 관리자 이상), 아니면 구역 관리자(층 관리자) */
function floorPreset(admin: Admin, siteId: number, floor: AdminFloor): GrantPreset | null {
  const scope = { site_id: siteId, floor_id: floor.id };
  if (canManage(admin, { level: 3, ...scope })) return { role: "FLOOR_ADMIN", siteId, floorId: floor.id };
  if (floor.zones.length > 0 && canManage(admin, { level: 4, ...scope }))
    return { role: "ZONE_ADMIN", siteId, floorId: floor.id };
  return null;
}

function SiteSection({
  site,
  admin,
  isCompany,
  defaultOpen,
  acting,
}: {
  site: AdminSite;
  admin: Admin;
  isCompany: boolean;
  defaultOpen: boolean;
  acting: AdminOverview["acting_floor_admin"];
}) {
  const seats = site.floors.reduce((n, f) => n + f.seats, 0);
  const occupied = site.floors.reduce((n, f) => n + f.occupied, 0);
  const siteWide = canManageSite(admin, site.id);

  return (
    <SiteFold
      id={`site-${site.id}`}
      className={styles.site}
      headClassName={styles.siteHead}
      defaultOpen={defaultOpen}
      title={site.name}
      head={
        <>
          <span className={styles.chip}>{site.kind}</span>
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
          {(siteWide || isCompany) && (
            <div className={styles.siteActions}>
              {isCompany && <SiteButton site={site} />}
              {siteWide && <FloorButton siteId={site.id} floors={site.floors} />}
            </div>
          )}
        </>
      }
    >
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
            {site.floors.length === 0 && (
              <tr>
                <td colSpan={7} className={styles.muted}>
                  아직 층이 없어요{siteWide ? " · 위의 “+ 층 추가”로 만들어요" : ""}
                </td>
              </tr>
            )}
            {site.floors.map((floor) => (
              <FloorRow
                key={floor.id}
                floor={floor}
                preset={floorPreset(admin, site.id, floor)}
                siteWide={siteWide}
                acting={acting}
                editPlan={canEditPlan(admin, { id: floor.id, siteId: site.id })}
                edit={siteWide ? <FloorButton siteId={site.id} floors={site.floors} floor={floor} /> : null}
              />
            ))}
          </tbody>
        </table>
      </div>
    </SiteFold>
  );
}

/** siteWide: 사업장 전체를 맡았다 (모든 층이 내 범위라 층마다 "내 관리" 표시는 하지 않는다)
 *  editPlan: 이 층 도면을 고칠 수 있다 (층 관리자 이상) */
function FloorRow({
  floor,
  preset,
  siteWide,
  acting,
  editPlan,
  edit,
}: {
  floor: AdminFloor;
  /** "+ 지정"으로 바로 줄 권한 (내가 줄 수 없으면 null) */
  preset: GrantPreset | null;
  siteWide: boolean;
  /** 층 관리자가 없을 때 임시로 맡는 최고 단계 관리자 */
  acting: AdminOverview["acting_floor_admin"];
  editPlan: boolean;
  /** 층 고치기 (사업장 관리자 이상) */
  edit: ReactNode;
}) {
  const admins = floor.floor_admins.join(", ");
  const mark = !siteWide && floor.in_scope;
  return (
    <tr data-scope={mark || undefined}>
      <th scope="row" data-label="층">
        <strong className="mono">{floor.name}</strong>
        {mark && <span className={styles.scopeTag}>{floor.in_scope === "ALL" ? "내 관리" : "내 구역"}</span>}
      </th>
      <td data-label="입주 팀">
        {floor.zones.length > 0 ? (
          floor.zones.map((z) => (
            <span
              key={z.code}
              className={styles.team}
              data-color={z.color_key}
              style={zoneColorVars(z.color_key)}
              title={z.department_active ? undefined : "조직도에서 없어진 부서의 구역이에요"}
            >
              {z.name}
              {!z.department_active && " (폐지된 부서)"}
            </span>
          ))
        ) : (
          <span className={styles.muted}>
            {floor.description ? `${floor.description} · ` : ""}팀 구역 없음
          </span>
        )}
      </td>
      <td data-label="개인석 배정">
        {floor.seats ? <span className="mono">{`${floor.occupied}/${floor.seats}`}</span> : "—"}
        {floor.flex > 0 && <span className={styles.subLine}>자율석 {floor.flex}</span>}
        {floor.out_of_service > 0 && <span className={styles.subLine}>사용 중지 {floor.out_of_service}</span>}
      </td>
      <td data-label="층 관리자">
        {admins ||
          (acting ? (
            <span title="층 관리자를 정하기 전까지 최고 단계 관리자가 맡아요">
              {acting.name}
              <span className={styles.actingTag}>임시 · {acting.role_label}</span>
            </span>
          ) : (
            <span className={styles.muted}>미지정</span>
          ))}
        {floor.zone_admins > 0 ? (
          <span className={styles.subLine}>구역 관리자 {floor.zone_admins}명</span>
        ) : (
          floor.zones.length > 0 && (
            <span className={styles.subLine}>
              구역 관리자 없음{floor.floor_admins.length > 0 ? " · 층 관리자가 맡음" : ""}
            </span>
          )
        )}
        {preset && (
          <GrantButton
            preset={preset}
            label={preset.role === "FLOOR_ADMIN" ? "+ 층 관리자 지정" : "+ 구역 관리자 지정"}
          />
        )}
      </td>
      <td data-label="도면">
        <span className={styles.plan} data-plan={floor.plan}>
          <i aria-hidden="true" />
          {PLAN_LABEL[floor.plan]}
          {floor.plan_scheduled_at && ` ${shortDate(floor.plan_scheduled_at)}`}
        </span>
      </td>
      <td data-label="최종 수정" className={`mono ${styles.updated}`}>
        {floor.plan_updated_at ? `${kstDate(floor.plan_updated_at).slice(5)} ${floor.plan_updated_by ?? ""}` : "—"}
      </td>
      <td className={styles.actions}>
        <div className={styles.actionRow}>
          {edit}
          {floor.in_scope ? (
            <>
              {editPlan && (
                <Link href={`/admin/plans?floor=${floor.id}`} className={styles.btn}>
                  도면 관리
                </Link>
              )}
              {floor.seats + floor.flex + floor.out_of_service > 0 ? (
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
