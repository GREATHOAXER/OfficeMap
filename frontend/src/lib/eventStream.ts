// 실시간 알림(SSE) 연결. 직원 화면(/api/presence/stream)과 관리자 화면(/api/admin/stream)이 같이 쓴다.
//
// 탭이 보일 때만 연결을 연다. 브라우저는 같은 주소에 동시 연결을 6개까지만 여는데(HTTP/1.1), 탭마다 알림 연결을
// 하나씩 잡고 있으면 탭을 여러 개 열었을 때 페이지 이동·데이터 요청이 빈 연결을 기다리며 멈춘다("Rendering…").
// 숨긴 탭은 연결을 닫고, 다시 보이면 새로 붙으면서 onResync로 그사이 바뀐 것을 다시 읽는다.

const RETRY_MIN_MS = 3_000;
const RETRY_MAX_MS = 30_000;

type StreamOptions = {
  url: string;
  /** 이벤트 이름 → 받은 data (JSON 문자열) */
  on: Record<string, (data: string) => void>;
  /** 놓친 변경이 있을 수 있다 (다시 붙었을 때, 서버가 resync를 보냈을 때): 화면 데이터를 다시 읽는다 */
  onResync: () => void;
  /** 서버가 연결을 거절했다 (로그인 만료, 서버 꺼짐). 로그인을 확인하고, 다시 붙어도 되면 true */
  onRejected: () => Promise<boolean>;
};

/** 연결을 열고, 닫는 함수를 돌려준다 */
export function openEventStream({ url, on, onResync, onRejected }: StreamOptions): () => void {
  let source: EventSource | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryMs = RETRY_MIN_MS;
  let stale = false; // 연결이 없던 동안 바뀐 것이 있을 수 있다 (붙으면 다시 읽는다)
  let stopped = false;

  function connect() {
    if (stopped || source) return;
    if (document.hidden) {
      stale = true;
      return;
    }
    const es = new EventSource(url);
    source = es;
    es.addEventListener("open", () => {
      retryMs = RETRY_MIN_MS;
      if (stale) onResync();
      stale = false;
    });
    for (const [event, handler] of Object.entries(on)) {
      es.addEventListener(event, (e) => handler((e as MessageEvent<string>).data));
    }
    es.addEventListener("resync", onResync);
    es.addEventListener("error", () => {
      // 브라우저가 알아서 다시 붙는 중(CONNECTING)이면 둔다. CLOSED는 서버가 거절한 것이라 직접 확인하고 다시 시도한다
      stale = true;
      if (es.readyState === EventSource.CLOSED) void rejected(es);
    });
  }

  function disconnect() {
    clearTimeout(retryTimer);
    source?.close();
    source = null;
  }

  async function rejected(es: EventSource) {
    if (source === es) source = null;
    const again = await onRejected().catch(() => true);
    if (stopped || !again || source) return;
    retryTimer = setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
  }

  function onVisibility() {
    if (document.hidden) {
      if (source) stale = true;
      disconnect();
    } else connect();
  }

  document.addEventListener("visibilitychange", onVisibility);
  connect();
  return () => {
    stopped = true;
    document.removeEventListener("visibilitychange", onVisibility);
    disconnect();
  };
}
