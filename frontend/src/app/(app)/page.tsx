import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ApiError, fetchFloor, fetchSites } from "@/lib/api";
import OfficeView from "./OfficeView";
import styles from "./office.module.css";

// ① 자리·재실 현황. 주소의 ?floor=층ID 로 층을 고르고, 없으면 내 자리가 있는 층을 연다
export default async function OfficePage({ searchParams }: PageProps<"/">) {
  const data = await loadOffice(Number((await searchParams).floor));
  if (!data) return <p className={styles.errorBox}>등록된 층이 없습니다.</p>;
  return <OfficeView floors={data.floors} myFloorId={data.myFloorId} map={data.map} />;
}

async function loadOffice(requestedFloorId: number) {
  const cookieHeader = (await headers()).get("cookie");
  try {
    const { sites, my_floor_id: myFloorId } = await fetchSites(cookieHeader);
    const floors = sites[0]?.floors ?? []; // 사업장 고르기는 다음 단계. 지금은 첫 사업장(서울 본사)
    const floorId = floors.some((f) => f.id === requestedFloorId)
      ? requestedFloorId
      : (floors.find((f) => f.id === myFloorId)?.id ?? floors[0]?.id);
    if (floorId === undefined) return null;
    return { floors, myFloorId, map: await fetchFloor(cookieHeader, floorId) };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/login");
    throw error;
  }
}
