"use client";

import { useState } from "react";
import Dialog from "@/components/Dialog";
import type { DepartmentChoice, SeatingZone } from "@/lib/api";
import { isCustomColor, ZONE_PALETTE, zoneColorVars } from "@/lib/zoneColors";
import styles from "./seating.module.css";

const CUSTOM_DEFAULT = "#2f7d5b"; // "직접 고르기"를 처음 눌렀을 때의 색
const CODES = "ABCDEFGHIJKLMNOPQRSTUVWXY".split("");

export type ZoneDialogState = { mode: "create" } | { mode: "edit"; zone: SeatingZone };

type ZoneResult = {
  zone?: { id: number; code: string; name: string };
  seats?: number;
  unassigned?: number;
  revoked?: number;
  detail?: { code?: string };
};

type Props = {
  state: ZoneDialogState;
  floorId: number;
  floorName: string;
  zones: SeatingZone[];
  departments: DepartmentChoice[];
  /** 지울 구역에 지금(바꾼 것 포함) 좌석·앉은 사람이 얼마나 있나 */
  statsOf: (zoneId: number) => { seats: number; people: number };
  onClose: () => void;
  onDone: (result: { message: string; zoneId?: number }) => void;
  onExpired: () => void;
};

/** 팀 구역 추가 · 고치기 · 없애기 (층 관리자 이상). 좌석을 구역에 넣는 것은 배치 화면의 "팀 구역 지정" 도구로 한다 */
export default function ZoneDialog(props: Props) {
  const { state, floorId, floorName, zones, statsOf, onClose, onDone, onExpired } = props;
  const editing = state.mode === "edit" ? state.zone : null;
  // 고르는 목록은 아래 부서가 없는 팀이다. 고치는 구역의 지금 부서가 목록에 없으면(아래 부서가 생겼거나 없어진 부서)
  // 그 부서도 넣어 둔다: 안 그러면 "공용 (부서 없음)"으로 보이고, 그대로 저장하면 공용 구역이 된다
  const departments =
    editing?.department_id && editing.department && !props.departments.some((d) => d.id === editing.department_id)
      ? [...props.departments, { id: editing.department_id, name: editing.department, parent: "지금 부서" }]
      : props.departments;
  const others = zones.filter((z) => z.id !== editing?.id);
  const usedColors = new Set(others.map((z) => z.color_key));
  const [departmentId, setDepartmentId] = useState<string>(editing?.department_id ? String(editing.department_id) : "");
  const [name, setName] = useState(editing?.name_custom ? editing.name : "");
  const [code, setCode] = useState(editing?.code ?? CODES.find((c) => !others.some((z) => z.code === c)) ?? "");
  const [color, setColor] = useState<string>(
    editing?.color_key ?? ZONE_PALETTE.find((c) => c.key !== "t0" && !usedColors.has(c.key))?.key ?? "t1",
  );
  // 직접 고른 색: 기본 색으로 바꿨다가 다시 "직접 고르기"를 눌러도 고른 색이 남아 있게 따로 둔다
  const [customHex, setCustomHex] = useState(isCustomColor(editing?.color_key) ? editing.color_key : CUSTOM_DEFAULT);
  const custom = isCustomColor(color);
  const sameColor = others.filter((z) => z.color_key.toLowerCase() === color.toLowerCase()).map((z) => z.name);
  const [view, setView] = useState<"form" | "delete">("form");
  const [mergeInto, setMergeInto] = useState("");
  const [unassign, setUnassign] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const department = departments.find((d) => String(d.id) === departmentId);
  const codeClash = others.find((z) => z.code === code.trim().toUpperCase());

  async function send(path: string, method: string, body: unknown): Promise<{ ok: boolean; data: ZoneResult | null }> {
    setBusy(true);
    try {
      const res = await fetch(path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 401) onExpired();
      return { ok: res.ok, data: await res.json().catch(() => null) };
    } catch {
      return { ok: false, data: null };
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const cleanCode = code.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9]?$/.test(cleanCode)) {
      setError("코드는 영문 대문자 한 글자(또는 글자+숫자)로 적어 주세요. 예: A, D, S1");
      return;
    }
    if (codeClash) {
      setError(`${cleanCode}는 이 층의 ${codeClash.name}이 쓰고 있어요. 다른 코드를 고르세요`);
      return;
    }
    if (!department && !name.trim()) {
      setError("공용 구역은 이름을 적어 주세요. 예: 공용 자율석, 교육장");
      return;
    }
    const body = {
      code: cleanCode,
      department_id: department?.id ?? null,
      color_key: color,
      name: name.trim() || null,
    };
    const res = editing
      ? await send(`/api/admin/zones/${editing.id}`, "PATCH", body)
      : await send(`/api/admin/floors/${floorId}/zones`, "POST", body);
    const zone = res.data?.zone;
    if (!res.ok || !zone) {
      setError(
        res.data?.detail?.code === "CODE_TAKEN" ? "이미 쓰는 코드예요" : "저장하지 못했어요. 잠시 뒤 다시 시도하세요",
      );
      return;
    }
    const label = `${zone.name} · ${zone.code}구역`;
    onDone(
      editing
        ? { message: `${label}: 고쳤어요` }
        : { message: `${label}: 만들었어요 · 넣을 좌석을 누르거나 끌어서 묶으세요`, zoneId: zone.id },
    );
  }

  async function remove() {
    if (!editing) return;
    const res = await send(`/api/admin/zones/${editing.id}/delete`, "POST", {
      merge_into: mergeInto ? Number(mergeInto) : null,
      unassign,
    });
    const r = res.data;
    if (!res.ok || !r) {
      setError(
        r?.detail?.code === "SCHEDULED"
          ? "날짜를 정해 둔 변경이 걸린 좌석이 있어요. 요청 목록에서 예정을 먼저 취소하세요"
          : "없애지 못했어요. 잠시 뒤 다시 시도하세요",
      );
      return;
    }
    onDone({
      message: `${editing.name} · ${editing.code}구역: 없앴어요 (좌석 ${r.seats}석${
        r.unassigned ? ` · 미배치 ${r.unassigned}명` : ""
      }${r.revoked ? ` · 구역 관리자 권한 ${r.revoked}건 회수` : ""})`,
    });
  }

  if (view === "delete" && editing) {
    const stats = statsOf(editing.id);
    return (
      <Dialog
        open
        onClose={onClose}
        title={`${editing.name} · ${editing.code}구역 없애기`}
        footer={
          <>
            <button type="button" className={styles.btn} onClick={() => setView("form")}>
              돌아가기
            </button>
            <button
              type="button"
              className={`${styles.btn} ${styles.danger}`}
              disabled={busy}
              onClick={() => void remove()}
            >
              구역 없애기
            </button>
          </>
        }
      >
        <div className={styles.dialogBody}>
          <p className={styles.lockNote}>
            좌석 {stats.seats}석 · 앉아 있는 사람 {stats.people}명
            {editing.managers.length > 0 && ` · 구역 관리자 ${editing.managers.join(", ")} (권한이 회수돼요)`}
          </p>
          <fieldset className={styles.when}>
            <legend>좌석은</legend>
            <label>
              <input type="radio" name="seats" checked={!mergeInto} onChange={() => setMergeInto("")} />
              구역 없는 좌석으로 두기
            </label>
            <label>
              <input
                type="radio"
                name="seats"
                checked={!!mergeInto}
                disabled={others.length === 0}
                onChange={() => setMergeInto(String(others[0]?.id ?? ""))}
              />
              다른 구역에 합치기
              <select
                className={styles.select}
                value={mergeInto}
                aria-label="합칠 구역"
                disabled={others.length === 0}
                onChange={(e) => setMergeInto(e.target.value)}
              >
                <option value="">고르세요</option>
                {others.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.name} · {z.code}
                  </option>
                ))}
              </select>
            </label>
          </fieldset>
          <fieldset className={styles.when}>
            <legend>앉아 있는 사람은</legend>
            <label>
              <input type="radio" name="people" checked={!unassign} onChange={() => setUnassign(false)} />그 자리 그대로
            </label>
            <label>
              <input type="radio" name="people" checked={unassign} onChange={() => setUnassign(true)} />
              모두 미배치로 (자리 배정이 끝나고, 각자 팀의 미배치 인원이 돼요)
            </label>
          </fieldset>
          <p className={styles.hint}>바로 반영되고 직원 화면에도 바로 보여요. 작업 묶음과 달리 되돌리기가 없어요.</p>
          {error && (
            <p className={styles.fieldError} role="alert">
              {error}
            </p>
          )}
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={editing ? `${floorName} ${editing.name} · ${editing.code}구역` : `${floorName} 팀 구역 추가`}
      footer={
        <>
          {editing && (
            <button
              type="button"
              className={`${styles.btn} ${styles.ghost} ${styles.footLeft}`}
              onClick={() => setView("delete")}
            >
              구역 없애기…
            </button>
          )}
          <button type="button" className={styles.btn} onClick={onClose}>
            취소
          </button>
          <button type="button" className={`${styles.btn} ${styles.pri}`} disabled={busy} onClick={() => void save()}>
            {editing ? "저장" : "만들기"}
          </button>
        </>
      }
    >
      <div className={styles.dialogBody}>
        <label className={styles.field}>
          <span>부서 (조직도)</span>
          <select
            data-autofocus
            className={styles.select}
            value={departmentId}
            onChange={(e) => {
              setDepartmentId(e.target.value);
              if (!e.target.value && !editing) setColor("t0");
              setError(null);
            }}
          >
            <option value="">공용 (부서 없음)</option>
            {[...new Set(departments.map((d) => d.parent ?? ""))].map((parent) => (
              <optgroup key={parent} label={parent || "본부"}>
                {departments
                  .filter((d) => (d.parent ?? "") === parent)
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
          {editing && !editing.department_active && (
            <span className={styles.conflictText}>
              지금 부서는 조직도에서 없어졌어요. 다른 부서를 고르거나 구역을 없애세요
            </span>
          )}
        </label>
        <label className={styles.field}>
          <span>이름</span>
          <input
            className={styles.textInput}
            value={name}
            maxLength={100}
            placeholder={department ? department.name : "예: 공용 자율석, 교육장"}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
          />
          <span className={styles.hint}>
            {department
              ? "비우면 부서 이름을 따라가요 (조직도에서 이름이 바뀌면 같이 바뀌어요)"
              : "공용 구역은 이름이 필요해요"}
          </span>
        </label>
        <label className={styles.field}>
          <span>코드 (층 안에서 겹치지 않게)</span>
          <input
            className={`${styles.textInput} mono`}
            value={code}
            maxLength={2}
            aria-invalid={!!codeClash || undefined}
            onChange={(e) => {
              setCode(e.target.value.toUpperCase());
              setError(null);
            }}
          />
          {codeClash && <span className={styles.conflictText}>{codeClash.name}이 쓰고 있어요</span>}
        </label>
        {/* legend는 화면 낭독기용만: fieldset 안을 grid로 놓고 legend를 보이면 Safari에서 칸이 어긋난다 */}
        <fieldset className={styles.colors}>
          <legend className="visually-hidden">도면 색</legend>
          <span className={styles.colorsLabel} aria-hidden="true">
            도면 색
          </span>
          <div className={styles.colorGrid}>
            {ZONE_PALETTE.map((c) => {
              const usedBy = others.filter((z) => z.color_key === c.key).map((z) => z.name);
              return (
                <label
                  key={c.key}
                  className={styles.colorOption}
                  data-color={c.key}
                  data-checked={color === c.key || undefined}
                  title={usedBy.length ? `쓰는 구역: ${usedBy.join(", ")}` : undefined}
                >
                  <input type="radio" name="color" checked={color === c.key} onChange={() => setColor(c.key)} />
                  <span className={styles.swatch} aria-hidden="true" />
                  {c.label}
                  {usedBy.length > 0 && <span className={styles.colorUsed}>쓰는 중</span>}
                </label>
              );
            })}
            <label
              className={styles.colorOption}
              data-color={customHex}
              style={zoneColorVars(customHex)}
              data-checked={custom || undefined}
            >
              <input type="radio" name="color" checked={custom} onChange={() => setColor(customHex)} />
              <input
                type="color"
                className={styles.colorInput}
                aria-label="직접 고를 색"
                value={customHex}
                onChange={(e) => {
                  setCustomHex(e.target.value);
                  setColor(e.target.value);
                }}
              />
              직접 고르기
            </label>
          </div>
          <p className={styles.hint}>
            {sameColor.length > 0
              ? `같은 색을 쓰는 구역: ${sameColor.join(", ")} (도면에서 구분이 어려울 수 있어요)`
              : custom
                ? "너무 밝은 색은 도면에서 잘 보이게 테두리만 조금 진하게 그려요."
                : "같은 층의 다른 구역과 다른 색을 고르면 도면에서 구분하기 쉬워요."}
          </p>
        </fieldset>
        {!editing && (
          <p className={styles.hint}>
            빈 구역으로 만들어져요. 만든 뒤 도면에서 좌석을 누르거나 끌어서 묶고 반영하면 직원 화면에 보여요.
          </p>
        )}
        {error && (
          <p className={styles.fieldError} role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
