import { cache } from "react";

// 서버 컴포넌트에서 FastAPI를 직접 부를 때 쓰는 함수들.
// 브라우저(클라이언트 컴포넌트)에서는 상대 경로 /api/... 를 쓴다 (next.config.ts 참고)

export const API_URL = process.env.API_URL ?? "http://localhost:8000";

export type User = {
  emp_no: string;
  name: string;
  rank: string | null;
  department: string;
  role: "USER" | "ADMIN";
  must_change_password: boolean;
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

/** 쿠키로 로그인한 사람을 확인한다. 로그인 안 했거나 API가 꺼져 있으면 null.
 *  레이아웃과 페이지가 같은 요청 안에서 한 번만 부르도록 cache로 감싼다 */
export const fetchMe = cache(async (cookieHeader: string | null): Promise<User | null> => {
  if (!cookieHeader) return null;
  try {
    const res = await fetch(`${API_URL}/api/auth/me`, {
      headers: { cookie: cookieHeader },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()).user as User;
  } catch {
    return null;
  }
});

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
};
export type SiteSummary = { id: number; name: string; floors: FloorSummary[] };
export type SitesResponse = { sites: SiteSummary[]; my_floor_id: number | null };

export type PlanSpace = Rect & { kind: string; label: string };

export type Zone = {
  id: number;
  code: string;
  name: string;
  department: string | null; // 공용 구역이면 null
  color_key: string; // t0~t4
  shape: Rect;
};

export type Room = {
  id: number;
  name: string;
  capacity: number;
  equipment: string[];
  shape: Rect | null;
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
  presence: { status: PresenceStatus; message: string | null; expires_at: string | null } | null;
};

export type Seat = {
  id: number;
  code: string;
  zone_id: number | null;
  seat_type: "FIXED" | "FLEX";
  x: number; // 좌석 중심
  y: number;
  rotation: 0 | 90 | 180 | 270; // 의자 방향. 180 = 위쪽
  status: "ACTIVE" | "OUT_OF_SERVICE";
  occupant: Occupant | null;
};

export type FloorMap = {
  floor: { id: number; name: string; site: { id: number; name: string } };
  fetched_at: string; // 이 데이터를 읽은 시각 (실시간 알림과 어느 쪽이 최신인지 비교)
  plan: {
    version: number;
    width_m: number;
    height_m: number;
    geometry: { walls?: Rect[]; pillars?: { x: number; y: number }[]; spaces?: PlanSpace[] } | null;
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

/** 재실 상태 자동 해제: 계속 / 30분 / 1시간 / 퇴근 시 */
export type PresenceDuration = "NONE" | "30M" | "1H" | "END_OF_DAY";

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

export async function fetchMyPresence(cookieHeader: string | null): Promise<MyPresence> {
  return (await apiGet<{ presence: MyPresence }>("/api/presence/me", cookieHeader)).presence;
}

// 직원 검색 ----------------------------------------------------------------------

export type EmployeeHit = {
  emp_no: string;
  name: string;
  rank: string | null;
  department: string;
  division: string | null; // 위 부서 (본부)
  extension: string | null;
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
};

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
  room: string;
  floor_id: number;
  floor: string;
  is_organizer: boolean;
  organizer: string;
  organizer_department: string;
  attendees: number;
};

export type ReservationDetail = {
  id: number;
  title: string;
  starts_at: string;
  ends_at: string;
  status: ReservationStatus;
  created_at: string;
  checked_in_at: string | null;
  room: { name: string; capacity: number; equipment: string[]; floor_id: number; floor: string; site: string };
  organizer: {
    emp_no: string;
    name: string;
    rank: string | null;
    department: string;
    extension: string | null;
    email: string | null;
  };
  attendees: {
    emp_no: string;
    name: string;
    rank: string | null;
    department: string;
    is_me: boolean;
    color_key: string | null;
    presence: PresenceStatus | null;
  }[];
  series: { repeat: "WEEKLY" | "WEEKDAYS"; first_date: string; last_date: string } | null;
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
export type PlanState = "PUBLISHED" | "EDITING" | "DRAFT" | "NONE";

export type AdminFloor = {
  id: number;
  name: string;
  description: string | null;
  seats: number;
  occupied: number;
  rooms: number;
  zones: { code: string; name: string; color_key: string; department: string | null }[];
  floor_admins: string[];
  zone_admins: number;
  plan: PlanState;
  plan_updated_at: string | null;
  plan_updated_by: string | null;
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
  summary: {
    employees: number;
    seats: number;
    occupied: number;
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
