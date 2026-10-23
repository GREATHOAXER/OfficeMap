import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ApiError, fetchMyReservations, fetchRoomsDay } from "@/lib/api";
import RoomsView from "./RoomsView";

// ② 회의실 확인·예약
// 주소의 ?date=YYYY-MM-DD 로 날짜를, ?site=사업장ID 로 사업장을 고른다. 없으면 오늘, 내 자리가 있는 사업장
export default async function RoomsPage({ searchParams }: PageProps<"/rooms">) {
  const params = await searchParams;
  const date = typeof params.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(params.date) ? params.date : null;
  const siteId = Number(params.site) || null;
  const cookieHeader = (await headers()).get("cookie");
  let data;
  try {
    const [day, mine] = await Promise.all([fetchRoomsDay(cookieHeader, date, siteId), fetchMyReservations(cookieHeader)]);
    data = { day, mine };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/login");
    if (error instanceof ApiError && (error.status === 422 || error.status === 404)) redirect("/rooms"); // 없는 날짜·사업장
    throw error;
  }
  return <RoomsView day={data.day} mine={data.mine} />;
}
