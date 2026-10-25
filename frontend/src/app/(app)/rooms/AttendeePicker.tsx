"use client";

import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { CloseIcon, PersonIcon, PlusIcon, SearchIcon } from "@/components/icons";
import type { EmployeeHit, TeamHit } from "@/lib/api";
import { NO_STATUS_LABEL, PRESENCE_LABEL } from "@/lib/presence";
import { type SearchWhen, useDebouncedJson, useEmployeeSearch, useTeamSearch } from "@/lib/useEmployeeSearch";
import type { Attendee } from "./slots";
import styles from "./rooms.module.css";

const ABSENCE_LABEL = { LEAVE: "휴가", BUSINESS_TRIP: "출장", REMOTE: "재택" } as const;

type Props = {
  people: Attendee[];
  onPeopleChange: (people: Attendee[]) => void;
  /** 예약하는 나도 회의에 들어가나 */
  meAttends: boolean;
  onMeAttendsChange: (attends: boolean) => void;
  /** 고른 회의 시간. 있으면 참석자마다 그 시간에 다른 회의·휴가가 있는지 같이 보여 준다 */
  when: SearchWhen | null;
  /** 고치는 예약 (나의 일정 확인에서 자기 자신과는 겹치지 않게) */
  exclude?: number | null;
};

/** 그 시간 나의 다른 회의·휴가 (/api/reservations/mine/clash) */
type MyClash = { busy: { title: string } | null; absence: keyof typeof ABSENCE_LABEL | null };

type Option = { kind: "team"; team: TeamHit } | { kind: "person"; hit: EmployeeHit };

/** 그 시간에 다른 일정이 있으면 이유 문구 */
function conflictOf(person: EmployeeHit): string | null {
  if (person.absence) return `이 시간 ${ABSENCE_LABEL[person.absence]} 예정`;
  if (person.busy) return `이 시간 다른 회의: ${person.busy.title}`;
  return null;
}

/**
 * 참석자 추가. 실제로 회의에 들어가는 사람만 넣는다.
 * - 예약하는 나는 기본으로 참석. 비서처럼 예약만 해 주면 "나" 칩을 빼면 된다 (다시 넣으려면 "나도 참석")
 * - 이름·사번, 또는 팀·부서 이름으로 찾아 한 사람씩 넣는다
 * - 팀 이름을 쓰면(또는 "$총무팀") 팀 사람을 한꺼번에 넣는다. 묶음이 아니라 한 사람씩 들어가서,
 *   안 올 사람 몇 명만 ✕로 뺄 수 있다. 팀으로 넣은 사람은 팀별로 모아 보여 주고 "모두 빼기"도 된다
 * 같은 이름이 여럿이면 팀·위치로 구별하게 알려 주고, 칩에 직급까지 붙인다.
 */
export default function AttendeePicker(props: Props) {
  const { people, onPeopleChange, meAttends, onMeAttendsChange, when, exclude = null } = props;
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [loadingTeam, setLoadingTeam] = useState<number | null>(null);
  const [teamError, setTeamError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null); // 방금 한 일 (팀을 넣었다, 이미 있는 사람이다 등)
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const teamMode = query.trimStart().startsWith("$"); // $팀이름: 팀 사람 한꺼번에
  const teamQuery = query.trimStart().slice(1);
  const search = useEmployeeSearch(query, when, 20, !teamMode);
  const teamSearch = useTeamSearch(teamQuery, open && teamMode);
  // "총무"처럼 팀 이름을 쓰면 $ 없이도 맨 위에 "총무팀 모두 넣기"를 보여 준다 (두 글자부터)
  const nameTeams = useTeamSearch(query, open && !teamMode && query.trim().length >= 2);
  const showList = open && query.trim() !== "";
  const queryRef = useRef(query); // 결과를 기다리는 동안 입력이 바뀌었나
  const [waiting, setWaiting] = useState(false); // 결과가 오기 전에 Enter를 눌러서 기다리는 중

  // "나" 칩도 다른 참석자처럼 그 시간에 내 다른 회의·휴가가 있으면 표시한다
  const myClash = useDebouncedJson<MyClash>(
    meAttends && when
      ? `/api/reservations/mine/clash?${new URLSearchParams({
          start_date: when.date,
          start_min: String(when.start_min),
          end_date: when.end_date,
          end_min: String(when.end_min),
          ...(exclude ? { exclude: String(exclude) } : {}),
        })}`
      : null,
  );
  const myConflict = myClash.data?.absence
    ? `이 시간 ${ABSENCE_LABEL[myClash.data.absence]} 예정`
    : myClash.data?.busy
      ? `이 시간 다른 회의: ${myClash.data.busy.title}`
      : null;

  const added = new Set(people.map((p) => p.emp_no));
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
    if (hit.is_me) return meAttends ? "나 · 참석" : null;
    if (added.has(hit.emp_no)) return "추가됨";
    return null;
  }

  function reset() {
    setQuery("");
    queryRef.current = "";
    setActive(-1);
    inputRef.current?.focus();
  }

  /** 팀 사람을 한 사람씩 넣는다 (이미 있는 사람·나는 건너뛴다) */
  async function addTeam(team: TeamHit) {
    if (loadingTeam !== null) return;
    setLoadingTeam(team.id);
    setTeamError(null);
    try {
      const params = new URLSearchParams();
      if (when) Object.entries(when).forEach(([k, v]) => params.set(k, String(v)));
      const res = await fetch(`/api/employees/teams/${team.id}/members?${params}`);
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { team: { id: number; name: string }; members: EmployeeHit[] };
      const fresh = data.members.filter((m) => !m.is_me && !added.has(m.emp_no));
      onPeopleChange([...people, ...fresh.map((m) => ({ ...m, via: data.team.name }))]);
      const skipped = data.members.length - fresh.length;
      setNote(
        fresh.length === 0
          ? `${data.team.name} 사람은 이미 모두 들어가 있어요.`
          : `${data.team.name} ${fresh.length}명을 한 명씩 넣었어요${
              skipped ? ` (나·이미 있는 사람 ${skipped}명 빼고)` : ""
            }. 안 올 사람은 ✕로 빼세요.`,
      );
      reset();
    } catch {
      setTeamError(`${team.name} 사람들을 불러오지 못했습니다. 다시 시도하세요.`);
    } finally {
      setLoadingTeam(null);
    }
  }

  /** results: 동명이인을 가릴 검색 결과 (보통은 지금 보이는 결과) */
  function addPerson(hit: EmployeeHit, results: EmployeeHit[] = search.results) {
    if (hit.is_me) {
      if (!meAttends) {
        onMeAttendsChange(true);
        setNote("나도 참석자로 넣었어요.");
        reset();
      } else {
        setNote("나는 이미 참석자예요. 예약만 하고 들어가지 않으려면 ‘나’ 칩을 빼세요.");
      }
      return;
    }
    if (added.has(hit.emp_no)) {
      setNote(`이미 참석자에 있어요: ${hit.name}`);
      return;
    }
    const sameName = results.some((r) => r.name === hit.name && r.emp_no !== hit.emp_no);
    onPeopleChange([...people, { ...hit, sameName }]);
    setNote(null);
    reset();
  }

  function choose(option: Option | undefined) {
    if (!option) return;
    if (option.kind === "team") void addTeam(option.team);
    else addPerson(option.hit);
  }

  /**
   * 결과가 아직 안 왔는데 Enter를 눌렀다 (빨리 치고 바로 Enter): 바로 물어보고 맨 위 것을 고른다.
   * 그사이 입력을 바꿨으면 고르지 않는다
   */
  async function chooseFirstWhenLoaded() {
    const asked = query;
    const q = asked.trim();
    if (!q || waiting) return;
    setWaiting(true);
    try {
      let first: Option | undefined;
      let hits: EmployeeHit[] = [];
      if (teamMode) {
        const res = await fetch(`/api/employees/teams?${new URLSearchParams({ q: teamQuery.trim() })}`);
        if (!res.ok) throw new Error(String(res.status));
        const team = ((await res.json()) as { teams: TeamHit[] }).teams[0];
        first = team && { kind: "team", team };
      } else {
        const params = new URLSearchParams({ q, limit: "20" });
        if (when) Object.entries(when).forEach(([k, v]) => params.set(k, String(v)));
        const [teamRes, personRes] = await Promise.all([
          q.length >= 2 ? fetch(`/api/employees/teams?${new URLSearchParams({ q })}`) : null,
          fetch(`/api/employees/search?${params}`),
        ]);
        if (!personRes.ok || (teamRes && !teamRes.ok)) throw new Error("search");
        const team = teamRes ? ((await teamRes.json()) as { teams: TeamHit[] }).teams[0] : undefined;
        hits = ((await personRes.json()) as { results: EmployeeHit[] }).results;
        first = team ? { kind: "team", team } : hits[0] && { kind: "person", hit: hits[0] };
      }
      if (queryRef.current !== asked) return;
      if (!first) setNote(`‘${q}’에 맞는 사람이 없습니다`);
      else if (first.kind === "team") void addTeam(first.team);
      else addPerson(first.hit, hits);
    } catch {
      setNote("찾지 못했습니다. 잠시 후 다시 시도하세요.");
    } finally {
      setWaiting(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const last = options.length - 1;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActive((i) => (event.key === "ArrowDown" ? Math.min(last, i + 1) : Math.max(0, i - 1)));
    } else if (event.key === "Enter") {
      event.preventDefault(); // 폼이 제출되지 않게
      const loading = teamMode ? teamSearch.loading : search.loading || nameTeams.loading;
      if (showList && loading && activeIndex < 0) void chooseFirstWhenLoaded();
      else if (showList) choose(options[Math.max(0, activeIndex)]);
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
    else status = name ? `팀 사람 한꺼번에 넣기 · ‘${name}’ ${options.length}개` : "팀 이름을 이어서 쓰세요";
  } else if (waiting) status = "찾는 중… 맨 위 사람을 넣어요";
  else if (search.loading) status = "찾는 중…";
  else if (search.failed) status = "검색하지 못했습니다. 잠시 후 다시 시도하세요.";
  else if (options.length === 0) status = `‘${query.trim()}’에 맞는 사람이 없습니다`;
  else if (sameNameCount > 1) status = `‘${query.trim()}’ 동명이인 ${sameNameCount}명 · 소속과 위치를 확인하고 골라주세요`;
  else status = `${search.results.length}명${search.results.length === 20 ? " (앞 20명)" : ""}`;

  // 칩: 한 사람씩 넣은 사람 먼저, 팀으로 넣은 사람은 팀별로 모아서
  const single = people.filter((p) => !p.via);
  const groups = new Map<string, Attendee[]>();
  for (const p of people) if (p.via) groups.set(p.via, [...(groups.get(p.via) ?? []), p]);
  const remove = (emp: string) => onPeopleChange(people.filter((p) => p.emp_no !== emp));

  function chip(person: Attendee) {
    const conflict = conflictOf(person);
    return (
      <li key={person.emp_no} className={styles.chip} data-conflict={!!conflict || undefined} title={conflict ?? undefined}>
        <span className={styles.chipSwatch} data-color={person.seat?.color_key ?? "t0"} aria-hidden="true" />
        {person.name}
        {showRank(person) && person.rank ? ` ${person.rank}` : ""}
        {!person.via && ` · ${person.department}`}
        {conflict && (
          <span className={styles.chipWarn} aria-label={conflict}>
            !
          </span>
        )}
        <button
          type="button"
          className={styles.chipRemove}
          aria-label={`${person.name} 빼기`}
          onClick={() => remove(person.emp_no)}
        >
          <CloseIcon size={14} />
        </button>
      </li>
    );
  }

  return (
    <div ref={boxRef} className={styles.attendees}>
      <ul className={styles.chips} aria-label="참석자">
        {meAttends ? (
          <li
            className={`${styles.chip} ${styles.meChip}`}
            data-conflict={!!myConflict || undefined}
            title={myConflict ?? undefined}
          >
            <PersonIcon size={14} />나 · 예약한 사람
            {myConflict && (
              <span className={styles.chipWarn} aria-label={myConflict}>
                !
              </span>
            )}
            <button
              type="button"
              className={styles.chipRemove}
              aria-label="나는 참석하지 않음 (예약만 하기)"
              title="예약만 하고 회의에는 들어가지 않으면 빼세요"
              onClick={() => {
                onMeAttendsChange(false);
                setNote("나는 예약만 하고 회의에는 들어가지 않아요. 참석자에서 빠졌어요.");
              }}
            >
              <CloseIcon size={14} />
            </button>
          </li>
        ) : (
          <li>
            <button
              type="button"
              className={styles.addMe}
              onClick={() => {
                onMeAttendsChange(true);
                setNote(null);
              }}
            >
              <PlusIcon size={14} /> 나도 참석
            </button>
          </li>
        )}
        {single.map(chip)}
      </ul>
      {[...groups.entries()].map(([team, members]) => {
        const busy = members.filter((m) => conflictOf(m)).length;
        return (
          <div key={team} className={styles.chipGroup}>
            <div className={styles.chipGroupHead}>
              <strong>{team}</strong> {members.length}명
              {busy > 0 && <span className={styles.chipWarnText}> · 다른 일정 {busy}명</span>}
              <button
                type="button"
                className={styles.linkButton}
                onClick={() => onPeopleChange(people.filter((p) => p.via !== team))}
              >
                모두 빼기
              </button>
            </div>
            <ul className={styles.chips} aria-label={`${team}에서 넣은 참석자`}>
              {members.map(chip)}
            </ul>
          </div>
        );
      })}
      {note && (
        <p className={styles.attendeeNote} role="status">
          {note}
        </p>
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
          placeholder="이름·사번, 또는 팀 이름으로 한꺼번에"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            queryRef.current = event.target.value;
            setOpen(true);
            setActive(-1);
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
          <p className={styles.attendeeStatus} role="status" data-warn={sameNameCount > 1 || undefined}>
            {status}
          </p>
          {options.length > 0 && (
            <ul id={listId} role="listbox" aria-label="참석자 검색 결과" className={styles.attendeeList}>
              {options.map((option, i) => {
                const optionClass = `${styles.attendeeOption} ${i === activeIndex ? styles.attendeeOptionActive : ""}`;
                if (option.kind === "team") {
                  const { team } = option;
                  return (
                    <li
                      key={`team-${team.id}`}
                      id={`${listId}-${i}`}
                      role="option"
                      aria-selected={i === activeIndex}
                      className={optionClass}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => choose(option)}
                    >
                      <span className={`${styles.avatar} ${styles.teamAvatar}`} aria-hidden="true">
                        <PersonIcon size={16} />
                      </span>
                      <span className={styles.attendeeMain}>
                        <span>
                          <strong>{team.name}</strong> {team.member_count}명 모두 넣기
                        </span>
                        <span className={styles.attendeeMeta}>
                          {team.has_children ? "아래 팀 사람까지 · " : team.parent ? `${team.parent} · ` : ""}
                          한 명씩 들어가서 안 올 사람만 뺄 수 있어요
                        </span>
                      </span>
                      <span className={styles.attendeeSide}>{loadingTeam === team.id ? "넣는 중…" : "모두 넣기"}</span>
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
                        {hit.is_me && !reason && <span className={styles.tag}>나 · 누르면 참석</span>}
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
