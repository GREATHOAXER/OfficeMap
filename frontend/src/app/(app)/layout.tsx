import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import AppShell from "@/components/AppShell";
import { fetchMe, fetchSites, type SiteSummary } from "@/lib/api";
import { SIDEBAR_COOKIE } from "@/lib/sidebar";

// 로그인한 사람만 보는 화면들의 공통 틀: 왼쪽 메뉴 + 본문
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const cookieHeader = (await headers()).get("cookie");
  const user = await fetchMe(cookieHeader);
  if (!user) redirect("/login");

  let sites: SiteSummary[] = [];
  let myFloorId: number | null = null;
  try {
    ({ sites, my_floor_id: myFloorId } = await fetchSites(cookieHeader));
  } catch {
    // 사업장 목록을 못 읽어도 메뉴는 그린다. 본문 쪽에서 오류를 보여 준다
  }
  // 쿠키가 없으면 null: 화면 폭에 맞춰 CSS가 정한다
  const saved = (await cookies()).get(SIDEBAR_COOKIE)?.value;
  const collapsed = saved === "collapsed" ? true : saved === "expanded" ? false : null;
  // 주소에 사업장·층이 없을 때 고른 것으로 보여 줄 사업장: 내 자리가 있는 곳
  const defaultSiteId = sites.find((s) => s.floors.some((f) => f.id === myFloorId))?.id ?? sites[0]?.id ?? null;

  return (
    <AppShell user={user} sites={sites} defaultSiteId={defaultSiteId} initialCollapsed={collapsed}>
      {children}
    </AppShell>
  );
}
