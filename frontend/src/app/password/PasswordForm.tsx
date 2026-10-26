"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { AlertIcon } from "@/app/login/LoginForm";
import styles from "@/app/login/login.module.css";
import own from "./password.module.css";

// 서버(POST /api/auth/password, 관리자는 /api/admin/auth/password)와 같은 규칙. 화면에서는 입력하는 동안 맞았는지 보여 준다
const MIN_LENGTH = 8;

/** 직원 화면 비밀번호(user)와 관리자 페이지 비밀번호(admin)는 따로다 */
const KIND = {
  user: { endpoint: "/api/auth/password", login: "/login", id: "사번" },
  admin: { endpoint: "/api/admin/auth/password", login: "/admin/login", id: "사번(관리자 ID)" },
} as const;

function rulesOf(password: string, confirm: string, empNo: string, idLabel: string) {
  return [
    { label: `${MIN_LENGTH}자 이상`, ok: password.length >= MIN_LENGTH },
    { label: "영문과 숫자를 모두 포함", ok: /[A-Za-z]/.test(password) && /\d/.test(password) },
    { label: `${idLabel}이 들어가지 않음`, ok: password.length > 0 && !password.includes(empNo) },
    { label: "새 비밀번호 확인과 같음", ok: confirm.length > 0 && password === confirm },
  ];
}

/** 오류 문구. 임시 비밀번호로 들어온 사람에게는 "현재 비밀번호" 대신 "임시 비밀번호"라고 쓴다 */
function errorText(code: string, forced: boolean, maxFailed: number) {
  const current = forced ? "임시 비밀번호" : "현재 비밀번호";
  const texts: Record<string, string> = {
    EMPTY: `${current}와 새 비밀번호를 모두 입력하세요.`,
    RULES: "새 비밀번호가 아래 조건을 모두 만족해야 합니다.",
    // 로그인과 같은 실패 횟수를 센다 (서버가 같은 횟수에서 잠근다)
    WRONG_CURRENT: `${current}가 맞지 않습니다. 로그인과 합쳐 ${maxFailed}회 연속 틀리면 계정이 잠깁니다.`,
    SAME_AS_OLD: "지금 쓰는 비밀번호와 다른 비밀번호를 정하세요.",
    WEAK_PASSWORD: "새 비밀번호가 조건에 맞지 않습니다.",
    NETWORK: "서버에 연결하지 못했습니다. 잠시 후 다시 시도하세요.",
  };
  return texts[code] ?? texts.NETWORK;
}

/** next: 바꾼 뒤 갈 화면 (임시 비밀번호로 로그인했을 때 가려던 화면, 없으면 첫 화면) */
export default function PasswordForm({
  empNo,
  forced,
  next,
  kind = "user",
}: {
  empNo: string;
  forced: boolean;
  next: string;
  kind?: keyof typeof KIND;
}) {
  const api = KIND[kind];
  const router = useRouter();
  const currentRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [maxFailed, setMaxFailed] = useState(5);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const rules = rulesOf(password, confirm, empNo, api.id);

  useEffect(() => {
    currentRef.current?.focus();
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const current = currentRef.current?.value ?? "";
    if (!current || !password) {
      setError("EMPTY");
      return;
    }
    if (rules.some((r) => !r.ok)) {
      setError("RULES");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(api.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ current_password: current, new_password: password }),
      });
      if (res.status === 401) {
        router.replace(api.login); // 로그인이 끊겼다 (현재 비밀번호가 틀리면 400 WRONG_CURRENT)
        return;
      }
      if (res.status === 423) {
        router.replace(`${api.login}?reason=locked`); // 여러 번 틀려 잠겼다: 이 로그인도 끝났다
        return;
      }
      if (res.ok) {
        setDone(true);
        setTimeout(() => {
          router.replace(next);
          router.refresh();
        }, 2000);
        return;
      }
      const body = await res.json().catch(() => ({}));
      if (typeof body.max_failed_count === "number") setMaxFailed(body.max_failed_count);
      setError(typeof body.code === "string" ? body.code : "NETWORK");
    } catch {
      setError("NETWORK");
    }
    setSubmitting(false);
  }

  // 고치려고 다시 입력하기 시작하면 오류 문구를 내린다
  const clearError = () => error && setError(null);

  if (done) {
    return (
      <p role="status" className={own.done}>
        {kind === "admin" ? "관리자 비밀번호를" : "비밀번호를"} 바꿨습니다. 다음 로그인부터 새 비밀번호를 쓰세요. 다른
        기기에 로그인되어 있었다면 그쪽은 로그아웃됩니다. 잠시 후{" "}
        {next === "/" || next === "/admin" ? "첫 화면" : "보던 화면"}으로 이동합니다…
      </p>
    );
  }

  // 화면 스크립트가 뜨기 전에 눌러도 비밀번호가 주소(?password=…)에 남지 않게 form은 POST로 둔다
  return (
    <form className={styles.form} method="post" onSubmit={handleSubmit} noValidate>
      <label className={styles.field}>
        {forced ? "임시 비밀번호" : "현재 비밀번호"}
        <input
          ref={currentRef}
          name="current"
          type="password"
          autoComplete="current-password"
          maxLength={128}
          aria-invalid={error === "WRONG_CURRENT" || undefined}
          aria-describedby={error ? "password-error" : undefined}
          onChange={clearError}
        />
      </label>
      <label className={styles.field}>
        새 비밀번호
        <input
          name="new"
          type="password"
          autoComplete="new-password"
          maxLength={128}
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            clearError();
          }}
          aria-describedby="password-rules"
        />
      </label>
      <label className={styles.field}>
        새 비밀번호 확인
        <input
          name="confirm"
          type="password"
          autoComplete="new-password"
          maxLength={128}
          value={confirm}
          onChange={(event) => {
            setConfirm(event.target.value);
            clearError();
          }}
          aria-invalid={(confirm.length > 0 && confirm !== password) || undefined}
        />
      </label>

      <ul id="password-rules" className={own.rules} aria-label="새 비밀번호 조건">
        {rules.map((rule) => (
          <li key={rule.label} data-ok={rule.ok}>
            {rule.label}
            <span className="visually-hidden">{rule.ok ? " (충족)" : " (아직)"}</span>
          </li>
        ))}
      </ul>

      {error && (
        <div id="password-error" role="alert" className={styles.alert}>
          <AlertIcon />
          <span>{errorText(error, forced, maxFailed)}</span>
        </div>
      )}

      <button type="submit" className={styles.primaryButton} disabled={submitting}>
        {submitting ? "바꾸는 중…" : "비밀번호 바꾸기"}
      </button>
    </form>
  );
}
