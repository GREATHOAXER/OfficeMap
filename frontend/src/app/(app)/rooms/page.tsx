import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { ApiError, fetchRoomsDay } from "@/lib/api";
import { redirectToLogin } from "@/lib/expiredRedirect";
import { ROOMS_FLOOR_COOKIE } from "@/lib/roomsFloor";
import RoomsView from "./RoomsView";

export const metadata: Metadata = { title: "회의실 확인·예약 · Office Map" };

// ② 회의실 확인·예약
// 주소의 ?date=YYYY-MM-DD 로 날짜를, ?site=사업장ID 로 사업장을 고른다. 없으면 오늘, 층(아래)의 사업장, 내 자리가 있는 사업장.
// 층 필터는 ?floor=층ID(자리 현황 도면의 회의실을 눌러 왔을 때), 없으면 마지막으로 고른 층(쿠키)으로 연다.
// 사업장을 주지 않고 층만 주면 그 층의 사업장으로 연다 (분당 센터 도면의 회의실을 눌렀는데 서울 본사가 열리지 않게)
export default async function RoomsPage({ searchParams }: PageProps<"/rooms">) {
  const params = await searchParams;
  const date = typeof params.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(params.date) ? params.date : null;
  const siteId = Number(params.site) || null;
  const savedFloor = Number((await cookies()).get(ROOMS_FLOOR_COOKIE)?.value);
  const floor = Number(params.floor) || savedFloor;
  const cookieHeader = (await headers()).get("cookie");
  let day;
  try {
    day = await fetchRoomsDay(cookieHeader, date, siteId, Number(params.floor) || null);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return redirectToLogin();
    if (error instanceof ApiError && (error.status === 422 || error.status === 404)) redirect("/rooms"); // 없는 날짜·사업장
    throw error;
  }
  return (
    <RoomsView
      day={day}
      initialFloor={day.rooms.some((r) => r.floor.id === floor) ? floor : "all"}
      editId={Number(params.edit) || null}
    />
  );
}
