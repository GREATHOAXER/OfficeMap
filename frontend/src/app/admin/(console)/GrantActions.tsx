"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import CopyButton from "@/components/CopyButton";
import Dialog from "@/components/Dialog";
import type { AdminGrant, GrantOptions } from "@/lib/api";
import { adminExpiredUrl } from "@/lib/loginRedirect";
import ui from "./seating/seating.module.css";
import { validationText } from "./validation";
import styles from "./admin.module.css";

// 관리자 첫 화면의 권한 부여·편집. 최종 관리자는 1~4단계, 그 아래는 맡은 범위 안의 아래 단계 관리자를 지정·편집한다
// (서버 server/app/routers/grants.py). 권한을 처음 받는 사람에게는 관리자 계정이 임시 비밀번호로 만들어진다

type GrantRole = GrantOptions["roles"][number]["role"];
type ApplyMode = AdminGrant["apply_mode"];
type Person = {
  emp_no: string;
  name: string;
  rank: string | null;
  department: string;
  has_account: boolean;
  grants: string[]; // 이미 가진 관리자 권한 ("층 관리자 · 서울 본사 · 7F")
};
type Choice = {
  role: GrantRole | null;
  siteId: number | null;
  floorId: number | null;
  zoneId: number | null;
  applyMode: ApplyMode;
};
/** 층 줄의 "+ 지정"처럼 미리 골라 여는 권한 */
export type GrantPreset = { role: GrantRole; siteId: number; floorId?: number };

const json = { "content-type": "application/json" };

const ROLE_HINT: Record<GrantRole, string> = {
  COMPANY_ADMIN: "모든 사업장 · 사업장·층 생성, 조직도, 2~4단계 지정",
  SITE_ADMIN: "사업장 한 곳 · 층 추가, 도면, 층·구역 관리자 지정",
  FLOOR_ADMIN: "층 하나 · 도면, 팀 구역, 층 전체 배치, 구역 관리자 지정 (한 층에 여러 명 가능)",
  ZONE_ADMIN: "팀 구역 하나 · 구역 안 좌석 배정",
};

function errorText(code: string | undefined, detail: Record<string, unknown> | undefined): string {
  switch (code) {
    case "ALREADY_GRANTED":
      return "이 사람은 이미 같은 범위의 같은 권한을 가지고 있어요";
    case "NOT_IN_SCOPE":
      return "내 관리 범위 밖이라 이 권한은 다룰 수 없어요";
    case "EMPLOYEE_NOT_FOUND":
      return "재직 중인 직원을 찾지 못했어요";
    case "SCOPE_REQUIRED":
      return "맡길 범위(사업장·층·구역)를 골라 주세요";
    case "GRANT_NOT_FOUND":
      return "이미 회수된 권한이에요. 화면을 새로 고쳐 보세요";
    default:
      return validationText(detail) ?? "저장하지 못했어요. 다시 해 보세요";
  }
}

/** 요청 → 401이면 관리자 로그인으로, 실패면 오류 글. 성공하면 응답 본문 */
function useCall() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function call<T>(url: string, method: string, body?: unknown): Promise<T | null> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method,
        headers: body === undefined ? undefined : json,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
      });
      if (res.status === 401) {
        router.replace(adminExpiredUrl());
        return null;
      }
      const out = res.status === 204 ? {} : await res.json().catch(() => null);
      if (!res.ok) {
        setError(errorText(out?.detail?.code, out?.detail));
        return null;
      }
      return out as T;
    } catch {
      setError("네트워크 오류로 저장하지 못했어요");
      return null;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, call, refresh: () => router.refresh() };
}

/** 창을 열 때 고를 거리를 받아 온다 */
function useOptions(open: boolean) {
  const [options, setOptions] = useState<GrantOptions | null>(null);
  useEffect(() => {
    if (!open || options) return;
    let alive = true;
    void fetch("/api/admin/grants/options", { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<GrantOptions>) : null))
      .then((out) => alive && setOptions(out));
    return () => {
      alive = false;
    };
  }, [open, options]);
  return options;
}

/** 역할에 맞춰 고를 수 있는 사업장·층. 층 관리자는 줄 수 있는 층만, 구역 관리자는 내가 맡은 층 */
function floorsFor(options: GrantOptions, role: GrantRole | null, siteId: number | null) {
  const site = options.sites.find((s) => s.id === siteId);
  if (!site) return [];
  return role === "FLOOR_ADMIN" ? site.floors.filter((f) => f.floor_admin) : site.floors;
}

function sitesFor(options: GrantOptions, role: GrantRole | null) {
  if (role === "FLOOR_ADMIN") return options.sites.filter((s) => s.floors.some((f) => f.floor_admin));
  if (role === "ZONE_ADMIN") return options.sites.filter((s) => s.floors.length > 0);
  return options.sites;
}

/** 역할을 바꾸면 범위를 그 역할에서 고를 수 있는 첫 칸으로 (이미 고른 것이 맞으면 그대로) */
function fitChoice(options: GrantOptions, c: Choice): Choice {
  const sites = sitesFor(options, c.role);
  const siteId = sites.some((s) => s.id === c.siteId) ? c.siteId : (sites[0]?.id ?? null);
  const floors = floorsFor(options, c.role, siteId);
  const floorId = floors.some((f) => f.id === c.floorId) ? c.floorId : (floors[0]?.id ?? null);
  const zones = floors.find((f) => f.id === floorId)?.zones ?? [];
  const zoneId = zones.some((z) => z.id === c.zoneId) ? c.zoneId : (zones[0]?.id ?? null);
  return { ...c, siteId, floorId, zoneId };
}

function payload(c: Choice) {
  return {
    role: c.role,
    site_id: c.role === "SITE_ADMIN" ? c.siteId : null,
    floor_id: c.role === "FLOOR_ADMIN" ? c.floorId : null,
    zone_id: c.role === "ZONE_ADMIN" ? c.zoneId : null,
    apply_mode: c.applyMode,
  };
}

/** 역할 → 사업장 → 층 → 구역 (+ 구역 관리자의 변경 반영 방식) */
function RoleScopeFields({
  options,
  choice,
  onChange,
}: {
  options: GrantOptions;
  choice: Choice;
  onChange: (c: Choice) => void;
}) {
  // 라디오 묶음 이름은 창마다 다르게 (같은 화면의 다른 권한 부여 창과 한 묶음이 되어 선택을 빼앗지 않게)
  const group = useId();
  const set = (patch: Partial<Choice>) => onChange(fitChoice(options, { ...choice, ...patch }));
  const sites = sitesFor(options, choice.role);
  const floors = floorsFor(options, choice.role, choice.siteId);
  const zones = floors.find((f) => f.id === choice.floorId)?.zones ?? [];
  const role = choice.role;
  return (
    <>
      <fieldset className={ui.when}>
        <legend>권한</legend>
        {options.roles.map((r) => (
          <label key={r.role} style={{ alignItems: "flex-start" }}>
            <input
              type="radio"
              name={`${group}-role`}
              checked={role === r.role}
              onChange={() => set({ role: r.role })}
            />
            <span>
              <strong>
                LEVEL {r.level} {r.label}
              </strong>
              <span className={ui.hint} style={{ display: "block" }}>
                {ROLE_HINT[r.role]}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      {role && role !== "COMPANY_ADMIN" && (
        <div className={styles.scopeRow}>
          <label className={ui.field}>
            <span>사업장</span>
            <select
              className={ui.select}
              value={choice.siteId ?? ""}
              onChange={(e) => set({ siteId: Number(e.target.value), floorId: null, zoneId: null })}
            >
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          {(role === "FLOOR_ADMIN" || role === "ZONE_ADMIN") && (
            <label className={ui.field}>
              <span>층</span>
              <select
                className={ui.select}
                value={choice.floorId ?? ""}
                onChange={(e) => set({ floorId: Number(e.target.value), zoneId: null })}
              >
                {floors.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                    {role === "ZONE_ADMIN" && f.zones.length === 0 ? " (팀 구역 없음)" : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
          {role === "ZONE_ADMIN" && zones.length > 0 && (
            <label className={ui.field}>
              <span>팀 구역</span>
              <select
                className={ui.select}
                value={choice.zoneId ?? ""}
                onChange={(e) => set({ zoneId: Number(e.target.value) })}
              >
                {zones.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.code}구역 · {z.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
      {role === "ZONE_ADMIN" && zones.length === 0 && (
        <p className={ui.hint}>
          이 층에는 아직 팀 구역이 없어요. 좌석 배치 편집에서 구역을 만든 뒤 지정하세요. 구역 관리자가 없으면 층
          관리자가 그 구역 배치까지 맡아요.
        </p>
      )}
      {role === "ZONE_ADMIN" && (
        <fieldset className={ui.when}>
          <legend>구역 관리자의 변경 반영</legend>
          <label>
            <input
              type="radio"
              name={`${group}-apply`}
              checked={choice.applyMode === "NEEDS_APPROVAL"}
              onChange={() => set({ applyMode: "NEEDS_APPROVAL" })}
            />{" "}
            층 관리자 승인 후
          </label>
          <label>
            <input
              type="radio"
              name={`${group}-apply`}
              checked={choice.applyMode === "IMMEDIATE"}
              onChange={() => set({ applyMode: "IMMEDIATE" })}
            />{" "}
            즉시 반영
          </label>
          {choice.applyMode === "NEEDS_APPROVAL" && (
            <span className={ui.hint}>
              구역 관리자가 올린 변경은 그 층의 층 관리자 이상(층·사업장·전사·최종 관리자)이 관리자 첫 화면의 승인함에서
              승인하면 반영돼요.
            </span>
          )}
        </fieldset>
      )}
    </>
  );
}

/** 새로 만든 관리자 계정·초기화한 비밀번호. 다시 볼 수 없으니 "적어 두었어요"로만 닫는다
 *  (Esc·바깥 누르기로 닫히면 창을 다시 띄우고 warned로 알려 준다) */
function TempPassword({
  name,
  empNo,
  password,
  warned,
}: {
  name: string;
  empNo: string;
  password: string;
  warned: boolean;
}) {
  return (
    <>
      <p>
        <strong>{name}</strong> 님의 관리자 페이지 임시 비밀번호예요 (관리자 ID는 사번{" "}
        <span className="mono">{empNo}</span>). 이 창을 닫으면 다시 볼 수 없어요.
      </p>
      <p className={styles.password}>
        <span className="mono">{password}</span>
        <CopyButton text={password} className={ui.btn} />
      </p>
      <p className={ui.hint}>
        첫 로그인 때 새 관리자 비밀번호를 정하게 돼요. 직원 화면 비밀번호와는 따로예요. 메신저·메일로 본인에게만 전해
        주세요.
      </p>
      {warned && (
        <p className={ui.conflictText} role="status">
          잘못 닫지 않도록 이 창은 &ldquo;적어 두었어요&rdquo;를 눌러야 닫혀요.
        </p>
      )}
    </>
  );
}

/** 권한 부여: 사람 찾기 → 권한·범위 고르기. preset이 있으면 그 권한·층으로 미리 골라 연다 */
export function GrantButton({ preset, label = "권한 부여" }: { preset?: GrantPreset; label?: string }) {
  const [open, setOpen] = useState(false);
  const options = useOptions(open);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Person[]>([]);
  const [person, setPerson] = useState<Person | null>(null);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [result, setResult] = useState<{
    name: string;
    empNo: string;
    text: string;
    password: string | null;
  } | null>(null);
  // 임시 비밀번호 창을 Esc·바깥 누르기로 닫으면 다시 띄운다 (새로 그리려고 key를 바꾼다)
  const [reopen, setReopen] = useState(0);
  const { busy, error, setError, call, refresh } = useCall();
  const group = useId();

  // 고를 거리가 오면 첫 선택을 정한다 (미리 고른 권한·층이 있으면 그것)
  const [readyFor, setReadyFor] = useState<GrantOptions | null>(null);
  if (options && readyFor !== options) {
    setReadyFor(options);
    const role = preset?.role ?? options.roles[0]?.role ?? null;
    setChoice(
      fitChoice(options, {
        role: options.roles.some((r) => r.role === role) ? role : (options.roles[0]?.role ?? null),
        siteId: preset?.siteId ?? null,
        floorId: preset?.floorId ?? null,
        zoneId: null,
        applyMode: "NEEDS_APPROVAL",
      }),
    );
  }

  useEffect(() => {
    const text = q.trim();
    if (!text) return;
    let alive = true;
    const timer = setTimeout(() => {
      void fetch(`/api/admin/grants/people?q=${encodeURIComponent(text)}`, { cache: "no-store" })
        .then((res) => (res.ok ? (res.json() as Promise<{ people: Person[] }>) : { people: [] }))
        .then((out) => alive && setHits(out.people));
    }, 200);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [q]);

  function close() {
    setOpen(false);
    setPerson(null);
    setQ("");
    setHits([]);
    setResult(null);
    setError(null);
    setReopen(0);
    setReadyFor(null); // 다음에 열면 미리 고른 권한부터 다시
  }

  async function save() {
    if (!person) return setError("권한을 줄 사람을 먼저 찾아 고르세요");
    if (!choice?.role) return setError("줄 권한을 고르세요");
    const out = await call<{ grant: AdminGrant; temporary_password: string | null }>("/api/admin/grants", "POST", {
      emp_no: person.emp_no,
      ...payload(choice),
    });
    if (!out) return;
    refresh();
    setResult({
      name: person.name,
      empNo: person.emp_no,
      text: `${out.grant.label} · ${out.grant.scope}`,
      password: out.temporary_password,
    });
  }

  return (
    <>
      <button
        type="button"
        className={preset ? styles.addLink : `${styles.btn} ${styles.pri}`}
        onClick={() => setOpen(true)}
      >
        {label}
      </button>
      <Dialog
        key={reopen}
        open={open}
        onClose={result?.password ? () => setReopen((k) => k + 1) : close}
        title={result ? "권한을 줬어요" : "권한 부여"}
        footer={
          result ? (
            <button type="button" className={`${ui.btn} ${ui.pri}`} onClick={close}>
              {result.password ? "적어 두었어요" : "확인"}
            </button>
          ) : (
            <>
              <button type="button" className={ui.btn} onClick={close}>
                닫기
              </button>
              <button
                type="button"
                className={`${ui.btn} ${ui.pri}`}
                disabled={busy || !options}
                onClick={() => void save()}
              >
                {busy ? "주는 중…" : "권한 주기"}
              </button>
            </>
          )
        }
      >
        <div className={ui.dialogBody}>
          {result ? (
            <>
              <p>
                <strong>{result.name}</strong> 님에게 <strong>{result.text}</strong> 권한을 줬어요.
              </p>
              {result.password ? (
                <TempPassword name={result.name} empNo={result.empNo} password={result.password} warned={reopen > 0} />
              ) : (
                <p className={ui.hint}>이미 관리자 계정이 있어 쓰던 관리자 비밀번호로 그대로 들어와요.</p>
              )}
            </>
          ) : (
            <>
              {person ? (
                <p className={styles.picked}>
                  <strong>{person.name}</strong> {person.rank} <span className="mono">{person.emp_no}</span>
                  <span className={ui.muted}>{person.department}</span>
                  <button type="button" className={ui.btn} onClick={() => setPerson(null)}>
                    다른 사람
                  </button>
                </p>
              ) : (
                <>
                  <label className={ui.field}>
                    <span>권한을 줄 사람 (이름·사번)</span>
                    <input
                      className={ui.textInput}
                      value={q}
                      data-autofocus
                      placeholder="예: 정민호 또는 20130003"
                      onChange={(e) => setQ(e.target.value)}
                    />
                  </label>
                  <ul className={styles.pickList} aria-label="찾은 사람">
                    {(q.trim() ? hits : []).map((p) => (
                      <li key={p.emp_no}>
                        <label>
                          <input type="radio" name={`${group}-person`} onChange={() => setPerson(p)} />
                          <strong>{p.name}</strong> {p.rank} <span className="mono">{p.emp_no}</span>
                          <span className={ui.muted}>{p.department}</span>
                          {p.grants.length > 0 && <span className={styles.held}>지금: {p.grants.join(" / ")}</span>}
                        </label>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {person && person.grants.length > 0 && (
                <p className={ui.hint}>지금 가진 권한: {person.grants.join(" / ")}</p>
              )}
              {options && choice ? (
                options.roles.length > 0 ? (
                  <RoleScopeFields options={options} choice={choice} onChange={setChoice} />
                ) : (
                  <p className={ui.hint}>내 권한으로 줄 수 있는 관리자 권한이 없어요.</p>
                )
              ) : (
                <p className={ui.hint}>고를 수 있는 권한을 불러오는 중…</p>
              )}
              {person && !person.has_account && (
                <p className={ui.hint}>
                  관리자 계정이 없는 사람이라 권한을 주면 관리자 계정이 임시 비밀번호로 만들어져요.
                </p>
              )}
            </>
          )}
          {error && (
            <p className={ui.conflictText} role="alert">
              {error}
            </p>
          )}
        </div>
      </Dialog>
    </>
  );
}

/** 관리자 목록의 "편집": 권한·범위·반영 방식 고치기, 권한 회수, 관리자 비밀번호 초기화(잠금 해제) */
export function GrantEditButton({ grant, canReset }: { grant: AdminGrant; canReset: boolean }) {
  const [open, setOpen] = useState(false);
  const options = useOptions(open);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [confirm, setConfirm] = useState<"revoke" | "reset" | null>(null);
  const [password, setPassword] = useState<string | null>(null);
  const [reopen, setReopen] = useState(0);
  const { busy, error, setError, call, refresh } = useCall();
  const who = grant.employee;

  const [readyFor, setReadyFor] = useState<GrantOptions | null>(null);
  if (options && readyFor !== options) {
    setReadyFor(options);
    setChoice(
      fitChoice(options, {
        role: grant.role === "SUPER_ADMIN" ? null : grant.role,
        siteId: grant.site_id,
        floorId: grant.floor_id,
        zoneId: grant.zone_id,
        applyMode: grant.apply_mode,
      }),
    );
  }

  function close() {
    setOpen(false);
    setConfirm(null);
    setPassword(null);
    setError(null);
    setReopen(0);
    setReadyFor(null);
  }

  async function save() {
    if (!choice?.role) return;
    const out = await call(`/api/admin/grants/${grant.id}`, "PUT", payload(choice));
    if (out) {
      refresh();
      close();
    }
  }

  async function revoke() {
    if (confirm !== "revoke") return setConfirm("revoke");
    if (await call(`/api/admin/grants/${grant.id}`, "DELETE")) {
      refresh();
      close();
    }
  }

  async function reset() {
    if (confirm !== "reset") return setConfirm("reset");
    const out = await call<{ temporary_password: string }>(`/api/admin/admins/${who.emp_no}/reset-password`, "POST");
    if (out) {
      refresh();
      setConfirm(null);
      setPassword(out.temporary_password);
    }
  }

  return (
    <>
      <button type="button" className={styles.btn} onClick={() => setOpen(true)}>
        편집
      </button>
      <Dialog
        key={reopen}
        open={open}
        onClose={password ? () => setReopen((k) => k + 1) : close}
        title={password ? "관리자 비밀번호 초기화" : `${who.name} · ${grant.label} 편집`}
        footer={
          password ? (
            <button type="button" className={`${ui.btn} ${ui.pri}`} onClick={close}>
              적어 두었어요
            </button>
          ) : (
            <>
              <button type="button" className={ui.btn} onClick={close}>
                닫기
              </button>
              <button
                type="button"
                className={`${ui.btn} ${ui.pri}`}
                disabled={busy || !choice?.role}
                onClick={() => void save()}
              >
                {busy ? "저장 중…" : "저장"}
              </button>
            </>
          )
        }
      >
        <div className={ui.dialogBody}>
          {password ? (
            <TempPassword name={who.name} empNo={who.emp_no} password={password} warned={reopen > 0} />
          ) : (
            <>
              <p className={styles.picked}>
                <strong>{who.name}</strong> {who.rank} <span className="mono">{who.emp_no}</span>
                <span className={ui.muted}>{who.department}</span>
                {grant.account.locked && (
                  <span className={styles.accountTag} data-tone="danger">
                    잠김
                  </span>
                )}
                {grant.account.temporary_password && <span className={styles.accountTag}>임시 비밀번호</span>}
              </p>
              <p className={ui.hint}>
                지금: {grant.label} · {grant.scope}
                {grant.granted_by ? ` · ${grant.granted_by} 지정` : ""}. 권한이나 범위를 바꾸면 지금 권한을 회수하고
                새로 줘요.
              </p>
              {options && choice ? (
                <RoleScopeFields options={options} choice={choice} onChange={setChoice} />
              ) : (
                <p className={ui.hint}>불러오는 중…</p>
              )}
              <div className={styles.dangerZone}>
                <button type="button" className={`${ui.btn} ${ui.ghost}`} disabled={busy} onClick={() => void revoke()}>
                  {confirm === "revoke" ? "정말 회수" : "이 권한 회수"}
                </button>
                {canReset && (
                  <button
                    type="button"
                    className={`${ui.btn} ${ui.ghost}`}
                    disabled={busy}
                    onClick={() => void reset()}
                  >
                    {confirm === "reset"
                      ? "정말 초기화"
                      : grant.account.locked
                        ? "잠금 풀고 비밀번호 초기화"
                        : "관리자 비밀번호 초기화"}
                  </button>
                )}
              </div>
              {confirm === "revoke" && (
                <p className={ui.hint} role="status">
                  회수하면 {who.name} 님은 이 범위를 더 관리하지 못해요. 남은 권한이 없으면 관리자 페이지에 들어오지
                  못해요. 한 번 더 누르면 회수해요.
                </p>
              )}
              {confirm === "reset" && (
                <p className={ui.hint} role="status">
                  임시 비밀번호를 새로 만들고 잠금도 풀어요. 그 사람의 관리자 로그인은 지금 끝나요. 한 번 더 누르면
                  초기화해요.
                </p>
              )}
            </>
          )}
          {error && (
            <p className={ui.conflictText} role="alert">
              {error}
            </p>
          )}
        </div>
      </Dialog>
    </>
  );
}
