"use client";

import { useRouter } from "next/navigation";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import Avatar from "@/components/Avatar";
import { CameraIcon, CloseIcon } from "@/components/icons";
import type { MyProfile } from "@/lib/api";
import styles from "./profile.module.css";

const PHOTO_PX = 320; // 올리는 사진 크기 (정사각형)
const MAX_FILE_MB = 15; // 고를 수 있는 원본 사진 크기
const MAX_SKILLS = 15;
const MAX_SKILL_LEN = 20;
const MAX_DUTIES = 1000;

type Form = { display_name: string; headline: string; duties: string; skills: string[] };
const formOf = (p: MyProfile): Form => ({
  display_name: p.display_name ?? "",
  headline: p.headline ?? "",
  duties: p.duties ?? "",
  skills: p.skills,
});
const same = (a: Form, b: Form) =>
  a.display_name.trim() === b.display_name.trim() &&
  a.headline.trim() === b.headline.trim() &&
  a.duties.trim() === b.duties.trim() &&
  a.skills.join("\u0000") === b.skills.join("\u0000");

/** 고른 사진을 가운데 정사각형으로 잘라 줄인다 (JPEG). 휴대폰 사진의 방향(EXIF)은 브라우저가 맞춰 준다 */
async function squarePhoto(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = PHOTO_PX;
  canvas.height = PHOTO_PX;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, PHOTO_PX, PHOTO_PX);
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, PHOTO_PX, PHOTO_PX);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("jpeg"))), "image/jpeg", 0.88),
  );
}

export default function ProfileView({ initial }: { initial: MyProfile }) {
  const router = useRouter();
  const [saved, setSaved] = useState<MyProfile>(initial);
  const [form, setForm] = useState<Form>(() => formOf(initial));
  const [skill, setSkill] = useState("");
  const [busy, setBusy] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone?: "error" } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dirty = !same(form, formOf(saved)) || skill.trim() !== "";

  // 저장하지 않고 나가려 하면 묻는다
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  function expired() {
    router.replace("/login?reason=expired&next=/profile");
  }

  /** 입력 중인 키워드를 더한다. 쉼표로 여러 개를 한 번에 넣어도 된다 */
  function addSkills(text: string): string[] {
    const next = [...form.skills];
    for (const raw of text.split(",")) {
      const s = raw.trim().replace(/^#+/, "").slice(0, MAX_SKILL_LEN);
      if (!s || next.some((x) => x.toLowerCase() === s.toLowerCase()) || next.length >= MAX_SKILLS) continue;
      next.push(s);
    }
    return next;
  }

  function onSkillKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return; // 한글 조합 중 Enter는 글자 확정
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      setForm({ ...form, skills: addSkills(skill) });
      setSkill("");
    } else if (event.key === "Backspace" && !skill && form.skills.length) {
      setForm({ ...form, skills: form.skills.slice(0, -1) });
    }
  }

  async function save() {
    setBusy(true);
    setMessage(null);
    const skills = addSkills(skill);
    try {
      const res = await fetch("/api/profile", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...form, skills }),
      });
      if (res.status === 401) return expired();
      if (!res.ok) {
        setMessage({ text: "저장하지 못했어요. 글자 수를 확인하고 다시 해 보세요", tone: "error" });
        return;
      }
      const next = (await res.json()) as MyProfile;
      setSaved(next);
      setForm(formOf(next));
      setSkill("");
      setMessage({ text: "저장했어요. 자리 카드와 직원 검색에 바로 보여요" });
      router.refresh(); // 왼쪽 아래 내 이름·사진
    } catch {
      setMessage({ text: "네트워크 오류로 저장하지 못했어요", tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function pickPhoto(file: File | undefined) {
    if (!file) return;
    if (fileRef.current) fileRef.current.value = "";
    if (!file.type.startsWith("image/") || file.size > MAX_FILE_MB * 1024 * 1024) {
      setMessage({ text: `${MAX_FILE_MB}MB 이하의 사진 파일(JPG·PNG 등)을 골라 주세요`, tone: "error" });
      return;
    }
    setPhotoBusy(true);
    setMessage(null);
    try {
      const blob = await squarePhoto(file).catch(() => null);
      if (!blob) {
        setMessage({ text: "이 사진은 읽지 못했어요. JPG나 PNG로 다시 골라 주세요", tone: "error" });
        return;
      }
      const res = await fetch("/api/profile/photo", {
        method: "PUT",
        headers: { "content-type": "image/jpeg" },
        body: blob,
      });
      if (res.status === 401) return expired();
      if (!res.ok) {
        setMessage({ text: "사진을 올리지 못했어요. 다른 사진으로 해 보세요", tone: "error" });
        return;
      }
      const { photo } = (await res.json()) as { photo: string };
      setSaved((p) => ({ ...p, photo }));
      setMessage({ text: "사진을 바꿨어요" });
      router.refresh();
    } catch {
      setMessage({ text: "네트워크 오류로 사진을 올리지 못했어요", tone: "error" });
    } finally {
      setPhotoBusy(false);
    }
  }

  async function removePhoto() {
    setPhotoBusy(true);
    setMessage(null);
    const res = await fetch("/api/profile/photo", { method: "DELETE" }).catch(() => null);
    setPhotoBusy(false);
    if (res?.status === 401) return expired();
    if (!res?.ok) {
      setMessage({ text: "사진을 지우지 못했어요", tone: "error" });
      return;
    }
    setSaved((p) => ({ ...p, photo: null }));
    setMessage({ text: "사진을 지웠어요" });
    router.refresh();
  }

  const preview = { ...saved, ...form, skills: addSkills(skill) };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>내 정보</h1>
        <p className={styles.lead}>
          여기 적은 사진·하는 일은 자리 카드와 직원 검색에 보이고, AI 도우미가 담당자를 찾을 때 참고해요.
        </p>
      </header>
      <main className={styles.main}>
        <div className={styles.grid}>
          <div className={styles.column}>
            <section className={styles.card} aria-labelledby="photo-title">
              <h2 id="photo-title" className={styles.cardTitle}>
                사진
              </h2>
              <div className={styles.photoRow}>
                <span className={styles.bigAvatar} aria-hidden="true">
                  <Avatar name={saved.name} photo={saved.photo} size={96} />
                </span>
                <div className={styles.photoActions}>
                  <label className={`${styles.btn} ${photoBusy ? styles.disabled : ""}`}>
                    <CameraIcon size={16} />
                    {photoBusy ? "올리는 중…" : saved.photo ? "사진 바꾸기" : "사진 올리기"}
                    <input
                      ref={fileRef}
                      type="file"
                      accept="image/*"
                      className="visually-hidden"
                      disabled={photoBusy}
                      onChange={(e) => void pickPhoto(e.target.files?.[0])}
                    />
                  </label>
                  {saved.photo && (
                    <button
                      type="button"
                      className={styles.linkButton}
                      disabled={photoBusy}
                      onClick={() => void removePhoto()}
                    >
                      사진 지우기
                    </button>
                  )}
                  <p className={styles.hint}>가운데를 정사각형으로 잘라 올려요. 얼굴이 가운데 오는 사진이 좋아요.</p>
                </div>
              </div>
            </section>

            <section className={styles.card} aria-labelledby="form-title">
              <h2 id="form-title" className={styles.cardTitle}>
                내가 소개하는 나
              </h2>
              <label className={styles.field}>
                <span>부르는 이름 (영문 이름·별칭)</span>
                <input
                  value={form.display_name}
                  maxLength={30}
                  placeholder="예: Daniel"
                  onChange={(e) => setForm({ ...form, display_name: e.target.value })}
                />
                <small>이름 옆에 함께 보여요. 인사 이름({saved.name})은 바뀌지 않아요.</small>
              </label>
              <label className={styles.field}>
                <span>한 줄 소개</span>
                <input
                  value={form.headline}
                  maxLength={80}
                  placeholder="예: 결제망 API 연동 담당"
                  onChange={(e) => setForm({ ...form, headline: e.target.value })}
                />
              </label>
              <label className={styles.field}>
                <span>하는 일</span>
                <textarea
                  value={form.duties}
                  maxLength={MAX_DUTIES}
                  rows={5}
                  placeholder="예: 법인카드 사용 내역 정산, 출장비 지급, 세금계산서 발행을 맡고 있어요."
                  onChange={(e) => setForm({ ...form, duties: e.target.value })}
                />
                <small>
                  {form.duties.length}/{MAX_DUTIES}자 · 동료가 &ldquo;이 일 누가 해요?&rdquo;로 찾을 수 있게 구체적으로
                  적어 주세요
                </small>
              </label>
              <div className={styles.field}>
                <span id="skills-label">업무 키워드</span>
                <div className={styles.chips} role="group" aria-labelledby="skills-label">
                  {form.skills.map((s) => (
                    <span key={s} className={styles.chip}>
                      #{s}
                      <button
                        type="button"
                        aria-label={`${s} 빼기`}
                        onClick={() => setForm({ ...form, skills: form.skills.filter((x) => x !== s) })}
                      >
                        <CloseIcon size={12} />
                      </button>
                    </span>
                  ))}
                  <input
                    value={skill}
                    maxLength={MAX_SKILL_LEN * 3}
                    disabled={form.skills.length >= MAX_SKILLS}
                    placeholder={form.skills.length ? "" : "예: 법인카드, 세금계산서"}
                    aria-label="키워드 넣기"
                    onChange={(e) => setSkill(e.target.value)}
                    onKeyDown={onSkillKey}
                    onBlur={() => {
                      if (!skill.trim()) return;
                      setForm({ ...form, skills: addSkills(skill) });
                      setSkill("");
                    }}
                  />
                </div>
                <small>
                  Enter나 쉼표로 넣어요 · {form.skills.length}/{MAX_SKILLS}개, 하나에 {MAX_SKILL_LEN}자까지
                </small>
              </div>
              <div className={styles.saveRow}>
                {message && (
                  <p
                    className={styles.message}
                    role={message.tone === "error" ? "alert" : "status"}
                    data-tone={message.tone}
                  >
                    {message.text}
                  </p>
                )}
                <button
                  type="button"
                  className={`${styles.btn} ${styles.pri}`}
                  disabled={!dirty || busy}
                  onClick={() => void save()}
                >
                  {busy ? "저장 중…" : "저장"}
                </button>
              </div>
            </section>
          </div>

          <div className={styles.column}>
            <section className={styles.card} aria-labelledby="hr-title">
              <h2 id="hr-title" className={styles.cardTitle}>
                인사 정보
              </h2>
              <dl className={styles.facts}>
                <dt>이름</dt>
                <dd>{saved.name}</dd>
                <dt>사번</dt>
                <dd className="mono">{saved.emp_no}</dd>
                <dt>부서</dt>
                <dd>{[saved.division, saved.department].filter(Boolean).join(" · ")}</dd>
                <dt>직급·직책</dt>
                <dd>{[saved.rank, saved.position].filter(Boolean).join(" · ") || "—"}</dd>
                <dt>이메일</dt>
                <dd className="mono">{saved.email ?? "—"}</dd>
                <dt>내선</dt>
                <dd className="mono">{saved.extension ?? "—"}</dd>
              </dl>
              <p className={styles.hint}>
                인사 정보는 조직도에서 가져와요. 틀린 곳이 있으면 인사 담당자에게 알려 주세요.
              </p>
            </section>

            <section className={styles.card} aria-labelledby="preview-title">
              <h2 id="preview-title" className={styles.cardTitle}>
                동료에게 이렇게 보여요
              </h2>
              <div className={styles.preview}>
                <span className={styles.previewAvatar} aria-hidden="true">
                  <Avatar name={saved.name} photo={saved.photo} size={44} />
                </span>
                <div>
                  <strong>
                    {saved.name} {saved.rank}
                    {preview.display_name.trim() && <span> · {preview.display_name.trim()}</span>}
                  </strong>
                  <p>{saved.department}</p>
                  {preview.headline.trim() && <p className={styles.previewHeadline}>{preview.headline.trim()}</p>}
                </div>
              </div>
              {(preview.duties.trim() || preview.skills.length > 0) && (
                <div className={styles.previewDuties}>
                  {preview.duties.trim() && <p>{preview.duties.trim()}</p>}
                  {preview.skills.length > 0 && (
                    <ul>
                      {preview.skills.map((s) => (
                        <li key={s}>#{s}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
