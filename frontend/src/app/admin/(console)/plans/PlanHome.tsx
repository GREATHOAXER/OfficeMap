"use client";

import Link from "next/link";
import type { Admin, PlanFloor } from "@/lib/api";
import { agoText } from "@/lib/dates";
import { useNow } from "@/lib/useNow";
import SiteFold from "../SiteFold";
import ui from "../seating/seating.module.css";
import styles from "./plans.module.css";

/** 층의 도면 상태와 그 층을 열면 할 일 */
function floorState(f: PlanFloor): { label: string; action: string; tone?: "draft" | "scheduled" | "none" } {
  if (f.scheduled) return { label: "게시 예약", action: "예약 보기", tone: "scheduled" };
  if (f.drafting) return { label: "초안 있음", action: "이어서 편집", tone: "draft" };
  if (f.published) return { label: "게시됨", action: "초안 만들어 고치기" };
  return { label: "도면 없음", action: "도면 만들기", tone: "none" };
}

/** ⑥ 도면 편집 첫 화면: 사업장별로 편집할 수 있는 층과 도면 상태를 보고 층을 고른다 (왼쪽 메뉴 "도면 편집") */
export default function PlanHome({ admin, floors }: { admin: Admin; floors: PlanFloor[] }) {
  const now = useNow();
  const sites = [...new Map(floors.map((f) => [f.site_id, f.site])).entries()];
  return (
    <main className={ui.page}>
      <header className={ui.header}>
        <div className={ui.titleRow}>
          <h1 className={ui.title}>도면 편집</h1>
          <span className={ui.roleChip}>
            <strong>{admin.role_label}</strong>
          </span>
        </div>
      </header>
      <div className={styles.start}>
        <p className={styles.homeLead}>
          고칠 층을 고르세요. 초안은 게시하기 전까지 직원 화면에 보이지 않고, 고친 내용은 자동 저장돼서 언제든 이어서
          고칠 수 있어요.
        </p>
        {/* 사업장이 여럿이면 접어 두고, 사업장 이름을 누르면 그 사업장의 층이 펼쳐진다 */}
        {sites.map(([siteId, site]) => {
          const siteFloors = floors.filter((f) => f.site_id === siteId);
          const drafts = siteFloors.filter((f) => f.drafting).length;
          return (
            <SiteFold
              key={siteId}
              id={`plan-site-${siteId}`}
              className={styles.homeSite}
              headClassName={styles.homeSiteHead}
              defaultOpen={sites.length === 1}
              title={site}
              head={
                <span className={styles.homeSiteMeta}>
                  층 {siteFloors.length}개{drafts > 0 ? ` · 초안 ${drafts}개` : ""}
                </span>
              }
            >
              <ul className={styles.homeFloors}>
                {siteFloors.map((f) => {
                  const state = floorState(f);
                  const saved = f.drafting && f.draft_updated_at ? agoText(f.draft_updated_at, now) : "";
                  return (
                    <li key={f.id}>
                      <Link href={`/admin/plans?floor=${f.id}`} className={styles.homeFloor} data-tone={state.tone}>
                        <strong>{f.name}</strong>
                        <span className={`${ui.statusChip} ${styles.homeChip}`}>{state.label}</span>
                        <span className={styles.homeMeta}>
                          {f.drafting
                            ? `마지막 저장${saved ? ` ${saved}` : ""}${f.draft_updated_by ? ` · ${f.draft_updated_by}` : ""}`
                            : f.published
                              ? "직원 화면에 보이는 도면이 있어요"
                              : "아직 그린 도면이 없어요"}
                        </span>
                        <span className={styles.homeAction}>{state.action} →</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </SiteFold>
          );
        })}
      </div>
    </main>
  );
}
