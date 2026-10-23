"use client";

import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { addDays, daysInMonth, formatDay, isoOf, partsOf, WEEKDAY_NAMES, weekdayOf } from "@/lib/dates";
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon } from "./icons";
import styles from "./DatePicker.module.css";

type View = "day" | "month" | "year";

type Props = {
  value: string; // YYYY-MM-DD
  onChange: (iso: string) => void;
  /** 버튼과 달력의 이름 (스크린 리더) */
  label: string;
  today: string;
  min?: string;
  /** 달력을 버튼 왼쪽(start)에 맞출지 오른쪽(end)에 맞출지 */
  align?: "start" | "end";
  className?: string;
  children?: ReactNode; // 버튼 안 글자. 없으면 "2026-10-23 (금)"
};

const YEARS_PER_PAGE = 12;

/**
 * 날짜 고르기. 버튼을 누르면 달력이 뜨고, 위의 "2026년 10월"을 누르면 월 → 연도 순으로 넓게 볼 수 있다.
 * 키보드: 화살표(하루·한 주), PageUp/PageDown(한 달), Home/End(주의 처음·끝), Enter(고르기), Esc(닫기)
 */
export default function DatePicker({ value, onChange, label, today, min, align = "start", className, children }: Props) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("day");
  const [cursor, setCursor] = useState(value); // 달력에서 포커스가 있는 날 (보이는 달·연도도 여기서 정한다)
  const boxRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  function openCalendar() {
    setCursor(value);
    setView("day");
    setOpen(true);
  }

  function close(returnFocus = true) {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }

  function choose(iso: string) {
    if (min && iso < min) return;
    onChange(iso);
    close();
  }

  // 밖을 누르면 닫는다
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // 날짜를 옮기면 그 날 버튼으로 포커스를 옮긴다
  useEffect(() => {
    if (open && view === "day") gridRef.current?.querySelector<HTMLButtonElement>(`[data-iso="${cursor}"]`)?.focus();
  }, [open, view, cursor]);

  const { year, month } = partsOf(cursor);

  function moveMonths(n: number) {
    const { day } = partsOf(cursor);
    const target = new Date(Date.UTC(year, month - 1 + n, 1));
    const y = target.getUTCFullYear();
    const m = target.getUTCMonth() + 1;
    setCursor(isoOf(y, m, Math.min(day, daysInMonth(y, m))));
  }

  function onGridKeyDown(event: KeyboardEvent) {
    const moves: Record<string, () => void> = {
      ArrowLeft: () => setCursor(addDays(cursor, -1)),
      ArrowRight: () => setCursor(addDays(cursor, 1)),
      ArrowUp: () => setCursor(addDays(cursor, -7)),
      ArrowDown: () => setCursor(addDays(cursor, 7)),
      Home: () => setCursor(addDays(cursor, -weekdayOf(cursor))),
      End: () => setCursor(addDays(cursor, 6 - weekdayOf(cursor))),
      PageUp: () => moveMonths(event.shiftKey ? -12 : -1),
      PageDown: () => moveMonths(event.shiftKey ? 12 : 1),
    };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      move();
    }
  }

  function onPanelKeyDown(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    event.preventDefault(); // 바깥(예약 팝업 등)이 같이 닫히지 않게
    event.stopPropagation();
    if (view !== "day") setView(view === "year" ? "month" : "day");
    else close();
  }

  let header: ReactNode;
  let body: ReactNode;
  if (view === "day") {
    const first = isoOf(year, month, 1);
    const blanks = weekdayOf(first);
    const days = Array.from({ length: daysInMonth(year, month) }, (_, i) => isoOf(year, month, i + 1));
    header = (
      <Header
        titleId={titleId}
        title={`${year}년 ${month}월`}
        titleHint="월 고르기"
        onTitle={() => setView("month")}
        onPrev={() => moveMonths(-1)}
        onNext={() => moveMonths(1)}
        prevLabel="이전 달"
        nextLabel="다음 달"
      />
    );
    body = (
      <div ref={gridRef} role="grid" aria-labelledby={titleId} className={styles.days} onKeyDown={onGridKeyDown}>
        <div role="row" className={styles.weekRow}>
          {WEEKDAY_NAMES.map((name, i) => (
            <span key={name} role="columnheader" className={styles.weekday} data-weekday={i}>
              {name}
            </span>
          ))}
        </div>
        {chunk([...Array<string | null>(blanks).fill(null), ...days], 7).map((week, w) => (
          <div key={w} role="row" className={styles.weekRow}>
            {week.map((iso, i) =>
              iso === null ? (
                <span key={`blank-${i}`} role="gridcell" />
              ) : (
                <span key={iso} role="gridcell" aria-selected={iso === value}>
                  <button
                    type="button"
                    className={styles.day}
                    data-iso={iso}
                    data-weekday={weekdayOf(iso)}
                    data-today={iso === today || undefined}
                    data-selected={iso === value || undefined}
                    tabIndex={iso === cursor ? 0 : -1}
                    disabled={!!min && iso < min}
                    aria-label={`${formatDay(iso)}${iso === today ? ", 오늘" : ""}`}
                    aria-current={iso === today ? "date" : undefined}
                    onClick={() => choose(iso)}
                  >
                    {partsOf(iso).day}
                  </button>
                </span>
              ),
            )}
          </div>
        ))}
      </div>
    );
  } else if (view === "month") {
    header = (
      <Header
        titleId={titleId}
        title={`${year}년`}
        titleHint="연도 고르기"
        onTitle={() => setView("year")}
        onPrev={() => setCursor(isoOf(year - 1, month, 1))}
        onNext={() => setCursor(isoOf(year + 1, month, 1))}
        prevLabel="이전 해"
        nextLabel="다음 해"
      />
    );
    body = (
      <div className={styles.grid3} role="group" aria-labelledby={titleId}>
        {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
          <button
            key={m}
            type="button"
            className={styles.cell}
            data-selected={(year === partsOf(value).year && m === partsOf(value).month) || undefined}
            data-today={(year === partsOf(today).year && m === partsOf(today).month) || undefined}
            onClick={() => {
              setCursor(isoOf(year, m, Math.min(partsOf(cursor).day, daysInMonth(year, m))));
              setView("day");
            }}
          >
            {m}월
          </button>
        ))}
      </div>
    );
  } else {
    const start = year - (year % YEARS_PER_PAGE); // 12년씩 묶어서 보여 준다 (예: 2016~2027)
    header = (
      <Header
        titleId={titleId}
        title={`${start}–${start + YEARS_PER_PAGE - 1}`}
        onPrev={() => setCursor(isoOf(year - YEARS_PER_PAGE, month, 1))}
        onNext={() => setCursor(isoOf(year + YEARS_PER_PAGE, month, 1))}
        prevLabel="이전 12년"
        nextLabel="다음 12년"
      />
    );
    body = (
      <div className={styles.grid3} role="group" aria-labelledby={titleId}>
        {Array.from({ length: YEARS_PER_PAGE }, (_, i) => start + i).map((y) => (
          <button
            key={y}
            type="button"
            className={styles.cell}
            data-selected={y === partsOf(value).year || undefined}
            data-today={y === partsOf(today).year || undefined}
            onClick={() => {
              setCursor(isoOf(y, month, 1));
              setView("month");
            }}
          >
            {y}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div ref={boxRef} className={`${styles.picker} ${className ?? ""}`}>
      <button
        ref={buttonRef}
        type="button"
        className={styles.button}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label}: ${formatDay(value)}`}
        onClick={() => (open ? close(false) : openCalendar())}
      >
        <CalendarIcon size={16} />
        <span className="mono">{children ?? formatDay(value)}</span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={`${label} 달력`}
          className={styles.panel}
          data-align={align}
          onKeyDown={onPanelKeyDown}
        >
          {header}
          {body}
          <div className={styles.footer}>
            <button type="button" className={styles.todayButton} disabled={!!min && today < min} onClick={() => choose(today)}>
              오늘
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

type HeaderProps = {
  titleId: string;
  title: string;
  titleHint?: string;
  onTitle?: () => void;
  onPrev: () => void;
  onNext: () => void;
  prevLabel: string;
  nextLabel: string;
};

function Header({ titleId, title, titleHint, onTitle, onPrev, onNext, prevLabel, nextLabel }: HeaderProps) {
  return (
    <div className={styles.header}>
      <button type="button" className={styles.nav} aria-label={prevLabel} onClick={onPrev}>
        <ChevronLeftIcon size={18} />
      </button>
      {onTitle ? (
        <button
          type="button"
          id={titleId}
          className={styles.title}
          aria-label={`${title}, ${titleHint}`}
          onClick={onTitle}
        >
          {title} <span aria-hidden="true">▾</span>
        </button>
      ) : (
        <strong id={titleId} className={styles.title}>
          {title}
        </strong>
      )}
      <button type="button" className={styles.nav} aria-label={nextLabel} onClick={onNext}>
        <ChevronRightIcon size={18} />
      </button>
    </div>
  );
}

function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}
