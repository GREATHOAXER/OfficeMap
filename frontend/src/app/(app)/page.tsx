import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ApiError, fetchFloor, fetchMe, fetchMyPresence, fetchSites } from "@/lib/api";
import OfficeView from "./OfficeView";
import styles from "./office.module.css";

// ① 자리·재실 현황
// 주소의 ?floor=층ID 또는 ?site=사업장ID 로 고른다. 둘 다 없으면 내 자리가 있는 층을 연다
// (자리가 아직 없으면 우리 팀 구역이 있는 층)
export default async function OfficePage({ searchParams }: PageProps<"/">) {
  const params = await searchParams;
  const data = await loadOffice(Number(params.site), Number(params.floor));
  if (!data) return <p className={styles.errorBox}>등록된 층이 없습니다.</p>;
  return (
    <OfficeView
      floors={data.floors}
      myFloorId={data.myFloorId}
      teamFloorId={data.teamFloorId}
      myEmpNo={data.myEmpNo}
      myPresence={data.myPresence}
      map={data.map}
    />
  );
}

async function loadOffice(siteId: number, floorId: number) {
  const cookieHeader = (await headers()).get("cookie");
  try {
    const [me, { sites, my_floor_id: myFloorId, team_floor_id: teamFloorId }, myPresence] = await Promise.all([
      fetchMe(cookieHeader), // 레이아웃에서 이미 부른 것을 같이 쓴다 (cache)
      fetchSites(cookieHeader),
      fetchMyPresence(cookieHeader),
    ]);
    if (!me) redirect("/login");
    const homeFloorId = myFloorId ?? teamFloorId;
    const hasFloor = (id: number) => (s: (typeof sites)[number]) => s.floors.some((f) => f.id === id);
    const site =
      sites.find(hasFloor(floorId)) ??
      sites.find((s) => s.id === siteId) ??
      (homeFloorId !== null ? sites.find(hasFloor(homeFloorId)) : undefined) ??
      sites[0];
    const floors = site?.floors ?? [];
    const floor =
      floors.find((f) => f.id === floorId) ?? floors.find((f) => f.id === homeFloorId) ?? floors[0];
    if (!floor) return null;
    return {
      floors,
      myFloorId,
      teamFloorId,
      myEmpNo: me.emp_no,
      myPresence,
      map: await fetchFloor(cookieHeader, floor.id),
    };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/login?reason=expired");
    throw error;
  }
}
