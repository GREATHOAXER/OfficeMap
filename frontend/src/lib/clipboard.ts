/**
 * 글자를 클립보드에 복사한다. 됐으면 true.
 * navigator.clipboard는 보안 연결(https·localhost)에서만 있어서, http로 연 서버에서는 숨긴 입력칸의 글자를 골라
 * 복사 명령을 쓴다 (iPhone Safari도 된다). 누른 바로 그때 불러야 한다 (await 뒤면 브라우저가 막는다).
 * near: 복사용 입력칸을 붙일 곳. 모달 대화상자 안에서 부르면 그 안의 요소를 준다 (밖은 고를 수 없게 막혀 있다)
 */
export async function copyText(text: string, near?: Element | null): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.readOnly = true; // 휴대폰 키보드가 올라오지 않게
  // 화면에는 안 보이게. 16px: iPhone Safari가 입력칸을 고를 때 화면을 확대하지 않게
  area.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px;";
  (near?.parentElement ?? document.body).append(area);
  area.focus({ preventScroll: true });
  area.select();
  area.setSelectionRange(0, text.length); // iPhone Safari는 select()만으로는 고르지 않는다
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  area.remove();
  if (near instanceof HTMLElement) near.focus({ preventScroll: true }); // 복사용 칸으로 옮겨 간 초점을 돌려 둔다
  return copied;
}
