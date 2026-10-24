-- 06_rooms.sql
-- 회의실과 예약

CREATE TABLE meeting_rooms (
    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    floor_id          bigint       NOT NULL REFERENCES floors(id),
    name              varchar(100) NOT NULL,              -- 예: 소회의실 702
    capacity          smallint     NOT NULL CHECK (capacity > 0),
    equipment         text[]       NOT NULL DEFAULT '{}', -- 예: {VIDEO, TV, PROJECTOR}. '화상회의 장비' 필터에 사용
    shape             jsonb,                              -- 도면 위 위치. 사용 중/비어 있음 표시용
    plan_element_key  varchar(50),                        -- 도면 편집기에서 이 회의실을 만든 공간의 ID
    sort_order        integer      NOT NULL DEFAULT 0,
    is_active         boolean      NOT NULL DEFAULT true,
    created_at        timestamptz  NOT NULL DEFAULT now(),
    updated_at        timestamptz  NOT NULL DEFAULT now(),
    UNIQUE (floor_id, name)
);

-- 반복 예약 규칙. 회차는 reservations에 한 행씩 만들어서 회차마다 겹침을 검사한다
CREATE TABLE reservation_series (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    room_id      bigint       NOT NULL REFERENCES meeting_rooms(id),
    organizer_id bigint       NOT NULL REFERENCES employees(id),
    title        varchar(200) NOT NULL,
    repeat_rule  varchar(10)  NOT NULL CHECK (repeat_rule IN ('WEEKLY', 'WEEKDAYS')),  -- 매주 같은 요일, 매일(평일)
    start_time   time         NOT NULL,
    end_time     time         NOT NULL,
    first_date   date         NOT NULL,
    last_date    date         NOT NULL,
    created_at   timestamptz  NOT NULL DEFAULT now(),
    CHECK (end_time > start_time),
    CHECK (last_date >= first_date)
);

-- 예약 1건. 같은 회의실에서 시간이 겹치는 확정 예약은 DB가 막는다. 승인 절차 없이 바로 확정된다
-- 최대 2시간, 체크인 유예 15분 같은 정책 값은 app_settings에서 읽어 앱에서 검사한다
CREATE TABLE reservations (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    room_id          bigint       NOT NULL REFERENCES meeting_rooms(id),
    organizer_id     bigint       NOT NULL REFERENCES employees(id),
    series_id        bigint REFERENCES reservation_series(id),
    title            varchar(200) NOT NULL,
    starts_at        timestamptz  NOT NULL,
    ends_at          timestamptz  NOT NULL,
    status           varchar(20)  NOT NULL DEFAULT 'CONFIRMED'
                     CHECK (status IN ('CONFIRMED', 'CANCELLED', 'RELEASED')),
    notify_attendees boolean      NOT NULL DEFAULT true,  -- 참석자에게 메신저 알림
    checked_in_at    timestamptz,                         -- 시작 후 유예 시간 안에 없으면 RELEASED(자동 반납)
    cancelled_at     timestamptz,
    created_at       timestamptz  NOT NULL DEFAULT now(),
    updated_at       timestamptz  NOT NULL DEFAULT now(),
    CHECK (ends_at > starts_at),
    EXCLUDE USING gist (room_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
        WHERE (status = 'CONFIRMED')
);
CREATE INDEX reservations_organizer_idx ON reservations (organizer_id, starts_at);
CREATE INDEX reservations_starts_at_idx ON reservations (starts_at);

-- 실제로 회의에 들어가는 사람. 예약한 사람(organizer)도 참석하면 여기에 들어간다
-- (비서가 임원 회의를 잡아 주는 것처럼, 예약만 하고 들어가지 않을 수도 있다)
CREATE TABLE reservation_attendees (
    reservation_id bigint      NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
    employee_id    bigint      NOT NULL REFERENCES employees(id),
    added_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (reservation_id, employee_id)
);
CREATE INDEX reservation_attendees_employee_idx ON reservation_attendees (employee_id);
