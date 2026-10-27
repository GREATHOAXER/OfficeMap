import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { isCompanyWide } from "@/lib/admin";
import { ApiError, fetchAdmin, fetchPersonnelMoves } from "@/lib/api";
import { redirectToAdminLogin } from "@/lib/expiredRedirect";
import ui from "../seating/seating.module.css";
import PersonnelWizard from "./PersonnelWizard";

export const metadata: Metadata = { title: "인사이동 · 오피스 안내" };

// 인사이동: 발령 엑셀로 여러 사람의 소속을 한 번에 바꾸고 새 팀 구역에 자리를 정한다. 최종·전사 관리자 (조직도와 같다)
export default async function PersonnelPage() {
  const cookieHeader = (await headers()).get("cookie");
  let loaded;
  try {
    const admin = await fetchAdmin(cookieHeader);
    if (!admin) return redirectToAdminLogin();
    loaded = { admin, moves: isCompanyWide(admin) ? (await fetchPersonnelMoves(cookieHeader)).moves : null };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return redirectToAdminLogin();
    throw error;
  }

  if (!loaded.moves) {
    return (
      <div className={ui.emptyPage}>
        <h1>인사이동</h1>
        <p>인사이동(여러 사람의 소속을 한 번에 바꾸기)은 최종·전사 관리자가 할 수 있어요.</p>
        <Link href="/admin">사업장·권한으로</Link>
      </div>
    );
  }
  return <PersonnelWizard admin={loaded.admin} moves={loaded.moves} />;
}
