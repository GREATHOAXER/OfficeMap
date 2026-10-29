-- 16_zone_plan_obstacles.sql
-- 팀 구역 모양을 층 단위로 계산한다: 이웃한 다른 팀 구역은 물론 도면 요소(벽·회의실·공용 공간·기둥·출입구)도
-- 침범하지 않고, 도면 밖으로 나가지 않게. (15_zone_shapes.sql의 첫 버전은 다른 구역만 피해서, 벽 옆·회의실 옆 좌석의
-- 여백이 벽을 넘거나 회의실 위로 올라갔다)
-- 층의 구역을 모두 같이 보고:
--   1) 같은 구역 좌석 중 가까운 것끼리 묶되, 묶은 사각형이 다른 구역 좌석이나 도면 요소에 걸리면 묶지 않는다
--      (좌석이 원래 걸쳐 있던 요소는 셈하지 않는다)
--   2) 덩어리마다 좌석을 감싸고 여백을 둔다 (가로 0.5 m, 위 1.5 m, 아래 0.9 m)
--   3) 여백이 도면 요소에 걸리면 그 요소 앞 0.1 m에서 자르고, 다른 구역 덩어리와 겹치면 두 덩어리 사이 가운데에서
--      나눈다(양쪽에 0.1 m씩 틈). 어느 경우든 자기 좌석은 끝까지 덮는다.
--      위아래로 놓였으면 위·아래 변을, 옆으로 놓였으면 옆 변을 자른다 (대각선이면 더 멀리 떨어진 쪽)
-- 화면(frontend/src/lib/zoneShape.ts planObstacles·autoZoneRects)과 같아야 한다. 배치 화면이 반영 전 모양을 같은
-- 방법으로 미리 그린다. 좌석이 바뀌면 그 층 구역을 모두 다시 계산하고(문장마다 한 번), 도면을 게시하면 다시 계산한다.
-- 15의 함수 이름을 그대로 다시 정의하면 이미 넣은 서버에서 이 파일이 "일부만 있음"으로 보여 자동으로 들어가지 않아서
-- (server/app/schema.py) 새 이름으로 만들고 옛 것은 지운다.
-- 이미 돌고 있는 서버에는: python -m scripts.init_db --upgrade (자동 배포는 알아서 한다). 넣으면서 모든 층을 다시 계산한다

-- 03_space.sql(구역마다 계산)과 15_zone_shapes.sql(첫 층 단위 계산)의 것
DROP TRIGGER IF EXISTS seats_zone_shape ON seats;
DROP TRIGGER IF EXISTS seats_zone_shapes_insert ON seats;
DROP TRIGGER IF EXISTS seats_zone_shapes_update ON seats;
DROP TRIGGER IF EXISTS seats_zone_shapes_delete ON seats;
DROP FUNCTION IF EXISTS refresh_zone_shapes();
DROP FUNCTION IF EXISTS zone_auto_shape(bigint);
DROP FUNCTION IF EXISTS seats_zone_shapes_changed();
DROP FUNCTION IF EXISTS refresh_floor_zone_shapes(bigint);
DROP FUNCTION IF EXISTS zone_floor_shapes(bigint);

-- 구역이 덮으면 안 되는 도면 요소 (도면 대비 비율의 사각형). 게시본 도면(floor_plans.geometry)과 회의실(meeting_rooms)
--   벽(사각형): 네 변을 굵기만큼 (테두리는 사각형 안쪽에 그린다. 기본 0.3 m)
--   선 벽: 가로·세로 선만, 굵기만큼 양 끝도 굵기 반씩 늘려서 (기본 0.2 m). 비스듬한 선은 뺀다
--   기둥·공용 공간·출입구, 회의실
-- 도면 편집기 도면(schema 1)은 미터, 목업 도면(v0)은 비율이다 (server/app/plan_geometry.py)
CREATE OR REPLACE FUNCTION zone_plan_obstacles(p_floor bigint)
RETURNS TABLE (x0 numeric, y0 numeric, x1 numeric, y1 numeric)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    plan_w numeric;
    plan_h numeric;
    geo jsonb;
BEGIN
    SELECT p.width_m, p.height_m, p.geometry INTO plan_w, plan_h, geo
    FROM floor_plans p WHERE p.floor_id = p_floor AND p.status = 'PUBLISHED';
    plan_w := coalesce(plan_w, 50);
    plan_h := coalesce(plan_h, 30);

    RETURN QUERY
    SELECT (m.shape->>'x')::numeric, (m.shape->>'y')::numeric,
           (m.shape->>'x')::numeric + (m.shape->>'w')::numeric, (m.shape->>'y')::numeric + (m.shape->>'h')::numeric
    FROM meeting_rooms m
    WHERE m.floor_id = p_floor AND m.is_active AND m.shape IS NOT NULL;
    IF geo IS NULL THEN
        RETURN;
    END IF;

    IF geo->>'schema' = '1' THEN
        RETURN QUERY
        WITH el AS (SELECT e FROM jsonb_array_elements(geo->'elements') AS e),
        boxes AS (
            SELECT s.* FROM el
            CROSS JOIN LATERAL (
                SELECT (e->>'x')::numeric AS x, (e->>'y')::numeric AS y, (e->>'w')::numeric AS w,
                       (e->>'h')::numeric AS h, coalesce((e->>'line_w')::numeric, 0.3) AS t
            ) r
            CROSS JOIN LATERAL (VALUES
                (r.x, r.y, r.x + r.w, r.y + least(r.t, r.h)),
                (r.x, r.y + r.h - least(r.t, r.h), r.x + r.w, r.y + r.h),
                (r.x, r.y, r.x + least(r.t, r.w), r.y + r.h),
                (r.x + r.w - least(r.t, r.w), r.y, r.x + r.w, r.y + r.h)
            ) AS s(bx0, by0, bx1, by1)
            WHERE e->>'type' = 'wall'
            UNION ALL
            SELECT least(l.ax, l.bx) - l.t / 2, least(l.ay, l.by) - l.t / 2,
                   greatest(l.ax, l.bx) + l.t / 2, greatest(l.ay, l.by) + l.t / 2
            FROM el
            CROSS JOIN LATERAL (
                SELECT (e->>'x')::numeric AS ax, (e->>'y')::numeric AS ay, (e->>'x2')::numeric AS bx,
                       (e->>'y2')::numeric AS by, coalesce((e->>'line_w')::numeric, 0.2) AS t
            ) l
            WHERE e->>'type' = 'wall_line' AND (l.ax = l.bx OR l.ay = l.by)
            UNION ALL
            SELECT (e->>'x')::numeric, (e->>'y')::numeric,
                   (e->>'x')::numeric + (e->>'w')::numeric, (e->>'y')::numeric + (e->>'h')::numeric
            FROM el
            WHERE e->>'type' IN ('pillar', 'space', 'entrance')
        )
        SELECT b.bx0 / plan_w, b.by0 / plan_h, b.bx1 / plan_w, b.by1 / plan_h FROM boxes AS b;
    ELSE
        RETURN QUERY
        SELECT s.* FROM jsonb_array_elements(coalesce(geo->'walls', '[]')) AS w
        CROSS JOIN LATERAL (
            SELECT (w->>'x')::numeric AS x, (w->>'y')::numeric AS y, (w->>'w')::numeric AS ww,
                   (w->>'h')::numeric AS hh,
                   least(coalesce((w->>'line')::numeric, 0.3 / plan_w), (w->>'w')::numeric) AS tx,
                   least(coalesce((w->>'line')::numeric, 0.3 / plan_w) * plan_w / plan_h, (w->>'h')::numeric) AS ty
        ) r
        CROSS JOIN LATERAL (VALUES
            (r.x, r.y, r.x + r.ww, r.y + r.ty),
            (r.x, r.y + r.hh - r.ty, r.x + r.ww, r.y + r.hh),
            (r.x, r.y, r.x + r.tx, r.y + r.hh),
            (r.x + r.ww - r.tx, r.y, r.x + r.ww, r.y + r.hh)
        ) AS s(bx0, by0, bx1, by1);
        RETURN QUERY
        SELECT (p->>'x')::numeric - k.w / 2, (p->>'y')::numeric - k.h / 2,
               (p->>'x')::numeric + k.w / 2, (p->>'y')::numeric + k.h / 2
        FROM jsonb_array_elements(coalesce(geo->'pillars', '[]')) AS p
        CROSS JOIN LATERAL (
            SELECT coalesce((p->>'w')::numeric, 0.015) AS w, coalesce((p->>'h')::numeric, 0.025) AS h
        ) k;
        RETURN QUERY
        SELECT (s->>'x')::numeric, (s->>'y')::numeric,
               (s->>'x')::numeric + (s->>'w')::numeric, (s->>'y')::numeric + (s->>'h')::numeric
        FROM jsonb_array_elements(coalesce(geo->'spaces', '[]')) AS s;
    END IF;
END $$;

-- 층의 구역마다 모양 (좌석이 있는 살아 있는 구역만). 좌석 크기·여백은 미터로 정하고 층의 게시본 도면 크기로 나눠
-- 비율로 쓴다 (없으면 50 × 30 m). 모양: {"type":"rect",x,y,w,h} 또는 덩어리가 여럿이면 {"type":"rects","rects":[…]}
CREATE OR REPLACE FUNCTION zone_shapes_of_floor(p_floor bigint)
RETURNS TABLE (zone_id bigint, shape jsonb)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    eps constant numeric := 0.000000001;
    touch constant numeric := 0.000001;  -- m. 이보다 적게 겹치면 맞닿은 것
    plan_w numeric;
    plan_h numeric;
    seat_w numeric;
    seat_h numeric;
    pad_x  numeric;
    pad_t  numeric;
    pad_b  numeric;
    gap_x  numeric;   -- 두 구역 사이 틈 (0.2 m). 도면 요소와는 반
    gap_y  numeric;
    -- 좌석 (id 순서): 구역, 중심, 크기
    zs bigint[];
    cx numeric[];
    cy numeric[];
    sw numeric[];
    sh numeric[];
    n int;
    -- 도면 요소
    ox0 numeric[];
    oy0 numeric[];
    ox1 numeric[];
    oy1 numeric[];
    no int;
    -- 덩어리 묶기 (union-find): 대표 좌석 번호, 대표마다 감싸는 칸
    parent int[];
    bx0 numeric[];
    by0 numeric[];
    bx1 numeric[];
    by1 numeric[];
    pr record;
    a int;
    b int;
    mx0 numeric;
    my0 numeric;
    mx1 numeric;
    my1 numeric;
    blocked boolean;
    -- 덩어리 (pz 구역, c 좌석을 감싸는 칸, r 여백을 둔 칸, l 자른 뒤의 한계)
    pz bigint[] := '{}';
    c0x numeric[] := '{}';
    c0y numeric[] := '{}';
    c1x numeric[] := '{}';
    c1y numeric[] := '{}';
    r0x numeric[] := '{}';
    r0y numeric[] := '{}';
    r1x numeric[] := '{}';
    r1y numeric[] := '{}';
    l0x numeric[];
    l0y numeric[];
    l1x numeric[];
    l1y numeric[];
    m int;
    xo numeric;
    yo numeric;
    mid numeric;
    t int;
    u int;
BEGIN
    SELECT p.width_m, p.height_m INTO plan_w, plan_h
    FROM floor_plans p WHERE p.floor_id = p_floor AND p.status = 'PUBLISHED';
    plan_w := coalesce(plan_w, 50);
    plan_h := coalesce(plan_h, 30);
    seat_w := 2.665 / plan_w;
    seat_h := 1.668 / plan_h;
    pad_x := 0.5 / plan_w;
    pad_t := 1.5 / plan_h;
    pad_b := 0.9 / plan_h;
    gap_x := 0.2 / plan_w;
    gap_y := 0.2 / plan_h;

    SELECT array_agg(s.zone_id ORDER BY s.id), array_agg(s.x ORDER BY s.id), array_agg(s.y ORDER BY s.id),
           array_agg(coalesce(s.w, seat_w) ORDER BY s.id), array_agg(coalesce(s.h, seat_h) ORDER BY s.id)
    INTO zs, cx, cy, sw, sh
    FROM seats s JOIN zones z ON z.id = s.zone_id AND z.is_active
    WHERE s.floor_id = p_floor AND s.status <> 'REMOVED';
    IF zs IS NULL THEN
        RETURN;
    END IF;
    n := array_length(zs, 1);
    SELECT coalesce(array_agg(o.x0), '{}'), coalesce(array_agg(o.y0), '{}'),
           coalesce(array_agg(o.x1), '{}'), coalesce(array_agg(o.y1), '{}')
    INTO ox0, oy0, ox1, oy1
    FROM zone_plan_obstacles(p_floor) AS o;
    no := coalesce(array_length(ox0, 1), 0);
    parent := ARRAY(SELECT i FROM generate_series(1, n) AS i);
    bx0 := ARRAY(SELECT cx[i] - sw[i] / 2 FROM generate_series(1, n) AS i);
    by0 := ARRAY(SELECT cy[i] - sh[i] / 2 FROM generate_series(1, n) AS i);
    bx1 := ARRAY(SELECT cx[i] + sw[i] / 2 FROM generate_series(1, n) AS i);
    by1 := ARRAY(SELECT cy[i] + sh[i] / 2 FROM generate_series(1, n) AS i);

    -- 1) 같은 구역의 가까운 좌석 쌍을 가까운 순(틈 m, mm까지)으로 묶는다.
    --    묶은 칸이 다른 구역 좌석이나, 두 덩어리 어느 쪽에도 걸쳐 있지 않던 도면 요소에 걸리면 묶지 않는다
    FOR pr IN
        SELECT q.i, q.j
        FROM (
            SELECT i, j,
                   abs(cx[i] - cx[j]) - (sw[i] + sw[j]) / 2 AS gx,
                   abs(cy[i] - cy[j]) - (sh[i] + sh[j]) / 2 AS gy
            FROM generate_series(1, n) AS i, generate_series(1, n) AS j
            WHERE i < j AND zs[i] = zs[j]
        ) q
        WHERE q.gx <= 2.5 / plan_w AND q.gy <= 1.5 / plan_h
        ORDER BY round(greatest(q.gx, 0) * plan_w + greatest(q.gy, 0) * plan_h, 3), q.i, q.j
    LOOP
        a := pr.i;
        WHILE parent[a] <> a LOOP
            a := parent[a];
        END LOOP;
        b := pr.j;
        WHILE parent[b] <> b LOOP
            b := parent[b];
        END LOOP;
        CONTINUE WHEN a = b;
        mx0 := least(bx0[a], bx0[b]);
        my0 := least(by0[a], by0[b]);
        mx1 := greatest(bx1[a], bx1[b]);
        my1 := greatest(by1[a], by1[b]);
        blocked := false;
        FOR k IN 1..n LOOP
            IF zs[k] <> zs[pr.i]
               AND mx0 < cx[k] + sw[k] / 2 - eps AND cx[k] - sw[k] / 2 < mx1 - eps
               AND my0 < cy[k] + sh[k] / 2 - eps AND cy[k] - sh[k] / 2 < my1 - eps THEN
                blocked := true;
                EXIT;
            END IF;
        END LOOP;
        IF NOT blocked THEN
            FOR k IN 1..no LOOP
                IF mx0 < ox1[k] - eps AND ox0[k] < mx1 - eps AND my0 < oy1[k] - eps AND oy0[k] < my1 - eps
                   AND NOT (bx0[a] < ox1[k] - eps AND ox0[k] < bx1[a] - eps
                            AND by0[a] < oy1[k] - eps AND oy0[k] < by1[a] - eps)
                   AND NOT (bx0[b] < ox1[k] - eps AND ox0[k] < bx1[b] - eps
                            AND by0[b] < oy1[k] - eps AND oy0[k] < by1[b] - eps) THEN
                    blocked := true;
                    EXIT;
                END IF;
            END LOOP;
        END IF;
        CONTINUE WHEN blocked;
        parent[greatest(a, b)] := least(a, b);
        bx0[least(a, b)] := mx0;
        by0[least(a, b)] := my0;
        bx1[least(a, b)] := mx1;
        by1[least(a, b)] := my1;
    END LOOP;

    -- 2) 덩어리마다 여백
    FOR i IN 1..n LOOP
        CONTINUE WHEN parent[i] <> i;
        pz := pz || zs[i];
        c0x := c0x || bx0[i];
        c0y := c0y || by0[i];
        c1x := c1x || bx1[i];
        c1y := c1y || by1[i];
        r0x := r0x || greatest(0, bx0[i] - pad_x);
        r0y := r0y || greatest(0, by0[i] - pad_t);
        r1x := r1x || least(1, bx1[i] + pad_x);
        r1y := r1y || least(1, by1[i] + pad_b);
    END LOOP;
    m := array_length(pz, 1);
    l0x := r0x;
    l0y := r0y;
    l1x := r1x;
    l1y := r1y;

    -- 3) 도면 요소에 걸린 여백은 그 요소 앞에서 자른다 (좌석이 원래 걸쳐 있는 요소는 뺀다)
    FOR p IN 1..m LOOP
        FOR k IN 1..no LOOP
            CONTINUE WHEN NOT (r0x[p] < ox1[k] - eps AND ox0[k] < r1x[p] - eps
                               AND r0y[p] < oy1[k] - eps AND oy0[k] < r1y[p] - eps);
            xo := (least(c1x[p], ox1[k]) - greatest(c0x[p], ox0[k])) * plan_w;
            yo := (least(c1y[p], oy1[k]) - greatest(c0y[p], oy0[k])) * plan_h;
            CONTINUE WHEN xo > touch AND yo > touch;
            IF xo > yo THEN
                IF oy0[k] + oy1[k] <= c0y[p] + c1y[p] THEN
                    l0y[p] := greatest(l0y[p], oy1[k] + gap_y / 2);
                ELSE
                    l1y[p] := least(l1y[p], oy0[k] - gap_y / 2);
                END IF;
            ELSIF ox0[k] + ox1[k] <= c0x[p] + c1x[p] THEN
                l0x[p] := greatest(l0x[p], ox1[k] + gap_x / 2);
            ELSE
                l1x[p] := least(l1x[p], ox0[k] - gap_x / 2);
            END IF;
        END LOOP;
    END LOOP;

    -- 다른 구역과 겹치는 여백을 가운데에서 나눈다 (처음 여백끼리 비교해서, 순서와 상관없이 같은 결과)
    FOR p IN 1..m LOOP
        FOR q IN p + 1..m LOOP
            CONTINUE WHEN pz[p] = pz[q];
            CONTINUE WHEN NOT (r0x[p] < r1x[q] - eps AND r0x[q] < r1x[p] - eps
                               AND r0y[p] < r1y[q] - eps AND r0y[q] < r1y[p] - eps);
            xo := (least(c1x[p], c1x[q]) - greatest(c0x[p], c0x[q])) * plan_w;
            yo := (least(c1y[p], c1y[q]) - greatest(c0y[p], c0y[q])) * plan_h;
            CONTINUE WHEN xo > touch AND yo > touch;  -- 좌석끼리 겹친다: 나눌 수 없다
            IF xo > yo THEN  -- 위아래로 놓였다: 가로로 나눈다
                IF c0y[p] + c1y[p] <= c0y[q] + c1y[q] THEN t := p; u := q; ELSE t := q; u := p; END IF;
                mid := (c1y[t] + c0y[u]) / 2;
                l1y[t] := least(l1y[t], mid - gap_y / 2);
                l0y[u] := greatest(l0y[u], mid + gap_y / 2);
            ELSE  -- 옆으로 놓였다: 세로로 나눈다
                IF c0x[p] + c1x[p] <= c0x[q] + c1x[q] THEN t := p; u := q; ELSE t := q; u := p; END IF;
                mid := (c1x[t] + c0x[u]) / 2;
                l1x[t] := least(l1x[t], mid - gap_x / 2);
                l0x[u] := greatest(l0x[u], mid + gap_x / 2);
            END IF;
        END LOOP;
    END LOOP;

    RETURN QUERY
    SELECT f.zone,
           CASE WHEN count(*) = 1
                THEN jsonb_build_object('type', 'rect') || (jsonb_agg(f.rect ORDER BY f.y0, f.x0) -> 0)
                ELSE jsonb_build_object('type', 'rects', 'rects', jsonb_agg(f.rect ORDER BY f.y0, f.x0))
           END
    FROM (
        SELECT pz[p] AS zone, e.x0, e.y0,
               jsonb_build_object('x', round(e.x0, 4), 'y', round(e.y0, 4),
                                  'w', round(e.x1 - e.x0, 4), 'h', round(e.y1 - e.y0, 4)) AS rect
        FROM generate_series(1, m) AS p
        CROSS JOIN LATERAL (
            SELECT greatest(0, least(c0x[p], l0x[p])) AS x0, greatest(0, least(c0y[p], l0y[p])) AS y0,
                   least(1, greatest(c1x[p], l1x[p])) AS x1, least(1, greatest(c1y[p], l1y[p])) AS y1
        ) e
    ) f
    GROUP BY f.zone;
END $$;

-- 층의 자동 모양 구역을 모두 다시 계산해서 바뀐 것만 저장한다 (좌석이 없어진 구역은 NULL)
CREATE OR REPLACE FUNCTION refresh_zone_shapes_of_floor(p_floor bigint) RETURNS void
LANGUAGE sql AS $$
    UPDATE zones z SET shape = f.shape, updated_at = now()
    FROM (
        SELECT zz.id, s.shape
        FROM zones zz LEFT JOIN zone_shapes_of_floor(p_floor) s ON s.zone_id = zz.id
        WHERE zz.floor_id = p_floor AND zz.is_active AND zz.shape_mode = 'AUTO'
    ) f
    WHERE z.id = f.id AND z.shape IS DISTINCT FROM f.shape
$$;

-- 좌석이 생기거나 구역·위치·크기·상태가 바뀌면 그 층의 구역 모양을 다시 계산한다 (문장마다 층마다 한 번)
CREATE OR REPLACE FUNCTION seats_refresh_zone_shapes() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    f bigint;
BEGIN
    IF TG_OP = 'INSERT' THEN
        FOR f IN SELECT DISTINCT n.floor_id FROM new_seats n WHERE n.zone_id IS NOT NULL LOOP
            PERFORM refresh_zone_shapes_of_floor(f);
        END LOOP;
    ELSIF TG_OP = 'DELETE' THEN
        FOR f IN SELECT DISTINCT o.floor_id FROM old_seats o WHERE o.zone_id IS NOT NULL LOOP
            PERFORM refresh_zone_shapes_of_floor(f);
        END LOOP;
    ELSE
        FOR f IN
            SELECT DISTINCT n.floor_id
            FROM new_seats n JOIN old_seats o ON o.id = n.id
            WHERE (n.zone_id IS NOT NULL OR o.zone_id IS NOT NULL)
              AND (n.zone_id, n.x, n.y, n.w, n.h, n.status) IS DISTINCT FROM (o.zone_id, o.x, o.y, o.w, o.h, o.status)
        LOOP
            PERFORM refresh_zone_shapes_of_floor(f);
        END LOOP;
    END IF;
    RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS seats_zone_refresh_insert ON seats;
CREATE TRIGGER seats_zone_refresh_insert
    AFTER INSERT ON seats REFERENCING NEW TABLE AS new_seats
    FOR EACH STATEMENT EXECUTE FUNCTION seats_refresh_zone_shapes();
DROP TRIGGER IF EXISTS seats_zone_refresh_update ON seats;
CREATE TRIGGER seats_zone_refresh_update
    AFTER UPDATE ON seats REFERENCING OLD TABLE AS old_seats NEW TABLE AS new_seats
    FOR EACH STATEMENT EXECUTE FUNCTION seats_refresh_zone_shapes();
DROP TRIGGER IF EXISTS seats_zone_refresh_delete ON seats;
CREATE TRIGGER seats_zone_refresh_delete
    AFTER DELETE ON seats REFERENCING OLD TABLE AS old_seats
    FOR EACH STATEMENT EXECUTE FUNCTION seats_refresh_zone_shapes();

-- 지금 있는 구역 모양을 새 방법으로 다시 계산한다
SELECT refresh_zone_shapes_of_floor(id) FROM floors;
