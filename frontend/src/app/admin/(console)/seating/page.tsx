import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ApiError, fetchAdmin, fetchSeating, fetchSeatingFloors } from "@/lib/api";
import SeatingEditor from "./SeatingEditor";
import styles from "./seating.module.css";

export const metadata: Metadata = { title: "좌석 배치 편집 · 오피스 안내" };

// ⑤ 좌석 배치 편집. 주소의 ?floor=층ID 로 층을 고른다. 없거나 내 범위가 아니면 맡은 층 중 첫 층
export default async function SeatingPage({ searchParams }: PageProps<"/admin/seating">) {
  const cookieHeader = (await headers()).get("cookie");
  const params = await searchParams;
  let loaded;
  try {
    const [admin, { floors }] = await Promise.all([fetchAdmin(cookieHeader), fetchSeatingFloors(cookieHeader)]);
    if (!admin) redirect("/admin/login?reason=expired");
    const wanted = Number(params.floor) || null;
    const floor = floors.find((f) => f.id === wanted) ?? floors[0];
    loaded = floor
      ? {
          admin,
          data: await fetchSeating(cookieHeader, floor.id),
          notice:
            wanted !== null && floor.id !== wanted ? "고른 층은 내 관리 범위가 아니어서, 맡은 층을 열었어요." : null,
        }
      : null;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/admin/login?reason=expired");
    throw error;
  }

  if (!loaded) {
    return (
      <div className={styles.emptyPage}>
        <h1>좌석 배치 편집</h1>
        <p>배치를 편집할 수 있는 층이 없어요. 좌석이 있는 층의 관리 권한을 받으면 여기서 편집할 수 있어요.</p>
        <Link href="/admin">사업장·권한으로</Link>
      </div>
    );
  }
  return <SeatingEditor key={loaded.data.floor.id} admin={loaded.admin} initial={loaded.data} notice={loaded.notice} />;
}
