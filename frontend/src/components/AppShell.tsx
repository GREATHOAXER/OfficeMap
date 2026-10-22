"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { SiteSummary, User } from "@/lib/api";
import { SIDEBAR_COOKIE } from "@/lib/sidebar";
import {
  CalendarIcon,
  CheckIcon,
  ChecklistIcon,
  ChevronDownIcon,
  GridIcon,
  MenuIcon,
  MoreIcon,
  MoveIcon,
  PenIcon,
  PersonIcon,
  ShieldIcon,
  SparkleIcon,
} from "./icons";
import LogoutButton from "./LogoutButton";
import styles from "./AppShell.module.css";

type MenuItem = { label: string; icon: ReactNode; href?: string; badge?: string };

// href가 없는 메뉴는 아직 화면이 없어서 버튼만 둔다
const MAIN_MENU: MenuItem[] = [
  { label: "AI 도우미", icon: <SparkleIcon />, badge: "NEW" },
  { label: "자리·재실 현황", icon: <GridIcon />, href: "/" },
  { label: "회의실 확인·예약", icon: <CalendarIcon /> },
  { label: "내 예약", icon: <ChecklistIcon /> },
  { label: "내 재실 상태", icon: <PersonIcon /> },
];

const ADMIN_MENU: MenuItem[] = [
  { label: "좌석 배치 편집", icon: <MoveIcon /> },
  { label: "도면 편집", icon: <PenIcon /> },
  { label: "사업장·권한", icon: <ShieldIcon /> },
];

// AppShell.module.css 의 좁은 화면 기준과 같아야 한다
const NARROW_QUERY = "(max-width: 720px)";

function subscribeNarrow(onChange: () => void) {
  const query = window.matchMedia(NARROW_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

type Props = {
  user: User;
  sites: SiteSummary[];
  defaultSiteId: number | null;
  /** 쿠키에 저장된 선택. null이면 아직 고른 적 없음: 넓은 화면은 펼치고 좁은 화면은 접는다 */
  initialCollapsed: boolean | null;
  children: ReactNode;
};

export default function AppShell({ user, sites, defaultSiteId, initialCollapsed, children }: Props) {
  const [choice, setChoice] = useState<boolean | null>(initialCollapsed);
  const narrow = useSyncExternalStore(
    subscribeNarrow,
    () => window.matchMedia(NARROW_QUERY).matches,
    () => false,
  );
  const collapsed = choice ?? narrow;

  function toggle() {
    const next = !collapsed;
    setChoice(next);
    document.cookie = `${SIDEBAR_COOKIE}=${next ? "collapsed" : "expanded"}; path=/; max-age=31536000; samesite=lax`;
  }

  // 화면에 보이는 모양은 CSS가 data-collapsed로 정한다. "auto"는 화면 폭에 따라 CSS가 고른다
  // (서버는 화면 폭을 몰라서, 이렇게 해야 첫 화면부터 맞는 모양으로 그려진다)
  return (
    <div className={styles.shell} data-collapsed={choice === null ? "auto" : String(choice)}>
      <nav id="main-menu" aria-label="주 메뉴" className={styles.sidebar}>
        <div className={styles.top}>
          <button
            type="button"
            className={styles.iconButton}
            onClick={toggle}
            aria-expanded={!collapsed}
            aria-controls="main-menu"
            aria-label={collapsed ? "메뉴 펼치기" : "메뉴 접기"}
            title={collapsed ? "메뉴 펼치기" : "메뉴 접기"}
          >
            <MenuIcon />
          </button>
          <Image src="/kftc-logo.jpg" alt="금융결제원" width={101} height={32} className={styles.logo} priority />
          <Image src="/kftc-symbol.png" alt="금융결제원" width={32} height={32} className={styles.symbol} />
        </div>

        {sites.length > 0 && <SiteSelect sites={sites} defaultSiteId={defaultSiteId} />}

        <MenuList items={MAIN_MENU} collapsed={collapsed} />

        {user.role === "ADMIN" && (
          <>
            <p className={styles.groupTitle}>관리</p>
            <hr className={styles.divider} />
            <MenuList items={ADMIN_MENU} collapsed={collapsed} />
          </>
        )}

        <div className={styles.spacer} />
        <UserCard user={user} />
      </nav>
      <div className={styles.content}>{children}</div>
    </div>
  );
}

// 사업장 고르기. OS 기본 선택창 대신 서비스 모양에 맞춘 목록 (listbox 패턴: 방향키·Enter·Esc 지원)
function SiteSelect({ sites, defaultSiteId }: { sites: SiteSummary[]; defaultSiteId: number | null }) {
  const router = useRouter();
  const params = useSearchParams();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // 주소의 층·사업장으로 지금 보고 있는 사업장을 정한다
  const floorId = Number(params.get("floor"));
  const siteId = Number(params.get("site"));
  const current =
    sites.find((s) => s.floors.some((f) => f.id === floorId)) ??
    sites.find((s) => s.id === siteId) ??
    sites.find((s) => s.id === defaultSiteId) ??
    sites[0];

  useEffect(() => {
    if (open) listRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function openList() {
    setActive(Math.max(0, sites.indexOf(current)));
    setOpen(true);
  }

  function close() {
    setOpen(false);
    buttonRef.current?.focus();
  }

  function choose(site: SiteSummary) {
    close();
    if (site.id !== current.id) router.push(`/?site=${site.id}`);
  }

  function onButtonKeyDown(event: KeyboardEvent) {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
      event.preventDefault();
      openList();
    }
  }

  function onListKeyDown(event: KeyboardEvent) {
    const last = sites.length - 1;
    const moves: Record<string, () => void> = {
      ArrowDown: () => setActive((i) => Math.min(last, i + 1)),
      ArrowUp: () => setActive((i) => Math.max(0, i - 1)),
      Home: () => setActive(0),
      End: () => setActive(last),
      Enter: () => choose(sites[active]),
      " ": () => choose(sites[active]),
      Escape: close,
    };
    if (event.key === "Tab") setOpen(false);
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      event.stopPropagation(); // 바깥의 Esc 처리(계정 메뉴 등)로 번지지 않게
      move();
    }
  }

  return (
    <div ref={boxRef} className={styles.site}>
      <span id="site-label" className={styles.siteLabel}>
        사업장
      </span>
      <button
        ref={buttonRef}
        id="site-button"
        type="button"
        className={styles.siteButton}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby="site-label site-button"
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onButtonKeyDown}
      >
        <span className={styles.siteName}>{current.name}</span>
        <ChevronDownIcon size={18} />
      </button>
      {open && (
        <ul
          ref={listRef}
          role="listbox"
          tabIndex={-1}
          aria-labelledby="site-label"
          aria-activedescendant={`site-option-${sites[active].id}`}
          className={styles.siteList}
          onKeyDown={onListKeyDown}
        >
          {sites.map((site, i) => (
            <li
              key={site.id}
              id={`site-option-${site.id}`}
              role="option"
              aria-selected={site.id === current.id}
              className={`${styles.siteOption} ${i === active ? styles.siteOptionActive : ""}`}
              onClick={() => choose(site)}
              onMouseEnter={() => setActive(i)}
            >
              <span className={styles.siteCheck} aria-hidden="true">
                {site.id === current.id && <CheckIcon size={16} />}
              </span>
              <span className={styles.siteOptionName}>{site.name}</span>
              <span className={styles.siteOptionMeta}>{site.floors.length}개 층</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MenuList({ items, collapsed }: { items: MenuItem[]; collapsed: boolean }) {
  const pathname = usePathname();
  return (
    <ul className={styles.menu}>
      {items.map((item) => (
        <li key={item.label}>
          <MenuEntry item={item} active={item.href === pathname} collapsed={collapsed} />
        </li>
      ))}
    </ul>
  );
}

function MenuEntry({ item, active, collapsed }: { item: MenuItem; active: boolean; collapsed: boolean }) {
  const body = (
    <>
      {item.icon}
      <span className={styles.label}>{item.label}</span>
      {item.badge && <span className={styles.badge}>{item.badge}</span>}
    </>
  );
  const className = `${styles.item} ${active ? styles.active : ""}`;

  if (item.href) {
    return (
      <Link
        href={item.href}
        className={className}
        aria-current={active ? "page" : undefined}
        aria-label={item.label}
        title={collapsed ? item.label : undefined}
      >
        {body}
      </Link>
    );
  }
  return (
    <button type="button" className={className} aria-label={`${item.label} (준비 중)`} title={`${item.label} · 준비 중`}>
      {body}
    </button>
  );
}

function UserCard({ user }: { user: User }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // 메뉴 밖을 누르면 닫는다
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const role = user.role === "ADMIN" ? "관리자" : "직원";
  const initials = user.name.slice(-2);
  const menuButtonProps = {
    type: "button" as const,
    "aria-label": "내 계정 메뉴",
    "aria-expanded": open,
    "aria-controls": "account-menu",
    onClick: () => setOpen((v) => !v),
  };

  return (
    <div
      ref={boxRef}
      className={styles.user}
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <span className={styles.avatar} aria-hidden="true">
        {initials}
      </span>
      <span className={styles.userText}>
        <strong>{user.name}</strong>
        <span>
          {user.department} · {role}
        </span>
      </span>
      {/* 펼쳤을 때는 ⋯ 버튼, 접었을 때는 아바타가 계정 메뉴 버튼. 안 보이는 쪽은 CSS가 숨긴다 */}
      <button {...menuButtonProps} className={`${styles.iconButton} ${styles.userButton}`}>
        <MoreIcon />
      </button>
      <button {...menuButtonProps} className={styles.avatarButton} title={`${user.name} · ${user.department}`}>
        {initials}
      </button>
      {open && (
        <div id="account-menu" className={styles.popover}>
          <p className={styles.popoverWho}>
            {user.name} {user.rank} · <span className="mono">{user.emp_no}</span>
          </p>
          <LogoutButton className={styles.popoverItem} />
        </div>
      )}
    </div>
  );
}
