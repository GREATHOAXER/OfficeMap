import type { Admin, AdminGrant, AdminRole, PlanState } from "./api";

// 관리자 권한 체계 (디자인 ④ 사업장·층·권한). 숫자가 작을수록 넓은 범위. 최종 관리자(admin)는 1~4단계 위에 있다
export const LEVELS: { level: number; role: AdminRole; name: string; scope: string; tasks: string }[] = [
  {
    level: 0,
    role: "SUPER_ADMIN",
    name: "최종 관리자",
    scope: "전체 (시스템 계정)",
    tasks: "1~4단계 관리자 지정·편집, 모든 관리 작업",
  },
  {
    level: 1,
    role: "COMPANY_ADMIN",
    name: "전사 관리자",
    scope: "전체 사업장",
    tasks: "사업장·층 생성, 조직도, 2~4단계 관리자 지정",
  },
  {
    level: 2,
    role: "SITE_ADMIN",
    name: "사업장 관리자",
    scope: "사업장 한 곳",
    tasks: "층 추가, 도면 편집, 회의실 등록, 층·구역 관리자 지정",
  },
  {
    level: 3,
    role: "FLOOR_ADMIN",
    name: "층 관리자",
    scope: "한 개 층",
    tasks: "도면 편집·게시, 팀 구역 지정·조정, 층 전체 배치(구역 관리자 일도 대신), 구역 관리자 지정, 하위 요청 승인",
  },
  {
    level: 4,
    role: "ZONE_ADMIN",
    name: "구역(팀) 관리자",
    scope: "내 팀 구역",
    tasks: "구역 안 좌석 배정·교환·해제. 반영 방식은 층마다 선택: 즉시 반영 / 층 관리자 승인 후",
  },
];

/** 관리자 목록의 "가능 작업" */
export const ROLE_TASKS: Record<AdminRole, string> = {
  SUPER_ADMIN: "전체 + 1~4단계 권한",
  COMPANY_ADMIN: "전체 + 권한 부여",
  SITE_ADMIN: "도면 · 회의실 · 배치",
  FLOOR_ADMIN: "도면 · 팀 구역 · 층 배치 · 요청 승인",
  ZONE_ADMIN: "구역 안 배치",
};

export const PLAN_LABEL: Record<PlanState, string> = {
  PUBLISHED: "작성 완료",
  EDITING: "수정 중",
  SCHEDULED: "게시 예약",
  DRAFT: "초안",
  NONE: "미작성",
};

/** 변경 반영: 구역 관리자만 층마다 고른다. 나머지는 바로 반영 */
export const applyModeText = (g: AdminGrant) =>
  g.role !== "ZONE_ADMIN" ? "즉시" : g.apply_mode === "NEEDS_APPROVAL" ? "층 관리자 승인 후" : "즉시";

/** 모든 사업장을 맡았나: 최종 관리자, 전사 관리자 (사업장·층 추가, 조직도) */
export const isCompanyWide = (admin: Admin) =>
  admin.grants.some((g) => g.role === "SUPER_ADMIN" || g.role === "COMPANY_ADMIN");

/** 이 사업장에 층을 더하거나 뺄 수 있나: 최종·전사 관리자, 그 사업장 관리자 */
export const canManageSite = (admin: Admin, siteId: number) =>
  isCompanyWide(admin) || admin.grants.some((g) => g.role === "SITE_ADMIN" && g.site_id === siteId);

/** 이 층의 도면을 고치고 게시할 수 있나: 층 관리자 이상 (구역 관리자는 보기만) */
export const canEditPlan = (admin: Admin, floor: { id: number; siteId: number }) =>
  canManageSite(admin, floor.siteId) || admin.grants.some((g) => g.role === "FLOOR_ADMIN" && g.floor_id === floor.id);

/** 도면 편집 메뉴를 보여 줄까: 어느 층이든 층 관리자 이상 */
export const hasPlanRole = (admin: Admin) => admin.grants.some((g) => g.role !== "ZONE_ADMIN");

/** 이 권한을 내가 주거나 고치거나 회수할 수 있나: 내 범위 안의 더 아래 단계 관리자 (서버 admin_auth.can_manage와 같다).
 *  최종 관리자는 1~4단계, 전사 관리자는 2~4단계, 사업장 관리자는 그 사업장의 층·구역, 층 관리자는 그 층의 구역 관리자 */
export function canManage(
  admin: Admin,
  target: { level: number; site_id: number | null; floor_id: number | null },
): boolean {
  if (target.level === 0) return false;
  return admin.grants.some((g) => {
    if (g.level >= target.level) return false;
    if (g.role === "SUPER_ADMIN" || g.role === "COMPANY_ADMIN") return true;
    if (g.role === "SITE_ADMIN") return g.site_id === target.site_id;
    return g.role === "FLOOR_ADMIN" && g.floor_id === target.floor_id;
  });
}

/** 권한을 줄 수 있는 관리자인가 (구역 관리자만 맡았으면 줄 권한이 없다) */
export const canGrant = (admin: Admin) => admin.grants.some((g) => g.role !== "ZONE_ADMIN");
