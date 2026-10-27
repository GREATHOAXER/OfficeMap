// pdf.js 호환(legacy) 빌드가 쓰는데 채워 주지 않는 기능. iPhone Safari에는 늦게 들어왔다:
//   Promise.withResolvers                  iOS 17.4 (없으면 PDF를 아예 열지 못한다)
//   ArrayBuffer.transferToFixedLength      iOS 17.4 (일꾼이 글꼴을 넘길 때)
//   ReadableStream을 for await로 읽기      iOS 18까지 없음 (없으면 도면 PDF의 글자를 못 읽는다)
// 화면 쪽은 lib/planFile.ts가 pdf.js보다 먼저 불러오고, 일꾼 쪽은 scripts/copy-pdfjs.mjs가
// public/pdfjs/polyfills.mjs로 복사해 일꾼 앞에 붙인다 (public/pdfjs/worker.mjs). 이미 있으면 건드리지 않는다

if (typeof Promise.withResolvers !== "function") {
  Promise.withResolvers = function withResolvers() {
    let resolve;
    let reject;
    const promise = new this((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

if (typeof ArrayBuffer.prototype.transferToFixedLength !== "function") {
  // 진짜는 원래 버퍼를 비우고 옮기지만, pdf.js는 돌려받은 버퍼만 쓰므로 복사로 충분하다
  ArrayBuffer.prototype.transferToFixedLength = function transferToFixedLength(length = this.byteLength) {
    const out = new ArrayBuffer(length);
    new Uint8Array(out).set(new Uint8Array(this, 0, Math.min(length, this.byteLength)));
    return out;
  };
}

if (typeof ReadableStream !== "undefined" && !ReadableStream.prototype[Symbol.asyncIterator]) {
  ReadableStream.prototype[Symbol.asyncIterator] = async function* values() {
    const reader = this.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  };
}

export {}; // 모듈로 불러오게 (내보내는 것은 없음)
