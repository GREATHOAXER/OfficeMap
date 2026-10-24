"use client";

import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { CloseIcon, PersonIcon, SearchIcon } from "@/components/icons";
import type { EmployeeHit, TeamHit } from "@/lib/api";
import { NO_STATUS_LABEL, PRESENCE_LABEL } from "@/lib/presence";
import { type SearchWhen, useEmployeeSearch, useTeamSearch } from "@/lib/useEmployeeSearch";
import type { Attendee, TeamGroup } from "./slots";
import styles from "./rooms.module.css";

const ABSENCE_LABEL = { LEAVE: "휴가", BUSINESS_TRIP: "출장", REMOTE: "재택" } as const;

type Props = {
  people: Attendee[];
  teams: TeamGroup[];
  onPeopleChange: (people: Attendee[]) => void;
  onTeamsChange: (teams: TeamGroup[]) => void;
  /** 고른 회의 시간. 있으면 참석자마다 그 시간에 다른 회의·휴가가 있는지 같이 보여 준다 */
  when: SearchWhen | null;
};

type Option = { kind: "team"; team: TeamHit } | { kind: "person"; hit: EmployeeHit };

/** 그 시간에 다른 일정이 있으면 이유 문구 */
function conflictOf(person: EmployeeHit): string | null {
  if (person.absence) return `이 시간 ${ABSENCE_LABEL[person.absence]} 예정`;
  if (person.busy) return `이 시간 다른 회의: ${person.busy.title}`;
  return null;
}

/**
 * 참석자 추가.
 * - 이름·사번, 또는 팀·부서 이름으로 찾아 한 사람씩 넣는다 (예: "재무팀"이면 재무팀 사람들이 목록에 뜬다)
 * - "$총무팀"처럼 $로 시작하면 팀을 찾아 팀 전체를 한 묶음으로 넣는다. 본부를 고르면 아래 팀 사람까지
 * 같은 이름이 여럿이면 팀·위치로 구별하게 알려 주고, 칩에 직급까지 붙인다.
 */
export default function AttendeePicker({ people, teams, onPeopleChange, onTeamsChange, when }: Props) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [loadingTeam, setLoadingTeam] = useState<number | null>(null);
  const [teamError, setTeamError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null); // 펼쳐 본 팀 묶음
  const [blockedNote, setBlockedNote] = useState<string | null>(null); // 고를 수 없는 사람을 골랐을 때 이유
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const teamMode = query.trimStart().startsWith("$"); // $팀이름: 팀 전체 추가
  const teamQuery = query.trimStart().slice(1);
  const search = useEmployeeSearch(query, when, 20, !teamMode);
  const teamSearch = useTeamSearch(teamQuery, open && teamMode);
  // "총무"처럼 팀 이름을 쓰면 $ 없이도 맨 위에 "총무팀 전체 추가"를 보여 준다 (두 글자부터)
  const nameTeams = useTeamSearch(query, open && !teamMode && query.trim().length >= 2);
  const showList = open && query.trim() !== "";

  const added = new Set(people.map((p) => p.emp_no));
  const inTeam = new Set(teams.flatMap((t) => t.members.map((m) => m.emp_no)));
  const addedTeams = new Set(teams.map((t) => t.id));
  const options: Option[] = teamMode
    ? teamSearch.teams.map((team) => ({ kind: "team" as const, team }))
    : [
        ...nameTeams.teams.slice(0, 2).map((team) => ({ kind: "team" as const, team })),
        ...search.results.map((hit) => ({ kind: "person" as const, hit })),
      ];
  const activeIndex = active < options.length ? active : -1;

  useEffect(() => {
    if (!showList) return;
    function onPointerDown(event: PointerEvent) {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [showList]);

  function personBlocked(hit: EmployeeHit): string | null {
    if (hit.is_me) return "주최자 · 자동 포함";
    if (added.has(hit.emp_no)) return "추가됨";
    if (inTeam.has(hit.emp_no)) return "팀으로 추가됨";
    return null;
  }

  function reset() {
    setQuery("");
    setActive(-1);
    setBlockedNote(null);
    inputRef.current?.focus();
  }

  async function addTeam(team: TeamHit) {
    if (addedTeams.has(team.id) || loadingTeam !== null) return;
    setLoadingTeam(team.id);
    setTeamError(null);
    try {
      const params = new URLSearchParams();
      if (when) Object.entries(when).forEach(([k, v]) => params.set(k, String(v)));
      const res = await fetch(`/api/employees/teams/${team.id}/members?${params}`);
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { team: { id: number; name: string }; members: EmployeeHit[] };
      const members = data.members.filter((m) => !m.is_me);
      onTeamsChange([...teams, { id: data.team.id, name: data.team.name, members }]);
      reset();
    } catch {
      setTeamError(`${team.name} 사람들을 불러오지 못했습니다. 다시 시도하세요.`);
    } finally {
      setLoadingTeam(null);
    }
  }

  function addPerson(hit: EmployeeHit) {
    const reason = personBlocked(hit);
    if (reason) {
      // 말없이 무시하지 않고 왜 안 되는지 알려 준다
      setBlockedNote(hit.is_me ? "주최자(나)는 따로 넣지 않아도 참석자에 포함돼요." : `${hit.name}: 이미 ${reason}`);
      return;
    }
    const sameName = search.results.some((r) => r.name === hit.name && r.emp_no !== hit.emp_no);
    onPeopleChange([...people, { ...hit, sameName }]);
    reset();
  }

  function choose(option: Option | undefined) {
    if (!option) return;
    if (option.kind === "team") void addTeam(option.team);
    else addPerson(option.hit);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const last = options.length - 1;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActive((i) => (event.key === "ArrowDown" ? Math.min(last, i + 1) : Math.max(0, i - 1)));
    } else if (event.key === "Enter") {
      event.preventDefault(); // 폼이 제출되지 않게
      if (showList) choose(options[Math.max(0, activeIndex)]);
    } else if (event.key === "Escape" && showList) {
      event.preventDefault(); // 예약 팝업이 같이 닫히지 않게
      event.stopPropagation();
      setOpen(false);
    } else if (event.key === "Backspace" && query === "" && people.length > 0) {
      onPeopleChange(people.slice(0, -1));
    }
  }

  // 같은 이름이 둘 이상이면 칩에 직급까지 붙여서 구별한다 (고를 때 동명이인이 있었거나, 칩끼리 이름이 같을 때)
  const showRank = (person: Attendee) => person.sameName || people.filter((p) => p.name === person.name).length > 1;
  const sameNameCount = search.results.filter((r) => r.name === query.trim()).length;

  let status: string;
  if (teamMode) {
    const name = teamQuery.trim();
    if (teamSearch.loading) status = "팀 찾는 중…";
    else if (teamSearch.failed) status = "팀을 찾지 못했습니다. 잠시 후 다시 시도하세요.";
    else if (options.length === 0) status = `‘${name}’에 맞는 팀·부서가 없습니다`;
    else status = name ? `팀 전체 추가 · ‘${name}’ ${options.length}개` : "팀 전체 추가 · 팀 이름을 이어서 쓰세요";
  } else if (search.loading) status = "찾는 중…";
  else if (search.failed) status = "검색하지 못했습니다. 잠시 후 다시 시도하세요.";
  else if (options.length === 0) status = `‘${query.trim()}’에 맞는 사람이 없습니다 · 팀 전체는 $팀이름`;
  else if (sameNameCount > 1) status = `‘${query.trim()}’ 동명이인 ${sameNameCount}명 · 소속과 위치를 확인하고 골라주세요`;
  else status = `${search.results.length}명${search.results.length === 20 ? " (앞 20명)" : ""} · 팀 전체는 $팀이름`;

  const expandedTeam = teams.find((t) => t.id === expanded);

  return (
    <div ref={boxRef} className={styles.attendees}>
      {(people.length > 0 || teams.length > 0) && (
        <ul className={styles.chips} aria-label="추가한 참석자">
          {teams.map((team) => {
            const busy = team.members.filter((m) => conflictOf(m)).length;
            return (
              <li key={`team-${team.id}`} className={`${styles.chip} ${styles.teamChip}`}>
                <button
                  type="button"
                  className={styles.chipLabel}
                  aria-expanded={expanded === team.id}
                  onClick={() => setExpanded(expanded === team.id ? null : team.id)}
                >
                  <PersonIcon size={14} />
                  {team.name} 전체 {team.members.length}명
                  {busy > 0 && <span className={styles.chipWarn}> · 다른 일정 {busy}명</span>}
                </button>
                <button
                  type="button"
                  className={styles.chipRemove}
                  aria-label={`${team.name} 전체 빼기`}
                  onClick={() => {
                    onTeamsChange(teams.filter((t) => t.id !== team.id));
                    if (expanded === team.id) setExpanded(null);
                  }}
                >
                  <CloseIcon size={14} />
                </button>
              </li>
            );
          })}
          {people.map((person) => (
            <li key={person.emp_no} className={styles.chip}>
              <span className={styles.chipSwatch} data-color={person.seat?.color_key ?? "t0"} aria-hidden="true" />
              {person.name}
              {showRank(person) && person.rank ? ` ${person.rank}` : ""} · {person.department}
              <button
                type="button"
                className={styles.chipRemove}
                aria-label={`${person.name} 빼기`}
                onClick={() => onPeopleChange(people.filter((p) => p.emp_no !== person.emp_no))}
              >
                <CloseIcon size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {expandedTeam && (
        <ul className={styles.teamMembers} aria-label={`${expandedTeam.name} 참석자`}>
          {expandedTeam.members.map((m) => {
            const conflict = conflictOf(m);
            return (
              <li key={m.emp_no}>
                <span>
                  {m.name} {m.rank}
                </span>
                {conflict && <span className={styles.conflict}>{conflict}</span>}
              </li>
            );
          })}
        </ul>
      )}
      <label className={styles.attendeeField}>
        <SearchIcon size={16} />
        <span className="visually-hidden">참석자 이름이나 팀으로 추가</span>
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
          placeholder="이름·팀·사번으로 추가 · $총무팀은 팀 전체"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            setActive(-1);
            setBlockedNote(null);
          }}
          onFocus={(event) => {
            setOpen(true);
            // 휴대폰: 결과 목록이 화면 아래 버튼·키보드에 가리지 않게 입력 칸을 위로 올린다
            if (window.matchMedia("(max-width: 720px)").matches) {
              event.currentTarget.scrollIntoView({ block: "start", behavior: "smooth" });
            }
          }}
          onKeyDown={onKeyDown}
        />
      </label>
      {teamError && (
        <p role="alert" className={styles.conflict}>
          {teamError}
        </p>
      )}
      {showList && (
        <div className={styles.attendeePanel}>
          <p className={styles.attendeeStatus} role="status" data-warn={sameNameCount > 1 || !!blockedNote || undefined}>
            {blockedNote ?? status}
          </p>
          {options.length > 0 && (
            <ul id={listId} role="listbox" aria-label="참석자 검색 결과" className={styles.attendeeList}>
              {options.map((option, i) => {
                const optionClass = `${styles.attendeeOption} ${i === activeIndex ? styles.attendeeOptionActive : ""}`;
                if (option.kind === "team") {
                  const { team } = option;
                  const done = addedTeams.has(team.id);
                  return (
                    <li
                      key={`team-${team.id}`}
                      id={`${listId}-${i}`}
                      role="option"
                      aria-selected={i === activeIndex}
                      aria-disabled={done}
                      className={optionClass}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => choose(option)}
                    >
                      <span className={`${styles.avatar} ${styles.teamAvatar}`} aria-hidden="true">
                        <PersonIcon size={16} />
                      </span>
                      <span className={styles.attendeeMain}>
                        <span>
                          <strong>{team.name} 전체</strong> {team.member_count}명
                          {done && <span className={styles.tag}>추가됨</span>}
                        </span>
                        <span className={styles.attendeeMeta}>
                          {team.has_children ? "아래 팀 사람까지 모두" : (team.parent ?? "팀 사람 모두")} · 나는 빼고 추가
                        </span>
                      </span>
                      <span className={styles.attendeeSide}>{loadingTeam === team.id ? "불러오는 중…" : "팀 추가"}</span>
                    </li>
                  );
                }
                const { hit } = option;
                const reason = personBlocked(hit);
                const conflict = conflictOf(hit);
                return (
                  <li
                    key={hit.emp_no}
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={i === activeIndex}
                    aria-disabled={!!reason}
                    className={optionClass}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => choose(option)}
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
                        {hit.division ? `${hit.division} ` : ""}
                        {hit.department} · {hit.seat ? `${hit.seat.floor_name} ${hit.seat.code}` : "자리 없음"}
                      </span>
                    </span>
                    <span className={styles.attendeeSide}>
                      <span className={styles.attendeePresence}>
                        {hit.presence && <span className="mk" data-status={hit.presence.status} aria-hidden="true" />}
                        {hit.presence ? PRESENCE_LABEL[hit.presence.status] : NO_STATUS_LABEL}
                      </span>
                      {when && (
                        <span className={conflict ? styles.conflict : styles.attendeeFree}>{conflict ?? "이 시간 비어 있음"}</span>
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
