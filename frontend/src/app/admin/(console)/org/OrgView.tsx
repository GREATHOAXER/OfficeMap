"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Dialog from "@/components/Dialog";
import type { Admin, OrgDepartment, OrgMember } from "@/lib/api";
import ui from "../seating/seating.module.css";
import { validationText } from "../validation";
import styles from "./org.module.css";

const json = { "content-type": "application/json" };
const EXPIRED = "/admin/login?reason=expired&next=/admin/org";

type Org = { departments: OrgDepartment[]; can_edit: boolean };
type Person = { emp_no: string; name: string; rank: string | null; department_id: number; department: string };

/** 열린 대화상자 */
type Open =
  | { kind: "dept"; dept: OrgDepartment | null; parentId: number | null }
  | { kind: "closeDept"; dept: OrgDepartment }
  | { kind: "bring" }
  | { kind: "newEmp" }
  | { kind: "person"; member: OrgMember }
  | { kind: "password"; name: string; password: string }
  | null;

/** API 오류 코드 → 글 */
function errorText(code: string | undefined, detail: Record<string, unknown> | undefined): string {
  switch (code) {
    case "DEPT_NOT_EMPTY":
      return `사람 ${detail?.members ?? 0}명 · 아래 부서 ${detail?.children ?? 0}개가 남아 있어요. 먼저 옮기거나 없애세요`;
    case "DEPT_NAME_TAKEN":
      return `같은 이름의 부서가 이미 있어요${detail?.parent ? ` (${detail.parent} 아래)` : ""} · 다른 이름을 쓰세요`;
    case "NAME_REQUIRED":
      return "이름을 넣어 주세요";
    case "DEPARTMENT_REQUIRED":
      return "부서를 고르세요";
    case "PARENT_CYCLE":
      return "자기 아래 부서 밑으로는 옮길 수 없어요";
    case "DEPT_CODE_TAKEN":
      return "같은 부서코드가 있어요";
    case "EMP_NO_TAKEN":
      return "같은 사번이 있어요";
    case "CANNOT_RETIRE_SELF":
      return "나 자신은 퇴사 처리할 수 없어요";
    case "COMPANY_ADMIN_ONLY":
      return "조직도는 전사 관리자만 고칠 수 있어요";
    case "EMPLOYEE_NOT_FOUND":
      return "그 직원을 찾지 못했어요 (그새 바뀌었을 수 있어요)";
    default:
      return validationText(detail) ?? "저장하지 못했어요. 입력을 확인하고 다시 해 보세요";
  }
}

/** 부서 나무: 위 부서 → 아래 부서들, 깊이, 경로 */
function treeOf(departments: OrgDepartment[]) {
  const children = new Map<number | null, OrgDepartment[]>();
  const byId = new Map(departments.map((d) => [d.id, d]));
  for (const d of departments) {
    const parent = d.parent_id !== null && byId.has(d.parent_id) ? d.parent_id : null;
    children.set(parent, [...(children.get(parent) ?? []), d]);
  }
  const order: { dept: OrgDepartment; depth: number }[] = [];
  const walk = (parent: number | null, depth: number) => {
    for (const d of children.get(parent) ?? []) {
      order.push({ dept: d, depth });
      walk(d.id, depth + 1);
    }
  };
  walk(null, 0);
  const path = (id: number): string[] => {
    const d = byId.get(id);
    return d ? [...(d.parent_id !== null ? path(d.parent_id) : []), d.name] : [];
  };
  // 아래 부서까지 합친 사람 수 (본부는 바로 속한 사람이 없어 0명으로 보이지 않게)
  const total = (id: number): number =>
    (byId.get(id)?.members ?? 0) + (children.get(id) ?? []).reduce((n, c) => n + total(c.id), 0);
  return { children, order, byId, path, total };
}

export default function OrgView({
  admin,
  initial,
  initialDept,
}: {
  admin: Admin;
  initial: Org;
  initialDept: number | null;
}) {
  const router = useRouter();
  const [org, setOrg] = useState<Org>(initial);
  const [inactive, setInactive] = useState(false);
  const tree = useMemo(() => treeOf(org.departments), [org.departments]);
  const [selected, setSelected] = useState<number | null>(
    initialDept && tree.byId.has(initialDept) ? initialDept : (tree.order[0]?.dept.id ?? null),
  );
  const [members, setMembers] = useState<OrgMember[] | null>(null);
  const [folded, setFolded] = useState<Set<number>>(new Set());
  const [open, setOpen] = useState<Open>(null);
  // 임시 비밀번호 창을 Esc·바깥 누르기로 닫으면 다시 띄운다 (새로 그리려고 key를 바꾼다)
  const [passwordKey, setPasswordKey] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const dept = selected !== null ? (tree.byId.get(selected) ?? null) : null;
  const canEdit = org.can_edit;

  const say = useCallback((text: string) => {
    clearTimeout(toastTimer.current);
    setToast(text);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  /** 요청 → 401이면 로그인, 실패면 오류 글을 던진다 */
  const call = useCallback(
    async <T,>(url: string, method = "GET", body?: unknown): Promise<T> => {
      const res = await fetch(url, {
        method,
        headers: body === undefined ? undefined : json,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
      });
      if (res.status === 401) {
        router.replace(EXPIRED);
        throw new Error("로그인이 끝났어요");
      }
      const out = res.status === 204 ? null : await res.json().catch(() => null);
      if (!res.ok) throw new Error(errorText(out?.detail?.code, out?.detail));
      return out as T;
    },
    [router],
  );

  const reloadOrg = useCallback(
    async (withInactive = inactive) => setOrg(await call<Org>(`/api/admin/org?inactive=${withInactive}`)),
    [call, inactive],
  );
  const reloadMembers = useCallback(async () => {
    if (selected === null) return;
    const out = await call<{ members: OrgMember[] }>(`/api/admin/org/departments/${selected}/members`);
    setMembers(out.members);
  }, [call, selected]);

  // 부서를 고르면 팀원을 읽고 주소에 남긴다 (새로 고쳐도 같은 부서)
  useEffect(() => {
    if (selected === null) return;
    let alive = true;
    void fetch(`/api/admin/org/departments/${selected}/members`, { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<{ members: OrgMember[] }>) : null))
      .then((out) => alive && setMembers(out?.members ?? []))
      .catch(() => alive && setMembers([]));
    // 주소만 바꾼다 (router로 바꾸면 서버가 조직도 전체를 다시 그려 보낸다)
    const url = `/admin/org?dept=${selected}`;
    if (window.location.pathname + window.location.search !== url) window.history.replaceState(null, "", url);
    return () => {
      alive = false;
    };
  }, [selected]);

  async function after(text: string, deptId?: number | null) {
    await reloadOrg();
    if (deptId !== undefined && deptId !== selected) setSelected(deptId);
    else await reloadMembers();
    setOpen(null);
    say(text);
  }

  const options = tree.order.filter((o) => o.dept.is_active);
  const deptSelect = (value: number | null, onChange: (id: number) => void, label: string, exclude?: Set<number>) => (
    <label className={ui.field}>
      <span>{label}</span>
      <select className={ui.select} value={value ?? ""} onChange={(e) => onChange(Number(e.target.value))}>
        {options
          .filter((o) => !exclude?.has(o.dept.id))
          .map((o) => (
            <option key={o.dept.id} value={o.dept.id}>
              {"　".repeat(o.depth)}
              {o.dept.name}
            </option>
          ))}
      </select>
    </label>
  );

  const visible = (id: number | null): boolean => {
    if (id === null) return true;
    const d = tree.byId.get(id);
    return !d || d.parent_id === null || (!folded.has(d.parent_id) && visible(d.parent_id));
  };

  return (
    <div className={ui.page}>
      <header className={ui.header}>
        <div className={ui.titleRow}>
          <h1 className={ui.title}>조직도</h1>
          <span className={ui.roleChip}>
            <strong>{admin.role_label}</strong>
            {canEdit ? " · 부서·팀원을 고칠 수 있어요" : " · 보기만"}
          </span>
        </div>
        {canEdit && (
          <div className={ui.headerActions}>
            <button
              type="button"
              className={ui.btn}
              onClick={() => setOpen({ kind: "dept", dept: null, parentId: null })}
            >
              + 본부·부서 추가
            </button>
            <button type="button" className={`${ui.btn} ${ui.pri}`} onClick={() => setOpen({ kind: "newEmp" })}>
              + 새 직원 등록
            </button>
          </div>
        )}
      </header>
      <p className={ui.infoBar}>
        부서를 옮기거나 퇴사하면 그 사람의 고정석 배정은 끝나고, 새 팀의 미배치 인원으로 좌석 배치 화면에 떠요. 휴직은
        자리를 그대로 둬요. 없앤 부서의 팀 구역은 남아서 배치 화면에 &ldquo;폐지된 부서&rdquo;로 보여요.
      </p>

      <div className={styles.layout}>
        <section className={`${ui.card} ${styles.treeCard}`} aria-labelledby="tree-title">
          <div className={ui.cardHead}>
            <h2 id="tree-title" className={ui.cardTitle}>
              부서 <span className="mono">{org.departments.filter((d) => d.is_active).length}</span>
            </h2>
            <label className={ui.check}>
              <input
                type="checkbox"
                checked={inactive}
                onChange={(e) => {
                  setInactive(e.target.checked);
                  void reloadOrg(e.target.checked);
                }}
              />
              없앤 부서도
            </label>
          </div>
          <ul className={styles.tree} role="tree" aria-label="부서 나무">
            {tree.order
              .filter((o) => visible(o.dept.id))
              .map(({ dept: d, depth }) => {
                const kids = (tree.children.get(d.id) ?? []).length;
                return (
                  <li key={d.id} role="treeitem" aria-selected={d.id === selected} aria-level={depth + 1}>
                    <div
                      className={styles.node}
                      style={{ paddingLeft: 8 + depth * 18 }}
                      data-inactive={!d.is_active || undefined}
                    >
                      {kids > 0 ? (
                        <button
                          type="button"
                          className={styles.fold}
                          aria-label={folded.has(d.id) ? `${d.name} 펼치기` : `${d.name} 접기`}
                          aria-expanded={!folded.has(d.id)}
                          onClick={() =>
                            setFolded((f) => {
                              const next = new Set(f);
                              if (next.has(d.id)) next.delete(d.id);
                              else next.add(d.id);
                              return next;
                            })
                          }
                        >
                          {folded.has(d.id) ? "▸" : "▾"}
                        </button>
                      ) : (
                        <span className={styles.fold} aria-hidden="true" />
                      )}
                      <button
                        type="button"
                        className={styles.nodeName}
                        aria-current={d.id === selected || undefined}
                        onClick={() => setSelected(d.id)}
                      >
                        {d.name}
                        {!d.is_active && <span className={styles.badge}>없앰</span>}
                        <span
                          className={styles.count}
                          title={tree.children.has(d.id) ? `아래 부서 포함 · 바로 속한 사람 ${d.members}명` : undefined}
                        >
                          {tree.total(d.id)}
                        </span>
                      </button>
                    </div>
                  </li>
                );
              })}
          </ul>
        </section>

        <section className={`${ui.card} ${styles.detail}`} aria-labelledby="dept-title">
          {!dept ? (
            <p className={ui.hint}>왼쪽에서 부서를 고르세요.</p>
          ) : (
            <>
              <div className={ui.cardHead}>
                <div>
                  <p className={styles.path}>{tree.path(dept.id).slice(0, -1).join(" › ") || "최상위"}</p>
                  <h2 id="dept-title" className={styles.deptTitle}>
                    {dept.name} <span className="mono">{dept.code}</span>
                    {!dept.is_active && <span className={styles.badge}>없앤 부서</span>}
                  </h2>
                  <p className={ui.hint}>
                    {dept.members}명
                    {tree.children.has(dept.id) && ` · 아래 부서 포함 ${tree.total(dept.id)}명`}
                    {dept.zones.length > 0 && ` · 팀 구역 ${dept.zones.map((z) => `${z.floor} ${z.code}`).join(", ")}`}
                  </p>
                </div>
                {canEdit && dept.is_active && (
                  <div className={ui.rowButtons}>
                    <button
                      type="button"
                      className={ui.btn}
                      onClick={() => setOpen({ kind: "dept", dept, parentId: dept.parent_id })}
                    >
                      이름·위 부서
                    </button>
                    <button
                      type="button"
                      className={ui.btn}
                      onClick={() => setOpen({ kind: "dept", dept: null, parentId: dept.id })}
                    >
                      + 아래 부서
                    </button>
                    <button
                      type="button"
                      className={`${ui.btn} ${ui.ghost}`}
                      onClick={() => setOpen({ kind: "closeDept", dept })}
                    >
                      부서 없애기
                    </button>
                  </div>
                )}
              </div>

              <div className={styles.membersHead}>
                <h3>팀원</h3>
                {canEdit && dept.is_active && (
                  <div className={ui.rowButtons}>
                    <button type="button" className={ui.btn} onClick={() => setOpen({ kind: "bring" })}>
                      + 다른 부서에서 데려오기
                    </button>
                    <button type="button" className={ui.btn} onClick={() => setOpen({ kind: "newEmp" })}>
                      + 새 직원 등록
                    </button>
                  </div>
                )}
              </div>
              {members === null ? (
                <p className={ui.hint}>읽는 중…</p>
              ) : members.length === 0 ? (
                <p className={ui.hint}>
                  이 부서에 바로 속한 사람이 없어요
                  {(tree.children.get(dept.id) ?? []).length > 0 && " (아래 부서를 보세요)"}.
                </p>
              ) : (
                <div className={styles.tableScroll}>
                  <table className={styles.table}>
                    <caption className="visually-hidden">{dept.name} 팀원</caption>
                    <thead>
                      <tr>
                        <th scope="col">이름</th>
                        <th scope="col">사번</th>
                        <th scope="col">자리</th>
                        <th scope="col">내선</th>
                        <th scope="col">
                          <span className="visually-hidden">고치기</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {members.map((m) => (
                        <tr key={m.emp_no} data-leave={m.status === "LEAVE" || undefined}>
                          <td>
                            <strong>{m.name}</strong> {[m.rank, m.position].filter(Boolean).join(" · ")}
                            {m.status === "LEAVE" && <span className={styles.badge}>휴직</span>}
                            {m.is_admin && (
                              <span className={styles.badge} data-tone="admin">
                                관리자
                              </span>
                            )}
                            {m.temporary_password && <span className={styles.badge}>임시 비밀번호</span>}
                          </td>
                          <td className="mono">{m.emp_no}</td>
                          <td>
                            {m.seat_code ? (
                              `${m.site_name ?? ""} ${m.floor_name} ${m.seat_code}`.trim()
                            ) : (
                              <span className={ui.muted}>없음</span>
                            )}
                          </td>
                          <td className="mono">{m.extension ?? "—"}</td>
                          <td className={styles.rowActions}>
                            {canEdit && (
                              <button
                                type="button"
                                className={ui.btn}
                                onClick={() => setOpen({ kind: "person", member: m })}
                              >
                                고치기·옮기기
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {open?.kind === "dept" && (
        <DeptDialog
          dept={open.dept}
          parentId={open.parentId}
          tree={tree}
          deptSelect={deptSelect}
          call={call}
          onDone={(d, text) => void after(text, d.id)}
          onClose={() => setOpen(null)}
        />
      )}
      {open?.kind === "closeDept" && (
        <CloseDeptDialog
          dept={open.dept}
          call={call}
          onDone={(text) => void after(text, open.dept.parent_id ?? null)}
          onClose={() => setOpen(null)}
        />
      )}
      {open?.kind === "bring" && dept && (
        <BringDialog dept={dept} call={call} onDone={(text) => void after(text)} onClose={() => setOpen(null)} />
      )}
      {open?.kind === "newEmp" && (
        <NewEmployeeDialog
          deptId={dept?.is_active ? dept.id : (options[0]?.dept.id ?? null)}
          deptSelect={deptSelect}
          call={call}
          onDone={(name, password, deptId) => {
            void after(`${name} 님을 등록했어요`, deptId).then(() => {
              setPasswordKey(0);
              setOpen({ kind: "password", name, password });
            });
          }}
          onClose={() => setOpen(null)}
        />
      )}
      {open?.kind === "person" && (
        <PersonDialog
          member={open.member}
          deptId={selected}
          deptSelect={deptSelect}
          deptName={(id) => tree.byId.get(id)?.name ?? ""}
          myEmpNo={admin.emp_no}
          call={call}
          onDone={(text) => void after(text)}
          onPassword={(password) => {
            setPasswordKey(0);
            setOpen({ kind: "password", name: open.member.name, password });
          }}
          onClose={() => setOpen(null)}
        />
      )}
      {open?.kind === "password" && (
        <Dialog
          key={passwordKey}
          open
          onClose={() => setPasswordKey((k) => k + 1)}
          title="임시 비밀번호"
          footer={
            <button type="button" className={`${ui.btn} ${ui.pri}`} onClick={() => setOpen(null)}>
              적어 두었어요
            </button>
          }
        >
          <div className={ui.dialogBody}>
            <p>
              <strong>{open.name}</strong> 님의 직원 화면 임시 비밀번호예요. 이 창을 닫으면 다시 볼 수 없어요.
            </p>
            <p className={styles.password}>
              <span className="mono">{open.password}</span>
              <button
                type="button"
                className={ui.btn}
                onClick={() => void navigator.clipboard?.writeText(open.password)}
              >
                복사
              </button>
            </p>
            <p className={ui.hint}>첫 로그인 때 새 비밀번호를 정하게 돼요. 메신저·메일로 본인에게만 전해 주세요.</p>
            {passwordKey > 0 && (
              <p className={styles.warn} role="status">
                잘못 닫지 않도록 이 창은 &ldquo;적어 두었어요&rdquo;를 눌러야 닫혀요.
              </p>
            )}
          </div>
        </Dialog>
      )}
      {toast && (
        <div className={ui.toast} role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

type Call = <T>(url: string, method?: string, body?: unknown) => Promise<T>;
type DeptSelect = (
  value: number | null,
  onChange: (id: number) => void,
  label: string,
  exclude?: Set<number>,
) => React.ReactNode;

function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p className={ui.conflictText} role="alert">
      {error}
    </p>
  ) : null;
}

function useBusy() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : "저장하지 못했어요");
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, run };
}

/** 부서 추가 (dept 없음) / 이름·위 부서 바꾸기 */
function DeptDialog({
  dept,
  parentId,
  tree,
  deptSelect,
  call,
  onDone,
  onClose,
}: {
  dept: OrgDepartment | null;
  parentId: number | null;
  tree: ReturnType<typeof treeOf>;
  deptSelect: DeptSelect;
  call: Call;
  onDone: (dept: OrgDepartment, text: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(dept?.name ?? "");
  const [parent, setParent] = useState<number | null>(parentId);
  const [code, setCode] = useState(dept?.code ?? "");
  const { busy, error, setError, run } = useBusy();
  // 자기와 자기 아래 부서는 위 부서로 고를 수 없다
  const blocked = new Set<number>();
  if (dept) {
    const add = (id: number) => {
      blocked.add(id);
      for (const c of tree.children.get(id) ?? []) add(c.id);
    };
    add(dept.id);
  }
  const save = () =>
    run(async () => {
      if (!name.trim()) return setError("부서 이름을 넣어 주세요");
      const body = { name, parent_id: parent, code: code.trim() || null };
      const out = dept
        ? await call<{ department: OrgDepartment }>(`/api/admin/org/departments/${dept.id}`, "PUT", body)
        : await call<{ department: OrgDepartment }>("/api/admin/org/departments", "POST", body);
      onDone(out.department, dept ? `${out.department.name}: 고쳤어요` : `${out.department.name}: 만들었어요`);
    });
  return (
    <Dialog
      open
      onClose={onClose}
      title={dept ? `${dept.name} 고치기` : "부서 추가"}
      footer={
        <>
          <button type="button" className={ui.btn} onClick={onClose}>
            닫기
          </button>
          <button type="button" className={`${ui.btn} ${ui.pri}`} disabled={busy} onClick={() => void save()}>
            {dept ? "저장" : "추가"}
          </button>
        </>
      }
    >
      <div className={ui.dialogBody}>
        <label className={ui.field}>
          <span>부서 이름</span>
          <input
            className={ui.textInput}
            value={name}
            maxLength={100}
            data-autofocus
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className={ui.check}>
          <input
            type="checkbox"
            checked={parent === null}
            onChange={(e) => setParent(e.target.checked ? null : (parentId ?? tree.order[0]?.dept.id ?? null))}
          />
          최상위 (본부 등)
        </label>
        {parent !== null && deptSelect(parent, setParent, "위 부서", blocked)}
        <label className={ui.field}>
          <span>부서코드 (인사 시스템 코드, 비우면 자동)</span>
          <input
            className={`${ui.textInput} mono`}
            value={code}
            maxLength={20}
            onChange={(e) => setCode(e.target.value)}
          />
        </label>
        {dept && (
          <p className={ui.hint}>이름을 바꾸면 이 부서 팀 구역 이름도 따라 바뀌어요 (별칭을 정한 구역은 그대로).</p>
        )}
        <ErrorLine error={error} />
      </div>
    </Dialog>
  );
}

function CloseDeptDialog({
  dept,
  call,
  onDone,
  onClose,
}: {
  dept: OrgDepartment;
  call: Call;
  onDone: (text: string) => void;
  onClose: () => void;
}) {
  const { busy, error, run } = useBusy();
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${dept.name} 없애기`}
      footer={
        <>
          <button type="button" className={ui.btn} onClick={onClose}>
            그대로 두기
          </button>
          <button
            type="button"
            className={`${ui.btn} ${ui.danger}`}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await call(`/api/admin/org/departments/${dept.id}`, "DELETE");
                onDone(`${dept.name}: 없앴어요`);
              })
            }
          >
            부서 없애기
          </button>
        </>
      }
    >
      <div className={ui.dialogBody}>
        <p>
          부서는 지우지 않고 &ldquo;없앤 부서&rdquo;로 남겨요 (예전 기록이 가리키므로). 사람이나 아래 부서가 남아 있으면
          없앨 수 없어요.
        </p>
        {dept.zones.length > 0 && (
          <p className={ui.hint}>
            이 부서의 팀 구역({dept.zones.map((z) => `${z.floor} ${z.code}`).join(", ")})은 남고 배치 화면에
            &ldquo;폐지된 부서&rdquo;로 보여요. 좌석 배치 화면에서 정리하세요.
          </p>
        )}
        <ErrorLine error={error} />
      </div>
    </Dialog>
  );
}

/** 다른 부서 사람을 이 부서로 데려오기 (여러 명) */
function BringDialog({
  dept,
  call,
  onDone,
  onClose,
}: {
  dept: OrgDepartment;
  call: Call;
  onDone: (text: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Person[]>([]);
  const [picked, setPicked] = useState<Map<string, Person>>(new Map());
  const { busy, error, run } = useBusy();

  useEffect(() => {
    const text = q.trim();
    if (!text) return;
    let alive = true;
    const timer = setTimeout(() => {
      void fetch(`/api/admin/org/people?q=${encodeURIComponent(text)}`, { cache: "no-store" })
        .then((res) => (res.ok ? (res.json() as Promise<{ people: Person[] }>) : { people: [] }))
        .then((out) => alive && setHits(out.people));
    }, 200);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [q]);

  const toggle = (p: Person) =>
    setPicked((m) => {
      const next = new Map(m);
      if (next.has(p.emp_no)) next.delete(p.emp_no);
      else next.set(p.emp_no, p);
      return next;
    });

  return (
    <Dialog
      open
      onClose={onClose}
      title={`데려오기 → ${dept.name}`}
      footer={
        <>
          <button type="button" className={ui.btn} onClick={onClose}>
            닫기
          </button>
          <button
            type="button"
            className={`${ui.btn} ${ui.pri}`}
            disabled={busy || picked.size === 0}
            onClick={() =>
              void run(async () => {
                const out = await call<{ moved: number; released: string[] }>(
                  `/api/admin/org/departments/${dept.id}/members`,
                  "POST",
                  { emp_nos: [...picked.keys()] },
                );
                onDone(
                  `${dept.name}: ${out.moved}명을 데려왔어요${
                    out.released.length
                      ? ` · ${out.released.join(", ")} 님은 고정석 배정이 끝나 미배치 인원이 됐어요`
                      : ""
                  }`,
                );
              })
            }
          >
            {picked.size ? `${picked.size}명 데려오기` : "데려오기"}
          </button>
        </>
      }
    >
      <div className={ui.dialogBody}>
        <label className={ui.field}>
          <span>이름·사번으로 찾기</span>
          <input className={ui.textInput} value={q} data-autofocus onChange={(e) => setQ(e.target.value)} />
        </label>
        {picked.size > 0 && <p className={ui.hint}>고름: {[...picked.values()].map((p) => p.name).join(", ")}</p>}
        <ul className={styles.pickList}>
          {(q.trim() ? hits : []).map((p) => {
            const here = p.department_id === dept.id;
            return (
              <li key={p.emp_no}>
                <label data-disabled={here || undefined}>
                  <input type="checkbox" disabled={here} checked={picked.has(p.emp_no)} onChange={() => toggle(p)} />
                  <strong>{p.name}</strong> {p.rank} <span className="mono">{p.emp_no}</span>
                  <span className={ui.muted}>{here ? "이미 이 부서" : p.department}</span>
                </label>
              </li>
            );
          })}
        </ul>
        <p className={ui.hint}>
          옮기면 그 사람의 고정석 배정은 끝나고, {dept.name}의 미배치 인원으로 배치 화면에 떠요.
        </p>
        <ErrorLine error={error} />
      </div>
    </Dialog>
  );
}

function NewEmployeeDialog({
  deptId,
  deptSelect,
  call,
  onDone,
  onClose,
}: {
  deptId: number | null;
  deptSelect: DeptSelect;
  call: Call;
  onDone: (name: string, password: string, deptId: number) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState({
    emp_no: "",
    name: "",
    rank: "",
    position: "",
    email: "",
    extension: "",
    hired_on: "",
  });
  const [dept, setDept] = useState<number | null>(deptId);
  const { busy, error, setError, run } = useBusy();
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value });
  const save = () =>
    run(async () => {
      if (!/^[0-9A-Za-z]{4,20}$/.test(form.emp_no.trim())) return setError("사번은 영문·숫자 4~20자로 넣어 주세요");
      if (!form.name.trim()) return setError("이름을 넣어 주세요");
      if (dept === null) return setError("부서를 고르세요");
      const out = await call<{ employee: { name: string }; temporary_password: string }>(
        "/api/admin/org/employees",
        "POST",
        {
          ...form,
          department_id: dept,
          hired_on: form.hired_on || null,
        },
      );
      onDone(out.employee.name, out.temporary_password, dept);
    });
  return (
    <Dialog
      open
      onClose={onClose}
      title="새 직원 등록"
      footer={
        <>
          <button type="button" className={ui.btn} onClick={onClose}>
            닫기
          </button>
          <button type="button" className={`${ui.btn} ${ui.pri}`} disabled={busy} onClick={() => void save()}>
            등록
          </button>
        </>
      }
    >
      <div className={ui.dialogBody}>
        <div className={styles.grid2}>
          <label className={ui.field}>
            <span>사번</span>
            <input
              className={`${ui.textInput} mono`}
              value={form.emp_no}
              maxLength={20}
              data-autofocus
              onChange={set("emp_no")}
            />
          </label>
          <label className={ui.field}>
            <span>이름</span>
            <input className={ui.textInput} value={form.name} maxLength={50} onChange={set("name")} />
          </label>
          <label className={ui.field}>
            <span>직급 (선택)</span>
            <input
              className={ui.textInput}
              value={form.rank}
              maxLength={30}
              placeholder="예: 사원"
              onChange={set("rank")}
            />
          </label>
          <label className={ui.field}>
            <span>직책 (선택)</span>
            <input
              className={ui.textInput}
              value={form.position}
              maxLength={30}
              placeholder="예: 팀장"
              onChange={set("position")}
            />
          </label>
          <label className={ui.field}>
            <span>이메일 (선택)</span>
            <input className={ui.textInput} type="email" value={form.email} maxLength={100} onChange={set("email")} />
          </label>
          <label className={ui.field}>
            <span>내선 (선택)</span>
            <input
              className={`${ui.textInput} mono`}
              value={form.extension}
              maxLength={20}
              onChange={set("extension")}
            />
          </label>
          <label className={ui.field}>
            <span>입사일 (선택)</span>
            <input className={ui.textInput} type="date" value={form.hired_on} onChange={set("hired_on")} />
          </label>
        </div>
        {deptSelect(dept, setDept, "부서")}
        <p className={ui.hint}>
          등록하면 직원 화면 계정이 임시 비밀번호로 만들어지고, 그 부서의 미배치 인원으로 좌석 배치 화면에 떠요.
        </p>
        <ErrorLine error={error} />
      </div>
    </Dialog>
  );
}

/** 팀원 고치기: 인사 정보, 부서 옮기기, 휴직, 비밀번호 초기화, 퇴사 */
function PersonDialog({
  member,
  deptId,
  deptSelect,
  deptName,
  myEmpNo,
  call,
  onDone,
  onPassword,
  onClose,
}: {
  member: OrgMember;
  deptId: number | null;
  deptSelect: DeptSelect;
  deptName: (id: number) => string;
  myEmpNo: string;
  call: Call;
  onDone: (text: string) => void;
  onPassword: (password: string) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState({
    name: member.name,
    rank: member.rank ?? "",
    position: member.position ?? "",
    email: member.email ?? "",
    extension: member.extension ?? "",
  });
  const [dept, setDept] = useState<number | null>(deptId);
  const [status, setStatus] = useState<"ACTIVE" | "LEAVE">(member.status);
  const [retiring, setRetiring] = useState(false);
  const [resetting, setResetting] = useState(false);
  const { busy, error, run } = useBusy();
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value });
  const moved = dept !== null && dept !== deptId;

  const save = () =>
    run(async () => {
      const out = await call<{ released: string[] }>(`/api/admin/org/employees/${member.emp_no}`, "PUT", {
        ...form,
        department_id: dept,
        status,
      });
      onDone(
        moved
          ? `${form.name} 님 → ${deptName(dept!)}: 옮겼어요${out.released.length ? " · 고정석 배정이 끝나 미배치 인원이 됐어요" : ""}`
          : `${form.name} 님 정보를 고쳤어요`,
      );
    });
  const retire = () =>
    run(async () => {
      const out = await call<{ released: string[] }>(`/api/admin/org/employees/${member.emp_no}`, "PUT", {
        status: "RETIRED",
      });
      onDone(`${member.name} 님을 퇴사 처리했어요${out.released.length ? " · 자리가 비었어요" : ""}`);
    });
  const resetPassword = () =>
    run(async () => {
      const out = await call<{ temporary_password: string }>(
        `/api/admin/org/employees/${member.emp_no}/reset-password`,
        "POST",
      );
      onPassword(out.temporary_password);
    });

  return (
    <Dialog
      open
      onClose={onClose}
      title={`${member.name} 고치기·옮기기`}
      footer={
        <>
          {member.emp_no !== myEmpNo && (
            <button
              type="button"
              className={`${ui.btn} ${retiring ? ui.danger : ui.ghost}`}
              style={{ marginRight: "auto" }}
              disabled={busy}
              onClick={() => (retiring ? void retire() : setRetiring(true))}
            >
              {retiring ? "정말 퇴사 처리" : "퇴사 처리"}
            </button>
          )}
          <button type="button" className={ui.btn} onClick={onClose}>
            닫기
          </button>
          <button type="button" className={`${ui.btn} ${ui.pri}`} disabled={busy} onClick={() => void save()}>
            저장
          </button>
        </>
      }
    >
      <div className={ui.dialogBody}>
        <div className={styles.grid2}>
          <label className={ui.field}>
            <span>이름</span>
            <input className={ui.textInput} value={form.name} maxLength={50} onChange={set("name")} />
          </label>
          <label className={ui.field}>
            <span>사번</span>
            <input className={`${ui.textInput} mono`} value={member.emp_no} disabled />
          </label>
          <label className={ui.field}>
            <span>직급</span>
            <input className={ui.textInput} value={form.rank} maxLength={30} onChange={set("rank")} />
          </label>
          <label className={ui.field}>
            <span>직책</span>
            <input className={ui.textInput} value={form.position} maxLength={30} onChange={set("position")} />
          </label>
          <label className={ui.field}>
            <span>이메일</span>
            <input className={ui.textInput} type="email" value={form.email} maxLength={100} onChange={set("email")} />
          </label>
          <label className={ui.field}>
            <span>내선</span>
            <input
              className={`${ui.textInput} mono`}
              value={form.extension}
              maxLength={20}
              onChange={set("extension")}
            />
          </label>
        </div>
        {deptSelect(dept, setDept, "부서 (옮기면 고정석 배정이 끝나요)")}
        {moved && member.seat_code && (
          <p className={styles.warn}>
            지금 자리 {member.site_name} {member.floor_name} {member.seat_code}의 고정석 배정이 끝나고, {deptName(dept!)}의 미배치 인원이
            돼요.
          </p>
        )}
        <fieldset className={ui.when}>
          <legend>재직 상태</legend>
          <label>
            <input type="radio" checked={status === "ACTIVE"} onChange={() => setStatus("ACTIVE")} /> 재직
          </label>
          <label>
            <input type="radio" checked={status === "LEAVE"} onChange={() => setStatus("LEAVE")} /> 휴직 (자리는 그대로,
            로그인은 막힘)
          </label>
        </fieldset>
        <p className={ui.hint}>
          <button
            type="button"
            className={ui.linkButton}
            disabled={busy}
            onClick={() => (resetting ? void resetPassword() : setResetting(true))}
          >
            {resetting ? "정말 비밀번호 초기화" : "직원 화면 비밀번호 초기화"}
          </button>{" "}
          (잠금도 풀리고, 임시 비밀번호가 한 번 보여요)
        </p>
        {resetting && (
          <p className={styles.warn}>
            지금 비밀번호로는 더 로그인할 수 없고, 로그인해 있던 직원 화면도 끝나요. 한 번 더 누르면 초기화해요.
          </p>
        )}
        {retiring && (
          <p className={styles.warn}>
            퇴사 처리하면 자리 배정이 끝나고, 로그인·관리자 권한이 모두 막혀요. 되돌리려면 새로 등록해야 해요.
          </p>
        )}
        <ErrorLine error={error} />
      </div>
    </Dialog>
  );
}
