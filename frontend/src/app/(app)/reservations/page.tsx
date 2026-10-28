import type { Metadata } from "next";
import { headers } from "next/headers";
import { ApiError, fetchMyReservations } from "@/lib/api";
import { kstDate } from "@/lib/dates";
import { redirectToLogin } from "@/lib/expiredRedirect";
import ReservationsView from "./ReservationsView";

export const metadata: Metadata = { title: "내 예약 · Office Map" };

/** 서버 기준 오늘 (서울) */
const todayInSeoul = () => kstDate(new Date().toISOString());

// 내 예약: 내가 만들었거나 참석하는 예약. 예정(가까운 순)과 최근 30일 지난·취소 예약
export default async function ReservationsPage() {
  const cookieHeader = (await headers()).get("cookie");
  let data;
  try {
    const [upcoming, past] = await Promise.all([
      fetchMyReservations(cookieHeader, "upcoming"),
      fetchMyReservations(cookieHeader, "past"),
    ]);
    data = { upcoming, past };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return redirectToLogin();
    throw error;
  }
  return <ReservationsView upcoming={data.upcoming} past={data.past} today={todayInSeoul()} />;
}
