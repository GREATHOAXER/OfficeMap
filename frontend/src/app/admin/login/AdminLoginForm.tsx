"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { AlertIcon } from "@/app/login/LoginForm";
import styles from "@/app/login/login.module.css";

type AdminLoginError =
  | { code: "EMPTY" }
  | { code: "INVALID_CREDENTIALS"; failedCount?: number; maxFailedCount?: number }
  | { code: "LOCKED"; maxFailedCount: number }
  | { code: "NOT_ACTIVE" }
  | { code: "NO_PERMISSION" }
  | { code: "NETWORK" };

type Props = { supportContact: string; maxFailedCount: number };

/** 관리자 로그인. 직원 로그인과 비밀번호·실패 횟수·잠금이 따로다 (사번 기억하기는 두지 않는다) */
export default function AdminLoginForm({ supportContact, maxFailedCount }: Props) {
  const router = useRouter();
  const empNoRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<AdminLoginError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    empNoRef.current?.focus();
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
      const res = await fetch("/api/admin/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ emp_no: empNo, password }),
      });
      if (res.ok) {
        router.replace("/admin");
        router.refresh();
        return;
      }
      setError(toError(await res.json().catch(() => ({}))));
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
          aria-describedby={error ? "admin-login-error" : undefined}
        />
      </label>
      <label className={styles.field}>
        관리자 비밀번호
        <input
          ref={passwordRef}
          name="password"
          type="password"
          placeholder="직원 화면 비밀번호와 다릅니다"
          autoComplete="current-password"
          maxLength={128}
          aria-invalid={credentialError || undefined}
          aria-describedby={error ? "admin-login-error" : undefined}
        />
      </label>

      {error && (
        <div id="admin-login-error" role="alert" className={styles.alert}>
          <AlertIcon />
          <span>{errorMessage(error, supportContact, maxFailedCount)}</span>
        </div>
      )}

      <button type="submit" className={styles.primaryButton} disabled={submitting}>
        {submitting ? "로그인 중…" : "관리자 로그인"}
      </button>
    </form>
  );
}

function toError(body: Record<string, unknown>): AdminLoginError {
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
    case "NO_PERMISSION":
      return { code: "NO_PERMISSION" };
    default:
      return { code: "NETWORK" };
  }
}

function errorMessage(error: AdminLoginError, contact: string, defaultMax: number): string {
  switch (error.code) {
    case "EMPTY":
      return "사번과 관리자 비밀번호를 입력하세요.";
    case "INVALID_CREDENTIALS": {
      // 관리자 계정이 없는 사번도 같은 문구: 누가 관리자인지 알려 주지 않는다
      if (error.failedCount === undefined) return "사번 또는 관리자 비밀번호가 맞지 않습니다.";
      const max = error.maxFailedCount ?? defaultMax;
      return `사번 또는 관리자 비밀번호가 맞지 않습니다. (${error.failedCount}/${max}회 · ${max}회 실패 시 관리자 계정 잠금)`;
    }
    case "LOCKED":
      return `관리자 비밀번호를 ${error.maxFailedCount}회 잘못 입력해 관리자 계정이 잠겼습니다. 직원 화면 로그인은 그대로 쓸 수 있습니다. 잠금 해제 문의: ${contact}`;
    case "NOT_ACTIVE":
      return `로그인할 수 없는 계정입니다. 문의: ${contact}`;
    case "NO_PERMISSION":
      return "지금 맡고 있는 관리자 권한이 없습니다. 권한이 회수되었거나 아직 지정되지 않았다면 상위 관리자에게 문의하세요.";
    case "NETWORK":
      return "서버에 연결하지 못했습니다. 잠시 후 다시 시도하세요.";
  }
}
