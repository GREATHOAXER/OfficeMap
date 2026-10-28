"""사람 목록의 정렬 규칙 (팀원·조직원·참석자·미배치 인원 목록에서 모두 같은 순서).

직급 순 → 사번 앞자리의 입사연도 → 입사일 → 사번. 직급 순서는 회사 직급 체계를 따른다:
부장 → 수석부부장 → 부부장 → 차장 → 과장 → 대리 → 사원 → 수습직원 → 사무사원 (목록에 없는 직급·직급 없음은 뒤로).
사번 앞자리: 2023xxxx처럼 연도 네 자리로 시작하면 그 연도, 21000050처럼 두 자리면 2021년으로 읽는다.
"""

RANK_ORDER = ("부장", "수석부부장", "부부장", "차장", "과장", "대리", "사원", "수습직원", "사무사원")


def person_order(alias: str = "e") -> str:
    """ORDER BY에 넣는 정렬 식. alias: employees 테이블 별칭"""
    ranks = ", ".join(f"'{r}'" for r in RANK_ORDER)
    emp = f"{alias}.emp_no"
    hire_year = (
        f"CASE WHEN {emp} ~ '^(19|20)[0-9]{{6,}}$' THEN substr({emp}, 1, 4)::int"
        f" WHEN {emp} ~ '^[0-9]{{2}}' THEN"
        f" CASE WHEN substr({emp}, 1, 2)::int > 50 THEN 1900 ELSE 2000 END + substr({emp}, 1, 2)::int END"
    )
    return (
        f"array_position(ARRAY[{ranks}]::text[], {alias}.rank_name::text) NULLS LAST, "
        f"{hire_year} NULLS LAST, {alias}.hired_on NULLS LAST, {emp}"
    )
