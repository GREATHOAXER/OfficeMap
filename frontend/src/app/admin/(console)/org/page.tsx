import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ApiError, fetchAdmin, fetchOrg } from "@/lib/api";
import OrgView from "./OrgView";

export const metadata: Metadata = { title: "조직도 · 오피스 안내" };

// 조직도: 부서 나무, 부서마다 팀원. 고치기는 전사 관리자, 보기는 관리자 누구나. ?dept=부서ID 로 고른 부서
export default async function OrgPage({ searchParams }: PageProps<"/admin/org">) {
  const cookieHeader = (await headers()).get("cookie");
  const params = await searchParams;
  let loaded;
  try {
    const [admin, org] = await Promise.all([fetchAdmin(cookieHeader), fetchOrg(cookieHeader)]);
    if (!admin) redirect("/admin/login?reason=expired");
    loaded = { admin, org };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/admin/login?reason=expired");
    throw error;
  }
  const wanted = Number(params.dept) || null;
  return <OrgView admin={loaded.admin} initial={loaded.org} initialDept={wanted} />;
}
