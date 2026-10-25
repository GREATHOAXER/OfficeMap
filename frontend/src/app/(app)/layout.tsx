import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import AppShell from "@/components/AppShell";
import { fetchLogoutReason, fetchMe, fetchSites, SESSION_COOKIE, type SiteSummary } from "@/lib/api";
import { loginUrl } from "@/lib/loginRedirect";
import { SIDEBAR_COOKIE } from "@/lib/sidebar";

// 로그인한 사람만 보는 화면들의 공통 틀: 왼쪽 메뉴 + 본문
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const headerList = await headers();
  const cookieHeader = headerList.get("cookie");
  const user = await fetchMe(cookieHeader);
  if (!user) {
    // 로그인 쿠키가 남아 있는데 안 되면 끊긴 것: 왜 끊겼는지(오래 쓰지 않음, 비밀번호 초기화 …) 알려 주고
    // 로그인 후 보던 화면으로 돌아오게 한다
    const ended = (await cookies()).has(SESSION_COOKIE);
    const reason = ended ? ((await fetchLogoutReason(cookieHeader)) ?? "expired") : null;
    redirect(loginUrl("/login", headerList.get("x-pathname"), reason));
  }
  // 임시 비밀번호 상태면 새 비밀번호를 정하기 전에는 다른 화면에 못 간다. 정하고 나면 가려던 화면으로
  if (user.must_change_password) {
    const back = headerList.get("x-pathname");
    redirect(back && back !== "/" ? `/password?next=${encodeURIComponent(back)}` : "/password");
  }

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
    <AppShell variant="app" user={user} sites={sites} defaultSiteId={defaultSiteId} initialCollapsed={collapsed}>
      {children}
    </AppShell>
  );
}
