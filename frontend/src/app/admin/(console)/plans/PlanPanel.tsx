"use client";

import { useState } from "react";
import type { DeskGroup, PlanEditorData, PlanElement, PlanGeometry, SpaceKind, WallLine } from "@/lib/api";
import {
  type AlignMode,
  alignElements,
  boxOfAll,
  countsOf,
  DESK,
  DESK_RANGE,
  deskDims,
  distributeElements,
  EQUIPMENT,
  groupSize,
  hasLabel,
  hasLine,
  LABEL_RANGE,
  LINE_RANGE,
  lineLength,
  lineOf,
  MAX_SIZE,
  MIN_SIZE,
  moveElement,
  type PlanProblem,
  renumber,
  resizeGroup,
  rotateGroup,
  SPACE_KINDS,
  TYPE_LABEL,
  usedCodes,
} from "@/lib/planGeometry";
import ui from "../seating/seating.module.css";
import styles from "./plans.module.css";

const MAX_CELLS = 20; // 서버와 같은 한도 (줄·칸 각각)

type Props = {
  geometry: PlanGeometry;
  /** 고른 요소 (여러 개면 함께 고치는 칸) */
  selected: PlanElement[];
  width: number;
  height: number;
  live: PlanEditorData["live"];
  readOnly: boolean;
  problems: PlanProblem[];
  /** 고친 요소들. key: 같은 칸을 이어서 고치면(글자 입력) 되돌리기 한 번에 묶는다 */
  onChange: (els: PlanElement[], key?: string) => void;
  /** 도면 전체 설정 (새 책상 기본 크기) */
  onGeometry?: (geometry: PlanGeometry, key?: string) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  /** 다른 층 도면에도 붙여 넣을 수 있게 복사 (없으면 복사 단추를 숨긴다) */
  onCopy?: () => void;
  onSelect: (id: string | null) => void;
  /** 도면 크기 (m) 바꾸기: 요소는 그 자리에 둔다 */
  onResize: (size: { width: number; height: number }) => void;
  /** 요소도 같은 비율로 늘리거나 줄이는 크기 바꾸기 대화상자 */
  onResizeDialog?: () => void;
  /** 바꾼 것 때문에 앉은 사람의 책상이 빠졌을 때 알림 */
  onNotice: (text: string) => void;
};

/** 오른쪽 칸: 고른 요소의 속성. 여러 개를 골랐으면 함께 고치기, 아무것도 고르지 않았으면 도면 요약과 게시 전에 고칠 것 */
export default function PlanPanel(props: Props) {
  const { selected } = props;
  if (selected.length === 0) return <Summary {...props} />;
  if (selected.length > 1) return <Multi {...props} />;
  return <Properties key={selected[0].id} {...props} el={selected[0]} />;
}

const m2 = (v: number) => String(Math.round(v * 100) / 100);

function Summary(props: Props) {
  const { geometry, width, height, live, readOnly, problems, onSelect, onResize, onResizeDialog, onGeometry } = props;
  const counts = countsOf(geometry);
  const impact = impactOf(geometry, live);
  const kinds = { wall: 0, wall_line: 0, pillar: 0, space: 0 };
  for (const el of geometry.elements) if (el.type in kinds) kinds[el.type as keyof typeof kinds] += 1;
  const mains = geometry.elements.filter((e) => e.type === "entrance" && e.main).length;
  const desk = geometry.desk ?? DESK;
  const setDesk = (d: { w: number; h: number }) => onGeometry?.({ ...geometry, desk: d }, "desk-default");
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
          <dt>사무실 크기</dt>
          <dd>
            {width} × {height} m · {m2(width * height)} m²
          </dd>
          <dt>책상(좌석)</dt>
          <dd>{counts.desks}석</dd>
          <dt>회의실</dt>
          <dd>{counts.rooms}개</dd>
          <dt>출입구</dt>
          <dd>
            {counts.entrances}개{mains > 0 && ` (주 출입구 ${mains})`}
          </dd>
          <dt>벽 · 선 벽 · 기둥 · 공간</dt>
          <dd>
            {kinds.wall} · {kinds.wall_line} · {kinds.pillar} · {kinds.space}
          </dd>
        </dl>
        <p className={ui.hint}>
          요소를 누르면 여기서 크기·이름·좌석 번호를 고칠 수 있어요. Ctrl(⌘)·Shift를 누르고 누르거나 빈 곳에서 끌면 여러
          개를 함께 골라요.
        </p>
        <fieldset disabled={readOnly} className={ui.when}>
          <legend>도면 크기 (m)</legend>
          <div className={styles.numbers}>
            <Num
              label="폭"
              value={width}
              min={MIN_SIZE}
              max={MAX_SIZE}
              step={0.5}
              onChange={(w) => onResize({ width: w, height })}
            />
            <Num
              label="높이"
              value={height}
              min={MIN_SIZE}
              max={MAX_SIZE}
              step={0.5}
              onChange={(h) => onResize({ width, height: h })}
            />
          </div>
          <p className={ui.hint}>
            요소는 그 자리에 두고 도면만 넓히거나 줄여요. 책상 크기는 그대로라, 도면이 커지면 직원 화면의 좌석은 작게
            보여요.
          </p>
          {onResizeDialog && (
            <button type="button" className={ui.btn} onClick={onResizeDialog}>
              요소도 같은 비율로 바꾸기…
            </button>
          )}
        </fieldset>
        {onGeometry && (
          <fieldset disabled={readOnly} className={ui.when}>
            <legend>새 책상 기본 크기 (m)</legend>
            <div className={styles.numbers}>
              <Num
                label="책상 폭"
                value={desk.w}
                min={DESK_RANGE.min}
                max={DESK_RANGE.max}
                step={0.05}
                onChange={(w) => setDesk({ ...desk, w })}
              />
              <Num
                label="책상 깊이"
                value={desk.h}
                min={DESK_RANGE.min}
                max={DESK_RANGE.max}
                step={0.05}
                onChange={(h) => setDesk({ ...desk, h })}
              />
            </div>
            <p className={ui.hint}>
              새로 놓는 책상 묶음에 써요. 이미 놓은 묶음은 골라서 책상 크기를 바꿔요.
              {geometry.desk && (
                <>
                  {" "}
                  <button
                    type="button"
                    className={ui.linkButton}
                    onClick={() =>
                      onGeometry({ schema: geometry.schema, grid_m: geometry.grid_m, elements: geometry.elements })
                    }
                  >
                    기본({DESK.w} × {DESK.h})으로
                  </button>
                </>
              )}
            </p>
          </fieldset>
        )}
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
        {impact.displaced.length > 0 && !readOnly && (
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
  el,
  width,
  live,
  readOnly,
  problems,
  onChange,
  onDelete,
  onDuplicate,
  onCopy,
  onNotice,
}: Props & { el: PlanElement }) {
  const mine = problems.filter((p) => p.elementId === el.id);
  const set = (patch: Partial<PlanElement>, key?: string) =>
    onChange([{ ...el, ...patch } as PlanElement], key && `${el.id}:${key}`);

  return (
    <section className={`${ui.card} ${ui.selected}`} aria-label={`${TYPE_LABEL[el.type]} 속성`}>
      <div className={ui.cardHead}>
        <h2 className={ui.cardTitle}>{titleOf(el)}</h2>
        <Actions readOnly={readOnly} onDuplicate={onDuplicate} onCopy={onCopy} onDelete={onDelete} />
      </div>
      {mine.map((p, i) => (
        <p key={i} className={ui.conflictNote} role="alert">
          {p.text}
        </p>
      ))}
      <fieldset disabled={readOnly} className={ui.when}>
        {el.type === "wall_line" ? (
          <LineFields line={el} onChange={(next, key) => onChange([next], key && `${el.id}:${key}`)} />
        ) : (
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
        )}
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
        {el.type === "entrance" && (
          <>
            <label className={ui.field}>
              <span>이름표 (비우면 &lsquo;{el.main ? "주 출입구" : "출입구"}&rsquo;)</span>
              <input
                className={ui.textInput}
                value={el.label}
                maxLength={50}
                placeholder={el.main ? "주 출입구" : "출입구"}
                onChange={(e) => set({ label: e.target.value }, "label")}
              />
            </label>
            <label className={styles.checks}>
              <span>
                <input type="checkbox" checked={el.main} onChange={(e) => set({ main: e.target.checked })} /> 주 출입구
                (직원 화면에 진하게)
              </span>
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
        {(hasLine(el) || hasLabel(el)) && (
          <StyleFields els={[el]} width={width} onChange={(els, key) => onChange(els, key && `${el.id}:${key}`)} />
        )}
        {el.type === "desk_group" && (
          <DeskGroupFields
            group={el}
            geometry={geometry}
            live={live}
            onChange={(g, key) => onChange([g], key)}
            onNotice={onNotice}
          />
        )}
      </fieldset>
    </section>
  );
}

function Actions({
  readOnly,
  onDuplicate,
  onCopy,
  onDelete,
}: Pick<Props, "readOnly" | "onDuplicate" | "onCopy" | "onDelete">) {
  return (
    <div className={ui.rowButtons}>
      {!readOnly && (
        <button type="button" className={ui.btn} onClick={onDuplicate} title="복제 (Ctrl+D)">
          복제
        </button>
      )}
      {onCopy && (
        <button type="button" className={ui.btn} onClick={onCopy} title="복사 (Ctrl+C) · 다른 층 도면에서 붙여넣기">
          복사
        </button>
      )}
      {!readOnly && (
        <button type="button" className={`${ui.btn} ${ui.ghost}`} onClick={onDelete} title="지우기 (Delete)">
          지우기
        </button>
      )}
    </div>
  );
}

function titleOf(el: PlanElement): string {
  if (el.type === "space") return el.label || SPACE_KINDS.find((k) => k.kind === el.kind)?.label || "공간";
  if (el.type === "room") return el.name || "이름 없는 회의실";
  if (el.type === "entrance") return el.label || (el.main ? "주 출입구" : "출입구");
  if (el.type === "desk_group") return `책상 묶음 ${el.rows}×${el.cols}`;
  return TYPE_LABEL[el.type];
}

/** 선 벽: 양 끝점과 길이 (길이를 바꾸면 시작점은 두고 같은 방향으로 늘이거나 줄인다) */
function LineFields({ line, onChange }: { line: WallLine; onChange: (l: WallLine, key?: string) => void }) {
  const length = lineLength(line);
  const angle = Math.atan2(line.y2 - line.y, line.x2 - line.x);
  const deg = Math.round(((((-angle * 180) / Math.PI) % 360) + 360) % 360);
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return (
    <>
      <div className={styles.numbers}>
        <Num label="시작 x (m)" value={line.x} onChange={(x) => onChange({ ...line, x }, "x")} />
        <Num label="시작 y (m)" value={line.y} onChange={(y) => onChange({ ...line, y }, "y")} />
        <Num label="끝 x (m)" value={line.x2} onChange={(x2) => onChange({ ...line, x2 }, "x2")} />
        <Num label="끝 y (m)" value={line.y2} onChange={(y2) => onChange({ ...line, y2 }, "y2")} />
        <Num
          label="길이 (m)"
          value={length}
          min={0.05}
          onChange={(l) =>
            onChange(
              {
                ...line,
                x2: r2(line.x + (length > 0 ? Math.cos(angle) : 1) * l),
                y2: r2(line.y + (length > 0 ? Math.sin(angle) : 0) * l),
              },
              "length",
            )
          }
        />
        <label>
          각도
          <output className={styles.readout}>{deg}°</output>
        </label>
      </div>
      <p className={ui.hint}>끝의 동그란 손잡이를 끌어 늘여요. Shift를 누르고 끌면 45도씩 맞춰요.</p>
    </>
  );
}

/** 선 굵기(cm)·이름표 글자 크기(%)·굵게. 여러 요소를 골랐으면 함께 바꾼다 (값은 첫 요소 기준으로 보여 준다) */
function StyleFields({
  els,
  width,
  onChange,
}: {
  els: PlanElement[];
  width: number;
  onChange: (els: PlanElement[], key?: string) => void;
}) {
  const lined = els.filter(hasLine);
  const labeled = els.filter(hasLabel);
  const apply = (pick: (el: PlanElement) => boolean, patch: object, key?: string) =>
    onChange(
      els.map((el) => (pick(el) ? ({ ...el, ...patch } as PlanElement) : el)),
      key,
    );
  const clear = (pick: (el: PlanElement) => boolean, field: "line_w" | "label_size") =>
    onChange(
      els.map((el) => {
        if (!pick(el)) return el;
        const next = { ...el } as Record<string, unknown>;
        delete next[field];
        return next as PlanElement;
      }),
    );
  const line = lined[0];
  const label = labeled[0];
  return (
    <fieldset className={ui.when}>
      <legend>모양</legend>
      <div className={styles.numbers}>
        {line && (
          <Num
            label="선 굵기 (cm)"
            value={lineOf(line) * 100}
            min={LINE_RANGE.min * 100}
            max={LINE_RANGE.max * 100}
            step={1}
            onChange={(cm) => apply(hasLine, { line_w: Math.round(cm) / 100 }, "line")}
          />
        )}
        {label && (
          <Num
            label="글자 크기 (%)"
            value={label.label_size ?? 100}
            min={LABEL_RANGE.min}
            max={LABEL_RANGE.max}
            step={10}
            onChange={(v) => apply(hasLabel, { label_size: Math.round(v) }, "label-size")}
          />
        )}
      </div>
      {label && (
        <label className={styles.checks}>
          <span>
            <input
              type="checkbox"
              checked={!!label.label_bold}
              onChange={(e) => apply(hasLabel, { label_bold: e.target.checked })}
            />{" "}
            이름표 굵게
          </span>
        </label>
      )}
      <p className={ui.hint}>
        {line &&
          `직원 화면에서 ${m2(lineOf(line))} m 굵기는 도면 폭(${width} m)의 ${m2((lineOf(line) / width) * 100)}%로 그려져요. `}
        {(lined.some((el) => el.line_w) || labeled.some((el) => el.label_size)) && (
          <button
            type="button"
            className={ui.linkButton}
            onClick={() => {
              clear(hasLine, "line_w");
              clear(hasLabel, "label_size");
            }}
          >
            기본 굵기·글자 크기로
          </button>
        )}
      </p>
    </fieldset>
  );
}

const CHAIR_TEXT: Record<number, string> = { 0: "아래", 90: "오른쪽", 180: "위", 270: "왼쪽" };
// rotation은 의자 방향 기준(90 = 아래 → 오른쪽)이라 화면에서는 왼쪽으로 돈 것이다
const TURN_TEXT: Record<number, string> = {
  0: "돌리지 않음",
  90: "왼쪽으로 90도 돌림",
  180: "180도 돌림",
  270: "오른쪽으로 90도 돌림",
};

/** 책상 묶음 방향 돌리기·책상 크기 (여러 묶음이면 함께) */
function DeskShapeFields({
  groups,
  geometry,
  onChange,
}: {
  groups: DeskGroup[];
  geometry: PlanGeometry;
  onChange: (groups: DeskGroup[], key?: string) => void;
}) {
  const first = groups[0];
  const d = deskDims(first);
  const base = geometry.desk ?? DESK;
  const isBase = groups.every((g) => {
    const dd = deskDims(g);
    return dd.w === base.w && dd.h === base.h;
  });
  const rotation = first.rotation ?? 0;
  return (
    <>
      <fieldset className={ui.when}>
        <legend>방향</legend>
        <div className={ui.rowButtons}>
          <button
            type="button"
            className={ui.btn}
            title="왼쪽으로 90도 (Shift+R)"
            onClick={() => onChange(groups.map((g) => rotateGroup(g, false)))}
          >
            ↺ 왼쪽으로
          </button>
          <button
            type="button"
            className={ui.btn}
            title="오른쪽으로 90도 (R)"
            onClick={() => onChange(groups.map((g) => rotateGroup(g, true)))}
          >
            ↻ 오른쪽으로
          </button>
        </div>
        <p className={ui.hint}>
          {groups.length === 1
            ? `${TURN_TEXT[rotation]} · ${first.layout === "one" ? `의자가 ${CHAIR_TEXT[rotation]}쪽` : "마주보기"}. `
            : ""}
          돌려도 같은 칸(좌석)이라 앉은 사람은 그대로예요.
        </p>
      </fieldset>
      <fieldset className={ui.when}>
        <legend>책상 하나 크기 (m)</legend>
        <div className={styles.numbers}>
          <Num
            label="책상 폭"
            value={d.w}
            min={DESK_RANGE.min}
            max={DESK_RANGE.max}
            step={0.05}
            onChange={(w) =>
              onChange(
                groups.map((g) => ({ ...g, desk_w: w, desk_h: deskDims(g).h })),
                "desk-w",
              )
            }
          />
          <Num
            label="책상 깊이"
            value={d.h}
            min={DESK_RANGE.min}
            max={DESK_RANGE.max}
            step={0.05}
            onChange={(h) =>
              onChange(
                groups.map((g) => ({ ...g, desk_w: deskDims(g).w, desk_h: h })),
                "desk-h",
              )
            }
          />
        </div>
        <p className={ui.hint}>
          {groups.length === 1 && `묶음 크기 ${m2(groupSize(first).w)} × ${m2(groupSize(first).h)} m. `}
          {!isBase && (
            <button
              type="button"
              className={ui.linkButton}
              onClick={() => onChange(groups.map((g) => ({ ...g, desk_w: base.w, desk_h: base.h })))}
            >
              기본 크기({base.w} × {base.h})로
            </button>
          )}
        </p>
      </fieldset>
    </>
  );
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
    const merge = (c: DeskGroup["cells"][number]) => {
      const next = { ...c, ...patch };
      if (!next.flip) delete next.flip;
      return next;
    };
    onChange(
      { ...group, cells: group.cells.map((c) => (c.id === cell.id ? merge(c) : c)) },
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
      <DeskShapeFields
        groups={[group]}
        geometry={geometry}
        onChange={([g], key) => onChange(g, key && `${group.id}:${key}`)}
      />

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
            <label className={styles.checks}>
              <span>
                <input
                  type="checkbox"
                  checked={!!cell.flip}
                  onChange={(e) => setCell(e.target.checked ? { flip: true } : { flip: undefined })}
                />{" "}
                이 책상만 반대쪽을 보고 앉기
              </span>
            </label>
          )}
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

const ALIGN: { mode: AlignMode; label: string }[] = [
  { mode: "left", label: "왼쪽" },
  { mode: "hcenter", label: "가로 가운데" },
  { mode: "right", label: "오른쪽" },
  { mode: "top", label: "위" },
  { mode: "vcenter", label: "세로 가운데" },
  { mode: "bottom", label: "아래" },
];

/** 여러 개를 골랐을 때: 함께 옮기기·줄 맞추기·간격·모양·책상 방향과 크기 */
function Multi({ geometry, selected, width, readOnly, onChange, onDelete, onDuplicate, onCopy }: Props) {
  const ids = selected.map((e) => e.id).join(",");
  const key = (k: string) => `multi:${ids}:${k}`;
  const box = boxOfAll(selected)!;
  const kinds = new Map<string, number>();
  for (const el of selected) kinds.set(TYPE_LABEL[el.type], (kinds.get(TYPE_LABEL[el.type]) ?? 0) + 1);
  const groups = selected.filter((e): e is DeskGroup => e.type === "desk_group");
  const seats = groups.reduce((n, g) => n + g.cells.filter((c) => c.desk).length, 0);
  const styled = selected.filter((e) => hasLine(e) || hasLabel(e));
  return (
    <section className={`${ui.card} ${ui.selected}`} aria-label="고른 요소 함께 고치기">
      <div className={ui.cardHead}>
        <h2 className={ui.cardTitle}>{selected.length}개 골랐어요</h2>
        <Actions readOnly={readOnly} onDuplicate={onDuplicate} onCopy={onCopy} onDelete={onDelete} />
      </div>
      <p className={ui.hint}>
        {[...kinds].map(([k, n]) => `${k} ${n}`).join(" · ")}
        {seats > 0 && ` (좌석 ${seats}석)`} · 전체 {m2(box.w)} × {m2(box.h)} m
      </p>
      <fieldset disabled={readOnly} className={ui.when}>
        <div className={styles.numbers}>
          <Num
            label="왼쪽 x (m)"
            value={box.x}
            onChange={(x) =>
              onChange(
                selected.map((e) => moveElement(e, x - box.x, 0)),
                key("x"),
              )
            }
          />
          <Num
            label="위 y (m)"
            value={box.y}
            onChange={(y) =>
              onChange(
                selected.map((e) => moveElement(e, 0, y - box.y)),
                key("y"),
              )
            }
          />
        </div>
        <fieldset className={ui.when}>
          <legend>줄 맞추기</legend>
          <div className={styles.alignGrid}>
            {ALIGN.map((a) => (
              <button
                key={a.mode}
                type="button"
                className={ui.btn}
                onClick={() => onChange(alignElements(selected, a.mode))}
              >
                {a.label}
              </button>
            ))}
            <button
              type="button"
              className={ui.btn}
              disabled={selected.length < 3}
              title={selected.length < 3 ? "3개 이상 고르세요" : undefined}
              onClick={() => onChange(distributeElements(selected, "x"))}
            >
              가로 간격 똑같이
            </button>
            <button
              type="button"
              className={ui.btn}
              disabled={selected.length < 3}
              title={selected.length < 3 ? "3개 이상 고르세요" : undefined}
              onClick={() => onChange(distributeElements(selected, "y"))}
            >
              세로 간격 똑같이
            </button>
          </div>
          <p className={ui.hint}>고른 것 전체를 감싸는 사각형의 한쪽에 맞춰요. 끌거나 방향키로 함께 옮겨요.</p>
        </fieldset>
        {styled.length > 0 && (
          <StyleFields els={selected} width={width} onChange={(els, k) => onChange(els, k && key(k))} />
        )}
        {groups.length > 0 && (
          <DeskShapeFields
            groups={groups}
            geometry={geometry}
            onChange={(next, k) => {
              const byId = new Map(next.map((g) => [g.id, g]));
              onChange(
                selected.map((e) => byId.get(e.id) ?? e),
                k && key(k),
              );
            }}
          />
        )}
      </fieldset>
    </section>
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
  const shown = String(Math.round(value * 1000) / 1000);
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
