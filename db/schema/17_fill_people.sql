-- 17_fill_people.sql
-- 모든 직원(재직·휴직)의 빈 정보를 채운다: 이메일 도메인, 한 줄 소개, 하는 일, 업무 키워드(5개 이상), 재실 상태.
-- 이미 적어 둔 한 줄 소개·하는 일과 지금 걸려 있는 재실 상태는 그대로 두고, 업무 키워드가 5개보다 적으면 채운다.
-- 내용은 부서 이름으로 업무 종류를 골라(보안·데이터·AI·개발·디지털·IT·결제·고객·인사·재무·기획·총무·법무·홍보·사업·운영,
-- 맞는 것이 없으면 부서 이름으로 일반적인 업무) 사람마다 조금씩 다르게 만든다. 재실 상태는 직접 바꿀 때까지 유지한다.
-- 이 파일을 넣을 때(init_db --upgrade, 자동 배포) 한 번 돌리고, 목업(db/seed/04_fill_people.sql)도 마지막에 부른다.
-- 다시 돌려도 빈 것만 채운다: SELECT fill_demo_people();

CREATE OR REPLACE FUNCTION fill_demo_people() RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
    n_mail int;
    n_profile int;
    n_presence int;
BEGIN
    -- 1) 이메일 도메인은 모두 officemap.site
    UPDATE employees
    SET email = split_part(email, '@', 1) || '@officemap.site', updated_at = now()
    WHERE email LIKE '%_@_%' AND lower(split_part(email, '@', 2)) <> 'officemap.site';
    GET DIAGNOSTICS n_mail = ROW_COUNT;

    -- 2) 한 줄 소개·하는 일·업무 키워드
    WITH kinds(ord, pattern, headlines, duties, tags) AS (VALUES
        (1, '보안|정보보호',
         ARRAY['정보보호·보안 관제 담당', '취약점 점검과 보안 정책 담당', '접근권한·개인정보 관리 담당'],
         ARRAY['보안 관제 이벤트 분석과 1차 대응', '정기 취약점 점검과 조치 확인', '시스템 접근권한 신청·회수 관리',
               '개인정보 처리 현황 점검', '임직원 보안 교육·모의훈련 운영'],
         ARRAY['정보보호', '보안관제', '취약점점검', '접근통제', '개인정보', 'ISMS', '보안교육', '침해대응']),
        (2, '데이터|분석|통계',
         ARRAY['데이터 분석·대시보드 담당', '데이터 품질·표준 관리 담당', '데이터 적재·파이프라인 운영'],
         ARRAY['업무 지표 대시보드 만들기·관리', '데이터 추출·분석 요청 처리', '데이터 품질 점검과 표준 관리',
               '배치 적재 작업 모니터링', '분석 결과 보고서 작성'],
         ARRAY['데이터분석', 'SQL', '대시보드', '데이터품질', '통계', '파이썬', 'ETL', '리포트']),
        (3, 'AI|인공지능|머신러닝',
         ARRAY['사내 AI 서비스 개발', 'AI 플랫폼·모델 서빙 담당', 'AI 응답 품질 평가 담당'],
         ARRAY['사내 AI 도우미 기능 개발', '모델 서빙 환경 운영', '프롬프트·응답 품질 평가', 'AI 사용 가이드 작성',
               '신규 AI 기술 검토'],
         ARRAY['AI', 'LLM', '머신러닝', '모델서빙', '프롬프트', '파이썬', 'MLOps', 'RAG']),
        (4, '앱|개발|프론트|모바일|소프트웨어',
         ARRAY['모바일 앱 개발', '웹 프론트엔드 개발', '서비스 기능 개발·배포 담당'],
         ARRAY['모바일 앱 화면 개발과 배포', '웹 프론트엔드 기능 개발', 'API 연동과 테스트', '앱 장애·문의 대응',
               '코드 리뷰와 품질 관리'],
         ARRAY['앱개발', 'iOS', '안드로이드', '리액트', '타입스크립트', 'API연동', '코드리뷰', '테스트자동화']),
        (5, '디지털|혁신|DX',
         ARRAY['디지털 전환 과제 담당', '업무 자동화·혁신 과제 담당', '신기술 도입 검토 담당'],
         ARRAY['업무 자동화(RPA) 과제 발굴·운영', '디지털 전환 과제 일정 관리', '신기술 도입 검토', '현업 요구사항 정리',
               '혁신 과제 성과 보고'],
         ARRAY['디지털전환', 'RPA', '업무자동화', '신기술', 'PMO', '요구사항', '혁신과제', '클라우드']),
        (6, 'IT|인프라|시스템|전산|네트워크|클라우드|플랫폼',
         ARRAY['IT 인프라·서버 운영 담당', '사내 시스템 운영 담당', '네트워크·장비 관리 담당'],
         ARRAY['서버·스토리지 운영과 점검', '사내 네트워크·VPN 관리', '장애 1차 대응과 원인 분석', '백업·복구 점검',
               'IT 자산(노트북·장비) 관리'],
         ARRAY['서버', '네트워크', 'VPN', '클라우드', '장애대응', '백업', '모니터링', 'IT자산']),
        (7, '결제|정산|자금|이체|금융|청산',
         ARRAY['결제 서비스 운영 담당', '정산·대사 업무 담당', '참가기관 연동 지원 담당'],
         ARRAY['결제 서비스 운영 현황 점검', '일일 정산 대사와 차액 처리', '참가기관 연동·테스트 지원', '정산 관련 문의 대응',
               '수수료 산정과 보고'],
         ARRAY['결제', '정산', '대사', '참가기관', '수수료', 'API연동', '결제망', '운영점검']),
        (8, '고객|상담|CS|민원|콜센터',
         ARRAY['고객 문의·민원 응대 담당', '고객지원 운영 담당', 'VOC 분석·개선 담당'],
         ARRAY['고객 문의·민원 접수와 답변', 'VOC 분석과 개선 제안', 'FAQ·안내문 관리', '상담 품질 점검',
               '관련 부서 협업 요청'],
         ARRAY['고객지원', '민원처리', 'VOC', '상담', 'FAQ', 'CS', '응대품질', '협업']),
        (9, '인사|HR|교육|채용|노무|인재',
         ARRAY['채용·평가 담당', '인사 운영과 교육 담당', '조직문화·복리후생 담당'],
         ARRAY['채용 공고·면접 일정 관리', '인사평가 운영과 결과 정리', '신입·직무 교육 준비', '급여·근태 자료 확인',
               '복리후생 제도 안내'],
         ARRAY['채용', '인사평가', '교육', '급여', '근태', '노무', '조직문화', '복리후생']),
        (10, '재무|회계|예산|경비|세무',
         ARRAY['재무·회계 담당', '예산 편성·집행 관리 담당', '결산·세무 담당'],
         ARRAY['월말·분기 결산', '예산 편성과 집행 점검', '법인카드·경비 정산', '세금계산서 발행·수취', '재무 보고서 작성'],
         ARRAY['결산', '예산', '회계', '세무', '경비정산', '법인카드', '재무보고', '자금관리']),
        (11, '기획|전략|경영',
         ARRAY['경영 계획·성과 관리 담당', '중장기 전략 과제 담당', '경영회의·보고 자료 담당'],
         ARRAY['연간 사업계획 수립 지원', '부서별 성과(KPI) 관리', '경영회의·이사회 자료 작성', '중장기 전략 과제 관리',
               '대외 보고 자료 정리'],
         ARRAY['사업계획', 'KPI', '성과관리', '전략', '이사회', '보고서', '예산편성', '경영분석']),
        (12, '총무|비서|구매|시설|자산|임원',
         ARRAY['총무·시설 관리 담당', '구매·자산 관리 담당', '임원 일정·의전 담당'],
         ARRAY['사무 공간·시설 관리', '비품 구매와 자산 관리', '행사·회의실 지원', '출입카드 발급과 관리',
               '임원 일정과 의전 지원'],
         ARRAY['총무', '시설관리', '구매', '자산관리', '행사', '의전', '비품', '출입관리']),
        (13, '법무|감사|준법|컴플라이언스|리스크',
         ARRAY['계약 검토·법무 담당', '준법감시 담당', '내부감사 담당'],
         ARRAY['계약서 검토와 법률 자문 요청', '준법 점검과 규정 관리', '내부감사 계획·수행', '리스크 점검 보고',
               '소송·분쟁 대응 지원'],
         ARRAY['계약검토', '준법감시', '내부감사', '규정관리', '법률자문', '리스크관리', '내부통제', '분쟁대응']),
        (14, '홍보|마케팅|브랜드|커뮤니케이션|대외',
         ARRAY['홍보·보도자료 담당', '마케팅 캠페인 담당', '브랜드·콘텐츠 담당'],
         ARRAY['보도자료 작성과 언론 대응', '마케팅 캠페인 기획·운영', 'SNS·홈페이지 콘텐츠 관리', '브랜드 가이드 관리',
               '대외 행사 지원'],
         ARRAY['홍보', '보도자료', '마케팅', '브랜드', 'SNS', '캠페인', '콘텐츠', '대외협력']),
        (15, '사업|영업|제휴|법인|세일즈',
         ARRAY['법인 고객·제휴 담당', '사업 제휴·영업 담당', '신규 사업 발굴 담당'],
         ARRAY['법인 고객 계약·관리', '제휴사 발굴과 협상', '사업 제안서 작성', '매출·실적 관리', '고객사 미팅 일정 관리'],
         ARRAY['영업', '제휴', '법인고객', '계약관리', '제안서', '실적관리', '신규사업', '협상']),
        (16, '운영',
         ARRAY['서비스 운영 담당', '운영 현황·지표 관리 담당', '운영 이슈 대응 담당'],
         ARRAY['서비스 운영 현황 점검', '운영 이슈 접수와 대응', '운영 지표 관리와 보고', '업무 절차·매뉴얼 정리',
               '유관 부서 협업'],
         ARRAY['서비스운영', '운영관리', '이슈대응', '모니터링', '매뉴얼', '업무개선', '운영지표', '협업']),
        -- 맞는 것이 없으면 부서 이름으로 ({팀})
        (99, '',
         ARRAY['{팀} 업무 담당', '{팀} 실무 담당', '{팀} 운영 지원'],
         ARRAY['{팀} 주요 업무 수행', '업무 일정과 진행 현황 관리', '관련 부서 협업과 보고', '업무 문서 작성·관리',
               '업무 개선 과제 발굴'],
         ARRAY['{팀}', '업무관리', '협업', '보고서', '일정관리', '업무개선', '문서작성', '현황관리'])
    ),
    people AS (
        SELECT e.id, e.position_name, d.name AS dept, k.headlines, k.duties,
               ARRAY(SELECT replace(t, '{팀}', replace(d.name, ' ', '')) FROM unnest(k.tags) AS t) AS tags
        FROM employees e
        JOIN departments d ON d.id = e.department_id
        CROSS JOIN LATERAL (
            SELECT * FROM kinds WHERE d.name ~ kinds.pattern ORDER BY kinds.ord LIMIT 1
        ) k
        WHERE e.employment_status IN ('ACTIVE', 'LEAVE')
    ),
    made AS (
        SELECT p.id,
               CASE WHEN p.position_name ~ '장$' THEN p.dept || ' ' || p.position_name || ' · 업무 총괄'
                    ELSE replace(p.headlines[1 + p.id % 3], '{팀}', p.dept) END AS headline,
               '- ' || replace(p.duties[1 + p.id % 5], '{팀}', p.dept)
                   || E'\n- ' || replace(p.duties[1 + (p.id + 1) % 5], '{팀}', p.dept)
                   || E'\n- ' || replace(p.duties[1 + (p.id + 2) % 5], '{팀}', p.dept) AS duties,
               ARRAY(SELECT p.tags[1 + (p.id + g) % 8] FROM generate_series(0, 5) AS g ORDER BY g) AS skills
        FROM people p
    ),
    saved AS (
        INSERT INTO employee_profiles AS ep (employee_id, headline, duties, skills)
        SELECT id, headline, duties, skills FROM made
        ON CONFLICT (employee_id) DO UPDATE
        SET headline = coalesce(nullif(btrim(ep.headline), ''), EXCLUDED.headline),
            duties = coalesce(nullif(btrim(ep.duties), ''), EXCLUDED.duties),
            skills = CASE WHEN cardinality(ep.skills) >= 5 THEN ep.skills
                          ELSE (ep.skills || ARRAY(SELECT t FROM unnest(EXCLUDED.skills) WITH ORDINALITY AS u(t, o)
                                                   WHERE NOT t = ANY(ep.skills) ORDER BY o))[1:6] END,
            updated_at = now()
        WHERE nullif(btrim(ep.headline), '') IS NULL OR nullif(btrim(ep.duties), '') IS NULL
           OR cardinality(ep.skills) < 5
        RETURNING 1
    )
    SELECT count(*) INTO n_profile FROM saved;

    -- 3) 재실 상태: 지금 걸려 있는 상태가 없는 사람만. 사람마다 고르게 (대부분 재실). 휴직자는 부재
    WITH picked AS (
        SELECT e.id, e.employment_status, (e.id * 37 + 11) % 100 AS v
        FROM employees e
        WHERE e.employment_status IN ('ACTIVE', 'LEAVE')
          AND NOT EXISTS (
              SELECT 1 FROM presence_status ps
              WHERE ps.employee_id = e.id AND (ps.expires_at IS NULL OR ps.expires_at > now())
          )
    ),
    chosen AS (
        SELECT id,
               CASE WHEN employment_status = 'LEAVE' THEN 'AWAY'
                    WHEN v < 45 THEN 'AVAILABLE'
                    WHEN v < 57 THEN 'IN_MEETING'
                    WHEN v < 64 THEN 'DO_NOT_DISTURB'
                    WHEN v < 69 THEN 'STEPPED_OUT'
                    WHEN v < 76 THEN 'OUTSIDE'
                    WHEN v < 84 THEN 'REMOTE'
                    WHEN v < 89 THEN 'BUSINESS_TRIP'
                    WHEN v < 93 THEN 'TRAINING'
                    ELSE 'VACATION' END AS status
        FROM picked
    ),
    worded AS (
        SELECT id, status,
               CASE status
                   WHEN 'AWAY' THEN '휴직 중'
                   WHEN 'IN_MEETING' THEN (ARRAY['주간 업무 회의', '프로젝트 점검 회의', '고객사 화상 회의', '팀 회의'])[1 + id % 4]
                   WHEN 'DO_NOT_DISTURB' THEN (ARRAY['집중 업무 중 · 메신저로 연락 주세요', '보고서 마감 중'])[1 + id % 2]
                   WHEN 'STEPPED_OUT' THEN (ARRAY['잠깐 자리 비워요', '점심 식사 중'])[1 + id % 2]
                   WHEN 'OUTSIDE' THEN (ARRAY['고객사 방문', '외부 미팅'])[1 + id % 2]
                   WHEN 'REMOTE' THEN '재택 근무 · 메신저 가능'
                   WHEN 'BUSINESS_TRIP' THEN (ARRAY['출장 중 · 메신저 가능', '지역 센터 출장'])[1 + id % 2]
                   WHEN 'TRAINING' THEN (ARRAY['직무 교육 참석', '외부 교육'])[1 + id % 2]
                   WHEN 'VACATION' THEN (ARRAY['휴가 · 급한 일은 팀으로 연락 주세요', '연차'])[1 + id % 2]
               END AS message
        FROM chosen
    ),
    saved AS (
        INSERT INTO presence_status AS ps (employee_id, status, message, expires_at, source, updated_at)
        SELECT id, status, message, NULL, 'MANUAL', now() FROM worded
        ON CONFLICT (employee_id) DO UPDATE
        SET status = EXCLUDED.status, message = EXCLUDED.message, expires_at = NULL, source = 'MANUAL', updated_at = now()
        RETURNING 1
    )
    SELECT count(*) INTO n_presence FROM saved;

    RETURN format('이메일 %s명, 프로필 %s명, 재실 상태 %s명 채움', n_mail, n_profile, n_presence);
END $$;

SELECT fill_demo_people();
