"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { PlanEditorData } from "@/lib/api";
import { agoText, kstDate } from "@/lib/dates";
import { MAX_SIZE, MIN_SIZE } from "@/lib/planGeometry";
import { useNow } from "@/lib/useNow";
import ui from "../seating/seating.module.css";
import ImportWizard from "./ImportWizard";
import { EXPIRED, Header, json, type ScreenProps } from "./shared";
import styles from "./plans.module.css";

// 시작 화면 --------------------------------------------------------------------

export default function StartScreen({ admin, data, setData, reload, showToast, goFloor, notice }: ScreenProps) {
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState(String(data.sources[0]?.id ?? ""));
  const [archived, setArchived] = useState(String(data.archived[0]?.id ?? ""));
  const [importing, setImporting] = useState(false);
  const router = useRouter();
  const now = useNow();
  const pub = data.published;
  // 빈 도면의 크기 (m): 실제 사무실 크기를 넣으면 책상·회의실이 그 크기에 맞는 비율로 그려진다
  const [blank, setBlank] = useState({ w: String(data.size.width_m), h: String(data.size.height_m) });
  const blankW = Number(blank.w);
  const blankH = Number(blank.h);
  const sizeOk = [blankW, blankH].every((v) => Number.isFinite(v) && v >= MIN_SIZE && v <= MAX_SIZE);

  async function create(body: {
    source: string;
    plan_id?: number;
    floor_id?: number;
    width_m?: number;
    height_m?: number;
  }) {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/floors/${data.floor.id}/plan/draft`, {
        method: "POST",
        headers: json,
        body: JSON.stringify(body),
      });
      if (res.status === 401) {
        router.replace(EXPIRED);
        return;
      }
      const out = await res.json().catch(() => null);
      if (!res.ok) {
        if (out?.detail?.code === "HAS_DRAFT") {
          showToast("그새 다른 관리자가 초안을 만들었어요. 그 초안을 열었어요");
          await reload();
        } else showToast("초안을 만들지 못했어요. 잠시 뒤 다시 시도하세요", "error");
        return;
      }
      setData(out as PlanEditorData);
      showToast("초안을 만들었어요. 게시하기 전까지 직원 화면에는 보이지 않아요");
    } catch {
      showToast("네트워크 오류로 초안을 만들지 못했어요", "error");
    } finally {
      setBusy(false);
    }
  }

  const versionText = (p: { version: number; published_at: string | null; published_by: string | null }) =>
    `v${p.version}${p.published_at ? ` · ${kstDate(p.published_at)}` : ""}${p.published_by ? ` · ${p.published_by}` : ""}`;

  return (
    <>
      <Header admin={admin} data={data} goFloor={goFloor} />
      <p className={ui.infoBar}>
        {data.floor.name}에는 편집 중인 초안이 없어요. 어디서 시작할지 고르세요. 초안은 게시하기 전까지 직원 화면에
        보이지 않고, 게시하면 좌석·회의실이 초안에 맞춰져요.
      </p>
      {notice && <p className={ui.notice}>{notice}</p>}
      {data.background && (
        <p className={ui.notice}>
          이 층에는 밑그림({data.background.name ?? "도면 파일"})이 있어서, 어떻게 시작해도 편집 화면에 깔려요.
        </p>
      )}
      <div className={styles.start}>
        <div className={styles.startGrid}>
          <section className={styles.startCard} data-main={pub ? true : undefined}>
            <h3>지금 게시본에서</h3>
            <p>
              {pub
                ? `${versionText(pub)}. 지금 도면을 그대로 가져와 고쳐요. 책상·회의실이 지금 좌석·예약과 이어져 있어, 옮기거나 번호를 바꿔도 앉은 사람은 그대로예요.`
                : "아직 게시한 도면이 없어요."}
            </p>
            <button
              type="button"
              className={`${ui.btn} ${ui.pri}`}
              disabled={!pub || busy}
              onClick={() => void create({ source: "published" })}
            >
              게시본으로 초안 만들기
            </button>
          </section>
          <section className={styles.startCard} data-main={pub ? undefined : true}>
            <h3>도면 파일로 시작</h3>
            <p>
              그림(PNG·JPG)·PDF·엑셀 도면에서 벽·기둥·방 이름·좌석 번호를 찾아 초안을 만들어요. PDF·엑셀에 층이 여러
              개면 쪽(시트)마다 층을 골라 한 번에 만들 수 있고, 도면 그림은 밑그림으로 깔려 보면서 고칠 수 있어요.
              {pub && " 게시하면 지금 좌석은 모두 없어지고, 앉은 사람은 게시할 때 새 자리를 고르거나 미배치가 돼요."}
            </p>
            <button
              type="button"
              className={`${ui.btn} ${pub ? "" : ui.pri}`}
              disabled={busy}
              onClick={() => setImporting(true)}
            >
              도면 파일 고르기…
            </button>
          </section>
          <section className={styles.startCard}>
            <h3>빈 도면</h3>
            <p>
              바깥 벽만 있어요. 실제 사무실 크기를 넣으면 책상(기본 2.665 × 1.668 m)이 그 크기에 맞게 그려져요.
              {pub && " 게시하면 지금 좌석은 모두 없어지고, 앉은 사람은 게시할 때 새 자리를 고르거나 미배치가 돼요."}
            </p>
            <div className={styles.numbers}>
              <label>
                사무실 폭 (m)
                <input
                  type="number"
                  inputMode="decimal"
                  min={MIN_SIZE}
                  max={MAX_SIZE}
                  step={0.5}
                  value={blank.w}
                  aria-invalid={!sizeOk || undefined}
                  onChange={(e) => setBlank({ ...blank, w: e.target.value })}
                />
              </label>
              <label>
                사무실 높이 (m)
                <input
                  type="number"
                  inputMode="decimal"
                  min={MIN_SIZE}
                  max={MAX_SIZE}
                  step={0.5}
                  value={blank.h}
                  aria-invalid={!sizeOk || undefined}
                  onChange={(e) => setBlank({ ...blank, h: e.target.value })}
                />
              </label>
            </div>
            {!sizeOk && (
              <p className={ui.conflictText}>
                {MIN_SIZE}~{MAX_SIZE} m 사이로 넣으세요
              </p>
            )}
            <button
              type="button"
              className={ui.btn}
              disabled={busy || !sizeOk}
              onClick={() => void create({ source: "blank", width_m: blankW, height_m: blankH })}
            >
              빈 도면으로 시작
            </button>
          </section>
          <section className={styles.startCard}>
            <h3>다른 층 복제</h3>
            <p>다른 층 게시본의 모양만 가져와요. 지금 좌석과는 이어지지 않아, 좌석 번호를 확인하고 게시하세요.</p>
            <select
              className={ui.select}
              aria-label="복제할 층"
              value={source}
              disabled={data.sources.length === 0}
              onChange={(e) => setSource(e.target.value)}
            >
              {data.sources.length === 0 && <option value="">복제할 층이 없어요</option>}
              {data.sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.site} {s.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={ui.btn}
              disabled={!source || busy}
              onClick={() => void create({ source: "floor", floor_id: Number(source) })}
            >
              복제해서 시작
            </button>
          </section>
          <section className={styles.startCard}>
            <h3>보관본에서 다시 시작</h3>
            <p>예전에 게시했던 도면으로 돌아가요. 게시해야 직원 화면이 바뀌어요.</p>
            <select
              className={ui.select}
              aria-label="보관본"
              value={archived}
              disabled={data.archived.length === 0}
              onChange={(e) => setArchived(e.target.value)}
            >
              {data.archived.length === 0 && <option value="">보관본이 없어요</option>}
              {data.archived.map((p) => (
                <option key={p.id} value={p.id}>
                  {versionText(p)}
                  {p.note ? ` · ${p.note}` : ""}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={ui.btn}
              disabled={!archived || busy}
              onClick={() => void create({ source: "archived", plan_id: Number(archived) })}
            >
              이 보관본으로 시작
            </button>
          </section>
        </div>

        {importing && (
          <ImportWizard
            mode="start"
            data={data}
            onClose={() => setImporting(false)}
            onExpired={() => router.replace(EXPIRED)}
            onCreated={(floors) => {
              const names = floors.map((f) => f.name).join(", ");
              const here = floors.some((f) => f.id === data.floor.id);
              if (here) setImporting(false);
              showToast(
                here
                  ? `${floors.length}개 층(${names}) 초안을 만들었어요. 밑그림을 보며 고치고 게시하세요`
                  : `${floors.length}개 층(${names}) 초안을 만들었어요. 위 층 고르기에서 열어 보세요`,
              );
              void reload();
            }}
          />
        )}

        {(pub || data.archived.length > 0) && (
          <section className={ui.card} aria-labelledby="plan-history">
            <h2 id="plan-history" className={ui.cardTitle}>
              게시 기록
            </h2>
            <ul className={styles.history}>
              {[
                ...(pub ? [{ ...pub, current: true }] : []),
                ...data.archived.map((p) => ({ ...p, current: false })),
              ].map((p) => (
                <li key={p.id}>
                  <strong>v{p.version}</strong>
                  <span>{p.current ? "지금 게시본" : "보관본"}</span>
                  <span className={ui.muted}>
                    {p.published_at ? `${kstDate(p.published_at)} (${agoText(p.published_at, now)})` : ""}
                    {p.published_by ? ` · ${p.published_by}` : ""}
                  </span>
                  {p.note && <span>“{p.note}”</span>}
                </li>
              ))}
            </ul>
            <p className={ui.hint}>보관본은 5년 동안 남아요.</p>
          </section>
        )}
      </div>
    </>
  );
}
