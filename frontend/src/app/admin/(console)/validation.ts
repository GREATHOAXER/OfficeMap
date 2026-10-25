// 서버 입력 검사(422)에서 온 규칙을 화면 글로. FastAPI는 detail에 [{loc, msg, type, ctx}] 목록을 준다.
// "저장하지 못했어요"만 보이면 무엇을 고쳐야 할지 모르니, 서버가 알려 준 규칙을 그대로 보여 준다

const FIELD: Record<string, string> = {
  name: "이름",
  email: "이메일",
  emp_no: "사번",
  rank: "직급",
  position: "직책",
  extension: "내선",
  address: "주소",
  description: "용도",
  code: "부서코드",
  hired_on: "입사일",
};

/** 받침이 있으면 a, 없으면 b (을/를, 은/는) */
const josa = (word: string, a: string, b: string) => {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  return code >= 0 && code <= 11171 && code % 28 !== 0 ? a : b;
};

type Problem = { loc?: unknown[]; msg?: string; type?: string; ctx?: Record<string, unknown> };

/** 입력 검사 오류면 그 규칙 글, 아니면 null */
export function validationText(detail: unknown): string | null {
  if (!Array.isArray(detail) || detail.length === 0) return null;
  const p = detail[0] as Problem;
  const field = FIELD[String(p.loc?.at(-1) ?? "")] ?? "입력값";
  switch (p.type) {
    case "value_error":
      return (p.msg ?? "").replace(/^Value error, /, "") || null;
    case "missing":
    case "string_too_short":
      return `${field}${josa(field, "을", "를")} 넣어 주세요`;
    case "string_too_long":
      return `${field}${josa(field, "은", "는")} ${p.ctx?.max_length}자까지예요`;
    default:
      return p.msg ? `${field}: ${p.msg}` : null;
  }
}
