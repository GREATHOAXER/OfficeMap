// pdf.js가 브라우저에서 따로 내려받는 파일(일꾼·글꼴·문자표)을 public/pdfjs/로 복사한다.
// 도면 파일(PDF)로 초안 만들기에 쓴다. npm run dev·build 전에 저절로 돈다 (package.json의 predev·prebuild).
// 사내 PC의 조금 오래된 브라우저에서도 돌도록 호환(legacy) 빌드를 쓴다 (기본 빌드는 최신 브라우저 기능만 쓴다)
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pdfjs = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
const out = join(root, "public", "pdfjs");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(pdfjs, "legacy", "build", "pdf.worker.min.mjs"), join(out, "pdf.worker.min.mjs"));
for (const dir of ["cmaps", "standard_fonts", "wasm"]) cpSync(join(pdfjs, dir), join(out, dir), { recursive: true });
console.log("pdf.js 파일 복사:", out);
