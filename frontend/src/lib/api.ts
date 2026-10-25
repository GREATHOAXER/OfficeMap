import { cache } from "react";
import { type LogoutReason, toLogoutReason } from "./loginRedirect";

// 서버 컴포넌트에서 FastAPI를 직접 부를 때 쓰는 함수들.
// 브라우저(클라이언트 컴포넌트)에서는 상대 경로 /api/... 를 쓴다 (next.config.ts 참고)

export const API_URL = process.env.API_URL ?? "http://localhost:8000";

/** 직원 화면 세션 쿠키 이름 (server/app/config.py 의 session_cookie_name 과 같아야 한다) */
export const SESSION_COOKIE = "officemap_session";

export type User = {
  emp_no: string;
  name: string;
  rank: string | null;
  department: string;
  role: "USER" | "ADMIN";
  must_change_password: boolean;
  display_name: string | null; // 내 정보의 부르는 이름
  photo: string | null; // 내 정보의 사진 주소
};

/** 내 정보에서 고치는 것: 사진·부르는 이름(영문·별칭)·한 줄 소개·하는 일·업무 키워드. 다른 사람에게도 보인다 */
export type PublicProfile = {
  photo: string | null;
  display_name: string | null;
  headline: string | null;
  duties: string | null;
  skills: string[];
};

/** 내 정보 화면: 인사 정보(바꾸지 않음) + 내가 고치는 것 */
export type MyProfile = PublicProfile & {
  emp_no: string;
  name: string;
  rank: string | null;
  position: string | null;
  department: string;
  division: string | null;
  email: string | null;
  extension: string | null;
  updated_at: string | null;
};

export type LoginInfo = {
  notices: { id: number; title: string }[];
  support_contact: string | null;
  idle_minutes: number;
  admin_idle_minutes: number;
  max_failed_count: number;
};

const DEFAULT_LOGIN_INFO: LoginInfo = {
  notices: [],
  support_contact: null,
  idle_minutes: 30,
  admin_idle_minutes: 15,
  max_failed_count: 5,
};

/** 쿠키로 로그인한 사람과, 로그인이 끊겼으면 그 이유. 레이아웃과 페이지가 같은 요청 안에서 한 번만 부르도록 cache로 감싼다 */
const fetchSession = cache(
  async (cookieHeader: string | null): Promise<{ user: User | null; reason: LogoutReason | null }> => {
    if (!cookieHeader) return { user: null, reason: null };
    try {
      const res = await fetch(`${API_URL}/api/auth/me`, {
        headers: { cookie: cookieHeader },
        cache: "no-store",
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) return { user: body.user as User, reason: null };
      return { user: null, reason: res.status === 401 && body.reason ? toLogoutReason(body.reason) : null };
    } catch {
      return { user: null, reason: null };
    }
  },
);

/** 쿠키로 로그인한 사람을 확인한다. 로그인 안 했거나 API가 꺼져 있으면 null */
export const fetchMe = async (cookieHeader: string | null) => (await fetchSession(cookieHeader)).user;

/** 로그인 쿠키가 남아 있는데 로그인이 안 될 때, 왜 끊겼는지 (모르면 null) */
export const fetchLogoutReason = async (cookieHeader: string | null) => (await fetchSession(cookieHeader)).reason;

/** 로그인 화면의 공지·문의처. API가 꺼져 있어도 화면은 기본값으로 뜬다 */
export async function fetchLoginInfo(): Promise<LoginInfo> {
  try {
    const res = await fetch(`${API_URL}/api/auth/login-info`, { cache: "no-store" });
    if (!res.ok) return DEFAULT_LOGIN_INFO;
    return { ...DEFAULT_LOGIN_INFO, ...(await res.json()) };
  } catch {
    return DEFAULT_LOGIN_INFO;
  }
}

// 자리·재실 현황 ----------------------------------------------------------------

export type PresenceStatus = "AVAILABLE" | "DO_NOT_DISTURB" | "IN_MEETING" | "AWAY";

/** 도면 위 영역. 모두 도면 너비·높이 대비 비율(0~1) */
export type Rect = { x: number; y: number; w: number; h: number };

export type FloorSummary = {
  id: number;
  name: string;
  description: string | null; // 사무실이 아닌 층의 용도 (로비, 대강당 …)
  teams: string[];
  has_plan: boolean; // 게시된 도면이 있다
};
export type SiteSummary = { id: number; name: string; floors: FloorSummary[] };
/** my_floor_id: 내 자리가 있는 층. team_floor_id: 우리 팀 구역이 있는 층 (자리가 아직 없는 사람에게 먼저 보여 준다) */
export type SitesResponse = { sites: SiteSummary[]; my_floor_id: number | null; team_floor_id: number | null };

/** 도면 요소 모양: 선 굵기(도면 폭 대비 비율), 글자 크기(%, 100 = 기본), 굵게. 없으면 기본 모양 */
export type ShapeStyle = { line?: number; label_size?: number; label_bold?: boolean };
export type PlanSpace = Rect & ShapeStyle & { kind: string; label: string };
/** 선으로 그린 벽 (양 끝점, 굵기는 도면 폭 대비 비율) */
export type PlanLine = { x1: number; y1: number; x2: number; y2: number; line: number };
export type PlanEntrance = Rect & ShapeStyle & { label: string; main: boolean };

/** 팀 구역 모양: 좌석을 감싸는 사각형. 좌석 덩어리가 여럿이면 rects (자동 계산, zoneShape.ts) */
export type ZoneShape = (Rect & { type?: "rect" }) | { type: "rects"; rects: Rect[] };

export type Zone = {
  id: number;
  code: string;
  name: string;
  department: string | null; // 공용 구역이면 null
  color_key: string; // t0~t4
  shape: ZoneShape | null; // 좌석이 없으면 null (그리지 않는다)
};

export type Room = {
  id: number;
  name: string;
  capacity: number;
  equipment: string[];
  shape: (Rect & ShapeStyle) | null;
  busy_until: string | null;
  current_title: string | null;
  next_start: string | null; // 오늘 안에 시작하는 다음 예약
};

export type Occupant = {
  emp_no: string;
  name: string;
  rank: string | null;
  department: string;
  extension: string | null;
  email: string | null;
  kind: "FIXED" | "DAILY";
  photo: string | null;
  display_name: string | null;
  headline: string | null;
  duties: string | null;
  skills: string[];
  presence: {
    status: PresenceStatus;
    message: string | null;
    expires_at: string | null;
    updated_at?: string; // 언제 바꾼 상태인지
  } | null;
};

export type Seat = {
  id: number;
  code: string;
  zone_id: number | null;
  seat_type: "FIXED" | "FLEX";
  x: number; // 좌석 중심
  y: number;
  rotation: 0 | 90 | 180 | 270; // 의자 방향. 0 = 아래, 90 = 오른쪽, 180 = 위, 270 = 왼쪽
  w: number | null; // 좌석 크기 (도면 대비). null이면 기본 책상
  h: number | null;
  status: "ACTIVE" | "OUT_OF_SERVICE";
  occupant: Occupant | null;
};

export type FloorMap = {
  floor: { id: number; name: string; site: { id: number; name: string } };
  fetched_at: string; // 이 데이터를 읽은 시각 (실시간 알림과 어느 쪽이 최신인지 비교)
  /** 날짜를 정해 둔 배치 변경·자율석 사용 끝 등, 이 층 자리가 다음에 저절로 바뀌는 시각 (그때 다시 읽는다) */
  next_change_at: string | null;
  plan: {
    version: number;
    width_m: number;
    height_m: number;
    // 기둥은 중심점. w·h가 없으면 기본 크기 (목업 도면)
    geometry: {
      walls?: (Rect & ShapeStyle)[];
      lines?: PlanLine[];
      pillars?: { x: number; y: number; w?: number; h?: number }[];
      spaces?: PlanSpace[];
      entrances?: PlanEntrance[];
    } | null;
    published_at: string | null;
  } | null;
  zones: Zone[];
  rooms: Room[];
  seats: Seat[];
};

export type MyPresence = {
  status: PresenceStatus;
  message: string | null;
  expires_at: string | null;
  updated_at: string;
} | null;

/** 실시간 알림(/api/presence/stream)의 presence 이벤트. presence가 null이면 상태를 지웠다 */
export type PresenceEvent = { emp_no: string; presence: MyPresence; at: string };

/** 실시간 알림의 floor 이벤트: 좌석·배정(seats), 팀 구역(zones), 도면 게시(plan), 배치 요청(requests).
 *  emp_no: 고정석 배정이 바뀐 사람 (내 자리가 바뀌었는지 알아본다) */
export type FloorEvent = {
  kind: "seats" | "zones" | "plan" | "requests"; // requests: 배치 묶음 승인 요청·반려 (배치 화면만 쓴다)
  floor_id: number;
  seat_id?: number;
  emp_no?: string | null;
  version?: number;
  at: string;
};

/** 내 고정석과 날짜를 정해 둔 다음 변경 (seat가 null이면 그날 배정이 끝난다) */
export type MySeat = {
  seat: SeatRef | null;
  change: { at: string; seat: SeatRef | null } | null;
};

/** 재실 상태 자동 해제: 해제 안 함 / 30분 / 1시간 / 퇴근 시 / 지금 해제 시각 그대로 */
export type PresenceDuration = "NONE" | "30M" | "1H" | "END_OF_DAY" | "KEEP";

/** 내 재실 상태 + 지금 "퇴근 시"를 고르면 풀리는 시각 (퇴근 시각이 지났으면 오늘 자정) */
export type MyPresenceInfo = { presence: MyPresence; end_of_day_at: string; workday_end: string };

export class ApiError extends Error {
  constructor(readonly status: number) {
    super(`API ${status}`);
  }
}

async function apiGet<T>(path: string, cookieHeader: string | null): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
    cache: "no-store",
  });
  if (!res.ok) throw new ApiError(res.status);
  return (await res.json()) as T;
}

/** 레이아웃(왼쪽 메뉴)과 페이지가 같은 요청 안에서 한 번만 부르도록 cache로 감싼다 */
export const fetchSites = cache((cookieHeader: string | null) =>
  apiGet<SitesResponse>("/api/office/sites", cookieHeader),
);

export function fetchFloor(cookieHeader: string | null, floorId: number): Promise<FloorMap> {
  return apiGet<FloorMap>(`/api/office/floors/${floorId}`, cookieHeader);
}

export function fetchMyPresence(cookieHeader: string | null): Promise<MyPresenceInfo> {
  return apiGet<MyPresenceInfo>("/api/presence/me", cookieHeader);
}

// 직원 검색 ----------------------------------------------------------------------

export type EmployeeHit = {
  emp_no: string;
  name: string;
  rank: string | null;
  department: string;
  division: string | null; // 위 부서 (본부)
  extension: string | null;
  email: string | null;
  is_me: boolean;
  seat: {
    id: number;
    code: string;
    floor_id: number;
    floor_name: string;
    site_name: string;
    color_key: string | null;
  } | null;
  presence: { status: PresenceStatus; message: string | null } | null;
  /** 시간을 같이 넘겨 검색했을 때만: 그 시간에 겹치는 다른 회의 / 휴가·외근 */
  busy: { title: string; starts_at: string; ends_at: string } | null;
  absence: "LEAVE" | "BUSINESS_TRIP" | "REMOTE" | null;
  /** 이름·부서가 아니라 내 정보(하는 일·키워드 등)로 찾았을 때 걸린 부분 (검색만) */
  matched?: string | null;
} & PublicProfile;

export function fetchProfile(cookieHeader: string | null): Promise<MyProfile> {
  return apiGet<MyProfile>("/api/profile", cookieHeader);
}

// 회의실 확인·예약 -----------------------------------------------------------------

/** 시간은 모두 서울 기준 그날 0시부터 분 (예: 13:30 → 810) */
export type Booking = {
  id: number;
  title: string;
  status: "CONFIRMED";
  starts_at: string; // 여러 날에 걸친 예약이면 그날 밖의 시각
  ends_at: string;
  start_min: number;
  end_min: number;
  organizer: string;
  department: string;
  mine: boolean; // 내가 만들었거나 참석하는 예약
  organized: boolean; // 내가 만든 예약 (참석만 하는 회의는 false)
};

export type RoomDay = {
  id: number;
  name: string;
  capacity: number;
  equipment: string[];
  floor: { id: number; name: string };
  bookings: Booking[];
};

export type RoomPolicy = { slot: number; max: number; open_start: number; open_end: number };

export type RoomsDay = {
  date: string; // YYYY-MM-DD
  today: string;
  now_min: number | null; // 오늘이면 지금 시각
  past: boolean;
  site: { id: number; name: string };
  policy: RoomPolicy;
  rooms: RoomDay[];
};

/** 예약 상태: 확정 / 취소 / 체크인이 없어 자동 반납 */
export type ReservationStatus = "CONFIRMED" | "CANCELLED" | "RELEASED";

export type MyReservation = {
  id: number;
  title: string;
  starts_at: string;
  ends_at: string;
  status: ReservationStatus;
  series_id: number | null;
  cancelled_at: string | null;
  room: string;
  floor_id: number;
  floor: string;
  site: string;
  floor_ambiguous: boolean; // 다른 사업장에도 같은 이름의 층이 있다 (사업장 이름을 붙여 보여 준다)
  is_organizer: boolean; // 내가 예약했다
  attending: boolean; // 내가 회의에 들어간다 (예약만 해 줬으면 false)
  organizer: string;
  organizer_department: string;
  attendees: number; // 실제로 들어가는 사람 수 (예약한 사람이 참석하면 포함)
};

export type ReservationDetail = {
  id: number;
  title: string;
  starts_at: string;
  ends_at: string;
  status: ReservationStatus;
  created_at: string;
  updated_at: string; // 고칠 때 돌려보낸다 (그사이 다른 곳에서 고쳤으면 서버가 막는다)
  checked_in_at: string | null;
  cancelled_at: string | null;
  room: {
    id: number;
    name: string;
    capacity: number;
    equipment: string[];
    floor_id: number;
    floor: string;
    site_id: number;
    site: string;
  };
  organizer: {
    emp_no: string;
    name: string;
    rank: string | null;
    department: string;
    extension: string | null;
    email: string | null;
    attends: boolean; // 예약한 사람도 회의에 들어가나
  };
  /** 실제로 회의에 들어가는 사람 (예약한 사람이 참석하면 맨 앞) */
  attendees: {
    emp_no: string;
    name: string;
    rank: string | null;
    department: string;
    is_me: boolean;
    is_organizer: boolean;
    color_key: string | null;
    presence: PresenceStatus | null;
  }[];
  /** left: 이 회차를 포함해 앞으로 남은 확정 회차 수 */
  series: { repeat: "WEEKLY" | "WEEKDAYS"; first_date: string; last_date: string; left: number } | null;
  ended: boolean; // 이미 끝난 회의
  is_organizer: boolean;
  can_cancel: boolean;
};

/** 팀·본부. 참석자 칸에서 "$총무팀"처럼 찾아 팀 전체를 한 번에 넣는다. member_count는 아래 팀 사람까지 */
export type TeamHit = { id: number; name: string; parent: string | null; member_count: number; has_children: boolean };

export function fetchRoomsDay(cookieHeader: string | null, date: string | null, siteId: number | null) {
  const query = new URLSearchParams();
  if (date) query.set("date", date);
  if (siteId) query.set("site_id", String(siteId));
  return apiGet<RoomsDay>(`/api/rooms/day?${query}`, cookieHeader);
}

export async function fetchMyReservations(
  cookieHeader: string | null,
  scope: "upcoming" | "past" = "upcoming",
): Promise<MyReservation[]> {
  return (await apiGet<{ reservations: MyReservation[] }>(`/api/reservations/mine?scope=${scope}`, cookieHeader))
    .reservations;
}

// 내 재실 상태 ---------------------------------------------------------------------

/** 우리 팀(내 부서) 사람들의 재실 상태와 자리 */
export type MyTeam = { team: { id: number; name: string }; fetched_at: string; members: EmployeeHit[] };

export function fetchMyTeam(cookieHeader: string | null) {
  return apiGet<MyTeam>("/api/presence/team", cookieHeader);
}

// 관리자 페이지 --------------------------------------------------------------------
// 직원 화면과 쿠키·비밀번호가 따로다. 서버 컴포넌트는 요청 쿠키를 그대로 넘기면 된다

/** 관리자 세션 쿠키 이름 (server/app/config.py 의 admin_cookie_name 과 같아야 한다) */
export const ADMIN_COOKIE = "officemap_admin_session";

export type AdminRole = "COMPANY_ADMIN" | "SITE_ADMIN" | "FLOOR_ADMIN" | "ZONE_ADMIN";

export type AdminGrant = {
  id: number;
  role: AdminRole;
  level: number; // 1 전사 ~ 4 구역
  label: string;
  scope: string; // "전체 사업장", "서울 본사 · 7F" …
  site_id: number | null;
  floor_id: number | null;
  zone_id: number | null;
  apply_mode: "IMMEDIATE" | "NEEDS_APPROVAL"; // 구역 관리자의 변경 반영
  granted_at: string;
  granted_by: string | null;
  employee: { emp_no: string; name: string; rank: string | null; department: string };
};

export type Admin = {
  emp_no: string;
  name: string;
  rank: string | null;
  department: string;
  role: AdminRole; // 가장 넓은 권한
  role_label: string;
  grants: AdminGrant[];
  idle_minutes: number;
};

/** 도면 상태: 작성 완료 / 작성 완료 + 수정 중 / 초안만 / 없음 */
export type PlanState = "PUBLISHED" | "EDITING" | "SCHEDULED" | "DRAFT" | "NONE";

export type AdminFloor = {
  id: number;
  name: string;
  description: string | null;
  seats: number; // 개인석(고정석)
  flex: number; // 자율석 (배정하지 않음)
  occupied: number; // 배정된 개인석
  out_of_service: number; // 사용 중지(고장·수리) 자리. seats·flex에는 들어 있지 않다
  rooms: number;
  zones: { code: string; name: string; color_key: string; department: string | null; department_active: boolean }[];
  floor_admins: string[];
  zone_admins: number;
  plan: PlanState;
  plan_updated_at: string | null;
  plan_updated_by: string | null;
  plan_scheduled_at: string | null; // 게시 예약 시각
  in_scope: "ALL" | "ZONE" | null; // 내가 관리하는 층인가 (ZONE = 층 안 일부 구역만)
};

export type AdminSite = {
  id: number;
  kind: string; // 본사 / 센터
  name: string;
  address: string | null;
  admins: string[];
  floors: AdminFloor[];
};

export type AdminOverview = {
  /** seats·flex·occupied·rooms·reservations_today·pending_requests 는 내 관리 범위 안의 숫자.
   *  employees·unseated·admins 는 전사 숫자. pending_requests: 층 관리 권한이면 내가 승인할 요청,
   *  구역만 맡았으면 내가 올려서 승인을 기다리는 요청 */
  summary: {
    scope: "ALL" | "FLOORS" | "ZONES";
    employees: number;
    unseated: number;
    seats: number;
    flex: number;
    occupied: number;
    out_of_service: number;
    rooms: number;
    reservations_today: number;
    pending_requests: number;
    admins: number;
  };
  sites: AdminSite[];
  grants: AdminGrant[];
};

/** 관리자 쿠키로 로그인한 관리자. 아니면 null. 레이아웃과 페이지가 한 번만 부르도록 cache */
export const fetchAdmin = cache(async (cookieHeader: string | null): Promise<Admin | null> => {
  if (!cookieHeader) return null;
  try {
    return (await apiGet<{ admin: Admin }>("/api/admin/auth/me", cookieHeader)).admin;
  } catch {
    return null;
  }
});

export function fetchAdminOverview(cookieHeader: string | null) {
  return apiGet<AdminOverview>("/api/admin/overview", cookieHeader);
}

// 조직도 (관리자 페이지) ------------------------------------------------------------

/** 부서 하나. members: 재직·휴직 인원, zones: 이 부서 팀 구역 */
export type OrgDepartment = {
  id: number;
  code: string;
  name: string;
  parent_id: number | null;
  sort_order: number;
  is_active: boolean;
  members: number;
  zones: { floor: string; code: string }[];
};

export type OrgMember = {
  emp_no: string;
  name: string;
  rank: string | null;
  position: string | null;
  email: string | null;
  extension: string | null;
  status: "ACTIVE" | "LEAVE";
  hired_on: string | null;
  seat_code: string | null;
  floor_name: string | null;
  site_name: string | null;
  is_admin: boolean;
  temporary_password: boolean | null; // 아직 임시 비밀번호 (null이면 계정 없음)
};

export function fetchOrg(cookieHeader: string | null) {
  return apiGet<{ departments: OrgDepartment[]; can_edit: boolean }>("/api/admin/org", cookieHeader);
}

// 좌석 배치 편집 (⑤) -------------------------------------------------------------

/** 좌석 유형: 고정석 / 팀 내 자율석 / 사용 중지 (고장·수리) */
export type SeatMode = "FIXED" | "FLEX" | "OUT_OF_SERVICE";

/** 자리 위치 (층 이름 + 좌석 번호) */
export type SeatRef = { id: number; code: string; floor_id: number; floor: string; site?: string | null };

export type SeatingPerson = {
  emp_no: string;
  name: string;
  rank: string | null;
  department: string;
  department_id: number;
};

export type SeatingSeat = Omit<Seat, "occupant"> & {
  occupant: (SeatingPerson & { kind: "FIXED" | "DAILY"; active: boolean }) | null;
  /** 날짜를 정해 둔 다음 변경 (occupant가 null이면 그날 비워진다). 있으면 그날까지 잠긴다 */
  upcoming: { at: string; occupant: Omit<SeatingPerson, "department_id"> | null } | null;
  /** 내 범위(구역)의 좌석인가 */
  editable: boolean;
};

export type SeatingZone = Zone & {
  department_id: number | null;
  department_active: boolean; // false: 조직도에서 없어진 부서의 구역
  name_custom: boolean; // true: 부서 이름 대신 별칭
  editable: boolean;
  managers: string[];
};

export type DepartmentChoice = { id: number; name: string; parent: string | null };

/** 미배치 인원: 우리 팀(이 층에 구역이 있는 팀)인데 지금 고정석이 없는 사람 */
export type UnassignedPerson = SeatingPerson & {
  new_hire: boolean;
  released_at: string | null; // 마지막 고정석이 끝난 시각
  upcoming: { at: string; seat: string } | null; // 날짜를 정해 둔 새 자리
};

export type ChangeSetStatus = "DRAFT" | "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";

/** 작업 묶음: 좌석마다 "반영하면 이렇게 된다" */
export type ChangeSet = {
  id: number;
  floor_id: number;
  type: "SEAT_ASSIGNMENT" | "ZONE_CHANGE";
  status: ChangeSetStatus;
  note: string | null;
  effective_at: string | null;
  submitted_at: string | null;
  reviewed_at: string | null;
  reviewer: string | null;
  review_comment: string | null;
  updated_at: string;
  requester: string;
  assignments: { seat_id: number; emp_no: string | null; expected_emp_no: string | null }[];
  types: { seat_id: number; mode: SeatMode }[];
  zone_moves: { seat_id: number; zone_id: number | null }[]; // zone_id null: 구역 없음으로
  people: Record<string, SeatingPerson & { active: boolean; seat: SeatRef | null }>;
};

export type ChangeRequestRow = {
  id: number;
  type: ChangeSet["type"];
  status: ChangeSetStatus;
  scheduled: boolean; // 날짜를 정해 반영했고 아직 그날이 안 됐다
  note: string | null;
  effective_at: string | null;
  submitted_at: string | null;
  reviewed_at: string | null;
  reviewer: string | null;
  review_comment: string | null;
  requester: string;
  mine: boolean;
  item_count: number;
  zone_moves: boolean; // 구역 경계 변경이 들어 있다
  team_move: boolean; // 팀 이사로 여러 층에 함께 만든 묶음 (예정 취소도 함께)
  summary: string[];
  can_review: boolean;
  can_cancel: boolean;
};

export type SeatingFloorChoice = { id: number; name: string; site: string; mode: "FLOOR" | "ZONE" };

export type SeatingData = {
  floor: FloorMap["floor"];
  fetched_at: string;
  floors: SeatingFloorChoice[];
  permissions: {
    mode: "FLOOR" | "ZONE"; // 층 전체 / 내 구역만
    apply: "IMMEDIATE" | "NEEDS_APPROVAL"; // 바로 반영 / 층 관리자 승인 후
    zones: number[] | null;
    can_review: boolean;
    floor_admins: string[];
  };
  plan: FloorMap["plan"];
  plan_scheduled: { version: number; effective_at: string } | null; // 게시를 예약한 새 도면
  rooms: { id: number; name: string; shape: (Rect & ShapeStyle) | null }[];
  zones: SeatingZone[];
  departments: DepartmentChoice[]; // 구역에 고를 수 있는 부서 (층 관리자 이상만)
  seats: SeatingSeat[];
  unassigned: UnassignedPerson[];
  draft: ChangeSet | null; // 내 작업 묶음 (작성 중 또는 승인 대기)
  requests: ChangeRequestRow[];
};

export type SeatingSearchHit = SeatingPerson & { seat: SeatRef | null; locked: boolean };

export function fetchSeatingFloors(cookieHeader: string | null) {
  return apiGet<{ floors: SeatingFloorChoice[] }>("/api/admin/seating/floors", cookieHeader);
}

export function fetchSeating(cookieHeader: string | null, floorId: number) {
  return apiGet<SeatingData>(`/api/admin/floors/${floorId}/seating`, cookieHeader);
}

// 도면 편집 (⑥) ------------------------------------------------------------------

/** 미터 단위 사각형 */
export type PlanRect = { x: number; y: number; w: number; h: number };
export type SpaceKind = "core" | "pantry" | "restroom" | "lounge" | "storage" | "service" | "restricted";

export type DeskCell = { id: string; desk: boolean; code: string; flip?: boolean }; // flip: 이 책상만 반대로 앉는다
export type DeskGroup = {
  id: string;
  type: "desk_group";
  layout: "face" | "one"; // 마주보기 / 한 방향
  rows: number;
  cols: number;
  x: number;
  y: number;
  rotation?: 0 | 90 | 180 | 270; // 묶음을 통째로 돌린다 (90 = 의자가 아래였던 것이 오른쪽으로)
  desk_w?: number; // 책상 하나 크기 (m, 돌리기 전). 없으면 기본 2.665 × 1.668
  desk_h?: number;
  cells: DeskCell[]; // 줄 순서로 rows × cols 개
};

/** 선 굵기 (m)·글자 크기 (%)·굵게. 없으면 기본 모양 */
export type PlanStyle = { line_w?: number; label_size?: number; label_bold?: boolean };
export type WallLine = { id: string; type: "wall_line"; x: number; y: number; x2: number; y2: number; line_w?: number };

export type PlanElement =
  | ({ id: string; type: "wall"; line_w?: number } & PlanRect)
  | WallLine
  | ({ id: string; type: "pillar" } & PlanRect)
  | ({ id: string; type: "space"; kind: SpaceKind; label: string } & PlanStyle & PlanRect)
  | ({ id: string; type: "room"; name: string; capacity: number; equipment: string[] } & PlanStyle & PlanRect)
  | ({ id: string; type: "entrance"; label: string; main: boolean } & PlanStyle & PlanRect)
  | DeskGroup;

/** desk: 새로 놓는 책상의 기본 크기 (m) */
export type PlanGeometry = { schema: 1; grid_m: number; desk?: { w: number; h: number }; elements: PlanElement[] };

export type PlanSummary = {
  id: number;
  version: number;
  published_at: string | null;
  published_by: string | null;
  note: string | null;
};

export type PlanEditorData = {
  floor: FloorMap["floor"];
  floors: { id: number; name: string; site: string; site_id: number; published: boolean; drafting: boolean }[];
  size: { width_m: number; height_m: number };
  /** 밑그림: 도면 파일 그림 (편집 화면에서만 요소 밑에 깐다). 층마다 하나 */
  background: {
    url: string;
    x_m: number;
    y_m: number;
    w_m: number;
    h_m: number;
    opacity: number;
    visible: boolean;
    name: string | null;
    bytes: number;
    updated_at: string;
  } | null;
  published: PlanSummary | null;
  draft: {
    id: number;
    status: "DRAFT" | "SCHEDULED"; // SCHEDULED: 게시 예약 (effective_at에 서버가 게시)
    effective_at: string | null;
    scheduled_by: string | null;
    note: string | null;
    // 게시 예약 때 정한 것: 사람 → 책상 칸, 없어지는 회의실 → 옮길 회의실 또는 취소
    options: {
      people: { emp_no: string; to_key: string }[];
      rooms: { room_id: number; action: "MOVE" | "CANCEL"; to_key: string | null }[];
    } | null;
    version: number;
    revision: number;
    geometry: PlanGeometry;
    updated_at: string;
    updated_by: string | null;
    base_version: number | null;
    editing: { mine: boolean; name: string | null; at: string } | null; // 지금 편집 중인 사람
  } | null;
  archived: PlanSummary[];
  sources: { id: number; name: string; site: string }[]; // 복제할 수 있는 다른 층
  // 지금 게시본 기준으로 책상 칸·회의실 공간에 앉은 사람과 남은 예약 (초안에서 지우면 영향 받는 것)
  live: {
    seats: Record<
      string,
      { code: string; occupant: string | null; color_key: string | null; zone_code: string | null; upcoming: number }
    >;
    rooms: Record<string, { name: string; upcoming: number }>;
  };
};

export type PublishCheck = {
  revision: number;
  summary: {
    seats_before: number;
    seats_after: number;
    added: number;
    removed: number;
    moved: number;
    renamed: { from: string; to: string }[];
    daily_ended: number;
  };
  people: {
    emp_no: string;
    name: string;
    rank: string | null;
    department: string;
    seat_code: string;
    scheduled: boolean;
    suggestion: { key: string; code: string } | null;
  }[];
  rooms_removed: { id: number; name: string; upcoming: number; next_at: string | null }[];
  rooms_added: string[];
  rooms_changed: { from: string; to: string; capacity: number }[];
  room_targets: { key: string; name: string; capacity: number }[];
  seat_targets: { key: string; code: string }[];
  problems: { code: string; element: string; seat?: string; name?: string }[];
};

export function fetchPlanFloors(cookieHeader: string | null) {
  return apiGet<{ floors: PlanEditorData["floors"] }>("/api/admin/plans/floors", cookieHeader);
}

export function fetchPlanEditor(cookieHeader: string | null, floorId: number) {
  return apiGet<PlanEditorData>(`/api/admin/floors/${floorId}/plan`, cookieHeader);
}

// 팀 이사 도우미 -------------------------------------------------------------------

export type MoveOptions = {
  departments: (DepartmentChoice & { members: number })[]; // 옮길 수 있는 팀 (살아 있는 팀과 인원)
  floors: { id: number; name: string; site: string }[]; // 목적지로 고를 수 있는 층 (층 관리자 이상)
};

export type TeamMember = {
  emp_no: string;
  name: string;
  rank: string | null;
  seat: SeatRef | null; // 지금 고정석
  zone_code: string | null;
  locked: boolean; // 날짜를 정해 둔 변경이 걸려 있어 그날까지 옮길 수 없다
};

export function fetchMoveOptions(cookieHeader: string | null) {
  return apiGet<MoveOptions>("/api/admin/moves/options", cookieHeader);
}
