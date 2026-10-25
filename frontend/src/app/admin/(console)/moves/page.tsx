import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { ApiError, fetchAdmin, fetchMoveOptions } from "@/lib/api";
import { redirectToAdminLogin } from "@/lib/expiredRedirect";
import ui from "../seating/seating.module.css";
import MoveWizard from "./MoveWizard";

export const metadata: Metadata = { title: "팀 이사 · 오피스 안내" };

// 팀 이사 도우미: 한 팀을 다른 층(또는 같은 층의 다른 자리)으로 한 번에. 목적지 층의 층 관리자 이상
export default async function MovesPage() {
  const cookieHeader = (await headers()).get("cookie");
  let loaded;
  try {
    const [admin, options] = await Promise.all([fetchAdmin(cookieHeader), fetchMoveOptions(cookieHeader)]);
    if (!admin) return redirectToAdminLogin();
    loaded = { admin, options };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return redirectToAdminLogin();
    throw error;
  }

  if (loaded.options.floors.length === 0) {
    return (
      <div className={ui.emptyPage}>
        <h1>팀 이사</h1>
        <p>팀을 옮길 수 있는 층이 없어요. 팀 이사는 목적지 층의 층 관리자 이상이 할 수 있어요.</p>
        <Link href="/admin">사업장·권한으로</Link>
      </div>
    );
  }
  return <MoveWizard admin={loaded.admin} options={loaded.options} />;
}
