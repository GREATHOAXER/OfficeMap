"use client";

import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { CloseIcon, SearchIcon } from "@/components/icons";
import type { EmployeeHit } from "@/lib/api";
import { PRESENCE_LABEL } from "@/lib/presence";
import { type SearchWhen, useEmployeeSearch } from "@/lib/useEmployeeSearch";
import type { Attendee } from "./slots";
import styles from "./rooms.module.css";

const ABSENCE_LABEL = { LEAVE: "휴가", BUSINESS_TRIP: "출장", REMOTE: "재택" } as const;

type Props = {
  value: Attendee[];
  onChange: (attendees: Attendee[]) => void;
  /** 고른 회의 시간. 있으면 참석자마다 그 시간에 다른 회의·휴가가 있는지 같이 보여 준다 */
  when: SearchWhen | null;
};

/** 참석자 추가: 이름으로 찾아서 칩으로 붙인다. 같은 이름이 여럿이면 팀·위치로 구별하게 알려 준다 */
export default function AttendeePicker({ value, onChange, when }: Props) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const { results, loading, failed } = useEmployeeSearch(query, when, 10);
  const showList = open && query.trim() !== "";
  const activeIndex = active < results.length ? active : -1;
  const added = new Set(value.map((a) => a.emp_no));

  useEffect(() => {
    if (!showList) return;
    function onPointerDown(event: PointerEvent) {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [showList]);

  const selectable = (hit: EmployeeHit | undefined) => !!hit && !hit.is_me && !added.has(hit.emp_no);

  function add(hit: EmployeeHit | undefined) {
    if (!hit || !selectable(hit)) return;
    const sameName = results.some((r) => r.name === hit.name && r.emp_no !== hit.emp_no);
    onChange([...value, { ...hit, sameName }]);
    setQuery("");
    setActive(-1);
    inputRef.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const last = results.length - 1;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActive((i) => (event.key === "ArrowDown" ? Math.min(last, i + 1) : Math.max(0, i - 1)));
    } else if (event.key === "Enter") {
      event.preventDefault(); // 폼이 제출되지 않게
      if (showList) add(results[Math.max(0, activeIndex)]);
    } else if (event.key === "Escape" && showList) {
      event.preventDefault(); // 예약 팝업이 같이 닫히지 않게
      event.stopPropagation();
      setOpen(false);
    } else if (event.key === "Backspace" && query === "" && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  }

  // 같은 이름이 둘 이상이면 칩에 직급까지 붙여서 구별한다 (고를 때 동명이인이 있었거나, 칩끼리 이름이 같을 때)
  const showRank = (person: Attendee) => person.sameName || value.filter((p) => p.name === person.name).length > 1;
  const sameNameCount = results.filter((r) => r.name === query.trim()).length;

  let status: string;
  if (loading) status = "찾는 중…";
  else if (failed) status = "검색하지 못했습니다. 잠시 후 다시 시도하세요.";
  else if (results.length === 0) status = `‘${query.trim()}’에 맞는 사람이 없습니다`;
  else if (sameNameCount > 1) status = `‘${query.trim()}’ 동명이인 ${sameNameCount}명 · 소속과 위치를 확인하고 골라주세요`;
  else status = `검색 결과 ${results.length}명`;

  return (
    <div ref={boxRef} className={styles.attendees}>
      {value.length > 0 && (
        <ul className={styles.chips} aria-label="추가한 참석자">
          {value.map((person) => (
            <li key={person.emp_no} className={styles.chip}>
              <span className={styles.chipSwatch} data-color={person.seat?.color_key ?? "t0"} aria-hidden="true" />
              {person.name}
              {showRank(person) && person.rank ? ` ${person.rank}` : ""} · {person.department}
              <button
                type="button"
                className={styles.chipRemove}
                aria-label={`${person.name} 빼기`}
                onClick={() => onChange(value.filter((p) => p.emp_no !== person.emp_no))}
              >
                <CloseIcon size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <label className={styles.attendeeField}>
        <SearchIcon size={16} />
        <span className="visually-hidden">참석자 이름으로 추가</span>
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
          placeholder="이름·팀·사번으로 참석자 추가"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
      </label>
      {showList && (
        <div className={styles.attendeePanel}>
          <p className={styles.attendeeStatus} role="status" data-warn={sameNameCount > 1 || undefined}>
            {status}
          </p>
          {results.length > 0 && (
            <ul id={listId} role="listbox" aria-label="참석자 검색 결과" className={styles.attendeeList}>
              {results.map((hit, i) => {
                const reason = hit.is_me ? "주최자" : added.has(hit.emp_no) ? "추가됨" : null;
                const conflict = hit.absence
                  ? `이 시간 ${ABSENCE_LABEL[hit.absence]} 예정`
                  : hit.busy
                    ? `이 시간 다른 회의: ${hit.busy.title}`
                    : null;
                return (
                  <li
                    key={hit.emp_no}
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={i === activeIndex}
                    aria-disabled={!!reason}
                    className={`${styles.attendeeOption} ${i === activeIndex ? styles.attendeeOptionActive : ""}`}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => add(hit)}
                  >
                    <span className={styles.avatar} aria-hidden="true">
                      {hit.name.slice(-2)}
                    </span>
                    <span className={styles.attendeeMain}>
                      <span>
                        <strong>{hit.name}</strong> {hit.rank}
                        {reason && <span className={styles.tag}>{reason}</span>}
                      </span>
                      <span className={styles.attendeeMeta}>
                        <span className={styles.chipSwatch} data-color={hit.seat?.color_key ?? "t0"} aria-hidden="true" />
                        {hit.department} · {hit.seat ? `${hit.seat.floor_name} ${hit.seat.code}` : "자리 없음"}
                      </span>
                    </span>
                    <span className={styles.attendeeSide}>
                      {hit.presence && (
                        <span className={styles.attendeePresence}>
                          <span className="mk" data-status={hit.presence.status} aria-hidden="true" />
                          {PRESENCE_LABEL[hit.presence.status]}
                        </span>
                      )}
                      {when && (
                        <span className={conflict ? styles.conflict : styles.attendeeFree}>
                          {conflict ?? "이 시간 비어 있음"}
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
