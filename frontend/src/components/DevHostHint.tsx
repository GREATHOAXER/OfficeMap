"use client";

import { useSyncExternalStore } from "react";
import styles from "./DevHostHint.module.css";

const subscribe = () => () => {};

/** 개발 서버(npm run dev)에서만 쓴다. 화면 스크립트가 끝내 붙지 않으면 왜 그런지와 고치는 법을 띄운다.
 *  localhost가 아닌 주소(ngrok, PC 이름·IP)로 열면 개발 서버가 개발용 연결을 막아서, 화면은 보여도 버튼이 동작하지 않는다
 *  (로그인을 눌러도 로그인 화면이 다시 뜸). 스크립트가 붙으면 바로 사라지고, 안 붙으면 서버가 그린 안내가 CSS로 늦게 나타난다 */
export default function DevHostHint({ host }: { host: string }) {
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  if (hydrated) return null;
  return (
    <div className={styles.hint} role="alert">
      <strong>화면 스크립트가 붙지 않았습니다 (개발 서버)</strong>
      <p>
        개발 서버가 <code>{host}</code> 주소에서 온 연결을 막고 있을 수 있습니다. <code>frontend/.env.local</code>에{" "}
        <code>DEV_ORIGINS={host}</code>를 넣고 <code>npm run dev</code>를 다시 켜세요. ngrok은 개발 서버보다 먼저 켜 두면 자동으로
        허용됩니다. 빌드해서 띄우면(<code>npm run build</code> → <code>npm start</code>) 이 설정이 필요 없습니다.
      </p>
    </div>
  );
}
