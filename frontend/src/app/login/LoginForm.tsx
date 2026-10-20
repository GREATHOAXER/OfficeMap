"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useLayoutEffect, useRef, useState } from "react";
import styles from "./login.module.css";

const REMEMBER_KEY = "officemap.rememberedEmpNo";

type LoginError =
  | { code: "EMPTY" }
  | { code: "INVALID_CREDENTIALS"; failedCount?: number; maxFailedCount?: number }
  | { code: "LOCKED"; maxFailedCount: number }
  | { code: "NOT_ACTIVE" }
  | { code: "NETWORK" };

type Props = {
  ssoEnabled: boolean;
  supportContact: string;
  maxFailedCount: number;
};

export default function LoginForm({ ssoEnabled, supportContact, maxFailedCount }: Props) {
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
    if (!empNo || !password) {
      setError({ code: "EMPTY" });
      (empNo ? passwordRef : empNoRef).current?.focus();
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
        router.replace("/");
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

  const credentialError = error?.code === "INVALID_CREDENTIALS" || error?.code === "EMPTY";

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

      <form className={styles.form} onSubmit={handleSubmit} noValidate>
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
            aria-invalid={credentialError || undefined}
            aria-describedby={error ? "login-error" : undefined}
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
            aria-invalid={credentialError || undefined}
            aria-describedby={error ? "login-error" : undefined}
          />
        </label>

        {error && (
          <div id="login-error" role="alert" className={styles.alert}>
            <AlertIcon />
            <span>{errorMessage(error, supportContact, maxFailedCount)}</span>
          </div>
        )}

        <label className={styles.remember}>
          <input ref={rememberRef} type="checkbox" name="remember" />
          사번 기억하기
        </label>

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
          비밀번호를 잊었다면 임시 비밀번호를 다시 받으세요 (문의: {supportContact}). 임시
          비밀번호로 로그인하면 새 비밀번호로 바꾸게 됩니다.
        </p>
      )}
    </>
  );
}

function toLoginError(body: Record<string, unknown>): LoginError {
  switch (body.code) {
    case "INVALID_CREDENTIALS":
      return {
        code: "INVALID_CREDENTIALS",
        failedCount: typeof body.failed_count === "number" ? body.failed_count : undefined,
        maxFailedCount: typeof body.max_failed_count === "number" ? body.max_failed_count : undefined,
      };
    case "LOCKED":
      return { code: "LOCKED", maxFailedCount: Number(body.max_failed_count) || 5 };
    case "NOT_ACTIVE":
      return { code: "NOT_ACTIVE" };
    default:
      return { code: "NETWORK" };
  }
}

function errorMessage(error: LoginError, contact: string, defaultMax: number): string {
  switch (error.code) {
    case "EMPTY":
      return "사번과 비밀번호를 입력하세요.";
    case "INVALID_CREDENTIALS": {
      if (error.failedCount === undefined) return "사번 또는 비밀번호가 맞지 않습니다.";
      const max = error.maxFailedCount ?? defaultMax;
      return `사번 또는 비밀번호가 맞지 않습니다. (${error.failedCount}/${max}회 · ${max}회 실패 시 계정 잠금)`;
    }
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

function AlertIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className={styles.alertIcon}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v6M12 16v.5" />
    </svg>
  );
}
