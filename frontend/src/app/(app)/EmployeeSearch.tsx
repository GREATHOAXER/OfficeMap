"use client";

import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { CloseIcon, SearchIcon } from "@/components/icons";
import type { EmployeeHit } from "@/lib/api";
import { PRESENCE_LABEL } from "@/lib/presence";
import { useEmployeeSearch } from "@/lib/useEmployeeSearch";
import styles from "./office.module.css";

const QUERY_MAX = 50; // 서버(/api/employees/search)가 받는 검색어 길이

/** 머리글의 직원 검색창. 이름·사번이나 팀·부서 이름을 치면 아래에 결과 목록이 뜨고, 고르면 그 사람 자리로 간다.
 *  자리가 아직 없는 사람은 오른쪽 패널에 연락처를 보여 준다 */
export default function EmployeeSearch({ onPick }: { onPick: (hit: EmployeeHit) => void }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const { results, loading, failed } = useEmployeeSearch(query);
  const showList = open && query.trim() !== "";
  const activeIndex = active < results.length ? active : -1;

  useEffect(() => {
    if (!showList) return;
    function onPointerDown(event: PointerEvent) {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [showList]);

  function pick(hit: EmployeeHit | undefined) {
    if (!hit) return;
    onPick(hit);
    setOpen(false);
    setQuery("");
    setActive(-1);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const last = results.length - 1;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActive((i) => (event.key === "ArrowDown" ? Math.min(last, i + 1) : Math.max(0, i - 1)));
    } else if (event.key === "Enter" && showList) {
      event.preventDefault();
      pick(results[Math.max(0, activeIndex)]);
    } else if (event.key === "Escape") {
      if (showList) setOpen(false);
      else setQuery("");
    }
  }

  let status: string;
  if (loading) status = "찾는 중…";
  else if (failed) status = "검색하지 못했습니다. 잠시 후 다시 시도하세요.";
  else if (results.length === 0) status = `‘${query.trim()}’ 검색 결과가 없습니다`;
  else status = `‘${query.trim()}’ 검색 결과 ${results.length}건${results.length === 20 ? " (앞 20명)" : ""}`;

  return (
    <div ref={boxRef} className={styles.search}>
      <label className={styles.searchField}>
        <SearchIcon size={16} />
        <span className="visually-hidden">직원 검색</span>
        <input
          ref={inputRef}
          type="search"
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
          placeholder="이름·팀·사번·하는 일 검색" // 좁은 머리글(1024px)에서도 잘리지 않게 짧게
          maxLength={QUERY_MAX}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {/* 지우기 단추는 직접 그린다 (브라우저 기본 ×는 운영체제·브라우저마다 모양이 다르고 없는 곳도 있다) */}
        {query && (
          <button
            type="button"
            className={styles.searchClear}
            aria-label="검색어 지우기"
            onClick={() => {
              setQuery("");
              setActive(-1);
              inputRef.current?.focus();
            }}
          >
            <CloseIcon size={14} />
          </button>
        )}
      </label>
      {showList && (
        <div className={styles.searchPanel}>
          <p className={styles.searchStatus} role="status">
            {status}
          </p>
          {results.length > 0 && (
            <ul id={listId} role="listbox" aria-label="검색 결과" className={styles.searchList}>
              {results.map((hit, i) => (
                <li
                  key={hit.emp_no}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === activeIndex}
                  className={`${styles.searchOption} ${i === activeIndex ? styles.searchOptionActive : ""}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(hit)}
                >
                  <span className={styles.searchMark}>
                    {hit.presence && <span className="mk" data-status={hit.presence.status} aria-hidden="true" />}
                  </span>
                  <span className={styles.searchMain}>
                    <span>
                      <strong>{hit.name}</strong> {hit.rank}
                      {hit.display_name && <span className={styles.searchAlias}> · {hit.display_name}</span>}
                      {hit.is_me && <span className={styles.searchMe}>나</span>}
                    </span>
                    <span className={styles.searchMeta}>
                      <span className={styles.swatch} data-color={hit.seat?.color_key ?? "t0"} aria-hidden="true" />
                      {hit.department} ·{" "}
                      {hit.seat
                        ? `${hit.seat.site_name} ${hit.seat.floor_name} ${hit.seat.code}`
                        : "배정된 자리 없음 · 누르면 연락처"}
                    </span>
                    {hit.matched && <span className={styles.searchMatched}>{hit.matched}</span>}
                  </span>
                  <span className={styles.searchState}>{hit.presence ? PRESENCE_LABEL[hit.presence.status] : ""}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
