import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { ApiError, fetchAdmin, fetchPlanEditor, fetchPlanFloors } from "@/lib/api";
import { redirectToAdminLogin } from "@/lib/expiredRedirect";
import ui from "../seating/seating.module.css";
import PlanEditor from "./PlanEditor";
import PlanHome from "./PlanHome";

export const metadata: Metadata = { title: "도면 편집 · Office Map" };

// ⑥ 도면 편집 (층 관리자 이상). 주소에 ?floor=층ID 가 없으면 첫 화면(층 고르기),
// 있으면 그 층의 편집 화면. 내 범위가 아닌 층이면 맡은 층 중 첫 층
export default async function PlansPage({ searchParams }: PageProps<"/admin/plans">) {
  const cookieHeader = (await headers()).get("cookie");
  const params = await searchParams;
  let loaded;
  try {
    const [admin, { floors }] = await Promise.all([fetchAdmin(cookieHeader), fetchPlanFloors(cookieHeader)]);
    if (!admin) return redirectToAdminLogin();
    const wanted = Number(params.floor) || null;
    const floor = floors.find((f) => f.id === wanted) ?? floors[0];
    if (!floor) loaded = null;
    else if (wanted === null) loaded = { admin, floors, data: null, notice: null };
    else
      loaded = {
        admin,
        floors,
        data: await fetchPlanEditor(cookieHeader, floor.id),
        notice: floor.id !== wanted ? "고른 층은 도면을 편집할 수 있는 범위가 아니어서, 맡은 층을 열었어요." : null,
      };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return redirectToAdminLogin();
    throw error;
  }

  if (!loaded) {
    return (
      <div className={ui.emptyPage}>
        <h1>도면 편집</h1>
        <p>도면을 편집할 수 있는 층이 없어요. 도면 편집은 층 관리자 이상이 할 수 있어요.</p>
        <Link href="/admin">사업장·권한으로</Link>
      </div>
    );
  }
  if (!loaded.data) return <PlanHome admin={loaded.admin} floors={loaded.floors} />;
  return <PlanEditor key={loaded.data.floor.id} admin={loaded.admin} initial={loaded.data} notice={loaded.notice} />;
}
