-- 03_dense_floor.sql
-- 사람이 많은 층 목업: 8F를 도면 편집기 도면(v1, 미터)으로 다시 그린다.
--   실제 크기 책상(1.6 × 0.8 m) 68석 = 디지털혁신팀 A 18 · AI플랫폼팀 B 22 · 앱개발팀 C 20 · 공용 자율석 Z 8
--   54명이 앉는다 (팀마다 끝 두 자리는 비워 둔다). 회의실 5개, 코어·화장실·탕비실·폰부스·복합기·라운지·포커스룸·
--   통신실·수유실·창고, 기둥 6개, 주 출입구·비상구
-- 이 파일은 server/scripts/gen_dense_floor.py가 만든다. 도면을 고치려면 스크립트를 고치고 다시 만든다:
--   cd server && python -m scripts.gen_dense_floor
-- 01_mock.sql 다음에 실행한다 (8F 층·디지털혁신팀은 거기서 만들고, 8F 도면·구역·좌석·회의실은 여기서 만든다)

-- 새 팀 둘 (IT본부)
INSERT INTO departments (dept_code, name, parent_id, sort_order)
SELECT v.code, v.name, p.id, v.sort_order
FROM (VALUES ('D250', 'AI플랫폼팀', 5), ('D260', '앱개발팀', 6)) AS v(code, name, sort_order)
JOIN departments p ON p.dept_code = 'D200';

-- 새 팀 직원 (사번 22000001~). AI플랫폼팀 20명, 앱개발팀 18명
WITH gen AS (
    SELECT t.code, row_number() OVER (ORDER BY t.code, i) AS k
    FROM (VALUES ('D250', 20), ('D260', 18)) AS t(code, n), generate_series(1, t.n) AS i
)
INSERT INTO employees (emp_no, name, department_id, rank_name, email, extension, hired_on)
SELECT (22000000 + gen.k)::text,
       (ARRAY['김', '이', '박', '최', '정', '강', '조', '윤', '장',
              '임', '한', '오', '서', '신', '권', '황', '안', '송'])[1 + (gen.k * 5) % 18] ||
       (ARRAY['민서', '태윤', '서진', '하준', '유진', '도현', '지안', '시윤', '로아', '이준',
              '나은', '승우', '다인', '재원', '서윤', '규민', '하율', '지환', '아린', '정우'])[1 + (gen.k * 13) % 20],
       d.id,
       (ARRAY['사원', '사원', '대리', '대리', '과장', '차장', '부장'])[1 + gen.k % 7],
       'dev' || gen.k || '@officemap.site',
       (6000 + gen.k)::text,
       date '2016-03-02' + (gen.k * 41 % 3500)::int
FROM gen
JOIN departments d ON d.dept_code = gen.code;

INSERT INTO user_accounts (employee_id, password_hash, must_change_password, password_changed_at)
SELECT id, '$2b$12$YQWCooIW9V1YrWJ5vD7EDujBSKuP2HW49Z852NdLGSIWLnTG5B7b2', false, timestamptz '2026-09-01 09:00+09'
FROM employees WHERE emp_no LIKE '22%';  -- officemap1234

INSERT INTO presence_status (employee_id, status, message, updated_at)
SELECT e.id,
       (ARRAY['AVAILABLE', 'AVAILABLE', 'AVAILABLE', 'DO_NOT_DISTURB',
              'AVAILABLE', 'IN_MEETING', 'AWAY'])[1 + e.id % 7],
       (ARRAY[NULL, NULL, NULL, '집중 업무 중', NULL, '회의 중', '외근'])[1 + e.id % 7],
       least(now(), pg_temp.kst(0, '09:00'))
FROM employees e
WHERE e.emp_no LIKE '22%' AND e.id % 8 <> 0;

-- 도면 게시본 (v1)
INSERT INTO floor_plans (floor_id, version, status, width_m, height_m, geometry,
                         created_by, created_at, updated_by, updated_at, published_by, published_at)
SELECT f.id, 1, 'PUBLISHED', 50.0, 30.0, '{"schema":1,"grid_m":0.5,"desk":{"w":1.6,"h":0.8},"elements":[{"id":"wall-1","type":"wall","x":1,"y":1,"w":48,"h":28},{"id":"space-core","type":"space","kind":"core","label":"코어 · EV · 계단","x":20,"y":1,"w":8,"h":6},{"id":"space-wc","type":"space","kind":"restroom","label":"화장실","x":28,"y":1,"w":6,"h":6},{"id":"space-pantry","type":"space","kind":"pantry","label":"탕비실","x":34,"y":1,"w":5,"h":6},{"id":"space-booth1","type":"space","kind":"storage","label":"폰부스","x":39,"y":1,"w":2.5,"h":6},{"id":"space-booth2","type":"space","kind":"storage","label":"폰부스","x":41.5,"y":1,"w":2.5,"h":6},{"id":"space-print","type":"space","kind":"service","label":"복합기 · 사물함","x":44,"y":1,"w":5,"h":6},{"id":"space-lounge","type":"space","kind":"lounge","label":"휴게 라운지","x":37,"y":9.5,"w":11.5,"h":8},{"id":"space-focus","type":"space","kind":"storage","label":"포커스룸","x":37,"y":18.5,"w":5.5,"h":4},{"id":"space-tel","type":"space","kind":"restricted","label":"통신실 (출입 제한)","x":43,"y":18.5,"w":5.5,"h":4},{"id":"space-open","type":"space","kind":"lounge","label":"오픈 라운지","x":26,"y":20,"w":9,"h":8.5},{"id":"space-nursing","type":"space","kind":"lounge","label":"수유실","x":2.5,"y":23.5,"w":4.5,"h":5},{"id":"space-store","type":"space","kind":"storage","label":"창고","x":7.5,"y":23.5,"w":4.5,"h":5},{"id":"room-801","type":"room","name":"회의실 801","capacity":10,"equipment":["VIDEO"],"x":1,"y":1,"w":8,"h":6},{"id":"room-802","type":"room","name":"회의실 802","capacity":6,"equipment":["TV"],"x":9,"y":1,"w":6,"h":6},{"id":"room-803","type":"room","name":"회의실 803","capacity":4,"equipment":["TV"],"x":15,"y":1,"w":5,"h":6},{"id":"room-804","type":"room","name":"프로젝트룸 804","capacity":12,"equipment":["VIDEO","TV"],"x":13.5,"y":20,"w":10,"h":8.5},{"id":"room-805","type":"room","name":"교육장 805","capacity":20,"equipment":["PROJECTOR"],"x":37,"y":23,"w":11.5,"h":5.5},{"id":"door-main","type":"entrance","label":"","main":true,"x":22.5,"y":6.7,"w":3,"h":0.6},{"id":"door-exit","type":"entrance","label":"비상구","main":false,"x":48.7,"y":25,"w":0.6,"h":2.5},{"id":"pillar-1","type":"pillar","x":11.4,"y":13.15,"w":0.8,"h":0.8},{"id":"pillar-2","type":"pillar","x":11.4,"y":22.400000000000002,"w":0.8,"h":0.8},{"id":"pillar-3","type":"pillar","x":23.950000000000003,"y":13.15,"w":0.8,"h":0.8},{"id":"pillar-4","type":"pillar","x":23.950000000000003,"y":22.400000000000002,"w":0.8,"h":0.8},{"id":"pillar-5","type":"pillar","x":35.2,"y":13.15,"w":0.8,"h":0.8},{"id":"pillar-6","type":"pillar","x":35.2,"y":22.400000000000002,"w":0.8,"h":0.8},{"id":"desks-a1","type":"desk_group","layout":"face","rows":2,"cols":5,"x":2.5,"y":10.5,"desk_w":1.6,"desk_h":0.8,"cells":[{"id":"desks-a1-c1","desk":true,"code":"A-01"},{"id":"desks-a1-c2","desk":true,"code":"A-02"},{"id":"desks-a1-c3","desk":true,"code":"A-03"},{"id":"desks-a1-c4","desk":true,"code":"A-04"},{"id":"desks-a1-c5","desk":true,"code":"A-05"},{"id":"desks-a1-c6","desk":true,"code":"A-06"},{"id":"desks-a1-c7","desk":true,"code":"A-07"},{"id":"desks-a1-c8","desk":true,"code":"A-08"},{"id":"desks-a1-c9","desk":true,"code":"A-09"},{"id":"desks-a1-c10","desk":true,"code":"A-10"}]},{"id":"desks-a2","type":"desk_group","layout":"face","rows":2,"cols":4,"x":2.5,"y":15.0,"desk_w":1.6,"desk_h":0.8,"cells":[{"id":"desks-a2-c1","desk":true,"code":"A-11"},{"id":"desks-a2-c2","desk":true,"code":"A-12"},{"id":"desks-a2-c3","desk":true,"code":"A-13"},{"id":"desks-a2-c4","desk":true,"code":"A-14"},{"id":"desks-a2-c5","desk":true,"code":"A-15"},{"id":"desks-a2-c6","desk":true,"code":"A-16"},{"id":"desks-a2-c7","desk":true,"code":"A-17"},{"id":"desks-a2-c8","desk":true,"code":"A-18"}]},{"id":"desks-b1","type":"desk_group","layout":"face","rows":2,"cols":6,"x":13.5,"y":10.5,"desk_w":1.6,"desk_h":0.8,"cells":[{"id":"desks-b1-c1","desk":true,"code":"B-01"},{"id":"desks-b1-c2","desk":true,"code":"B-02"},{"id":"desks-b1-c3","desk":true,"code":"B-03"},{"id":"desks-b1-c4","desk":true,"code":"B-04"},{"id":"desks-b1-c5","desk":true,"code":"B-05"},{"id":"desks-b1-c6","desk":true,"code":"B-06"},{"id":"desks-b1-c7","desk":true,"code":"B-07"},{"id":"desks-b1-c8","desk":true,"code":"B-08"},{"id":"desks-b1-c9","desk":true,"code":"B-09"},{"id":"desks-b1-c10","desk":true,"code":"B-10"},{"id":"desks-b1-c11","desk":true,"code":"B-11"},{"id":"desks-b1-c12","desk":true,"code":"B-12"}]},{"id":"desks-b2","type":"desk_group","layout":"face","rows":2,"cols":5,"x":13.5,"y":15.0,"desk_w":1.6,"desk_h":0.8,"cells":[{"id":"desks-b2-c1","desk":true,"code":"B-13"},{"id":"desks-b2-c2","desk":true,"code":"B-14"},{"id":"desks-b2-c3","desk":true,"code":"B-15"},{"id":"desks-b2-c4","desk":true,"code":"B-16"},{"id":"desks-b2-c5","desk":true,"code":"B-17"},{"id":"desks-b2-c6","desk":true,"code":"B-18"},{"id":"desks-b2-c7","desk":true,"code":"B-19"},{"id":"desks-b2-c8","desk":true,"code":"B-20"},{"id":"desks-b2-c9","desk":true,"code":"B-21"},{"id":"desks-b2-c10","desk":true,"code":"B-22"}]},{"id":"desks-c1","type":"desk_group","layout":"face","rows":2,"cols":5,"x":26.0,"y":10.5,"desk_w":1.6,"desk_h":0.8,"cells":[{"id":"desks-c1-c1","desk":true,"code":"C-01"},{"id":"desks-c1-c2","desk":true,"code":"C-02"},{"id":"desks-c1-c3","desk":true,"code":"C-03"},{"id":"desks-c1-c4","desk":true,"code":"C-04"},{"id":"desks-c1-c5","desk":true,"code":"C-05"},{"id":"desks-c1-c6","desk":true,"code":"C-06"},{"id":"desks-c1-c7","desk":true,"code":"C-07"},{"id":"desks-c1-c8","desk":true,"code":"C-08"},{"id":"desks-c1-c9","desk":true,"code":"C-09"},{"id":"desks-c1-c10","desk":true,"code":"C-10"}]},{"id":"desks-c2","type":"desk_group","layout":"face","rows":2,"cols":5,"x":26.0,"y":15.0,"desk_w":1.6,"desk_h":0.8,"cells":[{"id":"desks-c2-c1","desk":true,"code":"C-11"},{"id":"desks-c2-c2","desk":true,"code":"C-12"},{"id":"desks-c2-c3","desk":true,"code":"C-13"},{"id":"desks-c2-c4","desk":true,"code":"C-14"},{"id":"desks-c2-c5","desk":true,"code":"C-15"},{"id":"desks-c2-c6","desk":true,"code":"C-16"},{"id":"desks-c2-c7","desk":true,"code":"C-17"},{"id":"desks-c2-c8","desk":true,"code":"C-18"},{"id":"desks-c2-c9","desk":true,"code":"C-19"},{"id":"desks-c2-c10","desk":true,"code":"C-20"}]},{"id":"desks-z1","type":"desk_group","layout":"face","rows":2,"cols":4,"x":2.5,"y":20.0,"desk_w":1.6,"desk_h":0.8,"cells":[{"id":"desks-z1-c1","desk":true,"code":"Z-01"},{"id":"desks-z1-c2","desk":true,"code":"Z-02"},{"id":"desks-z1-c3","desk":true,"code":"Z-03"},{"id":"desks-z1-c4","desk":true,"code":"Z-04"},{"id":"desks-z1-c5","desk":true,"code":"Z-05"},{"id":"desks-z1-c6","desk":true,"code":"Z-06"},{"id":"desks-z1-c7","desk":true,"code":"Z-07"},{"id":"desks-z1-c8","desk":true,"code":"Z-08"}]}]}'::jsonb,
       e.id, published, e.id, published, e.id, published
FROM floors f
CROSS JOIN LATERAL (SELECT timestamptz '2026-09-01 17:00+09' + f.sort_order * interval '2 days' AS published) p
JOIN employees e ON e.emp_no = '20120002'
WHERE f.name = '8F';

-- 팀 구역 (모양은 좌석을 넣으면 저절로 계산된다)
INSERT INTO zones (floor_id, code, name, department_id, color_key, sort_order)
SELECT f.id, v.code, v.name, d.id, v.color_key, v.sort_order
FROM (VALUES
    ('A', '디지털혁신팀', 'D230', 't1', 1),
    ('B', 'AI플랫폼팀', 'D250', 't3', 2),
    ('C', '앱개발팀', 'D260', 't4', 3),
    ('Z', '공용 자율석', NULL, 't0', 4)
) AS v(code, name, dept_code, color_key, sort_order)
JOIN floors f ON f.name = '8F'
LEFT JOIN departments d ON d.dept_code = v.dept_code;

-- 좌석: 도면의 책상 칸 하나가 좌석 하나 (plan_element_key = 칸 id)
INSERT INTO seats (floor_id, zone_id, code, seat_type, x, y, rotation, w, h, plan_element_key)
SELECT f.id, z.id, v.code, v.seat_type, v.x, v.y, v.rotation, v.w, v.h, v.key
FROM (VALUES
    ('A-01', 'A', 'FIXED', 0.066000, 0.363333, 180, 0.032000, 0.026667, 'desks-a1-c1'),
    ('A-02', 'A', 'FIXED', 0.099700, 0.363333, 180, 0.032000, 0.026667, 'desks-a1-c2'),
    ('A-03', 'A', 'FIXED', 0.133400, 0.363333, 180, 0.032000, 0.026667, 'desks-a1-c3'),
    ('A-04', 'A', 'FIXED', 0.167100, 0.363333, 180, 0.032000, 0.026667, 'desks-a1-c4'),
    ('A-05', 'A', 'FIXED', 0.200800, 0.363333, 180, 0.032000, 0.026667, 'desks-a1-c5'),
    ('A-06', 'A', 'FIXED', 0.066000, 0.390000, 0, 0.032000, 0.026667, 'desks-a1-c6'),
    ('A-07', 'A', 'FIXED', 0.099700, 0.390000, 0, 0.032000, 0.026667, 'desks-a1-c7'),
    ('A-08', 'A', 'FIXED', 0.133400, 0.390000, 0, 0.032000, 0.026667, 'desks-a1-c8'),
    ('A-09', 'A', 'FIXED', 0.167100, 0.390000, 0, 0.032000, 0.026667, 'desks-a1-c9'),
    ('A-10', 'A', 'FIXED', 0.200800, 0.390000, 0, 0.032000, 0.026667, 'desks-a1-c10'),
    ('A-11', 'A', 'FIXED', 0.066000, 0.513333, 180, 0.032000, 0.026667, 'desks-a2-c1'),
    ('A-12', 'A', 'FIXED', 0.099700, 0.513333, 180, 0.032000, 0.026667, 'desks-a2-c2'),
    ('A-13', 'A', 'FIXED', 0.133400, 0.513333, 180, 0.032000, 0.026667, 'desks-a2-c3'),
    ('A-14', 'A', 'FIXED', 0.167100, 0.513333, 180, 0.032000, 0.026667, 'desks-a2-c4'),
    ('A-15', 'A', 'FIXED', 0.066000, 0.540000, 0, 0.032000, 0.026667, 'desks-a2-c5'),
    ('A-16', 'A', 'FIXED', 0.099700, 0.540000, 0, 0.032000, 0.026667, 'desks-a2-c6'),
    ('A-17', 'A', 'FIXED', 0.133400, 0.540000, 0, 0.032000, 0.026667, 'desks-a2-c7'),
    ('A-18', 'A', 'FIXED', 0.167100, 0.540000, 0, 0.032000, 0.026667, 'desks-a2-c8'),
    ('B-01', 'B', 'FIXED', 0.286000, 0.363333, 180, 0.032000, 0.026667, 'desks-b1-c1'),
    ('B-02', 'B', 'FIXED', 0.319700, 0.363333, 180, 0.032000, 0.026667, 'desks-b1-c2'),
    ('B-03', 'B', 'FIXED', 0.353400, 0.363333, 180, 0.032000, 0.026667, 'desks-b1-c3'),
    ('B-04', 'B', 'FIXED', 0.387100, 0.363333, 180, 0.032000, 0.026667, 'desks-b1-c4'),
    ('B-05', 'B', 'FIXED', 0.420800, 0.363333, 180, 0.032000, 0.026667, 'desks-b1-c5'),
    ('B-06', 'B', 'FIXED', 0.454500, 0.363333, 180, 0.032000, 0.026667, 'desks-b1-c6'),
    ('B-07', 'B', 'FIXED', 0.286000, 0.390000, 0, 0.032000, 0.026667, 'desks-b1-c7'),
    ('B-08', 'B', 'FIXED', 0.319700, 0.390000, 0, 0.032000, 0.026667, 'desks-b1-c8'),
    ('B-09', 'B', 'FIXED', 0.353400, 0.390000, 0, 0.032000, 0.026667, 'desks-b1-c9'),
    ('B-10', 'B', 'FIXED', 0.387100, 0.390000, 0, 0.032000, 0.026667, 'desks-b1-c10'),
    ('B-11', 'B', 'FIXED', 0.420800, 0.390000, 0, 0.032000, 0.026667, 'desks-b1-c11'),
    ('B-12', 'B', 'FIXED', 0.454500, 0.390000, 0, 0.032000, 0.026667, 'desks-b1-c12'),
    ('B-13', 'B', 'FIXED', 0.286000, 0.513333, 180, 0.032000, 0.026667, 'desks-b2-c1'),
    ('B-14', 'B', 'FIXED', 0.319700, 0.513333, 180, 0.032000, 0.026667, 'desks-b2-c2'),
    ('B-15', 'B', 'FIXED', 0.353400, 0.513333, 180, 0.032000, 0.026667, 'desks-b2-c3'),
    ('B-16', 'B', 'FIXED', 0.387100, 0.513333, 180, 0.032000, 0.026667, 'desks-b2-c4'),
    ('B-17', 'B', 'FIXED', 0.420800, 0.513333, 180, 0.032000, 0.026667, 'desks-b2-c5'),
    ('B-18', 'B', 'FIXED', 0.286000, 0.540000, 0, 0.032000, 0.026667, 'desks-b2-c6'),
    ('B-19', 'B', 'FIXED', 0.319700, 0.540000, 0, 0.032000, 0.026667, 'desks-b2-c7'),
    ('B-20', 'B', 'FIXED', 0.353400, 0.540000, 0, 0.032000, 0.026667, 'desks-b2-c8'),
    ('B-21', 'B', 'FIXED', 0.387100, 0.540000, 0, 0.032000, 0.026667, 'desks-b2-c9'),
    ('B-22', 'B', 'FIXED', 0.420800, 0.540000, 0, 0.032000, 0.026667, 'desks-b2-c10'),
    ('C-01', 'C', 'FIXED', 0.536000, 0.363333, 180, 0.032000, 0.026667, 'desks-c1-c1'),
    ('C-02', 'C', 'FIXED', 0.569700, 0.363333, 180, 0.032000, 0.026667, 'desks-c1-c2'),
    ('C-03', 'C', 'FIXED', 0.603400, 0.363333, 180, 0.032000, 0.026667, 'desks-c1-c3'),
    ('C-04', 'C', 'FIXED', 0.637100, 0.363333, 180, 0.032000, 0.026667, 'desks-c1-c4'),
    ('C-05', 'C', 'FIXED', 0.670800, 0.363333, 180, 0.032000, 0.026667, 'desks-c1-c5'),
    ('C-06', 'C', 'FIXED', 0.536000, 0.390000, 0, 0.032000, 0.026667, 'desks-c1-c6'),
    ('C-07', 'C', 'FIXED', 0.569700, 0.390000, 0, 0.032000, 0.026667, 'desks-c1-c7'),
    ('C-08', 'C', 'FIXED', 0.603400, 0.390000, 0, 0.032000, 0.026667, 'desks-c1-c8'),
    ('C-09', 'C', 'FIXED', 0.637100, 0.390000, 0, 0.032000, 0.026667, 'desks-c1-c9'),
    ('C-10', 'C', 'FIXED', 0.670800, 0.390000, 0, 0.032000, 0.026667, 'desks-c1-c10'),
    ('C-11', 'C', 'FIXED', 0.536000, 0.513333, 180, 0.032000, 0.026667, 'desks-c2-c1'),
    ('C-12', 'C', 'FIXED', 0.569700, 0.513333, 180, 0.032000, 0.026667, 'desks-c2-c2'),
    ('C-13', 'C', 'FIXED', 0.603400, 0.513333, 180, 0.032000, 0.026667, 'desks-c2-c3'),
    ('C-14', 'C', 'FIXED', 0.637100, 0.513333, 180, 0.032000, 0.026667, 'desks-c2-c4'),
    ('C-15', 'C', 'FIXED', 0.670800, 0.513333, 180, 0.032000, 0.026667, 'desks-c2-c5'),
    ('C-16', 'C', 'FIXED', 0.536000, 0.540000, 0, 0.032000, 0.026667, 'desks-c2-c6'),
    ('C-17', 'C', 'FIXED', 0.569700, 0.540000, 0, 0.032000, 0.026667, 'desks-c2-c7'),
    ('C-18', 'C', 'FIXED', 0.603400, 0.540000, 0, 0.032000, 0.026667, 'desks-c2-c8'),
    ('C-19', 'C', 'FIXED', 0.637100, 0.540000, 0, 0.032000, 0.026667, 'desks-c2-c9'),
    ('C-20', 'C', 'FIXED', 0.670800, 0.540000, 0, 0.032000, 0.026667, 'desks-c2-c10'),
    ('Z-01', 'Z', 'FLEX', 0.066000, 0.680000, 180, 0.032000, 0.026667, 'desks-z1-c1'),
    ('Z-02', 'Z', 'FLEX', 0.099700, 0.680000, 180, 0.032000, 0.026667, 'desks-z1-c2'),
    ('Z-03', 'Z', 'FLEX', 0.133400, 0.680000, 180, 0.032000, 0.026667, 'desks-z1-c3'),
    ('Z-04', 'Z', 'FLEX', 0.167100, 0.680000, 180, 0.032000, 0.026667, 'desks-z1-c4'),
    ('Z-05', 'Z', 'FLEX', 0.066000, 0.706667, 0, 0.032000, 0.026667, 'desks-z1-c5'),
    ('Z-06', 'Z', 'FLEX', 0.099700, 0.706667, 0, 0.032000, 0.026667, 'desks-z1-c6'),
    ('Z-07', 'Z', 'FLEX', 0.133400, 0.706667, 0, 0.032000, 0.026667, 'desks-z1-c7'),
    ('Z-08', 'Z', 'FLEX', 0.167100, 0.706667, 0, 0.032000, 0.026667, 'desks-z1-c8')
) AS v(code, zone_code, seat_type, x, y, rotation, w, h, key)
JOIN floors f ON f.name = '8F'
JOIN zones z ON z.floor_id = f.id AND z.code = v.zone_code;

-- 회의실 (plan_element_key = 도면의 회의실 공간 id)
INSERT INTO meeting_rooms (floor_id, name, capacity, equipment, shape, plan_element_key, sort_order)
SELECT f.id, v.name, v.capacity, v.equipment::text[], v.shape::jsonb, v.key, v.sort_order
FROM (VALUES
    ('회의실 801', 10, '{VIDEO}', '{"type": "rect", "x": 0.02, "y": 0.0333, "w": 0.16, "h": 0.2}', 'room-801', 1),
    ('회의실 802', 6, '{TV}', '{"type": "rect", "x": 0.18, "y": 0.0333, "w": 0.12, "h": 0.2}', 'room-802', 2),
    ('회의실 803', 4, '{TV}', '{"type": "rect", "x": 0.3, "y": 0.0333, "w": 0.1, "h": 0.2}', 'room-803', 3),
    ('프로젝트룸 804', 12, '{VIDEO,TV}', '{"type": "rect", "x": 0.27, "y": 0.6667, "w": 0.2, "h": 0.2833}', 'room-804', 4),
    ('교육장 805', 20, '{PROJECTOR}', '{"type": "rect", "x": 0.74, "y": 0.7667, "w": 0.23, "h": 0.1833}', 'room-805', 5)
) AS v(name, capacity, equipment, shape, key, sort_order)
JOIN floors f ON f.name = '8F';

-- 앉히기: 팀마다 좌석 번호 순서대로, 구역 끝의 두 자리는 비워 둔다
WITH zone_seat AS (
    SELECT s.id AS seat_id, z.department_id,
           row_number() OVER (PARTITION BY z.id ORDER BY s.code) AS pos,
           count(*) OVER (PARTITION BY z.id) AS total
    FROM seats s
    JOIN zones z ON z.id = s.zone_id
    JOIN floors f ON f.id = s.floor_id AND f.name = '8F'
    WHERE z.department_id IS NOT NULL
), free_employee AS (
    SELECT e.id AS employee_id, e.department_id,
           row_number() OVER (PARTITION BY e.department_id ORDER BY e.emp_no) AS rn
    FROM employees e
    JOIN departments d ON d.id = e.department_id AND d.dept_code IN ('D230', 'D250', 'D260')
    WHERE NOT EXISTS (SELECT 1 FROM seat_assignments a
                      WHERE a.employee_id = e.id AND a.kind = 'FIXED' AND a.ends_at IS NULL)
)
INSERT INTO seat_assignments (seat_id, employee_id, kind, starts_at, assigned_by)
SELECT zs.seat_id, fe.employee_id, 'FIXED', '2025-03-01 09:00+09', (SELECT id FROM employees WHERE emp_no = '20120002')
FROM zone_seat zs
JOIN free_employee fe ON fe.department_id = zs.department_id AND fe.rn = zs.pos
WHERE zs.pos <= zs.total - 2;

-- 오늘 8F 회의실 예약
INSERT INTO reservations (room_id, organizer_id, title, starts_at, ends_at, checked_in_at)
SELECT m.id, e.id, v.title, pg_temp.kst(0, v.starts), pg_temp.kst(0, v.ends),
       CASE WHEN v.checked_in THEN pg_temp.kst(0, v.starts) + interval '3 minutes' END
FROM (VALUES
    ('회의실 801',     '22000001', 'AI 모델 배포 리뷰', time '10:00', time '11:30', true),
    ('프로젝트룸 804', '22000021', '앱 개편 스프린트',  time '09:00', time '18:00', true),
    ('교육장 805',     '22000003', '사내 AI 교육',      time '14:00', time '16:00', false)
) AS v(room, organizer, title, starts, ends, checked_in)
JOIN floors f ON f.name = '8F'
JOIN meeting_rooms m ON m.floor_id = f.id AND m.name = v.room
JOIN employees e ON e.emp_no = v.organizer;

INSERT INTO reservation_attendees (reservation_id, employee_id)
SELECT r.id, r.organizer_id
FROM reservations r JOIN meeting_rooms m ON m.id = r.room_id JOIN floors f ON f.id = m.floor_id AND f.name = '8F';
