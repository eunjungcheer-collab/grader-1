// PDF 관련 화면들이 같이 쓰는 도구 모음
const PDFJS_VERSION = '3.11.174';

function setupPdfJs() {
  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('js/vendor/pdf.worker.min.js', location.href).href;
  }
}

async function loadPdfDoc(file) {
  const bytes = await file.arrayBuffer();
  // pdf.js가 버퍼를 가져가 버리므로 원본은 복사해 둔다
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes.slice(0)) }).promise;
  return { doc: doc, bytes: bytes };
}

function showSpinner(msg) {
  let el = document.getElementById('spinner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'spinner';
    el.className = 'spinner-overlay';
    document.body.appendChild(el);
  }
  el.innerHTML = '<div style="font-size:28px">⏳</div><div id="spinner-msg">' + msg + '</div>';
}
function updateSpinner(msg) {
  const m = document.getElementById('spinner-msg');
  if (m) m.textContent = msg;
}
function hideSpinner() {
  const el = document.getElementById('spinner');
  if (el) el.remove();
}

/**
 * 정답 입력칸(.ans-input)들을 화면 순서대로 묶어서:
 *  - 숫자 1글자를 치면 자동으로 다음 칸으로 이동
 *  - 백스페이스(빈 칸에서)는 이전 칸, 엔터/방향키는 이동
 *  - 칸에 들어가면 내용을 전부 선택 (그냥 덮어쓰기)
 */
// 입력한 숫자(또는 "주관식" 표시)를 화면 가운데에 잠깐 크게 보여준다 — 작은 칸에 입력하다
// 실수로 다른 숫자를 누르는 걸 바로 알아챌 수 있게.
let flashEl = null, flashTimer = null;
function flashBigNumber(ch) {
  if (!flashEl) {
    flashEl = document.createElement('div');
    flashEl.className = 'big-flash';
    document.body.appendChild(flashEl);
  }
  const isSubj = ch === '-';
  flashEl.textContent = isSubj ? '주관식' : ch;
  flashEl.style.fontSize = isSubj ? '34px' : '';
  flashEl.classList.remove('show'); void flashEl.offsetWidth;  // 애니메이션 다시 시작되게 리플로우
  flashEl.classList.add('show');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { if (flashEl) flashEl.classList.remove('show'); }, 450);
}

function attachAnswerAdvance(root) {
  const inputs = Array.from(root.querySelectorAll('input.ans-input'));
  // 주관식(회색·비활성)으로 표시된 칸은 건너뛰고 다음/이전 "입력 가능한" 칸으로 간다
  const step = (i, dir) => { for (let j = i + dir; j >= 0 && j < inputs.length; j += dir) if (!inputs[j].disabled) return inputs[j]; return null; };
  inputs.forEach(function (input, i) {
    input.addEventListener('focus', function () { input.select(); });
    input.addEventListener('input', function () {
      input.value = input.value.replace(/[^0-9\-]/g, '').slice(-1);      // 숫자 또는 '-'(주관식)
      if (input.value) flashBigNumber(input.value);
      const nx = step(i, 1);
      if (input.value && nx) nx.focus();
    });
    input.addEventListener('keydown', function (e) {
      let t = null;
      if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); t = step(i, 1); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); t = step(i, -1); }
      else if (e.key === 'Backspace' && !input.value) t = step(i, -1);
      if (t) t.focus();
    });
  });
  return inputs;
}

// 주관식 표시: 입력칸을 회색으로 비활성화하고 값을 '-'로 둔다 (자동 채점에서 빠짐). 끄면 다시 입력 가능.
function setSubjective(input, on, container) {
  input.disabled = !!on;
  input.value = on ? '-' : '';
  (container || input.parentElement).classList.toggle('is-sub', !!on);
  input.classList.toggle('filled', !!on);
}

// 시험지 PDF의 첫 페이지에 QR을 찍는다.
// opts: { size: QR 한 변(pt, 기본 60), corner: 'top-right'|'top-left'|'bottom-right'|'bottom-left', margin: 가장자리에서 띄울 거리(pt, 기본 10) }
function qrPlacement(pageW, pageH, opts) {
  const size = (opts && opts.size) || 60, m = (opts && opts.margin != null) ? opts.margin : 10, corner = (opts && opts.corner) || 'top-right';
  const x = corner.indexOf('right') >= 0 ? pageW - size - m : m;
  const y = corner.indexOf('top') >= 0 ? pageH - size - m : m;       // PDF 좌표는 아래가 0
  return { x: x, y: y, size: size };
}
async function stampQrOnDoc(pdfDoc, url, opts) {
  const qrDataUrl = await QRCode.toDataURL(url, { width: 300, margin: 1 });
  const qrBytes = new Uint8Array(await (await fetch(qrDataUrl)).arrayBuffer());
  const qrImage = await pdfDoc.embedPng(qrBytes);
  const first = pdfDoc.getPages()[0];
  const pl = qrPlacement(first.getWidth(), first.getHeight(), opts);
  first.drawImage(qrImage, { x: pl.x, y: pl.y, width: pl.size, height: pl.size });
}

function studentLinkFor(examId, page) {
  return location.origin + location.pathname.replace(/[^/]*$/, '') + 'student_exam.html?id=' + examId;
}

function genExamId() {
  return 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function pngSize(bytes) {
  // PNG 헤더(IHDR)에서 가로·세로를 읽는다
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

function driveThumb(fileId, width) {
  return 'https://drive.google.com/thumbnail?id=' + fileId + '&sz=w' + (width || 500);
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function baseNoExt(filename) {
  return filename.replace(/\.pdf$/i, '').replace(/[_\-]+/g, ' ').trim();
}


// 붙여넣은 정답 글을 해석한다.
//  - "1③ 2① 3④", "1. 3 / 2. 1", "1) ③" 처럼 번호가 붙어 있으면 번호 기준으로
//  - "31425", "3 1 4 2 5", "③①④②⑤" 처럼 답만 나열되어 있으면 순서대로
function parseBulkAnswers(text) {
  const CIR = { '①': '1', '②': '2', '③': '3', '④': '4', '⑤': '5', '⑥': '6', '⑦': '7', '⑧': '8', '⑨': '9' };
  const t = String(text || '');
  const pairs = [];
  const re = /(\d{1,3})\s*([.)번:\-]?)\s*([①-⑨]|[1-9])(?![0-9])/g;
  let m;
  while ((m = re.exec(t))) pairs.push({ n: parseInt(m[1], 10), sep: m[2], a: CIR[m[3]] || m[3], circ: !!CIR[m[3]] });
  const strong = pairs.filter(p => p.circ || p.sep);
  if (strong.length >= 2 && strong.length >= pairs.length * 0.6) {
    const byN = {};
    strong.forEach(p => { if (!(p.n in byN)) byN[p.n] = p.a; });
    let max = 0;
    Object.keys(byN).forEach(k => { max = Math.max(max, parseInt(k, 10)); });
    const arr = [];
    for (let i = 1; i <= max; i++) arr.push(byN[i] || '');
    return { mode: 'pairs', answers: arr };
  }
  const seq = (t.match(/[①-⑨]|[1-9]|[-×주]/g) || []).map(c => CIR[c] || (/[-×주]/.test(c) ? '-' : c));
  return { mode: 'seq', answers: seq };
}

// 해석한 결과를 입력칸(input 배열)에 채우고, 몇 개를 채웠는지 돌려준다
function fillAnswersFromText(text, inputs) {
  const r = parseBulkAnswers(text);
  let n = 0;
  r.answers.forEach((a, i) => {
    const inp = inputs[i];
    if (!inp || !a) return;
    const box = inp.closest ? (inp.closest('.abox') || inp.closest('.qc') || inp.parentElement) : inp.parentElement;
    if (a === '-') setSubjective(inp, true, box);
    else { if (inp.disabled) setSubjective(inp, false, box); inp.value = a; inp.dispatchEvent(new Event('input', { bubbles: false })); }
    n++;
  });
  return { filled: n, parsed: r.answers.length, mode: r.mode };
}


// 그림을 누르면 화면 가득 크게 보여주고, 다시 누르면 닫는다
function zoomImg(src) {
  const ov = document.createElement('div');
  ov.className = 'zoom-ov';
  ov.innerHTML = '<img src="' + src + '">';
  ov.addEventListener('click', () => ov.remove());
  document.body.appendChild(ov);
}
