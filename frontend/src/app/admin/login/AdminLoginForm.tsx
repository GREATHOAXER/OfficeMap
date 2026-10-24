"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { AlertIcon, checkInput } from "@/app/login/LoginForm";
import styles from "@/app/login/login.module.css";

type AdminLoginError =
  | { code: "EMPTY" }
  | { code: "EMPTY_EMP_NO" }
  | { code: "EMPTY_PASSWORD" }
  | { code: "NOT_DIGITS" }
  | { code: "INVALID_CREDENTIALS" }
  | { code: "LOCKED"; maxFailedCount: number }
  | { code: "NOT_ACTIVE" }
  | { code: "NO_PERMISSION" }
  | { code: "NETWORK" };

type Props = {
  supportContact: string;
  maxFailedCount: number;
  /** 로그인 후 갈 곳 */
  next: string;
  /** 직원 화면에 로그인해 있는 사람의 사번: 미리 채우고 비밀번호 칸으로 */
  knownEmpNo: string | null;
};

/** 관리자 로그인. 직원 로그인과 비밀번호·실패 횟수·잠금이 따로다 (사번 기억하기는 두지 않는다) */
export default function AdminLoginForm({ supportContact, maxFailedCount, next, knownEmpNo }: Props) {
  const router = useRouter();
  const empNoRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<AdminLoginError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    (knownEmpNo ? passwordRef : empNoRef).current?.focus();
  }, [knownEmpNo]);

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
      const res = await fetch("/api/admin/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ emp_no: empNo, password }),
      });
      if (res.ok) {
        router.replace(next);
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

  const empNoError = ["INVALID_CREDENTIALS", "EMPTY", "EMPTY_EMP_NO", "NOT_DIGITS"].includes(error?.code ?? "");
  const passwordError = ["INVALID_CREDENTIALS", "EMPTY", "EMPTY_PASSWORD"].includes(error?.code ?? "");
  const clearError = () => error && error.code !== "LOCKED" && setError(null);

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
          defaultValue={knownEmpNo ?? undefined}
          aria-invalid={empNoError || undefined}
          aria-describedby={error ? "admin-login-error" : "admin-login-rule"}
          onChange={clearError}
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
          aria-invalid={passwordError || undefined}
          aria-describedby={error ? "admin-login-error" : "admin-login-rule"}
          onChange={clearError}
        />
      </label>

      {error && (
        <div id="admin-login-error" role="alert" className={styles.alert}>
          <AlertIcon />
          <span>{errorMessage(error, supportContact, maxFailedCount)}</span>
        </div>
      )}

      <span id="admin-login-rule" className={styles.formRule}>
        관리자 비밀번호를 {maxFailedCount}회 연속 틀리면 관리자 계정이 잠깁니다 (직원 화면 로그인은 그대로)
      </span>

      <button type="submit" className={styles.primaryButton} disabled={submitting}>
        {submitting ? "로그인 중…" : "관리자 로그인"}
      </button>
    </form>
  );
}

function toError(body: Record<string, unknown>): AdminLoginError {
  switch (body.code) {
    case "INVALID_CREDENTIALS":
      return { code: "INVALID_CREDENTIALS" };
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

function errorMessage(error: AdminLoginError, contact: string, max: number): string {
  switch (error.code) {
    case "EMPTY":
      return "사번과 관리자 비밀번호를 입력하세요.";
    case "EMPTY_EMP_NO":
      return "사번을 입력하세요.";
    case "EMPTY_PASSWORD":
      return "관리자 비밀번호를 입력하세요.";
    case "NOT_DIGITS":
      return "사번은 숫자로만 입력하세요.";
    // 관리자 계정이 없는 사번도 같은 문구이고 실패 횟수도 알려 주지 않는다: 누가 관리자인지 드러나지 않게
    case "INVALID_CREDENTIALS":
      return `사번 또는 관리자 비밀번호가 맞지 않습니다. ${max}회 연속 틀리면 관리자 계정이 잠깁니다.`;
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
