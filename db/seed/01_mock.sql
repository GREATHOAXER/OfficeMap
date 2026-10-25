-- 01_mock.sql
-- 화면 흐름 순서대로 넣는 목업 데이터: 서울 본사 1F~10F, 11개 팀
--   1F 로비 · 2F 대강당 · 3F 식당 · 4F~9F 사무실(11개 팀) · 10F 임원실
--   8F(사람이 많은 층, 도면 편집기 도면)의 도면·구역·좌석·회의실과 새 팀 둘은 03_dense_floor.sql이 만든다
-- 이름·사번·연락처는 모두 가짜다
-- 목업 계정의 비밀번호는 모두 officemap1234 (개발용. 운영 DB에 넣지 말 것)
-- 실행 순서: db/schema/01~08 → 이 파일
--
-- 오늘 예약·재실 상태·자율석 사용은 "넣는 날" 기준 시각으로 만든다.
-- 그래서 언제 init_db를 돌려도 화면에 오늘 상황처럼 보인다

-- kst(n, t): 서울 기준 오늘부터 n일 뒤 t시각
CREATE FUNCTION pg_temp.kst(day_offset int, t time) RETURNS timestamptz
LANGUAGE sql STABLE AS $$
    SELECT ((now() AT TIME ZONE 'Asia/Seoul')::date + day_offset + t) AT TIME ZONE 'Asia/Seoul'
$$;

-- 도면 칸 좌표 (도면 너비·높이 대비 비율). 모든 층이 같은 골격이다:
--   위쪽 띠   slot 1, 2 (회의실 자리) | 코어·EV·계단 | 탕비실 | 화장실
--   아래쪽    4칸(col 0~3) × full(전체 높이) 또는 top/bottom(절반 높이), span칸만큼 이어 붙인다
CREATE FUNCTION pg_temp.cell(col int, band text, span int DEFAULT 1) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
    SELECT jsonb_build_object(
        'type', 'rect',
        'x', xs[col + 1],
        'y', CASE band WHEN 'bottom' THEN 0.6444 ELSE 0.3667 END,
        'w', round(xs[col + span] + 0.1833 - xs[col + 1], 4),
        'h', CASE band WHEN 'full' THEN 0.4611 ELSE 0.2139 END)
    FROM (SELECT ARRAY[0.0567, 0.2983, 0.5317, 0.7567]::numeric[] AS xs) c
$$;

-- 위쪽 띠의 회의실 자리: 1 = 큰 방, 2 = 작은 방, 12 = 둘을 합친 자리
CREATE FUNCTION pg_temp.slot(n int) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
    SELECT jsonb_build_object('type', 'rect', 'y', 0.0694, 'h', 0.2194) || CASE n
        WHEN 1 THEN '{"x": 0.0417, "w": 0.2167}'::jsonb
        WHEN 2 THEN '{"x": 0.2583, "w": 0.1250}'::jsonb
        ELSE '{"x": 0.0417, "w": 0.3416}'::jsonb
    END
$$;

-- ⓪ 로그인: 부서 · 직원 · 계정 ------------------------------------------------

-- 본부 3개 아래 팀 11개
INSERT INTO departments (dept_code, name, sort_order) VALUES
    ('D100', '경영지원본부', 1),
    ('D200', 'IT본부', 2),
    ('D300', '결제사업본부', 3);
INSERT INTO departments (dept_code, name, parent_id, sort_order)
SELECT v.code, v.name, p.id, v.sort_order
FROM (VALUES
    ('D110', '총무팀',       'D100', 1),
    ('D120', '재무팀',       'D100', 2),
    ('D130', '경영기획팀',   'D100', 3),
    ('D140', '인사팀',       'D100', 4),
    ('D210', 'IT운영팀',     'D200', 1),
    ('D220', '보안팀',       'D200', 2),
    ('D230', '디지털혁신팀', 'D200', 3),
    ('D240', '데이터팀',     'D200', 4),
    ('D310', '결제서비스팀', 'D300', 1),
    ('D320', '정산팀',       'D300', 2),
    ('D330', '고객지원팀',   'D300', 3)
) AS v(code, name, parent_code, sort_order)
JOIN departments p ON p.dept_code = v.parent_code;

-- 시나리오에 등장하는 사람들. 김민준 두 명은 동명이인 화면 확인용
INSERT INTO employees (emp_no, name, department_id, rank_name, position_name, email, extension, hired_on)
SELECT v.emp_no, v.name, d.id, v.rank_name, v.position_name, v.email, v.extension, v.hired_on::date
FROM (VALUES
    ('20090001', '한도윤', 'D110', '부장', '팀장', 'doyun.han@example.com',   '1001', '2009-03-02'),  -- 전사 관리자
    ('20120002', '강지아', 'D110', '차장', NULL,   'jia.kang@example.com',    '1002', '2012-01-02'),  -- 사업장 관리자. 고정석 없이 자율석 사용
    ('20100009', '윤하은', 'D110', '차장', NULL,   'haeun.yoon@example.com',  '1003', '2010-03-02'),  -- 10F 비서석
    ('20130003', '정민호', 'D210', '차장', NULL,   'minho.jung@example.com',  '4001', '2013-07-01'),  -- 7F 층 관리자
    ('20170008', '김민준', 'D210', '과장', NULL,   'mj.kim@example.com',      '4002', '2017-01-02'),
    ('20150004', '오서연', 'D120', '과장', NULL,   'seoyeon.oh@example.com',  '3001', '2015-01-05'),  -- 재무팀 B구역 관리자
    ('20190005', '조시우', 'D120', '대리', NULL,   'siwoo.cho@example.com',   '3002', '2019-07-01'),  -- 법인카드 정산 정담당
    ('20260006', '이서연', 'D120', '사원', NULL,   'seoyeon.lee@example.com', '3003', '2026-10-01'),  -- 신규 입사, 아직 고정석 없음
    ('20180010', '한도현', 'D120', '대리', NULL,   'dohyun.han@example.com',  '3004', '2018-01-02'),  -- 파견 복귀, 아직 고정석 없음
    ('20200007', '김민준', 'D130', '대리', NULL,   'minjun.kim@example.com',  '3101', '2020-01-02')
) AS v(emp_no, name, dept_code, rank_name, position_name, email, extension, hired_on)
JOIN departments d ON d.dept_code = v.dept_code;

-- 나머지 직원은 팀별 인원수만큼 만든다 (사번 21000001~). 인원수는 각 팀 구역의 좌석 수에 맞춘 값.
-- 이름은 성 15 × 이름 30 조합에서 148명이 모두 다르게 고른다 (위 시나리오 인물·8F 직원과도 겹치지 않음)
WITH team_size(dept_code, n) AS (
    VALUES ('D110', 15), ('D120', 14), ('D130', 4), ('D140', 5), ('D210', 14), ('D220', 16),
           ('D230', 16), ('D240', 16), ('D310', 16), ('D320', 16), ('D330', 16)
), gen AS (
    SELECT t.dept_code, row_number() OVER (ORDER BY t.dept_code, i) AS k
    FROM team_size t, generate_series(1, t.n) AS i
)
INSERT INTO employees (emp_no, name, department_id, rank_name, email, extension, hired_on)
SELECT (21000000 + gen.k)::text,
       (ARRAY['김', '이', '박', '최', '정', '강', '조', '윤', '장', '임', '한', '오', '서', '신', '권'])[1 + (gen.k * 7) % 15] ||
       (ARRAY['서준', '하은', '도윤', '지우', '시우', '서아', '예준', '하린', '주원', '지호',
              '지민', '수아', '은우', '유나', '현우', '채원', '준서', '다은', '건우', '소율',
              '우진', '예린', '선우', '지아', '연우', '윤서', '민재', '수빈', '현준', '가은'])[1 + (gen.k / 15 + gen.k * 2) % 30],
       d.id,
       (ARRAY['사원', '대리', '대리', '과장', '과장', '차장', '부장'])[1 + gen.k % 7],
       'user' || gen.k || '@example.com',
       (5000 + gen.k)::text,
       date '2010-01-04' + (gen.k * 37 % 5000)::int
FROM gen
JOIN departments d ON d.dept_code = gen.dept_code;

-- 신규 입사자만 임시 비밀번호 상태
INSERT INTO user_accounts (employee_id, password_hash, must_change_password, password_changed_at)
SELECT id,
       '$2b$12$YQWCooIW9V1YrWJ5vD7EDujBSKuP2HW49Z852NdLGSIWLnTG5B7b2',  -- officemap1234
       emp_no = '20260006',
       CASE WHEN emp_no = '20260006' THEN NULL ELSE timestamptz '2026-09-01 09:00+09' END
FROM employees;

-- 조시우: 한 번 틀리고 두 번째에 성공. 없는 사번으로 한 번 시도
INSERT INTO login_history (emp_no_input, employee_id, result, ip_address, user_agent, created_at) VALUES
    ('20190005', (SELECT id FROM employees WHERE emp_no = '20190005'), 'WRONG_PASSWORD', '10.10.3.21', 'Chrome/130', pg_temp.kst(0, '08:51')),
    ('20190005', (SELECT id FROM employees WHERE emp_no = '20190005'), 'SUCCESS',        '10.10.3.21', 'Chrome/130', pg_temp.kst(0, '08:52')),
    ('20199999', NULL,                                                  'NO_ACCOUNT',     '10.10.3.44', 'Edge/130',   pg_temp.kst(0, '09:10'));
UPDATE user_accounts SET last_login_at = pg_temp.kst(0, '08:52')
WHERE employee_id = (SELECT id FROM employees WHERE emp_no = '20190005');

INSERT INTO user_sessions (token_hash, employee_id, created_at, last_active_at, expires_at, ip_address, user_agent)
VALUES (encode(sha256('mock-session-token'::bytea), 'hex'),
        (SELECT id FROM employees WHERE emp_no = '20190005'),
        now(), now(), now() + interval '12 hours', '10.10.3.21', 'Chrome/130');

INSERT INTO notices (title, display_from, display_until, created_by)
SELECT to_char(pg_temp.kst(4, '18:00') AT TIME ZONE 'Asia/Seoul', 'MM/DD') || ' 18:00–20:00 시스템 점검',
       pg_temp.kst(0, '00:00'), pg_temp.kst(4, '20:00'), id
FROM employees WHERE emp_no = '20090001';

-- 공통 ----------------------------------------------------------------------

INSERT INTO files (original_name, stored_path, mime_type, size_bytes, uploaded_by)
SELECT v.original_name, v.stored_path, v.mime_type, v.size_bytes, e.id
FROM (VALUES
    ('조직도_20261001.xlsx',        'org/20261001.xlsx',      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 88213, '20090001'),
    ('2026_업무분장표_재무팀.xlsx', 'duty/2026-finance.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 45120, '20150004')
) AS v(original_name, stored_path, mime_type, size_bytes, uploader)
JOIN employees e ON e.emp_no = v.uploader;

INSERT INTO files (original_name, stored_path, mime_type, size_bytes, uploaded_by)
SELECT '서울본사_' || n || 'F_평면도.pdf', 'plans/seoul/' || n || 'f-v1.pdf', 'application/pdf', 1800000 + n * 61231, e.id
FROM generate_series(1, 10) AS n, employees e
WHERE e.emp_no = '20120002';

INSERT INTO app_settings (key, value, description) VALUES
    ('login.max_failed_count',     '5',                                 '로그인 실패 허용 횟수'),
    ('session.idle_minutes',       '30',                                '미사용 자동 로그아웃'),
    ('admin.session.idle_minutes', '15',                                '관리자 페이지 미사용 자동 로그아웃'),
    ('room.slot_minutes',          '30',                                '예약표 칸 단위'),
    ('room.max_minutes',           '10080',                             '1회 최대 예약 시간 (7일, 여러 날 예약 가능)'),
    ('room.checkin_grace_minutes', '15',                                '체크인 없으면 자동 반납까지'),
    ('room.open_hours',            '{"start": "08:00", "end": "20:00"}', '예약 가능 시간'),
    ('support.contact',            '"정보보호팀(내선 2580)"',             '로그인 화면 계정 문의'),
    ('presence.workday_end',       '"18:00"',                           '재실 상태 "퇴근 시" 자동 해제 시각');

INSERT INTO org_sync_runs (source, file_id, status, created_count, run_by, started_at, finished_at)
VALUES ('EXCEL', (SELECT id FROM files WHERE stored_path = 'org/20261001.xlsx'), 'SUCCESS',
        (SELECT count(*) FROM employees),
        (SELECT id FROM employees WHERE emp_no = '20090001'), '2026-10-01 10:00+09', '2026-10-01 10:00:04+09');

-- ① 공간: 사업장 · 층 · 도면 · 구역 · 좌석 -------------------------------------

INSERT INTO sites (kind, name, address, sort_order) VALUES ('HQ', '서울 본사', NULL, 1);  -- 주소는 관리자가 입력

INSERT INTO floors (site_id, name, description, sort_order)
SELECT s.id, n || 'F',
       CASE n WHEN 1 THEN '로비' WHEN 2 THEN '대강당' WHEN 3 THEN '식당' WHEN 10 THEN '임원실' END,
       n
FROM sites s, generate_series(1, 10) AS n
WHERE s.name = '서울 본사';

-- 층마다 다른 공용 공간. 회의실·팀 구역·좌석은 각자 테이블에 넣는다
WITH extra(floor_name, kind, label, shape) AS (
    VALUES
    ('1F',  'lounge',     '로비 라운지',               pg_temp.cell(0, 'full', 2)),
    ('1F',  'lounge',     '방문객 대기석',             pg_temp.cell(2, 'top', 2)),
    ('1F',  'service',    '안내 데스크 · 보안 게이트', pg_temp.cell(2, 'bottom')),
    ('1F',  'storage',    '택배 · 우편실',             pg_temp.cell(3, 'bottom')),
    ('2F',  'storage',    '준비실',                    pg_temp.slot(2)),
    ('2F',  'restricted', '음향 · 영상 조정실',        pg_temp.cell(3, 'full')),
    ('3F',  'restricted', '주방',                      pg_temp.slot(12)),
    ('3F',  'lounge',     '구내식당',                  pg_temp.cell(0, 'full', 3)),
    ('3F',  'lounge',     '카페 라운지',               pg_temp.cell(3, 'full')),
    ('4F',  'service',    '복합기 · 사물함',           pg_temp.cell(2, 'bottom')),
    ('4F',  'storage',    '문서고',                    pg_temp.cell(3, 'full')),
    ('5F',  'storage',    '포커스룸',                  pg_temp.cell(2, 'bottom')),
    ('5F',  'lounge',     '휴게 공간',                 pg_temp.cell(3, 'full')),
    ('6F',  'restricted', '서버실 (출입 제한)',        pg_temp.cell(2, 'full', 2)),
    ('7F',  'lounge',     '휴게 공간',                 pg_temp.cell(2, 'full')),
    ('7F',  'storage',    '포커스룸',                  pg_temp.cell(3, 'top')),
    ('9F',  'storage',    '분석 랩',                   pg_temp.cell(1, 'bottom')),
    ('9F',  'restricted', '데이터 운영실 (출입 제한)', pg_temp.cell(2, 'full', 2)),
    ('10F', 'restricted', '사장실',                    pg_temp.cell(0, 'full')),
    ('10F', 'restricted', '부사장실',                  pg_temp.cell(1, 'top')),
    ('10F', 'restricted', '전무실',                    pg_temp.cell(1, 'bottom')),
    ('10F', 'lounge',     '비서실 응접',               pg_temp.cell(2, 'bottom')),
    ('10F', 'lounge',     '임원 라운지',               pg_temp.cell(3, 'full'))
), per_floor AS (
    SELECT floor_name, jsonb_agg(jsonb_build_object('kind', kind, 'label', label) || (shape - 'type')) AS spaces
    FROM extra
    GROUP BY floor_name
)
-- 도면 게시본. 벽·기둥·공용 공간은 geometry에 넣는다
INSERT INTO floor_plans (floor_id, version, status, background_file_id, width_m, height_m, geometry,
                         created_by, created_at, updated_by, updated_at, published_by, published_at)
SELECT f.id, 1, 'PUBLISHED', fi.id, 50.0, 30.0,
       jsonb_build_object(
           'walls', '[{"x": 0.0333, "y": 0.0556, "w": 0.9333, "h": 0.8889}]'::jsonb,
           'pillars', '[{"x": 0.2617, "y": 0.3278}, {"x": 0.2617, "y": 0.5972}, {"x": 0.2617, "y": 0.8750},
                        {"x": 0.4992, "y": 0.3278}, {"x": 0.4992, "y": 0.5972}, {"x": 0.4992, "y": 0.8750},
                        {"x": 0.7283, "y": 0.3278}, {"x": 0.7283, "y": 0.5972}, {"x": 0.7283, "y": 0.8750}]'::jsonb,
           'spaces', '[{"kind": "core",     "label": "코어 · EV · 계단", "x": 0.4333, "y": 0.0694, "w": 0.1417, "h": 0.2194},
                       {"kind": "pantry",   "label": "탕비실",           "x": 0.5917, "y": 0.0694, "w": 0.1250, "h": 0.2194},
                       {"kind": "restroom", "label": "화장실",           "x": 0.7167, "y": 0.0694, "w": 0.2417, "h": 0.2194}]'::jsonb
                     || coalesce(pf.spaces, '[]'::jsonb)),
       e.id, published, e.id, published, e.id, published
FROM floors f
CROSS JOIN LATERAL (SELECT timestamptz '2026-09-01 17:00+09' + f.sort_order * interval '2 days' AS published) p
JOIN files fi ON fi.stored_path = 'plans/seoul/' || lower(f.name) || '-v1.pdf'
LEFT JOIN per_floor pf ON pf.floor_name = f.name
JOIN employees e ON e.emp_no = '20120002'
WHERE f.name <> '8F';  -- 8F는 03_dense_floor.sql

-- 7F는 도면을 고치는 중 (사업장 화면의 "수정 중")
INSERT INTO floor_plans (floor_id, version, status, background_file_id, width_m, height_m, geometry,
                         created_by, created_at, updated_by, updated_at)
SELECT p.floor_id, 2, 'DRAFT', p.background_file_id, p.width_m, p.height_m, p.geometry,
       e.id, pg_temp.kst(0, '09:30'), e.id, pg_temp.kst(0, '09:30')
FROM floor_plans p
JOIN floors f ON f.id = p.floor_id AND f.name = '7F'
JOIN employees e ON e.emp_no = '20130003';

-- 팀 구역 (4F~9F 사무실 + 10F 비서석). 색(t0~t4)은 층 안에서만 겹치지 않으면 된다
INSERT INTO zones (floor_id, code, name, department_id, color_key, shape, sort_order)
SELECT f.id, v.code, v.name, d.id, v.color_key, pg_temp.cell(v.col, v.band), v.sort_order
FROM (VALUES
    ('4F',  'A', '고객지원팀',   'D330', 't1', 0, 'full',   1),
    ('4F',  'B', '총무팀',       'D110', 't2', 1, 'full',   2),
    ('4F',  'Z', '공용 자율석',  NULL,   't0', 2, 'top',    3),
    ('5F',  'A', '결제서비스팀', 'D310', 't1', 0, 'full',   1),
    ('5F',  'B', '정산팀',       'D320', 't2', 1, 'full',   2),
    ('5F',  'Z', '공용 자율석',  NULL,   't0', 2, 'top',    3),
    ('6F',  'A', 'IT운영팀',     'D210', 't4', 0, 'full',   1),
    ('6F',  'B', '보안팀',       'D220', 't3', 1, 'full',   2),
    ('7F',  'A', '경영기획팀',   'D130', 't1', 0, 'top',    1),
    ('7F',  'B', '재무팀',       'D120', 't2', 1, 'full',   2),
    ('7F',  'C', '인사팀',       'D140', 't3', 0, 'bottom', 3),
    ('7F',  'Z', '공용 자율석',  NULL,   't0', 3, 'bottom', 4),
    ('9F',  'A', '데이터팀',     'D240', 't3', 0, 'full',   1),
    ('9F',  'Z', '공용 자율석',  NULL,   't0', 1, 'top',    2),
    ('10F', 'S', '비서석',       'D110', 't2', 2, 'top',    1)
) AS v(floor_name, code, name, dept_code, color_key, col, band, sort_order)
JOIN floors f ON f.name = v.floor_name
LEFT JOIN departments d ON d.dept_code = v.dept_code;

-- 좌석: 구역마다 3열. 전체 높이 구역은 6줄(18석), 절반 높이는 2줄(6석)
-- 두 줄씩 책상을 마주 붙이고, 위 줄은 의자가 위(180°), 아래 줄은 의자가 아래(0°)
INSERT INTO seats (floor_id, zone_id, code, seat_type, x, y, rotation)
SELECT z.floor_id, z.id,
       z.code || '-' || lpad((r * 3 + c + 1)::text, 2, '0'),
       CASE WHEN z.department_id IS NULL THEN 'FLEX' ELSE 'FIXED' END,
       round((z.shape->>'x')::numeric + 0.0367 + c * 0.055, 4),
       round((z.shape->>'y')::numeric + 0.05 + (r / 2) * 0.145 + (r % 2) * 0.0556 + 0.0278, 4),
       CASE WHEN r % 2 = 0 THEN 180 ELSE 0 END
FROM zones z
CROSS JOIN LATERAL generate_series(0, CASE WHEN (z.shape->>'h')::numeric > 0.3 THEN 5 ELSE 1 END) AS r
CROSS JOIN generate_series(0, 2) AS c;

-- ② 회의실 (권한·예약보다 먼저). 대부분 위쪽 띠의 slot 1, 2. 2F 대강당은 아래쪽 세 칸
INSERT INTO meeting_rooms (floor_id, name, capacity, equipment, shape, sort_order)
SELECT f.id, v.name, v.capacity, v.equipment::text[], v.shape, v.sort_order
FROM (VALUES
    ('1F',  '접견실 101',       8, '{TV}',              pg_temp.slot(1),            1),
    ('1F',  '접견실 102',       6, '{TV}',              pg_temp.slot(2),            2),
    ('2F',  '대강당 201',     200, '{VIDEO,PROJECTOR}', pg_temp.cell(0, 'full', 3), 1),
    ('2F',  '세미나실 202',    30, '{PROJECTOR}',       pg_temp.slot(1),            2),
    ('4F',  '회의실 401',      12, '{VIDEO}',           pg_temp.slot(1),            1),
    ('4F',  '회의실 402',       6, '{TV}',              pg_temp.slot(2),            2),
    ('5F',  '회의실 501',       8, '{VIDEO}',           pg_temp.slot(1),            1),
    ('5F',  '회의실 502',       6, '{TV}',              pg_temp.slot(2),            2),
    ('6F',  '회의실 601',       8, '{VIDEO}',           pg_temp.slot(1),            1),
    ('6F',  '회의실 602',       6, '{TV}',              pg_temp.slot(2),            2),
    ('7F',  '대회의실 701',    12, '{VIDEO}',           pg_temp.slot(1),            1),
    ('7F',  '소회의실 702',     6, '{TV}',              pg_temp.slot(2),            2),
    ('9F',  '회의실 901',       8, '{VIDEO}',           pg_temp.slot(1),            1),
    ('9F',  '회의실 902',       6, '{TV}',              pg_temp.slot(2),            2),
    ('10F', '임원 회의실 1001', 10, '{VIDEO}',          pg_temp.slot(1),            1),
    ('10F', '회의실 1002',      6, '{TV}',              pg_temp.slot(2),            2)
) AS v(floor_name, name, capacity, equipment, shape, sort_order)
JOIN floors f ON f.name = v.floor_name;

-- ⑤ 권한: 위 단계가 바로 아래 단계를 지정 --------------------------------------

INSERT INTO admin_grants (employee_id, role, granted_by, granted_at)
VALUES ((SELECT id FROM employees WHERE emp_no = '20090001'), 'COMPANY_ADMIN', NULL, '2026-09-01 09:00+09');
INSERT INTO admin_grants (employee_id, role, site_id, granted_by, granted_at)
VALUES ((SELECT id FROM employees WHERE emp_no = '20120002'), 'SITE_ADMIN', (SELECT id FROM sites WHERE name = '서울 본사'),
        (SELECT id FROM employees WHERE emp_no = '20090001'), '2026-09-01 09:10+09');
INSERT INTO admin_grants (employee_id, role, floor_id, granted_by, granted_at)
VALUES ((SELECT id FROM employees WHERE emp_no = '20130003'), 'FLOOR_ADMIN', (SELECT id FROM floors WHERE name = '7F'),
        (SELECT id FROM employees WHERE emp_no = '20120002'), '2026-09-02 10:00+09');
INSERT INTO admin_grants (employee_id, role, zone_id, apply_mode, granted_by, granted_at)
VALUES ((SELECT id FROM employees WHERE emp_no = '20150004'), 'ZONE_ADMIN',
        (SELECT z.id FROM zones z JOIN floors f ON f.id = z.floor_id WHERE f.name = '7F' AND z.code = 'B'),
        'NEEDS_APPROVAL', (SELECT id FROM employees WHERE emp_no = '20130003'), '2026-09-03 10:00+09');

-- 관리자 페이지 계정: 권한을 받은 4명. 비밀번호는 직원 로그인과 다르게 officemap-admin
INSERT INTO admin_accounts (employee_id, password_hash, password_changed_at, created_by)
SELECT g.employee_id,
       '$2b$12$oqrqjAGZROKv0F//QSpNveyZFOBQz7sjAMJuSOMuSvHliUhwjqeC2',  -- officemap-admin
       g.granted_at, g.granted_by
FROM admin_grants g
WHERE g.revoked_at IS NULL;

-- ④ 좌석 배정 ----------------------------------------------------------------

-- 시나리오 인물. 조시우는 B-11에 있다가 B-01로 이동 (이력 확인용)
INSERT INTO seat_assignments (seat_id, employee_id, kind, starts_at, ends_at, assigned_by)
SELECT s.id, e.id, 'FIXED', v.starts_at::timestamptz, v.ends_at::timestamptz, a.id
FROM (VALUES
    ('4F',  'B-01', '20090001', '2024-01-02 09:00+09', NULL),
    ('10F', 'S-01', '20100009', '2024-01-02 09:00+09', NULL),
    ('7F',  'A-01', '20200007', '2024-01-02 09:00+09', NULL),
    ('7F',  'B-11', '20190005', '2023-03-02 09:00+09', '2025-03-01 09:00+09'),
    ('7F',  'B-01', '20190005', '2025-03-01 09:00+09', NULL),
    ('7F',  'B-02', '20150004', '2025-03-01 09:00+09', NULL),
    ('6F',  'A-01', '20130003', '2024-01-02 09:00+09', NULL),
    ('6F',  'A-05', '20170008', '2024-01-02 09:00+09', NULL)
) AS v(floor_name, seat_code, emp_no, starts_at, ends_at)
JOIN floors f ON f.name = v.floor_name
JOIN seats s ON s.floor_id = f.id AND s.code = v.seat_code
JOIN employees e ON e.emp_no = v.emp_no
JOIN employees a ON a.emp_no = '20130003';

-- 나머지는 팀 구역의 빈 좌석에 순서대로 앉힌다 (좌석번호 순. 총무팀은 4F B구역이 10F 비서석보다 먼저 찬다)
-- 구역 끝의 좌석은 비워 둔다 (18석 구역은 2석, 6석 구역은 1석): 미배치 인원·빈 자리 확인용
WITH zone_seat AS (
    SELECT s.id AS seat_id, s.code, z.department_id,
           row_number() OVER (PARTITION BY z.id ORDER BY s.code) AS pos,
           count(*) OVER (PARTITION BY z.id) AS total
    FROM seats s
    JOIN zones z ON z.id = s.zone_id
    WHERE z.department_id IS NOT NULL
), free_seat AS (
    SELECT seat_id, department_id, row_number() OVER (PARTITION BY department_id ORDER BY code) AS rn
    FROM zone_seat zs
    WHERE pos <= total - CASE WHEN total > 6 THEN 2 ELSE 1 END
      AND NOT EXISTS (SELECT 1 FROM seat_assignments a WHERE a.seat_id = zs.seat_id AND a.ends_at IS NULL)
), free_employee AS (
    SELECT e.id AS employee_id, e.department_id, row_number() OVER (PARTITION BY e.department_id ORDER BY e.emp_no) AS rn
    FROM employees e
    WHERE e.emp_no NOT IN ('20120002', '20260006', '20180010')  -- 강지아(자율석), 이서연·한도현(미배치)
      AND NOT EXISTS (SELECT 1 FROM seat_assignments a WHERE a.employee_id = e.id AND a.kind = 'FIXED' AND a.ends_at IS NULL)
)
INSERT INTO seat_assignments (seat_id, employee_id, kind, starts_at, assigned_by)
SELECT fs.seat_id, fe.employee_id, 'FIXED', '2025-03-01 09:00+09', (SELECT id FROM employees WHERE emp_no = '20130003')
FROM free_seat fs
JOIN free_employee fe ON fe.department_id = fs.department_id AND fe.rn = fs.rn;

-- 오늘 자율석 사용: 사업장 관리자와 아직 자리 없는 신규 입사자
INSERT INTO seat_assignments (seat_id, employee_id, kind, starts_at, ends_at, assigned_by)
SELECT s.id, e.id, 'DAILY', pg_temp.kst(0, '09:00'), pg_temp.kst(0, '18:00'), e.id
FROM (VALUES ('Z-01', '20120002'), ('Z-02', '20260006')) AS v(seat_code, emp_no)
JOIN floors f ON f.name = '7F'
JOIN seats s ON s.floor_id = f.id AND s.code = v.seat_code
JOIN employees e ON e.emp_no = v.emp_no;

-- B구역 관리자(승인 후 반영)의 변경: 신규 입사자 배치는 작성 중, 자율석 편입은 승인 대기
INSERT INTO change_requests (floor_id, zone_id, request_type, status, note, requested_by, submitted_at, created_at, updated_at)
SELECT z.floor_id, z.id, v.request_type, v.status, v.note, e.id, v.submitted_at, v.created_at, v.created_at
FROM (VALUES
    ('SEAT_ASSIGNMENT', 'DRAFT',   '신규 입사자 배치',              NULL::timestamptz,        pg_temp.kst(0, '10:05')),
    ('ZONE_CHANGE',     'PENDING', '공용 자율석 Z-02를 B구역으로', pg_temp.kst(-1, '16:00'), pg_temp.kst(-1, '15:40'))
) AS v(request_type, status, note, submitted_at, created_at)
JOIN floors f ON f.name = '7F'
JOIN zones z ON z.floor_id = f.id AND z.code = 'B'
JOIN employees e ON e.emp_no = '20150004';

INSERT INTO change_request_items (request_id, seat_id, action, employee_id)
SELECT r.id, s.id, 'ASSIGN', e.id
FROM change_requests r
JOIN seats s ON s.floor_id = r.floor_id AND s.code = 'B-17'
JOIN employees e ON e.emp_no = '20260006'
WHERE r.note = '신규 입사자 배치';
INSERT INTO change_request_items (request_id, seat_id, action, to_zone_id)
SELECT r.id, s.id, 'MOVE_ZONE', r.zone_id
FROM change_requests r
JOIN seats s ON s.floor_id = r.floor_id AND s.code = 'Z-02'
WHERE r.note = '공용 자율석 Z-02를 B구역으로';

-- ③ 재실 ---------------------------------------------------------------------

INSERT INTO employee_absences (employee_id, kind, starts_at, ends_at, source, external_id)
VALUES ((SELECT id FROM employees WHERE emp_no = '20130003'), 'LEAVE',
        pg_temp.kst(0, '00:00'), pg_temp.kst(1, '00:00'), 'HR_API', 'LV-MOCK-0001');

INSERT INTO presence_status (employee_id, status, message, expires_at, updated_at)
SELECT e.id, v.status, v.message, v.expires_at, pg_temp.kst(0, '09:00')
FROM (VALUES
    ('20190005', 'AVAILABLE',      '편하게 자리로 찾아오세요',       NULL::timestamptz),
    ('20150004', 'IN_MEETING',     '대회의실 701 · 14:30 종료 예정', pg_temp.kst(0, '14:30')),
    ('20170008', 'DO_NOT_DISTURB', '장애 대응 중 · 메신저로 연락',   pg_temp.kst(0, '18:00')),
    ('20130003', 'AWAY',           '연차 휴가 · 내일 복귀',          pg_temp.kst(1, '00:00')),
    ('20200007', 'AVAILABLE',      NULL,                            pg_temp.kst(0, '19:00')),   -- 퇴근 시 자동 해제
    ('20090001', 'AVAILABLE',      NULL,                            NULL),
    ('20120002', 'AVAILABLE',      '오늘은 7F 자율석에 있어요',      pg_temp.kst(0, '18:00')),
    ('20100009', 'DO_NOT_DISTURB', '임원 일정 조율 중',              NULL)
) AS v(emp_no, status, message, expires_at)
JOIN employees e ON e.emp_no = v.emp_no;

-- 나머지 직원: 대부분 방문 가능, 일부는 방해 금지·회의 중·부재, 일부는 상태를 정하지 않음
INSERT INTO presence_status (employee_id, status, message, updated_at)
SELECT e.id,
       (ARRAY['AVAILABLE', 'AVAILABLE', 'AVAILABLE', 'AVAILABLE', 'DO_NOT_DISTURB', 'IN_MEETING', 'AWAY'])[1 + e.id % 7],
       (ARRAY[NULL, NULL, NULL, NULL, '집중 업무 중', '회의 중', '외근'])[1 + e.id % 7],
       pg_temp.kst(0, '09:00')
FROM employees e
WHERE e.emp_no LIKE '21%' AND e.id % 9 <> 0;

-- ② 예약 ---------------------------------------------------------------------

-- 재무팀 주간회의: 오늘부터 3주 동안 같은 요일 15:00–16:00, 회차마다 예약 행
INSERT INTO reservation_series (room_id, organizer_id, title, repeat_rule, start_time, end_time, first_date, last_date)
SELECT (SELECT id FROM meeting_rooms WHERE name = '소회의실 702'), (SELECT id FROM employees WHERE emp_no = '20190005'),
       '재무팀 주간회의', 'WEEKLY', '15:00', '16:00', today, today + 14
FROM (SELECT (now() AT TIME ZONE 'Asia/Seoul')::date AS today) t;

INSERT INTO reservations (room_id, organizer_id, series_id, title, starts_at, ends_at)
SELECT s.room_id, s.organizer_id, s.id, s.title,
       (d::date + s.start_time) AT TIME ZONE 'Asia/Seoul', (d::date + s.end_time) AT TIME ZONE 'Asia/Seoul'
FROM reservation_series s,
     -- generate_series는 timestamptz를 돌려주니 날짜로 바꿔서 서울 시각을 붙인다
     generate_series(s.first_date, s.last_date, interval '7 days') AS d
WHERE s.title = '재무팀 주간회의';

-- 오늘·내일 예약 (승인 절차 없이 모두 확정)
INSERT INTO reservations (room_id, organizer_id, title, starts_at, ends_at, checked_in_at)
SELECT m.id, e.id, v.title, pg_temp.kst(v.day, v.starts), pg_temp.kst(v.day, v.ends),
       CASE WHEN v.checked_in THEN pg_temp.kst(v.day, v.starts) + interval '4 minutes' END
FROM (VALUES
    ('대강당 201',       '20090001', '신규 입사자 교육', 0, time '10:00', time '12:00', true),
    ('대회의실 701',     '20150004', '분기 결산 보고',   0, time '13:00', time '14:30', true),
    ('회의실 601',       '20170008', '장애 대응 상황실', 0, time '09:00', time '18:00', true),
    ('회의실 501',       '20190005', '정산 시스템 점검', 0, time '16:00', time '17:00', false),
    ('접견실 101',       '20120002', '협력사 방문 미팅', 0, time '11:00', time '12:00', false),
    ('임원 회의실 1001', '20090001', '이사회 준비',      1, time '14:00', time '16:00', false),
    -- 비서실 윤하은이 예약만 해 주고 본인은 들어가지 않는 회의
    ('임원 회의실 1001', '20100009', '경영회의',         1, time '10:00', time '11:00', false)
) AS v(room, organizer, title, day, starts, ends, checked_in)
JOIN meeting_rooms m ON m.name = v.room
JOIN employees e ON e.emp_no = v.organizer;

-- 참석자: 주간회의 전 회차에 재무팀 2명 + 경영기획팀 김민준
INSERT INTO reservation_attendees (reservation_id, employee_id)
SELECT r.id, e.id
FROM reservations r
JOIN employees e ON e.emp_no IN ('20150004', '20260006', '20200007')
WHERE r.title = '재무팀 주간회의';
INSERT INTO reservation_attendees (reservation_id, employee_id)
SELECT r.id, e.id
FROM reservations r
JOIN employees e ON e.emp_no IN ('20190005', '20200007')
WHERE r.title = '분기 결산 보고';
INSERT INTO reservation_attendees (reservation_id, employee_id)
SELECT r.id, e.id
FROM reservations r
JOIN employees e ON e.emp_no IN ('20090001', '20120002', '20130003')
WHERE r.title = '경영회의';
-- 예약한 사람도 참석한다 (경영회의는 비서가 예약만 했다)
INSERT INTO reservation_attendees (reservation_id, employee_id)
SELECT id, organizer_id FROM reservations WHERE title <> '경영회의'
ON CONFLICT DO NOTHING;

INSERT INTO notifications (recipient_id, channel, type, payload, status, created_at)
SELECT a.employee_id, 'IN_APP', 'RESERVATION_INVITE',
       jsonb_build_object('reservation_id', r.id, 'title', r.title, 'starts_at', r.starts_at),
       'PENDING', pg_temp.kst(0, '09:00')
FROM reservations r
JOIN reservation_attendees a ON a.reservation_id = r.id AND a.employee_id <> r.organizer_id
WHERE r.title = '재무팀 주간회의' AND r.starts_at = pg_temp.kst(0, '15:00');

-- ⑦ AI 도우미 ----------------------------------------------------------------

INSERT INTO duty_documents (title, department_id, file_id, effective_date, uploaded_by)
VALUES ('2026 업무분장표 · 재무팀', (SELECT id FROM departments WHERE dept_code = 'D120'),
        (SELECT id FROM files WHERE stored_path = 'duty/2026-finance.xlsx'), '2026-10-01',
        (SELECT id FROM employees WHERE emp_no = '20150004'));

INSERT INTO duty_tasks (document_id, department_id, name, description, keywords, embedding)
SELECT d.id, d.department_id, '법인카드 정산', '법인카드 사용 내역 확인과 월말 정산',
       '{경비 처리,세금계산서}', '[0.12, 0.34, 0.56]'
FROM duty_documents d WHERE d.title = '2026 업무분장표 · 재무팀';

INSERT INTO duty_task_owners (task_id, employee_id, role)
SELECT t.id, e.id, v.role
FROM (VALUES ('20190005', 'PRIMARY'), ('20150004', 'SECONDARY')) AS v(emp_no, role)
JOIN employees e ON e.emp_no = v.emp_no
JOIN duty_tasks t ON t.name = '법인카드 정산';

INSERT INTO ai_conversations (employee_id, started_at)
VALUES ((SELECT id FROM employees WHERE emp_no = '20170008'), pg_temp.kst(0, '13:45'));

INSERT INTO ai_messages (conversation_id, role, content, tool_name, tool_args, cited_task_ids, created_at)
SELECT c.id, v.role, v.content, v.tool_name, v.tool_args::jsonb,
       CASE WHEN v.role = 'ASSISTANT' THEN ARRAY[(SELECT id FROM duty_tasks WHERE name = '법인카드 정산')] END,
       pg_temp.kst(0, '13:45') + v.after
FROM (VALUES
    ('USER',      '법인카드 사용 내역 정산은 누구한테 물어봐야 해?', NULL,         NULL,                           interval '0 s'),
    ('TOOL',      '{"task": "법인카드 정산", "primary": "조시우", "seat": "7F B-01"}', 'find_owner', '{"query": "법인카드 정산"}', interval '1 s'),
    ('ASSISTANT', '법인카드 정산은 재무팀 조시우 님 담당이에요. 지금 방문 가능 상태이고 7F B-01 자리에 있어요.', NULL, NULL, interval '2 s')
) AS v(role, content, tool_name, tool_args, after)
CROSS JOIN ai_conversations c;

-- 관리자 작업 이력 ------------------------------------------------------------

INSERT INTO audit_logs (actor_id, action, target_type, target_id, before_data, after_data, ip_address, created_at)
SELECT e.id, 'SEAT_ASSIGN', 'seat', s.id,
       '{"employee": null}', jsonb_build_object('employee', '20190005'), '10.10.3.30', '2025-03-01 09:00+09'
FROM employees e
JOIN floors f ON f.name = '7F'
JOIN seats s ON s.floor_id = f.id AND s.code = 'B-01'
WHERE e.emp_no = '20130003';
INSERT INTO audit_logs (actor_id, action, target_type, target_id, after_data, ip_address, created_at)
SELECT e.id, 'PLAN_PUBLISH', 'floor_plan', p.id, '{"version": 1}', '10.10.1.12', p.published_at
FROM employees e, floor_plans p JOIN floors f ON f.id = p.floor_id
WHERE e.emp_no = '20120002' AND f.name = '10F' AND p.version = 1;
