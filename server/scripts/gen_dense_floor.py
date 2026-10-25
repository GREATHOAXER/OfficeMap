"""목업 8F(사람이 많은 층)의 도면·좌석 SQL을 만든다 → db/seed/03_dense_floor.sql

server 디렉토리에서 실행:
    python -m scripts.gen_dense_floor

8F는 도면 편집기로 그린 것과 같은 미터 단위 도면(v1)이다. 실제 크기 책상(1.6 × 0.8 m) 68석에
디지털혁신팀·AI플랫폼팀·앱개발팀 54명이 앉고, 회의실 5개와 부대시설이 있다.
좌석 위치·크기는 게시할 때와 같은 계산(app.plan_geometry)으로 만든다.
도면을 고치려면 아래 ELEMENTS를 고치고 다시 실행한다.
"""

import json
from pathlib import Path
from typing import Any

from app import plan_geometry as geo

OUT = Path(__file__).resolve().parents[2] / "db" / "seed" / "03_dense_floor.sql"
WIDTH, HEIGHT = 50.0, 30.0
DESK = {"w": 1.6, "h": 0.8}

# 책상 묶음: (구역 코드, 묶음 id, 줄, 칸, x, y). 칸은 구역 안에서 차례로 A-01, A-02 …
GROUPS = [
    ("A", "desks-a1", 2, 5, 2.5, 10.5),
    ("A", "desks-a2", 2, 4, 2.5, 15.0),
    ("B", "desks-b1", 2, 6, 13.5, 10.5),
    ("B", "desks-b2", 2, 5, 13.5, 15.0),
    ("C", "desks-c1", 2, 5, 26.0, 10.5),
    ("C", "desks-c2", 2, 5, 26.0, 15.0),
    ("Z", "desks-z1", 2, 4, 2.5, 20.0),
]

ZONES = [
    # 코드, 이름, 부서 코드, 색, 순서
    ("A", "디지털혁신팀", "D230", "t1", 1),
    ("B", "AI플랫폼팀", "D250", "t3", 2),
    ("C", "앱개발팀", "D260", "t4", 3),
    ("Z", "공용 자율석", None, "t0", 4),
]

# 회의실: id, 이름, 정원, 장비, x, y, w, h
ROOMS = [
    ("room-801", "회의실 801", 10, ["VIDEO"], 1, 1, 8, 6),
    ("room-802", "회의실 802", 6, ["TV"], 9, 1, 6, 6),
    ("room-803", "회의실 803", 4, ["TV"], 15, 1, 5, 6),
    ("room-804", "프로젝트룸 804", 12, ["VIDEO", "TV"], 13.5, 20, 10, 8.5),
    ("room-805", "교육장 805", 20, ["PROJECTOR"], 37, 23, 11.5, 5.5),
]

# 공용 공간: id, 종류, 이름, x, y, w, h
SPACES = [
    ("space-core", "core", "코어 · EV · 계단", 20, 1, 8, 6),
    ("space-wc", "restroom", "화장실", 28, 1, 6, 6),
    ("space-pantry", "pantry", "탕비실", 34, 1, 5, 6),
    ("space-booth1", "storage", "폰부스", 39, 1, 2.5, 6),
    ("space-booth2", "storage", "폰부스", 41.5, 1, 2.5, 6),
    ("space-print", "service", "복합기 · 사물함", 44, 1, 5, 6),
    ("space-lounge", "lounge", "휴게 라운지", 37, 9.5, 11.5, 8),
    ("space-focus", "storage", "포커스룸", 37, 18.5, 5.5, 4),
    ("space-tel", "restricted", "통신실 (출입 제한)", 43, 18.5, 5.5, 4),
    ("space-open", "lounge", "오픈 라운지", 26, 20, 9, 8.5),
    ("space-nursing", "lounge", "수유실", 2.5, 23.5, 4.5, 5),
    ("space-store", "storage", "창고", 7.5, 23.5, 4.5, 5),
]

# 출입구: id, 이름표, 주 출입구, x, y, w, h
ENTRANCES = [
    ("door-main", "", True, 22.5, 6.7, 3, 0.6),
    ("door-exit", "비상구", False, 48.7, 25, 0.6, 2.5),
]

PILLARS = [(x, y) for x in (11.8, 24.35, 35.6) for y in (13.55, 22.8)]


SQL = """-- 03_dense_floor.sql
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
       'dev' || gen.k || '@example.com',
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
SELECT f.id, 1, 'PUBLISHED', {width}, {height}, {geometry}::jsonb,
       e.id, published, e.id, published, e.id, published
FROM floors f
CROSS JOIN LATERAL (SELECT timestamptz '2026-09-01 17:00+09' + f.sort_order * interval '2 days' AS published) p
JOIN employees e ON e.emp_no = '20120002'
WHERE f.name = '8F';

-- 팀 구역 (모양은 좌석을 넣으면 저절로 계산된다)
INSERT INTO zones (floor_id, code, name, department_id, color_key, sort_order)
SELECT f.id, v.code, v.name, d.id, v.color_key, v.sort_order
FROM (VALUES
{zones}
) AS v(code, name, dept_code, color_key, sort_order)
JOIN floors f ON f.name = '8F'
LEFT JOIN departments d ON d.dept_code = v.dept_code;

-- 좌석: 도면의 책상 칸 하나가 좌석 하나 (plan_element_key = 칸 id)
INSERT INTO seats (floor_id, zone_id, code, seat_type, x, y, rotation, w, h, plan_element_key)
SELECT f.id, z.id, v.code, v.seat_type, v.x, v.y, v.rotation, v.w, v.h, v.key
FROM (VALUES
{seats}
) AS v(code, zone_code, seat_type, x, y, rotation, w, h, key)
JOIN floors f ON f.name = '8F'
JOIN zones z ON z.floor_id = f.id AND z.code = v.zone_code;

-- 회의실 (plan_element_key = 도면의 회의실 공간 id)
INSERT INTO meeting_rooms (floor_id, name, capacity, equipment, shape, plan_element_key, sort_order)
SELECT f.id, v.name, v.capacity, v.equipment::text[], v.shape::jsonb, v.key, v.sort_order
FROM (VALUES
{rooms}
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
"""


def geometry() -> dict[str, Any]:
    elements: list[dict[str, Any]] = [{"id": "wall-1", "type": "wall", "x": 1, "y": 1, "w": 48, "h": 28}]
    for key, kind, label, x, y, w, h in SPACES:
        elements.append({"id": key, "type": "space", "kind": kind, "label": label, "x": x, "y": y, "w": w, "h": h})
    for key, name, capacity, equipment, x, y, w, h in ROOMS:
        elements.append(
            {
                "id": key,
                "type": "room",
                "name": name,
                "capacity": capacity,
                "equipment": equipment,
                "x": x,
                "y": y,
                "w": w,
                "h": h,
            }
        )
    for key, label, main, x, y, w, h in ENTRANCES:
        elements.append({"id": key, "type": "entrance", "label": label, "main": main, "x": x, "y": y, "w": w, "h": h})
    for i, (x, y) in enumerate(PILLARS, 1):
        elements.append({"id": f"pillar-{i}", "type": "pillar", "x": x - 0.4, "y": y - 0.4, "w": 0.8, "h": 0.8})
    count: dict[str, int] = {}
    for zone, key, rows, cols, x, y in GROUPS:
        cells = []
        for i in range(rows * cols):
            count[zone] = count.get(zone, 0) + 1
            cells.append({"id": f"{key}-c{i + 1}", "desk": True, "code": f"{zone}-{count[zone]:02d}"})
        elements.append(
            {
                "id": key,
                "type": "desk_group",
                "layout": "face",
                "rows": rows,
                "cols": cols,
                "x": x,
                "y": y,
                "desk_w": DESK["w"],
                "desk_h": DESK["h"],
                "cells": cells,
            }
        )
    return {"schema": geo.SCHEMA, "grid_m": geo.GRID_M, "desk": DESK, "elements": elements}


def overlaps(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> bool:
    e = 1e-6
    return a[0] < b[0] + b[2] - e and b[0] < a[0] + a[2] - e and a[1] < b[1] + b[3] - e and b[1] < a[1] + a[3] - e


def check(g: dict[str, Any]) -> None:
    geo.validate(g, WIDTH, HEIGHT)
    assert not geo.problems(g, WIDTH, HEIGHT), geo.problems(g, WIDTH, HEIGHT)
    # 출입구는 벽·공간 테두리에 걸쳐 그린다
    boxes = [(el["id"], geo.box_of(el)) for el in g["elements"] if el["type"] not in ("wall", "entrance")]
    for i, (ka, a) in enumerate(boxes):
        for kb, b in boxes[i + 1 :]:
            assert not overlaps(a, b), f"{ka} · {kb} 겹침"


def sql_text(v: str) -> str:
    return "'" + v.replace("'", "''") + "'"


def main() -> None:
    g = geometry()
    check(g)
    cells = geo.desk_cells(g, WIDTH, HEIGHT)
    rooms = geo.room_elements(g, WIDTH, HEIGHT)
    zone_of = {key: zone for zone, key, *_ in GROUPS}

    seat_rows = []
    for key, c in cells.items():
        zone = zone_of[key.rsplit("-c", 1)[0]]
        seat_rows.append(
            f"    ({sql_text(c['code'])}, '{zone}', '{'FLEX' if zone == 'Z' else 'FIXED'}', "
            f"{c['x']:.6f}, {c['y']:.6f}, {c['rotation']}, {c['w']:.6f}, {c['h']:.6f}, {sql_text(key)})"
        )
    room_rows = [
        f"    ({sql_text(r['name'])}, {r['capacity']}, {sql_text('{' + ','.join(r['equipment']) + '}')}, "
        f"{sql_text(json.dumps(r['shape'], ensure_ascii=False))}, {sql_text(key)}, {i})"
        for i, (key, r) in enumerate(rooms.items(), 1)
    ]
    zone_rows = [
        f"    ({sql_text(code)}, {sql_text(name)}, {sql_text(dept) if dept else 'NULL'}, '{color}', {order})"
        for code, name, dept, color, order in ZONES
    ]
    geometry_json = json.dumps(g, ensure_ascii=False, separators=(",", ":"))

    OUT.write_text(
        SQL.format(
            width=WIDTH,
            height=HEIGHT,
            geometry=sql_text(geometry_json),
            zones=",\n".join(zone_rows),
            seats=",\n".join(seat_rows),
            rooms=",\n".join(room_rows),
        ),
        encoding="utf-8",
    )
    print(f"{OUT} 를 만들었습니다: 좌석 {len(seat_rows)}석, 회의실 {len(room_rows)}개")


if __name__ == "__main__":
    main()
