"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import Dialog from "@/components/Dialog";
import ui from "./seating/seating.module.css";
import { validationText } from "./validation";
import styles from "./admin.module.css";

// 관리자 첫 화면의 사업장·층 추가·고치기 (사업장은 전사 관리자, 층은 그 사업장의 사업장 관리자 이상)

const json = { "content-type": "application/json" };
const EXPIRED = "/admin/login?reason=expired";
const KIND_CODE: Record<string, "HQ" | "CENTER"> = { 본사: "HQ", 센터: "CENTER" };

type SiteInfo = { id: number; kind: string; name: string; address: string | null };
type FloorInfo = { id: number; name: string; description: string | null };

/** API 오류 코드를 읽을 수 있는 글로 */
function errorText(code: string | undefined, detail: Record<string, unknown> | undefined): string {
  switch (code) {
    case "SITE_NAME_TAKEN":
      return "같은 이름의 사업장이 있어요";
    case "SITE_HAS_FLOORS":
      return `층이 남아 있어요 (${(detail?.floors as string[]).join(", ")}). 층을 먼저 없애세요`;
    case "FLOOR_NAME_TAKEN":
      return "이 사업장에 같은 이름의 층이 있어요";
    case "FLOOR_IN_USE":
      return `좌석 ${detail?.seats}석 · 회의실 ${detail?.rooms}개가 남아 있어요. 도면에서 지우고 게시한 뒤 없앨 수 있어요`;
    case "COMPANY_ADMIN_ONLY":
    case "NOT_IN_SCOPE":
      return "내 관리 범위가 아니에요";
    default:
      return validationText(detail) ?? "저장하지 못했어요. 입력을 확인하고 다시 해 보세요";
  }
}

/** 요청 보내고 성공하면 화면을 다시 읽는다. 실패하면 알릴 글 */
function useSend() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function send(url: string, method: string, body?: unknown): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method,
        headers: json,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 401) {
        router.replace(EXPIRED);
        return false;
      }
      if (!res.ok) {
        const out = await res.json().catch(() => null);
        setError(errorText(out?.detail?.code, out?.detail));
        return false;
      }
      router.refresh();
      return true;
    } catch {
      setError("네트워크 오류로 저장하지 못했어요");
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, send };
}

function Footer({
  onClose,
  onSave,
  busy,
  saveLabel,
  danger,
}: {
  onClose: () => void;
  onSave: () => void;
  busy: boolean;
  saveLabel: string;
  danger?: ReactNode;
}) {
  return (
    <>
      {danger}
      <button type="button" className={ui.btn} onClick={onClose}>
        닫기
      </button>
      <button type="button" className={`${ui.btn} ${ui.pri}`} disabled={busy} onClick={onSave}>
        {busy ? "저장 중…" : saveLabel}
      </button>
    </>
  );
}

/** 사업장 추가 (새로) / 고치기 (site가 있으면) */
export function SiteButton({ site }: { site?: SiteInfo }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(site?.name ?? "");
  const [kind, setKind] = useState<"HQ" | "CENTER">(site ? (KIND_CODE[site.kind] ?? "CENTER") : "CENTER");
  const [address, setAddress] = useState(site?.address ?? "");
  const [closing, setClosing] = useState(false);
  const { busy, error, setError, send } = useSend();

  const close = () => {
    setOpen(false);
    setClosing(false);
    setError(null);
  };
  async function save() {
    if (!name.trim()) return setError("사업장 이름을 넣어 주세요");
    const ok = site
      ? await send(`/api/admin/sites/${site.id}`, "PUT", { name, kind, address })
      : await send("/api/admin/sites", "POST", { name, kind, address });
    if (ok) {
      close();
      if (!site) {
        setName("");
        setAddress("");
      }
    }
  }

  return (
    <>
      <button type="button" className={`${styles.btn} ${site ? "" : styles.pri}`} onClick={() => setOpen(true)}>
        {site ? "사업장 고치기" : "사업장 추가"}
      </button>
      <Dialog
        open={open}
        onClose={close}
        title={site ? `${site.name} 고치기` : "사업장 추가"}
        footer={
          <Footer
            onClose={close}
            onSave={() => void save()}
            busy={busy}
            saveLabel={site ? "저장" : "추가"}
            danger={
              site && (
                <button
                  type="button"
                  className={`${ui.btn} ${ui.ghost}`}
                  style={{ marginRight: "auto" }}
                  disabled={busy}
                  onClick={() =>
                    closing
                      ? void send(`/api/admin/sites/${site.id}`, "DELETE").then((ok) => ok && close())
                      : setClosing(true)
                  }
                >
                  {closing ? "정말 닫기" : "사업장 닫기"}
                </button>
              )
            }
          />
        }
      >
        <div className={ui.dialogBody}>
          <label className={ui.field}>
            <span>사업장 이름</span>
            <input
              className={ui.textInput}
              value={name}
              maxLength={100}
              placeholder="예: 부산 센터"
              data-autofocus
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <fieldset className={ui.when}>
            <legend>종류</legend>
            <label>
              <input type="radio" checked={kind === "HQ"} onChange={() => setKind("HQ")} /> 본사
            </label>
            <label>
              <input type="radio" checked={kind === "CENTER"} onChange={() => setKind("CENTER")} /> 센터
            </label>
          </fieldset>
          <label className={ui.field}>
            <span>주소 (선택)</span>
            <input
              className={ui.textInput}
              value={address}
              maxLength={255}
              onChange={(e) => setAddress(e.target.value)}
            />
          </label>
          {!site && (
            <p className={ui.hint}>
              추가한 뒤 사업장 칸의 &ldquo;+ 층 추가&rdquo;로 층을 만들어요. 예전에 닫은 사업장과 이름이 같으면 그
              사업장을 다시 열어요.
            </p>
          )}
          {closing && (
            <p className={ui.hint}>
              닫으면 직원 화면의 사업장 목록에서 빠지고 이 사업장 관리자 권한도 회수돼요. 층이 남아 있으면 닫을 수
              없어요.
            </p>
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

/** 층 추가 (floor가 없으면) / 고치기·순서·없애기 */
export function FloorButton({ siteId, floors, floor }: { siteId: number; floors: FloorInfo[]; floor?: FloorInfo }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(floor?.name ?? "");
  const [description, setDescription] = useState(floor?.description ?? "");
  // 놓을 자리: 이 층 바로 아래 (""이면 맨 위). floors는 위층부터
  const index = floor ? floors.findIndex((f) => f.id === floor.id) : -1;
  const [under, setUnder] = useState<string>(index > 0 ? String(floors[index - 1].id) : "");
  const [closing, setClosing] = useState(false);
  const { busy, error, setError, send } = useSend();
  const others = floors.filter((f) => f.id !== floor?.id);

  const close = () => {
    setOpen(false);
    setClosing(false);
    setError(null);
  };
  async function save() {
    if (!name.trim()) return setError("층 이름을 넣어 주세요");
    const body = { name, description, under_floor_id: under ? Number(under) : null, move: true };
    const ok = floor
      ? await send(`/api/admin/floors/${floor.id}`, "PUT", body)
      : await send(`/api/admin/sites/${siteId}/floors`, "POST", body);
    if (ok) {
      close();
      if (!floor) {
        setName("");
        setDescription("");
      }
    }
  }

  return (
    <>
      <button type="button" className={styles.btn} onClick={() => setOpen(true)}>
        {floor ? "층 고치기" : "+ 층 추가"}
      </button>
      <Dialog
        open={open}
        onClose={close}
        title={floor ? `${floor.name} 고치기` : "층 추가"}
        footer={
          <Footer
            onClose={close}
            onSave={() => void save()}
            busy={busy}
            saveLabel={floor ? "저장" : "추가"}
            danger={
              floor && (
                <button
                  type="button"
                  className={`${ui.btn} ${ui.ghost}`}
                  style={{ marginRight: "auto" }}
                  disabled={busy}
                  onClick={() =>
                    closing
                      ? void send(`/api/admin/floors/${floor.id}`, "DELETE").then((ok) => ok && close())
                      : setClosing(true)
                  }
                >
                  {closing ? "정말 없애기" : "층 없애기"}
                </button>
              )
            }
          />
        }
      >
        <div className={ui.dialogBody}>
          <label className={ui.field}>
            <span>층 이름</span>
            <input
              className={ui.textInput}
              value={name}
              maxLength={20}
              placeholder="예: 11F, B1"
              data-autofocus
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className={ui.field}>
            <span>용도 (사무실이 아닌 층만, 층 버튼 아래에 보여요)</span>
            <input
              className={ui.textInput}
              value={description}
              maxLength={50}
              placeholder="예: 로비, 대강당, 식당"
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <label className={ui.field}>
            <span>놓을 자리 (층 버튼 순서)</span>
            <select className={ui.select} value={under} onChange={(e) => setUnder(e.target.value)}>
              <option value="">맨 위{others[0] ? ` (${others[0].name} 위)` : ""}</option>
              {others.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name} 아래
                </option>
              ))}
            </select>
          </label>
          {!floor && (
            <p className={ui.hint}>
              만든 뒤 &ldquo;도면 관리&rdquo;에서 빈 도면(실제 크기)이나 도면 파일로 초안을 만들고 게시하면 좌석이
              생겨요.
            </p>
          )}
          {closing && (
            <p className={ui.hint}>
              없애면 직원 화면 층 버튼에서 빠지고 이 층 관리자·구역 관리자 권한도 회수돼요. 좌석·회의실이 남아 있으면
              없앨 수 없어요.
            </p>
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
