import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ApiError, fetchMe, fetchMyPresence, fetchMyReservations, fetchMyTeam } from "@/lib/api";
import { kstDate } from "@/lib/dates";
import PresenceView from "./PresenceView";

/** 서버 기준 오늘 (서울) */
const todayInSeoul = () => kstDate(new Date().toISOString());

// 내 재실 상태 (초안): 지금 내 상태, 상태 바꾸기, 오늘 내 일정, 우리 팀 재실 현황
export default async function PresencePage() {
  const cookieHeader = (await headers()).get("cookie");
  let data;
  try {
    const [me, presence, team, upcoming] = await Promise.all([
      fetchMe(cookieHeader),
      fetchMyPresence(cookieHeader),
      fetchMyTeam(cookieHeader),
      fetchMyReservations(cookieHeader, "upcoming"),
    ]);
    if (!me) redirect("/login");
    data = { me, presence, team, upcoming };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/login?reason=expired");
    throw error;
  }
  return (
    <PresenceView
      myEmpNo={data.me.emp_no}
      info={data.presence}
      team={data.team}
      upcoming={data.upcoming}
      today={todayInSeoul()}
    />
  );
}
