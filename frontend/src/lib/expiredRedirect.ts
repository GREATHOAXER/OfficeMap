import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { fetchLogoutReason } from "./api";
import { loginUrl } from "./loginRedirect";

/**
 * 서버에서 화면을 그리다 로그인이 끊긴 것(401)을 알았을 때: 보던 화면(next)과 끊긴 이유를 붙여 로그인 화면으로.
 * 메뉴를 눌러 옮겨 갈 때는 레이아웃이 다시 그려지지 않고 페이지만 그려져서, 페이지가 직접 보낸다
 */
export async function redirectToLogin(): Promise<never> {
  const headerList = await headers();
  const cookieHeader = headerList.get("cookie");
  redirect(loginUrl("/login", headerList.get("x-pathname"), (await fetchLogoutReason(cookieHeader)) ?? "expired"));
}
