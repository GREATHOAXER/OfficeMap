-- 01_mock.sql
-- 화면 흐름 순서대로 넣는 목업 데이터: 서울 본사 7F·10F 시나리오
-- 이름·사번·연락처는 모두 가짜다
-- 목업 계정의 비밀번호는 모두 officemap1234 (개발용. 운영 DB에 넣지 말 것)
-- 실행 순서: db/schema/01~08 → 이 파일

-- ⓪ 로그인 ------------------------------------------------------------------

INSERT INTO departments (dept_code, name, sort_order) VALUES
    ('D100', '경영지원본부', 1),
    ('D200', 'IT본부', 2),
    ('D300', '비서실', 3);
INSERT INTO departments (dept_code, name, parent_id, sort_order)
SELECT v.code, v.name, p.id, v.sort_order
FROM (VALUES
    ('D110', '총무팀',     'D100', 1),
    ('D120', '재무팀',     'D100', 2),
    ('D130', '경영기획팀', 'D100', 3),
    ('D210', 'IT운영팀',   'D200', 1)
) AS v(code, name, parent_code, sort_order)
JOIN departments p ON p.dept_code = v.parent_code;

-- 김민준 두 명은 동명이인 화면 확인용
INSERT INTO employees (emp_no, name, department_id, rank_name, position_name, email, extension, hired_on)
SELECT v.emp_no, v.name, d.id, v.rank_name, v.position_name, v.email, v.extension, v.hired_on::date
FROM (VALUES
    ('20090001', '한도윤', 'D110', '부장', '팀장', 'doyun.han@example.com',   '1001', '2009-03-02'),  -- 전사 관리자
    ('20120002', '강지아', 'D110', '차장', NULL,   'jia.kang@example.com',    '1002', '2012-01-02'),  -- 서울 본사 사업장 관리자
    ('20130003', '정민호', 'D210', '차장', NULL,   'minho.jung@example.com',  '2001', '2013-07-01'),  -- 7F 층 관리자
    ('20150004', '오서연', 'D120', '과장', NULL,   'seoyeon.oh@example.com',  '3001', '2015-01-05'),  -- 재무팀 B구역 관리자
    ('20190005', '조시우', 'D120', '대리', NULL,   'siwoo.cho@example.com',   '3002', '2019-07-01'),  -- 법인카드 정산 정담당
    ('20260006', '이서연', 'D120', '사원', NULL,   'seoyeon.lee@example.com', '3003', '2026-10-01'),  -- 신규 입사, 아직 자리 없음
    ('20200007', '김민준', 'D130', '대리', NULL,   'minjun.kim@example.com',  '4001', '2020-01-02'),
    ('20170008', '김민준', 'D210', '과장', NULL,   'mj.kim@example.com',      '2002', '2017-01-02'),
    ('20100009', '윤하은', 'D300', '차장', NULL,   'haeun.yoon@example.com',  '1101', '2010-03-02')   -- 임원 회의실 승인자
) AS v(emp_no, name, dept_code, rank_name, position_name, email, extension, hired_on)
JOIN departments d ON d.dept_code = v.dept_code;

-- 신규 입사자만 임시 비밀번호 상태
INSERT INTO user_accounts (employee_id, password_hash, role, must_change_password, password_changed_at)
SELECT id,
       '$2b$12$YQWCooIW9V1YrWJ5vD7EDujBSKuP2HW49Z852NdLGSIWLnTG5B7b2',  -- officemap1234
       CASE WHEN emp_no = '20090001' THEN 'ADMIN' ELSE 'USER' END,
       emp_no = '20260006',
       CASE WHEN emp_no = '20260006' THEN NULL ELSE timestamptz '2026-09-01 09:00+09' END
FROM employees;

-- 조시우: 한 번 틀리고 두 번째에 성공. 없는 사번으로 한 번 시도
INSERT INTO login_history (emp_no_input, employee_id, result, ip_address, user_agent, created_at) VALUES
    ('20190005', (SELECT id FROM employees WHERE emp_no = '20190005'), 'WRONG_PASSWORD', '10.10.7.21', 'Chrome/130', '2026-10-20 08:51+09'),
    ('20190005', (SELECT id FROM employees WHERE emp_no = '20190005'), 'SUCCESS',        '10.10.7.21', 'Chrome/130', '2026-10-20 08:52+09'),
    ('20199999', NULL,                                                  'NO_ACCOUNT',     '10.10.7.44', 'Edge/130',   '2026-10-20 09:10+09');
UPDATE user_accounts SET last_login_at = '2026-10-20 08:52+09'
WHERE employee_id = (SELECT id FROM employees WHERE emp_no = '20190005');

INSERT INTO user_sessions (token_hash, employee_id, created_at, last_active_at, expires_at, ip_address, user_agent)
VALUES (encode(sha256('mock-session-token'::bytea), 'hex'),
        (SELECT id FROM employees WHERE emp_no = '20190005'),
        now(), now(), now() + interval '12 hours', '10.10.7.21', 'Chrome/130');

INSERT INTO notices (title, display_from, display_until, created_by) VALUES
    ('10/24(금) 18:00–20:00 시스템 점검', '2026-10-20 00:00+09', '2026-10-24 20:00+09',
     (SELECT id FROM employees WHERE emp_no = '20090001'));

-- 공통 ----------------------------------------------------------------------

INSERT INTO files (original_name, stored_path, mime_type, size_bytes, uploaded_by)
SELECT v.original_name, v.stored_path, v.mime_type, v.size_bytes, e.id
FROM (VALUES
    ('서울본사_7F_평면도.pdf',  'plans/seoul/7f-v1.pdf',     'application/pdf', 2483021, '20120002'),
    ('서울본사_10F_평면도.pdf', 'plans/seoul/10f-v1.pdf',    'application/pdf', 1904112, '20120002'),
    ('조직도_20261001.xlsx',    'org/20261001.xlsx',         'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 88213, '20090001'),
    ('2026_업무분장표_재무팀.xlsx', 'duty/2026-finance.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 45120, '20150004')
) AS v(original_name, stored_path, mime_type, size_bytes, uploader)
JOIN employees e ON e.emp_no = v.uploader;

INSERT INTO app_settings (key, value, description) VALUES
    ('login.max_failed_count',     '5',                                 '로그인 실패 허용 횟수'),
    ('session.idle_minutes',       '30',                                '미사용 자동 로그아웃'),
    ('room.slot_minutes',          '30',                                '예약표 칸 단위'),
    ('room.max_minutes',           '120',                               '1회 최대 예약 시간'),
    ('room.checkin_grace_minutes', '15',                                '체크인 없으면 자동 반납까지'),
    ('room.open_hours',            '{"start": "08:00", "end": "20:00"}', '예약 가능 시간'),
    ('support.contact',            '"정보보호팀 내선 0000"',              '로그인 화면 계정 문의');

INSERT INTO org_sync_runs (source, file_id, status, created_count, run_by, started_at, finished_at)
VALUES ('EXCEL', (SELECT id FROM files WHERE stored_path = 'org/20261001.xlsx'), 'SUCCESS', 9,
        (SELECT id FROM employees WHERE emp_no = '20090001'), '2026-10-01 10:00+09', '2026-10-01 10:00:04+09');

-- ① 공간: 사업장 · 층 · 도면 · 구역 · 좌석 -------------------------------------

INSERT INTO sites (kind, name, address, sort_order) VALUES ('HQ', '서울 본사', '[서울 주소]', 1);

INSERT INTO floors (site_id, name, sort_order)
SELECT s.id, v.name, v.sort_order
FROM (VALUES ('7F', 7), ('10F', 10)) AS v(name, sort_order)
CROSS JOIN sites s WHERE s.name = '서울 본사';

-- 7F는 게시본 + 수정 중 초안(사업장 화면의 "수정 중"), 10F는 게시본만
INSERT INTO floor_plans (floor_id, version, status, background_file_id, width_m, height_m,
                         created_by, created_at, updated_by, updated_at, published_by, published_at)
SELECT f.id, v.version, v.status, fi.id, v.width_m, v.height_m,
       e.id, v.at::timestamptz, e.id, v.at::timestamptz,
       CASE WHEN v.status = 'PUBLISHED' THEN e.id END,
       CASE WHEN v.status = 'PUBLISHED' THEN v.at::timestamptz END
FROM (VALUES
    ('7F',  1, 'PUBLISHED', 'plans/seoul/7f-v1.pdf',  48.0, 30.0, '2026-09-12 17:00+09'),
    ('7F',  2, 'DRAFT',     'plans/seoul/7f-v1.pdf',  48.0, 30.0, '2026-10-20 09:30+09'),
    ('10F', 1, 'PUBLISHED', 'plans/seoul/10f-v1.pdf', 40.0, 28.0, '2026-09-28 11:00+09')
) AS v(floor_name, version, status, file_path, width_m, height_m, at)
JOIN floors f ON f.name = v.floor_name
JOIN files fi ON fi.stored_path = v.file_path
JOIN employees e ON e.emp_no = '20120002';

INSERT INTO zones (floor_id, code, name, department_id, color_key, shape, sort_order)
SELECT f.id, v.code, v.name, d.id, v.color_key, v.shape::jsonb, v.sort_order
FROM (VALUES
    ('A', '경영기획팀',  'D130', 't1', '{"type": "rect", "x": 0.05, "y": 0.10, "w": 0.20, "h": 0.35}', 1),
    ('B', '재무팀',      'D120', 't2', '{"type": "rect", "x": 0.28, "y": 0.10, "w": 0.25, "h": 0.35}', 2),
    ('D', 'IT운영팀',    'D210', 't4', '{"type": "rect", "x": 0.05, "y": 0.55, "w": 0.48, "h": 0.35}', 3),
    ('Z', '공용 자율석', NULL,   't0', '{"type": "rect", "x": 0.60, "y": 0.55, "w": 0.30, "h": 0.20}', 4)
) AS v(code, name, dept_code, color_key, shape, sort_order)
JOIN floors f ON f.name = '7F'
LEFT JOIN departments d ON d.dept_code = v.dept_code;

INSERT INTO seats (floor_id, zone_id, code, seat_type, x, y, rotation)
SELECT z.floor_id, z.id, v.code, v.seat_type, v.x, v.y, v.rotation
FROM (VALUES
    ('A', 'A-01', 'FIXED', 0.08, 0.15,   0),
    ('B', 'B-01', 'FIXED', 0.31, 0.15,   0),
    ('B', 'B-02', 'FIXED', 0.36, 0.15,   0),
    ('B', 'B-11', 'FIXED', 0.46, 0.38, 180),
    ('D', 'D-01', 'FIXED', 0.08, 0.60,   0),
    ('D', 'D-05', 'FIXED', 0.28, 0.60,   0),
    ('Z', 'Z-01', 'FLEX',  0.63, 0.60,  90),
    ('Z', 'Z-02', 'FLEX',  0.68, 0.60,  90)
) AS v(zone_code, code, seat_type, x, y, rotation)
JOIN zones z ON z.code = v.zone_code
JOIN floors f ON f.id = z.floor_id AND f.name = '7F';

-- ② 회의실 (권한·예약보다 먼저) ------------------------------------------------

INSERT INTO meeting_rooms (floor_id, name, capacity, equipment, requires_approval, shape, sort_order)
SELECT f.id, v.name, v.capacity, v.equipment::text[], v.requires_approval, v.shape::jsonb, v.sort_order
FROM (VALUES
    ('7F',  '대회의실 701',     12, '{VIDEO}', false, '{"type": "rect", "x": 0.60, "y": 0.10, "w": 0.18, "h": 0.25}', 1),
    ('7F',  '소회의실 702',      6, '{TV}',    false, '{"type": "rect", "x": 0.80, "y": 0.10, "w": 0.12, "h": 0.25}', 2),
    ('10F', '임원 회의실 1001', 10, '{VIDEO}', true,  '{"type": "rect", "x": 0.50, "y": 0.20, "w": 0.25, "h": 0.30}', 1)
) AS v(floor_name, name, capacity, equipment, requires_approval, shape, sort_order)
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
INSERT INTO admin_grants (employee_id, role, room_id, granted_by, granted_at)
VALUES ((SELECT id FROM employees WHERE emp_no = '20100009'), 'ROOM_APPROVER', (SELECT id FROM meeting_rooms WHERE name = '임원 회의실 1001'),
        (SELECT id FROM employees WHERE emp_no = '20120002'), '2026-09-03 11:00+09');

-- ④ 좌석 배정 ----------------------------------------------------------------

-- 조시우는 B-11에 있다가 B-01로 이동 (이력 확인용)
INSERT INTO seat_assignments (seat_id, employee_id, kind, starts_at, ends_at, assigned_by)
SELECT s.id, e.id, v.kind, v.starts_at::timestamptz, v.ends_at::timestamptz, a.id
FROM (VALUES
    ('A-01', '20200007', 'FIXED', '2024-01-02 09:00+09', NULL),
    ('B-11', '20190005', 'FIXED', '2023-03-02 09:00+09', '2025-03-01 09:00+09'),
    ('B-01', '20190005', 'FIXED', '2025-03-01 09:00+09', NULL),
    ('B-02', '20150004', 'FIXED', '2025-03-01 09:00+09', NULL),
    ('D-01', '20130003', 'FIXED', '2024-01-02 09:00+09', NULL),
    ('D-05', '20170008', 'FIXED', '2024-01-02 09:00+09', NULL),
    ('Z-01', '20120002', 'DAILY', '2026-10-20 09:00+09', '2026-10-20 18:00+09')   -- 사업장 관리자가 오늘 7F 자율석 사용
) AS v(seat_code, emp_no, kind, starts_at, ends_at)
JOIN seats s ON s.code = v.seat_code
JOIN employees e ON e.emp_no = v.emp_no
JOIN employees a ON a.emp_no = '20130003';

-- B구역 관리자(승인 후 반영)의 변경: 신규 입사자 배치는 작성 중, 자율석 편입은 승인 대기
INSERT INTO change_requests (floor_id, zone_id, request_type, status, note, requested_by, submitted_at, created_at, updated_at)
SELECT z.floor_id, z.id, v.request_type, v.status, v.note, e.id, v.submitted_at::timestamptz, v.created_at::timestamptz, v.created_at::timestamptz
FROM (VALUES
    ('SEAT_ASSIGNMENT', 'DRAFT',   '신규 입사자 배치',          NULL,                   '2026-10-20 10:05+09'),
    ('ZONE_CHANGE',     'PENDING', '공용 자율석 Z-02를 B구역으로', '2026-10-19 16:00+09', '2026-10-19 15:40+09')
) AS v(request_type, status, note, submitted_at, created_at)
JOIN zones z ON z.code = 'B'
JOIN employees e ON e.emp_no = '20150004';

INSERT INTO change_request_items (request_id, seat_id, action, employee_id)
SELECT r.id, s.id, 'ASSIGN', e.id
FROM change_requests r, seats s, employees e
WHERE r.note = '신규 입사자 배치' AND s.code = 'B-11' AND e.emp_no = '20260006';
INSERT INTO change_request_items (request_id, seat_id, action, to_zone_id)
SELECT r.id, s.id, 'MOVE_ZONE', z.id
FROM change_requests r, seats s, zones z
WHERE r.note = '공용 자율석 Z-02를 B구역으로' AND s.code = 'Z-02' AND z.code = 'B';

-- ③ 재실 ---------------------------------------------------------------------

INSERT INTO employee_absences (employee_id, kind, starts_at, ends_at, source, external_id)
VALUES ((SELECT id FROM employees WHERE emp_no = '20130003'), 'LEAVE',
        '2026-10-20 00:00+09', '2026-10-21 00:00+09', 'HR_API', 'LV-2026-10-0001');

INSERT INTO presence_status (employee_id, status, message, expires_at, updated_at)
SELECT e.id, v.status, v.message, v.expires_at::timestamptz, '2026-10-20 13:40+09'
FROM (VALUES
    ('20190005', 'AVAILABLE',      '편하게 자리로 찾아오세요',       NULL),
    ('20150004', 'IN_MEETING',     '대회의실 701 · 14:30 종료 예정', '2026-10-20 14:30+09'),
    ('20170008', 'DO_NOT_DISTURB', '집중 업무 중 · 15:00까지',      '2026-10-20 15:00+09'),
    ('20130003', 'AWAY',           '연차 휴가 · 내일 복귀',         '2026-10-21 00:00+09'),
    ('20200007', 'AVAILABLE',      NULL,                          '2026-10-20 18:00+09')   -- 퇴근 시 자동 해제
) AS v(emp_no, status, message, expires_at)
JOIN employees e ON e.emp_no = v.emp_no;

-- ② 예약 ---------------------------------------------------------------------

-- 재무팀 주간회의: 매주 화 15:00–16:00, 회차마다 예약 행
INSERT INTO reservation_series (room_id, organizer_id, title, repeat_rule, start_time, end_time, first_date, last_date)
VALUES ((SELECT id FROM meeting_rooms WHERE name = '소회의실 702'), (SELECT id FROM employees WHERE emp_no = '20190005'),
        '재무팀 주간회의', 'WEEKLY', '15:00', '16:00', '2026-10-20', '2026-11-03');

INSERT INTO reservations (room_id, organizer_id, series_id, title, starts_at, ends_at)
SELECT s.room_id, s.organizer_id, s.id, s.title,
       (d + s.start_time) AT TIME ZONE 'Asia/Seoul', (d + s.end_time) AT TIME ZONE 'Asia/Seoul'
FROM reservation_series s,
     generate_series(s.first_date, s.last_date, interval '7 days') AS d
WHERE s.title = '재무팀 주간회의';

INSERT INTO reservations (room_id, organizer_id, title, starts_at, ends_at, status, checked_in_at)
VALUES ((SELECT id FROM meeting_rooms WHERE name = '대회의실 701'), (SELECT id FROM employees WHERE emp_no = '20150004'),
        '분기 결산 보고', '2026-10-20 13:00+09', '2026-10-20 14:30+09', 'CONFIRMED', '2026-10-20 13:04+09');

-- 승인제 회의실은 승인 대기로 시작
INSERT INTO reservations (room_id, organizer_id, title, starts_at, ends_at, status)
VALUES ((SELECT id FROM meeting_rooms WHERE name = '임원 회의실 1001'), (SELECT id FROM employees WHERE emp_no = '20090001'),
        '이사회 준비', '2026-10-21 14:00+09', '2026-10-21 16:00+09', 'PENDING_APPROVAL');

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

INSERT INTO notifications (recipient_id, channel, type, payload, status, created_at)
SELECT a.employee_id, 'IN_APP', 'RESERVATION_INVITE',
       jsonb_build_object('reservation_id', r.id, 'title', r.title, 'starts_at', r.starts_at),
       'PENDING', '2026-10-20 09:00+09'
FROM reservations r
JOIN reservation_attendees a ON a.reservation_id = r.id
WHERE r.title = '재무팀 주간회의' AND r.starts_at = '2026-10-20 15:00+09';

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
VALUES ((SELECT id FROM employees WHERE emp_no = '20170008'), '2026-10-20 13:45+09');

INSERT INTO ai_messages (conversation_id, role, content, tool_name, tool_args, cited_task_ids, created_at)
SELECT c.id, v.role, v.content, v.tool_name, v.tool_args::jsonb,
       CASE WHEN v.role = 'ASSISTANT' THEN ARRAY[(SELECT id FROM duty_tasks WHERE name = '법인카드 정산')] END,
       v.at::timestamptz
FROM (VALUES
    ('USER',      '법인카드 사용 내역 정산은 누구한테 물어봐야 해?', NULL,         NULL,                           '2026-10-20 13:45:00+09'),
    ('TOOL',      '{"task": "법인카드 정산", "primary": "조시우", "seat": "7F B-01"}', 'find_owner', '{"query": "법인카드 정산"}', '2026-10-20 13:45:01+09'),
    ('ASSISTANT', '법인카드 정산은 재무팀 조시우 님 담당이에요. 지금 방문 가능 상태이고 7F B-01 자리에 있어요.', NULL, NULL, '2026-10-20 13:45:02+09')
) AS v(role, content, tool_name, tool_args, at)
CROSS JOIN ai_conversations c;

-- 관리자 작업 이력 ------------------------------------------------------------

INSERT INTO audit_logs (actor_id, action, target_type, target_id, before_data, after_data, ip_address, created_at)
SELECT e.id, 'SEAT_ASSIGN', 'seat', s.id,
       '{"employee": null}', jsonb_build_object('employee', '20190005'), '10.10.7.30', '2025-03-01 09:00+09'
FROM employees e, seats s WHERE e.emp_no = '20130003' AND s.code = 'B-01';
INSERT INTO audit_logs (actor_id, action, target_type, target_id, after_data, ip_address, created_at)
SELECT e.id, 'PLAN_PUBLISH', 'floor_plan', p.id, '{"version": 1}', '10.10.1.12', '2026-09-28 11:00+09'
FROM employees e, floor_plans p JOIN floors f ON f.id = p.floor_id
WHERE e.emp_no = '20120002' AND f.name = '10F' AND p.version = 1;
