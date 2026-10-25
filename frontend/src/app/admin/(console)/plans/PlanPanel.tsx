"use client";

import { useState } from "react";
import type { DeskGroup, PlanEditorData, PlanElement, PlanGeometry, SpaceKind } from "@/lib/api";
import {
  countsOf,
  EQUIPMENT,
  type PlanProblem,
  renumber,
  resizeGroup,
  SPACE_KINDS,
  TYPE_LABEL,
  usedCodes,
} from "@/lib/planGeometry";
import ui from "../seating/seating.module.css";
import styles from "./plans.module.css";

const MAX_CELLS = 20; // 서버와 같은 한도 (줄·칸 각각)

type Props = {
  geometry: PlanGeometry;
  selected: PlanElement | null;
  width: number;
  height: number;
  live: PlanEditorData["live"];
  readOnly: boolean;
  problems: PlanProblem[];
  /** key: 같은 칸을 이어서 고치면(글자 입력) 되돌리기 한 번에 묶는다 */
  onChange: (el: PlanElement, key?: string) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onSelect: (id: string | null) => void;
  /** 바꾼 것 때문에 앉은 사람의 책상이 빠졌을 때 알림 */
  onNotice: (text: string) => void;
};

/** 오른쪽 칸: 고른 요소의 속성. 아무것도 고르지 않았으면 도면 요약과 게시 전에 고칠 것 */
export default function PlanPanel(props: Props) {
  const { selected } = props;
  if (!selected) return <Summary {...props} />;
  return <Properties key={selected.id} {...props} selected={selected} />;
}

function Summary({ geometry, width, height, live, problems, onSelect }: Props) {
  const counts = countsOf(geometry);
  const impact = impactOf(geometry, live);
  const kinds = { wall: 0, pillar: 0, space: 0 };
  for (const el of geometry.elements) if (el.type in kinds) kinds[el.type as keyof typeof kinds] += 1;
  return (
    <>
      <section className={ui.card} aria-label="도면 요약">
        <h2 className={ui.cardTitle}>
          도면 요약{" "}
          <span className="mono">
            {width} × {height} m
          </span>
        </h2>
        <dl className={styles.stats}>
          <dt>책상(좌석)</dt>
          <dd>{counts.desks}석</dd>
          <dt>회의실</dt>
          <dd>{counts.rooms}개</dd>
          <dt>벽 · 기둥 · 공간</dt>
          <dd>
            {kinds.wall} · {kinds.pillar} · {kinds.space}
          </dd>
        </dl>
        <p className={ui.hint}>요소를 누르면 여기서 크기·이름·좌석 번호를 고칠 수 있어요.</p>
      </section>
      <section className={ui.card} aria-label="게시하면 바뀌는 것">
        <h2 className={ui.cardTitle}>게시하면</h2>
        <dl className={styles.stats}>
          <dt>새 책상</dt>
          <dd>{impact.newDesks}석</dd>
          <dt>없어질 좌석</dt>
          <dd>
            {impact.removed.length}석{impact.displaced.length > 0 && ` · 앉은 사람 ${impact.displaced.length}명`}
          </dd>
          <dt>없어질 회의실</dt>
          <dd>
            {impact.roomsRemoved.length}개{impact.reservations > 0 && ` · 남은 예약 ${impact.reservations}건`}
          </dd>
        </dl>
        {impact.displaced.length > 0 && (
          <p className={styles.warn}>
            {impact.displaced.slice(0, 3).join(", ")}
            {impact.displaced.length > 3 && ` 외 ${impact.displaced.length - 3}명`} 님의 책상이 초안에 없어요. 게시할 때
            새 자리를 고르거나 미배치로 둘 수 있어요.
          </p>
        )}
      </section>
      <section className={ui.card} aria-label="게시 전에 고칠 것">
        <h2 className={ui.cardTitle}>게시 전에 고칠 것</h2>
        {problems.length === 0 ? (
          <p className={ui.hint}>없어요.</p>
        ) : (
          <ul className={styles.problemList}>
            {problems.map((p, i) => (
              <li key={`${p.elementId}-${i}`}>
                <button type="button" onClick={() => onSelect(p.elementId)}>
                  {p.text}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/** 초안을 게시하면 지금 좌석·회의실에 생기는 일 (서버의 게시 점검과 같은 기준, 화면에서 미리 본다) */
export function impactOf(geometry: PlanGeometry, live: PlanEditorData["live"]) {
  const desks = new Set<string>();
  const rooms = new Set<string>();
  for (const el of geometry.elements) {
    if (el.type === "desk_group") for (const c of el.cells) if (c.desk) desks.add(c.id);
    if (el.type === "room") rooms.add(el.id);
  }
  const removed = Object.entries(live.seats).filter(([key]) => !desks.has(key));
  const roomsRemoved = Object.entries(live.rooms).filter(([key]) => !rooms.has(key));
  return {
    newDesks: [...desks].filter((key) => !live.seats[key]).length,
    removed,
    displaced: removed.flatMap(([, s]) => (s.occupant ? [s.occupant] : [])),
    roomsRemoved,
    reservations: roomsRemoved.reduce((n, [, r]) => n + r.upcoming, 0),
  };
}

function Properties({
  geometry,
  selected,
  live,
  readOnly,
  problems,
  onChange,
  onDelete,
  onDuplicate,
  onNotice,
}: Props & { selected: PlanElement }) {
  const el = selected;
  const mine = problems.filter((p) => p.elementId === el.id);
  const set = (patch: Partial<PlanElement>, key?: string) =>
    onChange({ ...el, ...patch } as PlanElement, key && `${el.id}:${key}`);

  return (
    <section className={`${ui.card} ${ui.selected}`} aria-label={`${TYPE_LABEL[el.type]} 속성`}>
      <div className={ui.cardHead}>
        <h2 className={ui.cardTitle}>{titleOf(el)}</h2>
        {!readOnly && (
          <div className={ui.rowButtons}>
            <button type="button" className={ui.btn} onClick={onDuplicate} title="복제 (Ctrl+D)">
              복제
            </button>
            <button type="button" className={`${ui.btn} ${ui.ghost}`} onClick={onDelete} title="지우기 (Delete)">
              지우기
            </button>
          </div>
        )}
      </div>
      {mine.map((p, i) => (
        <p key={i} className={ui.conflictNote} role="alert">
          {p.text}
        </p>
      ))}
      <fieldset disabled={readOnly} className={ui.when}>
        <div className={styles.numbers}>
          <Num label="x (m)" value={el.x} onChange={(x) => set({ x }, "x")} />
          <Num label="y (m)" value={el.y} onChange={(y) => set({ y }, "y")} />
          {el.type !== "desk_group" && (
            <>
              <Num label="폭 (m)" value={el.w} min={0.1} onChange={(w) => set({ w }, "w")} />
              <Num label="높이 (m)" value={el.h} min={0.1} onChange={(h) => set({ h }, "h")} />
            </>
          )}
        </div>
        {el.type === "space" && (
          <>
            <label className={ui.field}>
              <span>종류</span>
              <select
                className={ui.select}
                value={el.kind}
                onChange={(e) => set({ kind: e.target.value as SpaceKind })}
              >
                {SPACE_KINDS.map((k) => (
                  <option key={k.kind} value={k.kind}>
                    {k.label}
                  </option>
                ))}
              </select>
            </label>
            <label className={ui.field}>
              <span>이름표 (비우면 종류 이름)</span>
              <input
                className={ui.textInput}
                value={el.label}
                maxLength={50}
                placeholder={SPACE_KINDS.find((k) => k.kind === el.kind)?.label}
                onChange={(e) => set({ label: e.target.value }, "label")}
              />
            </label>
          </>
        )}
        {el.type === "room" && (
          <>
            <label className={ui.field}>
              <span>회의실 이름 (층 안에서 겹치지 않게)</span>
              <input
                className={ui.textInput}
                value={el.name}
                maxLength={100}
                aria-invalid={mine.some((p) => p.text.includes("회의실")) || undefined}
                onChange={(e) => set({ name: e.target.value }, "name")}
              />
            </label>
            <div className={styles.numbers}>
              <Num
                label="정원 (명)"
                value={el.capacity}
                min={1}
                max={999}
                step={1}
                onChange={(capacity) => set({ capacity: Math.max(1, Math.round(capacity)) }, "capacity")}
              />
            </div>
            <fieldset className={ui.when}>
              <legend>장비</legend>
              <div className={styles.checks}>
                {EQUIPMENT.map((eq) => (
                  <label key={eq.key}>
                    <input
                      type="checkbox"
                      checked={el.equipment.includes(eq.key)}
                      onChange={(e) =>
                        set({
                          equipment: e.target.checked
                            ? [...el.equipment, eq.key]
                            : el.equipment.filter((k) => k !== eq.key),
                        })
                      }
                    />
                    {eq.label}
                  </label>
                ))}
              </div>
            </fieldset>
            <p className={ui.hint}>
              {live.rooms[el.id]
                ? `지금 회의실 ${live.rooms[el.id].name}${
                    live.rooms[el.id].upcoming ? ` · 남은 예약 ${live.rooms[el.id].upcoming}건` : ""
                  }. 이름·정원을 바꿔도 예약은 그대로 이어져요.`
                : "새 회의실이에요. 게시하면 예약할 수 있게 돼요."}
            </p>
          </>
        )}
        {el.type === "desk_group" && (
          <DeskGroupFields group={el} geometry={geometry} live={live} onChange={onChange} onNotice={onNotice} />
        )}
      </fieldset>
    </section>
  );
}

function titleOf(el: PlanElement): string {
  if (el.type === "space") return el.label || SPACE_KINDS.find((k) => k.kind === el.kind)?.label || "공간";
  if (el.type === "room") return el.name || "이름 없는 회의실";
  if (el.type === "desk_group") return `책상 묶음 ${el.rows}×${el.cols}`;
  return TYPE_LABEL[el.type];
}

function DeskGroupFields({
  group,
  geometry,
  live,
  onChange,
  onNotice,
}: {
  group: DeskGroup;
  geometry: PlanGeometry;
  live: PlanEditorData["live"];
  onChange: (g: DeskGroup, key?: string) => void;
  onNotice: (text: string) => void;
}) {
  const [cellId, setCellId] = useState<string | null>(null);
  const firstCode = group.cells.find((c) => c.desk && c.code)?.code ?? "N-01";
  const [prefix, setPrefix] = useState(
    firstCode.includes("-") ? firstCode.split("-")[0] : firstCode.replace(/\d+$/, ""),
  );
  const [start, setStart] = useState(1);
  const cell = group.cells.find((c) => c.id === cellId) ?? null;
  const seated = group.cells.filter((c) => live.seats[c.id]?.occupant);
  const desks = group.cells.filter((c) => c.desk).length;
  const others = usedCodes(geometry, group.id);

  function resize(rows: number, cols: number) {
    const r = Math.min(MAX_CELLS, Math.max(1, Math.round(rows) || 1));
    const c = Math.min(MAX_CELLS, Math.max(1, Math.round(cols) || 1));
    if (r === group.rows && c === group.cols) return;
    const next = resizeGroup(group, r, c, geometry);
    const kept = new Set(next.cells.map((cell) => cell.id));
    noticeLost(group.cells.filter((cell) => !kept.has(cell.id) && cell.desk));
    onChange(next);
  }

  function noticeLost(cells: DeskGroup["cells"]) {
    const names = cells.flatMap((cell) =>
      live.seats[cell.id]?.occupant ? [`${cell.code} ${live.seats[cell.id].occupant}`] : [],
    );
    if (names.length)
      onNotice(`${names.join(", ")} 님의 책상이 빠졌어요 · 게시할 때 새 자리를 고를 수 있어요 (되돌리기 Ctrl+Z)`);
  }

  function setCell(patch: Partial<DeskGroup["cells"][number]>, key?: string) {
    if (!cell) return;
    onChange(
      { ...group, cells: group.cells.map((c) => (c.id === cell.id ? { ...c, ...patch } : c)) },
      key && `${group.id}:${cell.id}:${key}`,
    );
  }

  return (
    <>
      <fieldset className={ui.when}>
        <legend>놓는 모양</legend>
        <label>
          <input
            type="radio"
            name={`layout-${group.id}`}
            checked={group.layout === "face"}
            onChange={() => onChange({ ...group, layout: "face" })}
          />
          마주보기 (두 줄씩 마주 앉기)
        </label>
        <label>
          <input
            type="radio"
            name={`layout-${group.id}`}
            checked={group.layout === "one"}
            onChange={() => onChange({ ...group, layout: "one" })}
          />
          한 방향 (모두 같은 쪽을 보기)
        </label>
      </fieldset>
      <div className={styles.numbers}>
        <Num
          label="줄"
          value={group.rows}
          min={1}
          max={MAX_CELLS}
          step={1}
          onChange={(rows) => resize(rows, group.cols)}
        />
        <Num
          label="칸"
          value={group.cols}
          min={1}
          max={MAX_CELLS}
          step={1}
          onChange={(cols) => resize(group.rows, cols)}
        />
      </div>

      <div>
        <p className={ui.hint}>
          책상 {desks}석{seated.length > 0 && ` · 앉은 사람 ${seated.length}명`} · 칸을 눌러 번호를 고치거나 책상을 빼요
        </p>
        <div
          className={styles.cellGrid}
          data-layout={group.layout}
          style={{ gridTemplateColumns: `repeat(${group.cols}, minmax(34px, 1fr))` }}
          role="group"
          aria-label="책상 칸"
        >
          {group.cells.map((c, i) => {
            const row = Math.floor(i / group.cols);
            const seat = live.seats[c.id];
            return (
              <button
                key={c.id}
                type="button"
                className={styles.cell}
                data-blank={!c.desk || undefined}
                data-occupied={(c.desk && seat?.occupant) || undefined}
                data-pair-end={(group.layout === "face" && row % 2 === 1 && row < group.rows - 1) || undefined}
                aria-pressed={c.id === cellId}
                title={c.desk ? `${c.code}${seat?.occupant ? ` · ${seat.occupant}` : ""}` : "책상 없음"}
                onClick={() => setCellId(c.id === cellId ? null : c.id)}
              >
                {c.desk ? c.code || "?" : "–"}
              </button>
            );
          })}
        </div>
      </div>

      {cell && (
        <div className={styles.cellEdit}>
          <label className={styles.checks}>
            <span>
              <input
                type="checkbox"
                checked={cell.desk}
                onChange={(e) => {
                  if (!e.target.checked) noticeLost([cell]);
                  setCell({ desk: e.target.checked });
                }}
              />{" "}
              이 칸에 책상 두기
            </span>
          </label>
          {cell.desk && (
            <label className={ui.field}>
              <span>좌석 번호</span>
              <input
                className={`${ui.textInput} mono`}
                value={cell.code}
                maxLength={20}
                aria-invalid={(!!cell.code.trim() && others.has(cell.code.trim())) || undefined}
                onChange={(e) => setCell({ code: e.target.value.toUpperCase() }, "code")}
              />
              {cell.code.trim() && others.has(cell.code.trim()) && (
                <span className={ui.conflictText}>다른 묶음에서 쓰는 번호예요</span>
              )}
            </label>
          )}
          <p className={ui.hint}>
            {live.seats[cell.id]
              ? live.seats[cell.id].occupant
                ? `지금 ${live.seats[cell.id].code} 자리 · ${live.seats[cell.id].occupant} 님. ${
                    cell.desk
                      ? "번호를 바꾸거나 묶음을 옮겨도 그대로 앉아 있어요."
                      : "책상을 빼면 게시할 때 새 자리를 골라야 해요."
                  }`
                : `지금 ${live.seats[cell.id].code} 자리 (빈 자리)`
              : "새 책상이에요. 게시하면 좌석이 생기고, 배치 화면에서 사람을 앉힐 수 있어요."}
          </p>
        </div>
      )}

      <div className={styles.inline}>
        <label>
          머리글자
          <input value={prefix} maxLength={8} onChange={(e) => setPrefix(e.target.value.toUpperCase())} />
        </label>
        <label>
          시작 번호
          <input
            type="number"
            min={1}
            max={999}
            value={start}
            onChange={(e) => setStart(Math.max(1, Number(e.target.value) || 1))}
          />
        </label>
        <button
          type="button"
          className={ui.btn}
          disabled={!prefix.trim()}
          onClick={() => onChange(renumber(group, prefix.trim(), start))}
        >
          번호 다시 매기기
        </button>
      </div>
      <p className={ui.hint}>
        줄 순서로 {prefix.trim() || "?"}-{String(start).padStart(2, "0")}부터 붙여요. 번호만 바뀌고 앉은 사람은
        그대로예요.
      </p>
    </>
  );
}

/** 숫자 칸. 입력 중에는 글자 그대로 두고, 숫자가 되면 바로 반영한다 */
function Num({
  label,
  value,
  onChange,
  min,
  max,
  step = 0.1,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  const shown = String(Math.round(value * 100) / 100);
  const [text, setText] = useState(shown);
  const [focused, setFocused] = useState(false);
  return (
    <label>
      {label}
      <input
        type="number"
        inputMode="decimal"
        step={step}
        min={min}
        max={max}
        value={focused ? text : shown}
        onFocus={() => {
          setText(shown);
          setFocused(true);
        }}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          setText(e.target.value);
          const v = Number(e.target.value);
          if (e.target.value.trim() === "" || !Number.isFinite(v)) return;
          if ((min !== undefined && v < min) || (max !== undefined && v > max)) return;
          onChange(v);
        }}
      />
    </label>
  );
}
