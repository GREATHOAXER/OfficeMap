"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  type CSSProperties,
  Fragment,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { hasPlanRole, isCompanyWide } from "@/lib/admin";
import type { Admin, SiteSummary, User } from "@/lib/api";
import { SIDEBAR_COOKIE } from "@/lib/sidebar";
import {
  BuildingIcon,
  CalendarIcon,
  CheckIcon,
  ChecklistIcon,
  ChevronDownIcon,
  CloseIcon,
  GridIcon,
  IdCardIcon,
  KeyIcon,
  MenuIcon,
  MoreIcon,
  MoveIcon,
  OrgIcon,
  PenIcon,
  PersonIcon,
  ShieldIcon,
  TransferIcon,
  TruckIcon,
} from "./icons";
import Avatar from "./Avatar";
import LogoutButton from "./LogoutButton";
import SessionWatch from "./SessionWatch";
import styles from "./AppShell.module.css";
import Logo, { LogoSymbol } from "./Logo";

type MenuItem = { label: string; icon: ReactNode; href?: string; badge?: string };
type MenuGroup = { title?: string; items: MenuItem[] };

// href가 없는 메뉴는 아직 화면이 없어서 "준비 중" 표시를 붙인 버튼만 둔다.
// AI 도우미는 메뉴에 따로 두지 않는다: 자리·재실 현황 머리글의 "AI 도우미" 단추로 연다
const MAIN_MENU: MenuItem[] = [
  { label: "자리·재실 현황", icon: <GridIcon />, href: "/" },
  { label: "회의실 확인·예약", icon: <CalendarIcon />, href: "/rooms" },
  { label: "내 예약", icon: <ChecklistIcon />, href: "/reservations" },
  { label: "내 재실 상태", icon: <PersonIcon />, href: "/presence" },
  { label: "내 정보", icon: <IdCardIcon />, href: "/profile" },
];

// 직원 화면과 관리자 페이지는 완전히 나눈다: 서로 넘어가는 링크를 두지 않는다.
// 관리자는 관리자 페이지 주소(/admin)로 들어가 관리자 비밀번호로 따로 로그인한다

/** 관리자 페이지의 왼쪽 메뉴. 도면 편집은 층 관리자 이상만 할 수 있어서 구역 관리자에게는 보이지 않는다 */
function consoleMenu(admin: Admin): MenuGroup[] {
  return [
    {
      title: "관리",
      items: [
        { label: "사업장·권한", icon: <ShieldIcon />, href: "/admin" },
        { label: "조직도", icon: <OrgIcon />, href: "/admin/org" },
        { label: "좌석 배치 편집", icon: <MoveIcon />, href: "/admin/seating" },
        // 도면 편집은 층 관리자 이상 (구역 관리자는 보기만)
        ...(hasPlanRole(admin)
          ? [
              { label: "도면 편집", icon: <PenIcon />, href: "/admin/plans" },
              { label: "팀 이사", icon: <TruckIcon />, href: "/admin/moves" },
            ]
          : []),
        // 인사이동(여러 사람의 소속을 엑셀로 한 번에)은 조직도처럼 최종·전사 관리자만
        ...(isCompanyWide(admin) ? [{ label: "인사이동", icon: <TransferIcon />, href: "/admin/personnel" }] : []),
      ],
    },
  ];
}

// AppShell.module.css 의 좁은 화면 기준과 같아야 한다
const NARROW_QUERY = "(max-width: 720px)";

function subscribeNarrow(onChange: () => void) {
  const query = window.matchMedia(NARROW_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** 왼쪽 메뉴 아래 사용자 칸 */
type Account = {
  name: string;
  rank: string | null;
  emp_no: string;
  department: string | null; // 최종 관리자(시스템 계정)는 부서가 없다
  roleLabel: string;
  photo?: string | null; // 내 정보 사진 (관리자 페이지에는 없음)
  scopes?: string[]; // 관리자: 맡은 범위
  links?: { label: string; href: string; icon: ReactNode }[]; // 계정 메뉴의 링크 (내 정보·비밀번호 변경)
  logout: { endpoint: string; redirectTo: string };
};

type Common = {
  /** 넓은 화면에서 메뉴를 접었는지 (쿠키에 저장). null이면 아직 고른 적 없음: 펼친다.
   *  좁은 화면(휴대폰)에서는 메뉴가 숨어 있다가 위쪽 막대의 햄버거로 여는 서랍이 된다 */
  initialCollapsed: boolean | null;
  children: ReactNode;
};

// 직원 화면과 관리자 페이지가 같은 틀을 쓴다. 관리자 페이지는 메뉴·사용자 칸만 다르고 사업장 선택이 없다
type Props =
  | (Common & { variant: "app"; user: User; sites: SiteSummary[]; defaultSiteId: number | null })
  | (Common & { variant: "admin"; admin: Admin });

export default function AppShell(props: Props) {
  const { initialCollapsed, children } = props;
  const [choice, setChoice] = useState<boolean | null>(initialCollapsed);
  const narrow = useSyncExternalStore(
    subscribeNarrow,
    () => window.matchMedia(NARROW_QUERY).matches,
    () => false,
  );
  // 휴대폰 서랍: 연 화면의 주소를 기억해서, 다른 화면으로 가면 저절로 닫힌다
  const pathname = usePathname();
  const [drawerPath, setDrawerPath] = useState<string | null>(null);
  const drawerOpen = narrow && drawerPath === pathname;
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const collapsed = !narrow && (choice ?? false);

  function toggle() {
    if (narrow) {
      closeDrawer();
      return;
    }
    const next = !collapsed;
    setChoice(next);
    document.cookie = `${SIDEBAR_COOKIE}=${next ? "collapsed" : "expanded"}; path=/; max-age=31536000; samesite=lax`;
  }

  function closeDrawer() {
    setDrawerPath(null);
    openButtonRef.current?.focus();
  }

  // 서랍을 열면 메뉴로 포커스를 옮기고, Esc로 닫는다
  useEffect(() => {
    if (!drawerOpen) return;
    navRef.current?.querySelector<HTMLElement>("a, button")?.focus();
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        setDrawerPath(null);
        openButtonRef.current?.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen]);

  const groups: MenuGroup[] = props.variant === "admin" ? consoleMenu(props.admin) : [{ items: MAIN_MENU }];
  const account: Account =
    props.variant === "admin"
      ? {
          ...props.admin,
          roleLabel: props.admin.role_label,
          scopes: props.admin.grants.map((g) => `${g.label} · ${g.scope}`),
          links: [{ label: "관리자 비밀번호 변경", href: "/admin/password", icon: <KeyIcon size={18} /> }],
          logout: { endpoint: "/api/admin/auth/logout", redirectTo: "/admin/login?reason=logout" },
        }
      : {
          ...props.user,
          // 직원 화면에서는 직급을 보여 준다 (관리자 단계 이름은 관리자 페이지에서만)
          roleLabel: props.user.rank ?? "직원",
          links: [
            { label: "내 정보", href: "/profile", icon: <IdCardIcon size={18} /> },
            { label: "비밀번호 변경", href: "/password", icon: <KeyIcon size={18} /> },
          ],
          logout: { endpoint: "/api/auth/logout", redirectTo: "/login?reason=logout" },
        };
  const menuLabel = props.variant === "admin" ? "관리자 메뉴" : "주 메뉴";

  // 넓은 화면의 모양은 CSS가 data-collapsed로 정한다 (서버는 화면 폭을 몰라서, 이렇게 해야 첫 화면부터 맞는 모양).
  // 좁은 화면은 data-drawer로 서랍을 열고 닫는다
  return (
    <div
      className={styles.shell}
      data-collapsed={choice === null ? "auto" : String(choice)}
      data-drawer={drawerOpen ? "open" : undefined}
    >
      <nav
        ref={navRef}
        id="main-menu"
        aria-label={menuLabel}
        className={styles.sidebar}
        onClick={(event) => {
          // 서랍에서 메뉴를 고르면 닫는다 (지금 화면을 다시 눌러도)
          if (narrow && (event.target as Element).closest("a")) setDrawerPath(null);
        }}
      >
        <div className={styles.top}>
          <button
            type="button"
            className={styles.iconButton}
            onClick={toggle}
            aria-expanded={narrow ? drawerOpen : !collapsed}
            aria-controls="main-menu"
            aria-label={narrow ? "메뉴 닫기" : collapsed ? "메뉴 펼치기" : "메뉴 접기"}
            title={narrow ? "메뉴 닫기" : collapsed ? "메뉴 펼치기" : "메뉴 접기"}
          >
            {narrow ? <CloseIcon /> : <MenuIcon />}
          </button>
          <Logo size={24} className={styles.logo} />
          <span className={styles.symbol} role="img" aria-label="Office Map">
            <LogoSymbol size={28} />
          </span>
        </div>

        {props.variant === "admin" ? (
          <p className={styles.mode} title="관리자 페이지">
            <ShieldIcon size={16} />
            <span>관리자 페이지</span>
          </p>
        ) : (
          props.sites.length > 0 && (
            <SiteSelect sites={props.sites} defaultSiteId={props.defaultSiteId} collapsed={collapsed} />
          )
        )}

        {groups.map((group, i) => (
          <Fragment key={group.title ?? i}>
            {group.title && <p className={styles.groupTitle}>{group.title}</p>}
            {i > 0 && <hr className={styles.divider} />}
            <MenuList items={group.items} collapsed={collapsed} />
          </Fragment>
        ))}

        <div className={styles.spacer} />
        <UserCard account={account} />
      </nav>
      <div className={styles.backdrop} aria-hidden="true" onClick={closeDrawer} />
      {/* 서랍이 열려 있으면 뒤 화면은 Tab·화면 낭독기가 지나가지 않게 */}
      <div className={styles.content} inert={drawerOpen}>
        {/* 휴대폰: 왼쪽 메뉴 대신 위쪽 막대 (햄버거로 메뉴 서랍 열기) */}
        <div className={styles.mobileBar}>
          <button
            ref={openButtonRef}
            type="button"
            className={styles.iconButton}
            onClick={() => setDrawerPath(pathname)}
            aria-expanded={drawerOpen}
            aria-controls="main-menu"
            aria-label={`${menuLabel} 열기`}
          >
            <MenuIcon />
          </button>
          <Logo size={22} className={styles.logo} />
          {props.variant === "admin" && (
            <span className={styles.mobileMode}>
              <ShieldIcon size={14} />
              관리자
            </span>
          )}
        </div>
        {children}
      </div>
      <SessionWatch kind={props.variant === "admin" ? "admin" : "user"} />
    </div>
  );
}

// 사업장 고르기. OS 기본 선택창 대신 서비스 모양에 맞춘 목록 (listbox 패턴: 방향키·Enter·Esc 지원).
// 메뉴를 접으면 건물 아이콘만 남기고, 목록은 메뉴 밖(body)에 아이콘 오른쪽으로 띄운다 (접힌 메뉴는 넘치는 부분을 자른다)
function SiteSelect({
  sites,
  defaultSiteId,
  collapsed,
}: {
  sites: SiteSummary[];
  defaultSiteId: number | null;
  collapsed: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [open, setOpen] = useState(false);
  const [railPosition, setRailPosition] = useState<CSSProperties>({});
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
      const target = event.target as Node;
      if (!boxRef.current?.contains(target) && !listRef.current?.contains(target)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function openList() {
    setActive(Math.max(0, sites.indexOf(current)));
    if (collapsed && buttonRef.current) {
      const box = buttonRef.current.getBoundingClientRect();
      setRailPosition({ position: "fixed", left: box.right + 8, top: box.top, right: "auto", width: 240 });
    }
    setOpen(true);
  }

  function close() {
    setOpen(false);
    buttonRef.current?.focus();
  }

  function choose(site: SiteSummary) {
    close();
    if (site.id !== current.id) router.push(`${pathname}?site=${site.id}`); // 지금 화면 그대로 사업장만 바꾼다
  }

  /** 접힌 메뉴에서는 목록을 메뉴 밖(body)에 띄운다 */
  const portal = (node: ReactNode) => (collapsed ? createPortal(node, document.body) : node);

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
        title={collapsed ? `사업장: ${current.name}` : undefined}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onButtonKeyDown}
      >
        <span className={styles.siteIcon} aria-hidden="true">
          <BuildingIcon size={20} />
        </span>
        <span className={styles.siteName}>{current.name}</span>
        <ChevronDownIcon size={18} />
      </button>
      {open && portal(
        <ul
          ref={listRef}
          role="listbox"
          tabIndex={-1}
          aria-labelledby="site-label"
          aria-activedescendant={`site-option-${sites[active].id}`}
          className={styles.siteList}
          style={collapsed ? railPosition : undefined}
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
        </ul>,
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
      {!item.href && <span className={styles.pending}>준비 중</span>}
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
        <NavPending />
      </Link>
    );
  }
  return (
    <button
      type="button"
      className={`${className} ${styles.itemPending}`}
      aria-disabled="true"
      aria-label={`${item.label} (준비 중)`}
      title={`${item.label} · 준비 중`}
    >
      {body}
    </button>
  );
}

/** 메뉴를 누른 뒤 다음 화면이 뜨기 전까지 항목 아래에 움직이는 줄. 늘 자리를 차지하고 보이기만 바꿔서 메뉴가 들썩이지 않는다 */
function NavPending() {
  const { pending } = useLinkStatus();
  return <span aria-hidden="true" className={styles.navPending} data-pending={pending || undefined} />;
}

function UserCard({ account: user }: { account: Account }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  const boxRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // 메뉴 밖을 누르거나 창 폭이 바뀌면 닫는다 (높이만 바뀌는 것은 두고: iPhone Safari는 주소창이 접히고 펼쳐질 때마다
  // resize를 보낸다. 그때 닫으면 메뉴를 열자마자 사라진다)
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (!boxRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    }
    const width = window.innerWidth;
    const close = () => {
      if (window.innerWidth !== width) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", close);
    // 메뉴 자체로 포커스 (로그아웃 버튼에 두면 Enter를 두 번 눌러 바로 로그아웃될 수 있다)
    menuRef.current?.focus();
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  // 계정 메뉴는 왼쪽 메뉴 밖(body)에 띄운다. 접힌 메뉴는 폭이 좁고 넘치는 부분을 잘라서, 안에 두면 가려진다.
  // 펼친 메뉴에서는 사용자 칸 바로 위에, 접힌 메뉴에서는 아바타 오른쪽에 붙인다
  function toggle(event: ReactMouseEvent<HTMLButtonElement>) {
    if (open) {
      setOpen(false);
      return;
    }
    triggerRef.current = event.currentTarget;
    const box = boxRef.current!.getBoundingClientRect();
    const rail = box.width < 120;
    setPosition(
      rail
        ? { left: box.right + 8, bottom: window.innerHeight - box.bottom, width: 220 }
        : { left: box.left, bottom: window.innerHeight - box.top + 8, width: box.width },
    );
    setOpen(true);
  }

  const menuButtonProps = {
    type: "button" as const,
    "aria-label": "내 계정 메뉴",
    "aria-expanded": open,
    "aria-controls": "account-menu",
    onClick: toggle,
  };

  return (
    <div
      ref={boxRef}
      className={styles.user}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation(); // 휴대폰 메뉴 서랍까지 같이 닫히지 않게
          setOpen(false);
          triggerRef.current?.focus();
        }
      }}
    >
      <span className={styles.avatar} aria-hidden="true">
        <Avatar name={user.name} photo={user.photo} />
      </span>
      <span className={styles.userText}>
        <strong>{user.name}</strong>
        <span>{user.department ? `${user.department} · ${user.roleLabel}` : user.roleLabel}</span>
      </span>
      {/* 펼쳤을 때는 ⋯ 버튼, 접었을 때는 아바타가 계정 메뉴 버튼. 안 보이는 쪽은 CSS가 숨긴다 */}
      <button {...menuButtonProps} className={`${styles.iconButton} ${styles.userButton}`}>
        <MoreIcon />
      </button>
      <button {...menuButtonProps} className={styles.avatarButton} title={user.department ? `${user.name} · ${user.department}` : user.name}>
        <Avatar name={user.name} photo={user.photo} />
      </button>
      {open &&
        createPortal(
          <div
            id="account-menu"
            ref={menuRef}
            className={styles.popover}
            style={position}
            tabIndex={-1}
            role="group"
            aria-label="내 계정 메뉴"
          >
            <p className={styles.popoverWho}>
              {user.name} {user.rank} · <span className="mono">{user.emp_no}</span>
            </p>
            {user.scopes && (
              <ul className={styles.popoverScopes} aria-label="맡은 관리 범위">
                {user.scopes.map((scope) => (
                  <li key={scope}>{scope}</li>
                ))}
              </ul>
            )}
            {user.links?.map((link) => (
              <Link key={link.href} href={link.href} className={styles.popoverItem} onClick={() => setOpen(false)}>
                {link.icon}
                {link.label}
              </Link>
            ))}
            <LogoutButton className={styles.popoverItem} {...user.logout} />
          </div>,
          document.body,
        )}
    </div>
  );
}
