"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useLayoutEffect, useRef, useState } from "react";
import styles from "./login.module.css";

const REMEMBER_KEY = "officemap.rememberedEmpNo";

type LoginError =
  | { code: "EMPTY_EMP_NO" }
  | { code: "EMPTY_PASSWORD" }
  | { code: "EMPTY" }
  | { code: "NOT_DIGITS" }
  | { code: "INVALID_CREDENTIALS" }
  | { code: "LOCKED"; maxFailedCount: number }
  | { code: "NOT_ACTIVE" }
  | { code: "NETWORK" };

type Props = {
  ssoEnabled: boolean;
  supportContact: string;
  maxFailedCount: number;
  /** 로그인 후 갈 곳 (로그인이 끊기기 전에 보던 화면) */
  next: string;
};

export default function LoginForm({ ssoEnabled, supportContact, maxFailedCount, next }: Props) {
  const router = useRouter();
  const empNoRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const rememberRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<LoginError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showResetHelp, setShowResetHelp] = useState(false);

  // 사번 기억하기: 저장해 둔 사번을 채우고 비밀번호 칸으로 바로 이동.
  // 화면에 그리기 전에 채워서 사번 칸이 잠깐 비어 보이지 않게 한다
  useLayoutEffect(() => {
    const saved = readRememberedEmpNo();
    if (saved && empNoRef.current && rememberRef.current) {
      empNoRef.current.value = saved;
      rememberRef.current.checked = true;
      passwordRef.current?.focus();
    } else {
      empNoRef.current?.focus();
    }
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const empNo = String(form.get("empNo") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const invalid = checkInput(empNo, password);
    if (invalid) {
      setError(invalid);
      (invalid.code === "EMPTY_PASSWORD" ? passwordRef : empNoRef).current?.focus();
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ emp_no: empNo, password }),
      });
      if (res.ok) {
        writeRememberedEmpNo(rememberRef.current?.checked ? empNo : null);
        router.replace(next); // 임시 비밀번호면 화면이 비밀번호 변경으로 보낸다
        router.refresh();
        return;
      }
      const body = await res.json().catch(() => ({}));
      setError(toLoginError(body));
    } catch {
      setError({ code: "NETWORK" });
    }
    setSubmitting(false);
    if (passwordRef.current) {
      passwordRef.current.value = "";
      passwordRef.current.focus();
    }
  }

  const empNoError = ["INVALID_CREDENTIALS", "EMPTY", "EMPTY_EMP_NO", "NOT_DIGITS"].includes(error?.code ?? "");
  const passwordError = ["INVALID_CREDENTIALS", "EMPTY", "EMPTY_PASSWORD"].includes(error?.code ?? "");
  // 고치려고 다시 입력하기 시작하면 오류 문구를 내린다
  const clearError = () => error && error.code !== "LOCKED" && setError(null);

  return (
    <>
      <button type="button" className={styles.ssoButton} disabled={!ssoEnabled}>
        <LockIcon />
        사내 통합인증(SSO)으로 로그인
        {!ssoEnabled && <span className={styles.ssoPending}>준비 중</span>}
      </button>

      <div className={styles.divider}>
        <span aria-hidden="true" />
        또는 사번으로 로그인
        <span aria-hidden="true" />
      </div>

      {/* 화면 스크립트가 뜨기 전에 눌러도 비밀번호가 주소(?password=…)에 남지 않게 POST로 둔다 */}
      <form className={styles.form} method="post" onSubmit={handleSubmit} noValidate>
        <label className={styles.field}>
          사번
          <input
            ref={empNoRef}
            name="empNo"
            className="mono"
            placeholder="예: 20231234"
            autoComplete="username"
            inputMode="numeric"
            maxLength={20}
            aria-invalid={empNoError || undefined}
            aria-describedby={error ? "login-error" : "login-rule"}
            onChange={clearError}
          />
        </label>
        <label className={styles.field}>
          비밀번호
          <input
            ref={passwordRef}
            name="password"
            type="password"
            placeholder="비밀번호"
            autoComplete="current-password"
            maxLength={128}
            aria-invalid={passwordError || undefined}
            aria-describedby={error ? "login-error" : "login-rule"}
            onChange={clearError}
          />
        </label>

        {error && (
          <div id="login-error" role="alert" className={styles.alert}>
            <AlertIcon />
            <span>{errorMessage(error, supportContact, maxFailedCount)}</span>
          </div>
        )}

        <div className={styles.rememberRow}>
          <label className={styles.remember}>
            <input ref={rememberRef} type="checkbox" name="remember" />
            사번 기억하기
          </label>
          <span id="login-rule" className={styles.muted}>
            {maxFailedCount}회 연속 틀리면 계정이 잠깁니다
          </span>
        </div>

        <button
          type="submit"
          className={ssoEnabled ? styles.secondaryButton : styles.primaryButton}
          disabled={submitting}
        >
          {submitting ? "로그인 중…" : "로그인"}
        </button>
      </form>

      <div className={styles.help}>
        <button
          type="button"
          className={styles.linkButton}
          aria-expanded={showResetHelp}
          aria-controls="reset-help"
          onClick={() => setShowResetHelp((v) => !v)}
        >
          비밀번호 재설정
        </button>
        <span className={styles.muted}>계정 문의 · {supportContact}</span>
      </div>
      {showResetHelp && (
        <p id="reset-help" className={styles.resetHelp}>
          비밀번호를 잊었거나 계정이 잠겼다면 {supportContact}에 임시 비밀번호 발급을 요청하세요. 임시
          비밀번호로 로그인하면 바로 새 비밀번호를 정하는 화면이 나옵니다.
        </p>
      )}
    </>
  );
}

type InputError = { code: "EMPTY" | "EMPTY_EMP_NO" | "EMPTY_PASSWORD" | "NOT_DIGITS" };

/** 서버에 보내기 전에 확인: 빈 칸, 숫자가 아닌 사번 (관리자 로그인도 같이 쓴다) */
export function checkInput(empNo: string, password: string): InputError | null {
  if (!empNo && !password) return { code: "EMPTY" };
  if (!empNo) return { code: "EMPTY_EMP_NO" };
  if (!/^\d+$/.test(empNo)) return { code: "NOT_DIGITS" };
  if (!password) return { code: "EMPTY_PASSWORD" };
  return null;
}

function toLoginError(body: Record<string, unknown>): LoginError {
  switch (body.code) {
    case "INVALID_CREDENTIALS":
      return { code: "INVALID_CREDENTIALS" };
    case "LOCKED":
      return { code: "LOCKED", maxFailedCount: Number(body.max_failed_count) || 5 };
    case "NOT_ACTIVE":
      return { code: "NOT_ACTIVE" };
    default:
      return { code: "NETWORK" };
  }
}

function errorMessage(error: LoginError, contact: string, max: number): string {
  switch (error.code) {
    case "EMPTY":
      return "사번과 비밀번호를 입력하세요.";
    case "EMPTY_EMP_NO":
      return "사번을 입력하세요.";
    case "EMPTY_PASSWORD":
      return "비밀번호를 입력하세요.";
    case "NOT_DIGITS":
      return "사번은 숫자로만 입력하세요.";
    // 실패 횟수는 알려 주지 않는다: 있는 사번에만 횟수가 붙으면 어떤 사번이 있는지 드러난다
    case "INVALID_CREDENTIALS":
      return `사번 또는 비밀번호가 맞지 않습니다. ${max}회 연속 틀리면 계정이 잠깁니다.`;
    // 문의처는 설정값이라 끝 글자에 따라 조사(로/으로)가 달라지므로 조사 없이 붙인다
    case "LOCKED":
      return `비밀번호를 ${error.maxFailedCount}회 잘못 입력해 계정이 잠겼습니다. 잠금 해제 문의: ${contact}`;
    case "NOT_ACTIVE":
      return `로그인할 수 없는 계정입니다. 문의: ${contact}`;
    case "NETWORK":
      return "서버에 연결하지 못했습니다. 잠시 후 다시 시도하세요.";
  }
}

// 브라우저 저장소는 막혀 있을 수 있어서(사생활 보호 모드 등) 실패해도 무시한다
function readRememberedEmpNo(): string | null {
  try {
    return window.localStorage.getItem(REMEMBER_KEY);
  } catch {
    return null;
  }
}

function writeRememberedEmpNo(empNo: string | null) {
  try {
    if (empNo) window.localStorage.setItem(REMEMBER_KEY, empNo);
    else window.localStorage.removeItem(REMEMBER_KEY);
  } catch {
    // 무시
  }
}

function LockIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

export function AlertIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className={styles.alertIcon}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v6M12 16v.5" />
    </svg>
  );
}
