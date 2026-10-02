/**
 * 문제은행 핵심 로직 (브라우저용, pdf.js + pdf-lib 사용)
 *  - scanPdf: PDF에서 문항 위치/정답 표시 위치/문항 수를 자동으로 찾는다.
 *  - renderRect: PDF 페이지의 특정 영역을 이미지(캔버스)로 잘라낸다.
 *  - composeExamPdf: 선택한 문항 이미지들을 새 시험지 PDF로 조합한다.
 */
(function (root) {
  const COLUMN_GAP_MIN = 40;
  const TOP_PAD = 9;     // 문항 사이의 가는 구분선이 잘리지 않게 여유를 더 둔다
  const BOTTOM_PAD = 8;
  const CIRCLED = { '①': '1', '②': '2', '③': '3', '④': '4', '⑤': '5', '⑥': '6', '⑦': '7', '⑧': '8', '⑨': '9', '⑩': '10' };

  // ── 페이지 텍스트를 top 기준 좌표로 정리 ──
  async function pageItems(doc, pageNum) {
    const page = await doc.getPage(pageNum);
    const vp = page.getViewport({ scale: 1 });
    const H = vp.height, W = vp.width;
    const tc = await page.getTextContent();
    const items = [];
    for (const it of tc.items) {
      const str = it.str;
      if (!str || !str.trim()) continue;
      const size = Math.abs(it.transform[3]) || it.height || 0;
      const x = it.transform[4];
      const base = H - it.transform[5];          // 위에서부터 잰 baseline
      const h = it.height || size;
      items.push({
        str: str.trim(), x: x, w: it.width, size: Math.round(size * 10) / 10,
        top: base - h, bottom: base + h * 0.25, base: base,
      });
    }
    return { W: W, H: H, items: items };
  }

  const NUM_RE = /^(\d{1,2})[.)](\s|$)/;

  function numberSpans(pd) {
    const out = [];
    for (const it of pd.items) {
      const m = NUM_RE.exec(it.str);
      if (m) out.push({ num: parseInt(m[1], 10), x: it.x, x1: it.x + it.w, top: it.top, bottom: it.bottom, size: it.size });
    }
    return out;
  }

  // "N) 정답 ③" 표시 찾기 (정답 번호가 글자면 text로 읽고, 그림이면 text 없음)
  // "N) 정답 ③", "N)[정답] ③", "N.[정답]", "N번 【정답】 …" 같은 표시를 찾는다.
  //  - 정답이 ①~⑤ / 숫자면 text로 읽고, 문장이면(서술형 정답) written=true 로 표시한다
  //  - 정답 번호가 그림이라 안 읽히면 text 없이 위치만 돌려준다
  const MARK_OPEN = '[\\[\\(【<]?', MARK_CLOSE = '[\\]\\)】>]?';
  const MERGED_RE = new RegExp('^(\\d{1,2})\\s*[).]\\s*' + MARK_OPEN + '\\s*정답\\s*' + MARK_CLOSE + '\\s*[:：]?\\s*(.*)$');
  const NUM_ONLY_RE = /^(\d{1,2})\s*[).]$/;
  const MARK_ONLY_RE = new RegExp('^' + MARK_OPEN + '\\s*정답\\s*' + MARK_CLOSE + '$');

  function answerMarkers(pd) {
    const found = [];
    const its = pd.items;
    for (let i = 0; i < its.length; i++) {
      const it = its[i];
      let m = MERGED_RE.exec(it.str);
      let num, tail = '', top = it.top, bottom = it.bottom, base = it.base;
      let markerLeft = it.x, markerRight = it.x + it.w, numRect = null, nextIdx = i + 1;
      if (m) {
        num = parseInt(m[1], 10);
        tail = m[2].trim();
        // 글자 수 비율로 "N)" 부분의 위치를 어림한다 (옛 번호를 지우고 새 번호를 덮을 때 사용)
        const perChar = it.w / Math.max(1, it.str.length);
        const prefixLen = it.str.length - m[2].length;
        markerRight = it.x + prefixLen * perChar;
        const numLen = String(m[1]).length + 1;
        numRect = [it.x - 1, it.top - 1, it.x + numLen * perChar + 2, it.bottom + 1];
      } else {
        m = NUM_ONLY_RE.exec(it.str);
        if (!m) continue;
        const nxt = its[i + 1];
        if (!nxt || !MARK_ONLY_RE.test(nxt.str) || Math.abs(nxt.base - it.base) > 8 || nxt.x - (it.x + it.w) > 30 || nxt.x < it.x) continue;
        num = parseInt(m[1], 10);
        numRect = [it.x - 1, it.top - 1, it.x + it.w + 2, it.bottom + 1];
        markerRight = nxt.x + nxt.w;
        top = Math.min(top, nxt.top); bottom = Math.max(bottom, nxt.bottom);
        nextIdx = i + 2;
      }
      // 같은 줄 바로 오른쪽에 정답이 따로 떨어져 있으면 읽는다
      if (!tail) {
        const after = its[nextIdx];
        if (after && Math.abs(after.base - base) < 8 && after.x >= markerRight - 2 && after.x - markerRight < 40) tail = after.str;
      }
      let text = '', written = false;
      const t = tail.replace(/[:\s]/g, '');
      if (CIRCLED[t]) text = CIRCLED[t];
      else if (/^\d{1,2}$/.test(t)) text = t;
      else if (t.length >= 2) written = true;          // 문장으로 된 정답 = 서술형
      found.push({ num: num, rect: [markerLeft - 4, top - 4, markerRight + 70, bottom + 4], text: text, written: written, top: top, x: markerLeft, numRect: numRect });
    }
    return found;
  }


  // ── "정답 및 해설" 같은 제목으로 해설 영역의 시작 쪽을 찾는다 ──
  // 문항 번호 옆 정답 표시가 전부 그림이라 "N) 정답" 패턴이 하나도 안 잡히는 PDF에서도,
  // 이 제목 한 줄만 찾으면 그 뒤 페이지 전체를 해설 영역으로 확정할 수 있다.
  const EXPL_HEADING_RE = /정답\s*(및|과|와)?\s*(해설|풀이)|해설\s*(및|과|와)?\s*정답|정답\s*표/;
  const CHAPTER_TAG_RE = /^\d{1,2}-\d{1,2}\.$/;   // 문항마다 되풀이되는 "1-1." 같은 챕터 라벨
  function findExplHeadingPage(pages) {
    for (let i = 0; i < pages.length; i++) {
      const pd = pages[i];
      for (const it of pd.items) {
        if (EXPL_HEADING_RE.test(it.str)) return i + 1;
      }
      // 제목이 두 조각으로 나뉘어 찍히는 경우 대비 (예: "정답" + "및 해설")
      for (let j = 0; j < pd.items.length - 1; j++) {
        const a = pd.items[j], b = pd.items[j + 1];
        if (Math.abs(a.top - b.top) < 6 && EXPL_HEADING_RE.test(a.str + b.str)) return i + 1;
      }
    }
    return null;
  }

  function clusterColumns(spans) {
    if (spans.length < 2) return [spans];
    const xs = spans.map(s => s.x).sort((a, b) => a - b);
    let maxGap = 0, before = xs[0];
    for (let i = 0; i < xs.length - 1; i++) {
      const g = xs[i + 1] - xs[i];
      if (g > maxGap) { maxGap = g; before = xs[i]; }
    }
    if (maxGap < COLUMN_GAP_MIN) return [spans];
    const split = before + maxGap / 2;
    const left = spans.filter(s => s.x < split), right = spans.filter(s => s.x >= split);
    return left.length && right.length ? [left, right] : [spans];
  }

  // ── 해설 구간: "N) 정답" 표시부터 다음 표시 전까지 (단이 바뀌면 이어지는 부분까지 붙인다) ──
  function computeExplanations(pages, answerPages, qSize) {
    const out = {};
    if (!answerPages.length) return out;
    const first = answerPages[0], last = answerPages[answerPages.length - 1];
    // 2단 편집인지: 정답 표시들의 x가 크게 갈리면 2단
    const allX = [];
    for (let p = first; p <= last; p++) (pages[p - 1].markers || []).forEach(m => allX.push(m.x));
    if (!allX.length) return out;
    const two = Math.max.apply(null, allX) - Math.min.apply(null, allX) > 40;
    const W = pages[first - 1].W;
    const half = W / 2;
    const leftXs = allX.filter(x => !two || x < half), rightXs = allX.filter(x => two && x >= half);
    const leftX0 = Math.min.apply(null, leftXs) - 12;
    const rightX0 = two ? Math.min.apply(null, rightXs) - 12 : W;
    const colDefs = two ? [[leftX0, rightX0 - 4], [rightX0, W - leftX0]] : [[leftX0, W - leftX0]];

    let lastNum = null;
    for (let p = first; p <= last; p++) {
      const pd = pages[p - 1];
      const contentTop = pd.H * 0.096;
      colDefs.forEach((cd, ci) => {
        const inCol = it => (!two) || (ci === 0 ? it.x < half : it.x >= half);
        const ms = (pd.markers || []).filter(m => inCol({ x: m.x })).sort((a, b) => a.top - b.top);
        const body = pd.items.filter(it => inCol(it) && it.top >= contentTop && it.top < pd.H - 62);
        // 이어지는 부분: 이 단의 첫 표시 위쪽
        const firstTop = ms.length ? ms[0].top - 4 : pd.H - 62;
        if (lastNum !== null && firstTop - contentTop > 10 && body.some(it => it.top < firstTop)) {
          out[lastNum].segments.push({ page: p, rect: [cd[0], contentTop, cd[1], firstTop] });
        }
        ms.forEach((m, i) => {
          let bottom;
          if (i + 1 < ms.length) bottom = ms[i + 1].top - 6;
          else {
            // 이 단의 마지막 문항: 다음 표시가 없어서 어디까지가 이 해설인지 글자만으론 알기 어렵다.
            // 해설 문단이 그림(글자로 안 읽히는 폰트)으로 되어 있으면 body에 아무것도 안 잡히는데,
            // 그렇다고 상자를 작게 잡으면 실제 해설이 통째로 잘려나간다.
            // → 글자를 못 찾으면 "너무 작게"보다는 "이 칸의 바닥까지"로 넉넉하게 잡는다(빈 여백이 좀 남는 게,
            //   해설이 잘리는 것보다 낫다).
            // 표시 자기 자신과 "해설" 배지 글자는 상자 아래쪽 경계로 치지 않는다 — 마커 자신의
            // 줄(예: "13.")이 자기보다 낮은 텍스트가 없다는 이유로 스스로를 경계로 써버리는 것과,
            // 그 밑의(글자로 안 읽히는) 해설 문단을 "해설" 배지 위치에서 멈춰버리는 것을 막는다.
            const lows = body
              .filter(it => it.top > m.bottom && it.str.trim() !== '해설' &&
                (!qSize || it.size >= qSize * 0.65) && !CHAPTER_TAG_RE.test(it.str.trim()))
              .map(it => it.bottom);
            bottom = (lows.length ? Math.max.apply(null, lows) : pd.H - 62) + 6;
          }
          if (!out[m.num]) out[m.num] = { segments: [], numRect: m.numRect };
          out[m.num].segments.push({ page: p, rect: [cd[0], m.top - 4, cd[1], bottom] });
        });
        if (ms.length) lastNum = ms[ms.length - 1].num;
      });
    }
    return out;
  }

  // ── PDF 전체 스캔 ──
  async function scanPdf(doc, onProgress) {
    const n = doc.numPages;
    const pages = [];
    for (let p = 1; p <= n; p++) {
      pages.push(await pageItems(doc, p));
      if (onProgress) onProgress(p, n);
    }

    // 1) 문항 번호 글자 크기 = "서로 다른 번호가 가장 많이 나오는 크기 중 가장 큰 것"
    const groups = {};
    pages.forEach((pd, idx) => {
      const markerNums = new Set(answerMarkers(pd).map(a => a.num));
      pages[idx].markers = answerMarkers(pd);
      for (const s of numberSpans(pd)) {
        (groups[s.size] = groups[s.size] || new Set()).add(s.num);
      }
    });
    let maxDistinct = 0;
    Object.values(groups).forEach(set => { if (set.size > maxDistinct) maxDistinct = set.size; });
    let qSize = null;
    Object.keys(groups).map(Number).sort((a, b) => b - a).forEach(sz => {
      if (qSize === null && groups[sz].size >= Math.max(2, maxDistinct * 0.8)) qSize = sz;
    });

    // 1.5) "정답 및 해설" 같은 제목이 있으면, 정답 표시를 글자로 못 읽더라도
    //      그 뒤 페이지 전체는 해설 영역으로 확정하고, 문항 번호와 같은 크기의 "N." 표시를
    //      (곁에 "정답"이라는 글자가 없어도) 해설 시작 표시로 대신 사용한다.
    const explHeadingPage = findExplHeadingPage(pages);
    if (explHeadingPage !== null) {
      for (let idx = explHeadingPage - 1; idx < pages.length; idx++) {
        const pd = pages[idx];
        if (pd.markers.length || qSize === null) continue;   // 이미 글자로 읽혔으면 그대로 둔다
        pd.markers = numberSpans(pd)
          .filter(s => Math.abs(s.size - qSize) < 1.0)
          .map(s => ({
            num: s.num, x: s.x, top: s.top, bottom: s.bottom, base: s.bottom,
            rect: [s.x - 4, s.top - 4, s.x1 + 70, s.bottom + 4],
            text: '', written: false, numRect: [s.x - 1, s.top - 1, s.x1 + 2, s.bottom + 1],
          }));
      }
    }

    // 2) 정답 표시(페이지별)
    const answers = {};
    const answerPages = [];
    pages.forEach((pd, idx) => {
      if (pd.markers.length) answerPages.push(idx + 1);
      pd.markers.forEach(m => {
        if (!answers[m.num]) answers[m.num] = { page: idx + 1, rect: m.rect, text: m.text, written: !!m.written };
      });
    });

    // 3) 문항 위치 계산
    const questions = [];
    const questionPages = [];
    pages.forEach((pd, idx) => {
      if (answerPages.includes(idx + 1) || qSize === null) return;
      const spans = numberSpans(pd).filter(s => Math.abs(s.size - qSize) < 1.0);
      if (!spans.length) return;
      questionPages.push(idx + 1);
      const contentTop = Math.min.apply(null, spans.map(s => s.top)) - 3;
      const body = pd.items.filter(it => it.top >= contentTop && it.top < pd.H - 62);
      const cols = clusterColumns(spans);
      let splitX = null;
      if (cols.length === 2) {
        splitX = (Math.max.apply(null, cols[0].map(s => s.x)) + Math.min.apply(null, cols[1].map(s => s.x))) / 2;
      }
      const colX0 = cols.map(cs => Math.min.apply(null, cs.map(s => s.x)) - 6);
      const leftMargin = Math.min.apply(null, colX0);
      cols.forEach((colSpans, ci) => {
        colSpans.sort((a, b) => a.top - b.top);
        const colItems = splitX === null ? body : body.filter(it => ci === 0 ? it.x < splitX : it.x >= splitX);
        // 왼쪽 경계 = 각 단의 문항 번호 위치 (그림/표 안 글자에 흔들리지 않게)
        const x0 = colX0[ci];
        // 오른쪽 경계 = 다음 단 시작 직전, 마지막 단은 좌우 여백이 같다고 보고 페이지 폭에서 계산
        const measured = Math.max.apply(null, colItems.map(it => it.x + it.w).concat(colSpans.map(s => s.x1))) + 6;
        const x1 = ci + 1 < cols.length ? colX0[ci + 1] - 4 : Math.max(measured, pd.W - leftMargin);
        colSpans.forEach((s, i) => {
          const top = Math.max(0, s.top - TOP_PAD);
          let bottom;
          if (i + 1 < colSpans.length) bottom = colSpans[i + 1].top - TOP_PAD - 1;
          else {
            // 이 단의 마지막 문항: 문항 번호 자기 자신의 줄은 "그 밑에 내용이 있다"는 근거로 못 쓴다
            // (자기 자신만 잡히면 문항이 통째로 잘린다 — 특히 본문이 그림/이미지 형태라 글자로
            //  안 읽히는 경우 이 문제가 생긴다).
            // 챕터 라벨("1-1.")이나 그보다 확연히 작은 글자(난이도 배지 등)는 바닥 경계로 안 쓴다 —
            // 이런 게 문항 바로 밑 여백에 살짝 걸리면, 진짜 내용이 있는 훨씬 아래쪽 대신 그 배지
            // 위치에서 문항이 끊겨버린다.
            const lows = colItems
              .filter(it => it.top > s.bottom && it.size >= qSize * 0.65 && !CHAPTER_TAG_RE.test(it.str.trim()))
              .map(it => it.bottom);
            bottom = lows.length ? Math.max.apply(null, lows) : pd.H - 62;
          }
          questions.push({ page: idx + 1, num: s.num, rect: [Math.max(0, x0), top, Math.min(pd.W, x1), bottom + BOTTOM_PAD], numRect: [s.x, s.top, s.x1, s.bottom] });
        });
      });
    });
    questions.sort((a, b) => a.page - b.page || a.rect[0] - b.rect[0] || a.rect[1] - b.rect[1]);

    // 4) 추정 문항 수 = 가장 큰 문항 번호
    const questionCount = questions.reduce((m, q) => Math.max(m, q.num), 0);
    const explanations = computeExplanations(pages, answerPages, qSize);
    return { pageCount: n, questions: questions, answers: answers, explanations: explanations, questionPages: questionPages, answerPages: answerPages, questionCount: questionCount };
  }

  // ── 영역 이미지로 자르기 ──
  function createCanvas(w, h) {
    if (root.BankCore && root.BankCore._createCanvas) return root.BankCore._createCanvas(w, h);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  async function renderRect(doc, pageNum, rect, scale, trimBottom) {
    const page = await doc.getPage(pageNum);
    const x0 = rect[0], y0 = rect[1], w = Math.max(4, rect[2] - rect[0]), h = Math.max(4, rect[3] - rect[1]);
    const viewport = page.getViewport({ scale: scale, offsetX: -x0 * scale, offsetY: -y0 * scale });
    const canvas = createCanvas(Math.ceil(w * scale), Math.ceil(h * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: viewport, canvas: canvas }).promise;
    return trimBottom ? trimBottomWhite(canvas, Math.round(6 * scale)) : canvas;
  }

  // 해설 구간들을 세로로 이어붙인 이미지 하나로 만든다. 원본 문항 번호("7)")는 지워서 새 번호와 안 헷갈리게 한다.
  async function renderExplanation(doc, expl, scale) {
    const parts = [];
    for (let i = 0; i < expl.segments.length; i++) {
      const sg = expl.segments[i];
      const c = await renderRect(doc, sg.page, sg.rect, scale, false);
      if (i === 0 && expl.numRect) {
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff';
        const r = expl.numRect;
        ctx.fillRect((r[0] - sg.rect[0]) * scale, (r[1] - sg.rect[1]) * scale, (r[2] - r[0]) * scale, (r[3] - r[1]) * scale);
      }
      parts.push(c);
    }
    if (parts.length === 1) return parts[0];
    const w = Math.max.apply(null, parts.map(c => c.width));
    const h = parts.reduce((a, c) => a + c.height, 0);
    const out = createCanvas(w, h);
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    let y = 0;
    parts.forEach(c => { ctx.drawImage(c, 0, y); y += c.height; });
    return out;
  }

  function trimBottomWhite(canvas, pad) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const data = ctx.getImageData(0, 0, w, h).data;
    let last = 0;
    for (let y = h - 1; y >= 0 && !last; y--) {
      const row = y * w * 4;
      for (let x = 0; x < w; x += 2) {
        const i = row + x * 4;
        if (data[i] < 226 || data[i + 1] < 226 || data[i + 2] < 226) { last = y; break; }
      }
    }
    const newH = Math.min(h, Math.max(20, last + pad));
    if (newH >= h - 2) return canvas;
    const out = createCanvas(w, newH);
    out.getContext('2d').drawImage(canvas, 0, 0, w, newH, 0, 0, w, newH);
    return out;
  }

  function canvasToBase64(canvas) {
    const url = canvas.toDataURL('image/png');
    return url.substring(url.indexOf(',') + 1);
  }

  async function textPreview(doc, pageNum, rect, maxLen) {
    const pd = await pageItems(doc, pageNum);
    const inside = pd.items.filter(it => it.x >= rect[0] - 2 && it.x <= rect[2] && it.top >= rect[1] - 2 && it.top <= rect[3]);
    const t = inside.map(it => it.str).join(' ');
    return t.length > maxLen ? t.substring(0, maxLen) + '…' : t;
  }

  // ── 제목/안내 문구를 이미지로 그려서 PDF에 넣기 (한글 폰트 없이도 되도록) ──
  function headerPng(title, width, subtitle) {
    const scale = 3;
    const c = createCanvas(width * scale, 44 * scale);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#111';
    ctx.font = 'bold ' + (16 * scale) + 'px "Noto Sans KR","Malgun Gothic","Apple SD Gothic Neo",sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(title, 0, 2 * scale);
    ctx.fillStyle = '#6B7280';
    ctx.font = (9 * scale) + 'px "Noto Sans KR","Malgun Gothic","Apple SD Gothic Neo",sans-serif';
    ctx.fillText(subtitle || '※ 문항 왼쪽의 빨간 원 번호가 답안 입력 번호입니다. (문항 안에 다른 번호가 보여도 무시하세요)', 0, 26 * scale);
    return canvasToBase64(c);
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }

  // images: [{ base64, width, height, naturalW, numRect? }] 순서대로 1번부터
  //   naturalW = 원본 크기(pt) 기준 가로, numRect = 이미지 안 "옛 문항 번호"의 위치 [x0,top,x1,bottom] (pt, 이미지 왼쪽 위 기준)
  // 2단으로 배치한다: 왼쪽 단을 위에서 아래로 채우고, 다 차면 오른쪽 단, 그다음 새 페이지.
  // 옛 번호 위치를 아는 문항은 그 자리를 흰색으로 지우고 새 번호(빨간 원)를 덮어쓴다.
  // 위치를 모르는 문항(예전에 저장한 것)은 왼쪽 여백에 빨간 원을 붙인다.
  // opts: { subtitle, qrReserve(머리글 오른쪽에 비워둘 폭 pt) }
  async function composeExamPdf(PDFLib, title, images, opts) {
    opts = opts || {};
    const { PDFDocument, rgb, StandardFonts } = PDFLib;
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    const W = 595.28, H = 841.89;
    const useGutter = images.some(im => !im.numRect);          // 번호 위치를 모르는 문항이 있을 때만 왼쪽 여백을 쓴다
    const marginX = 30, marginTop = opts.marginTop || 74, marginBottom = 36, gap = 14, colGap = 14, gutter = useGutter ? 26 : 0;
    const areaW = W - marginX * 2;
    const colW = (areaW - colGap) / 2;
    const colImgW = colW - gutter;
    const colX = [marginX + gutter, marginX + colW + colGap + gutter];
    const subtitle = opts.subtitle || (useGutter
      ? '※ 문항 왼쪽의 빨간 원 번호가 답안 입력 번호입니다. (문항 안에 다른 번호가 보여도 무시하세요)'
      : '※ 문항 번호 자리의 빨간 원 번호가 답안 입력 번호입니다.');
    const headW = Math.round(areaW - (opts.qrReserve || 0));
    const headImg = await doc.embedPng(b64ToBytes(headerPng(title, headW, subtitle)));
    const maxH = H - marginTop - marginBottom;
    const RED = rgb(0.757, 0.224, 0.169);
    const GREY = rgb(0.95, 0.95, 0.95);

    let page, ys, col;
    function newPage() {
      page = doc.addPage([W, H]);
      page.drawImage(headImg, { x: marginX, y: H - 62, width: headW, height: 44 });
      ys = [H - marginTop, H - marginTop];
      col = 0;
    }
    function label(cx, cy, r, n, subj) {
      page.drawCircle({ x: cx, y: cy, size: r, color: RED });
      const t = String(n), fs = t.length > 1 ? 10.5 : 12, tw = font.widthOfTextAtSize(t, fs);
      page.drawText(t, { x: cx - tw / 2, y: cy - fs * 0.34, size: fs, font: font, color: rgb(1, 1, 1) });
      if (subj) {
        // 서술형(주관식)은 OMR 번호처럼 보이지 않게, 배지 밑에 작은 꼬리표를 따로 붙인다
        const tag = '서술형', tfs = 8, ttw = font.widthOfTextAtSize(tag, tfs);
        const tx = cx - ttw / 2 - 3, ty = cy - r - tfs - 5;
        page.drawRectangle({ x: tx, y: ty, width: ttw + 6, height: tfs + 5, color: GREY, borderColor: RED, borderWidth: 0.75 });
        page.drawText(tag, { x: tx + 3, y: ty + 2.2, size: tfs, font: font, color: RED });
      }
    }
    // 왼쪽 여백에 붙이는 번호 (번호 위치를 모를 때)
    function gutterBadge(cx, topY, n, subj) { label(cx, topY - 13, 11, n, subj); }
    // 옛 번호를 흰색으로 지우고 그 자리에 새 번호를 덮는다
    function overlayNumber(x, topY, drawW, im, n, subj) {
      const sc = drawW / im.naturalW, nr = im.numRect;
      const left = x + nr[0] * sc, right = x + nr[2] * sc, top = topY - nr[1] * sc, bottom = topY - nr[3] * sc;
      page.drawRectangle({ x: left - 1.5, y: bottom - 1.5, width: (right - left) + 3, height: (top - bottom) + 3, color: rgb(1, 1, 1) });
      const h = top - bottom;
      const cx = (left + right) / 2, cy = top - h * 0.46;
      label(cx, cy, Math.max(9.5, Math.min(12, h * 0.62)), n, subj);
    }
    function mark(x, topY, drawW, im, n, badgeX) {
      const subj = String(im.answer) === '-';
      if (im.numRect && im.naturalW) overlayNumber(x, topY, drawW, im, n, subj);
      else gutterBadge(badgeX, topY, n, subj);
    }

    newPage();
    for (let i = 0; i < images.length; i++) {
      const im = images[i];
      const img = await doc.embedPng(b64ToBytes(im.base64));
      const wide = (im.naturalW || 0) > colImgW * 1.25;
      const targetW = wide ? Math.min(areaW - gutter, im.naturalW) : colImgW;
      let drawW = targetW, drawH = im.height * (drawW / im.width);
      if (drawH > maxH) { drawW *= maxH / drawH; drawH = maxH; }

      if (wide) {
        let top = Math.min(ys[0], ys[1]);
        if (top - drawH < marginBottom) { newPage(); top = ys[0]; }
        const x = marginX + gutter;
        page.drawImage(img, { x: x, y: top - drawH, width: drawW, height: drawH });
        mark(x, top, drawW, im, i + 1, marginX + 11);
        ys[0] = ys[1] = top - drawH - gap;
        col = 0;
      } else {
        if (ys[col] - drawH < marginBottom) {
          if (col === 0) { col = 1; }
          else { newPage(); }
          if (ys[col] - drawH < marginBottom && ys[col] < H - marginTop) { newPage(); }
        }
        const top = ys[col];
        page.drawImage(img, { x: colX[col], y: top - drawH, width: drawW, height: drawH });
        mark(colX[col], top, drawW, im, i + 1, colX[col] - gutter + 11);
        ys[col] = top - drawH - gap;
      }
    }
    return doc;   // 호출한 쪽에서 QR을 찍고 save()
  }

  // 시험지 PDF 뒤에 해설지 PDF를 그대로 이어붙여서 한 파일로 만든다 (다운로드 한 번으로 끝나게).
  // 시험지 쪽수가 홀수면, 양면 인쇄했을 때 해설지가 시험지 마지막 장 뒷면에 붙지 않도록
  // 빈 페이지를 한 장 끼워서 해설지가 항상 새 장의 앞면부터 시작하게 한다.
  async function mergePdfs(PDFLib, mainDoc, extraDoc) {
    if (!extraDoc) return mainDoc;
    if (mainDoc.getPageCount() % 2 === 1) {
      const last = mainDoc.getPage(mainDoc.getPageCount() - 1);
      const { width, height } = last.getSize();
      mainDoc.addPage([width, height]);   // 빈 페이지 (아무것도 안 그림)
    }
    const idx = extraDoc.getPageIndices();
    const copied = await mainDoc.copyPages(extraDoc, idx);
    copied.forEach(p => mainDoc.addPage(p));
    return mainDoc;
  }

  // 완성된 문서의 모든 쪽 아래에 "N / 전체" 쪽번호를 찍는다. 맨 마지막에, 쪽수가 다 정해진
  // 뒤에 한 번만 호출한다.
  async function addPageNumbers(PDFLib, doc) {
    const { StandardFonts, rgb } = PDFLib;
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const pages = doc.getPages();
    const total = pages.length;
    pages.forEach((page, i) => {
      const t = (i + 1) + ' / ' + total;
      const fs = 9, tw = font.widthOfTextAtSize(t, fs);
      page.drawText(t, { x: page.getWidth() / 2 - tw / 2, y: 16, size: fs, font: font, color: rgb(0.55, 0.55, 0.55) });
    });
  }

  // ── 암호(복사방지)가 걸려서 pdf-lib이 내용을 못 읽는 PDF를 다룬다 ──
  // pdf-lib은 PDF 안의 글자·그림(스트림) 자체를 푸는 기능이 없어서, 암호가 걸린 파일은
  // ignoreEncryption으로 "일단 열기"는 되어도 저장한 결과물이 속 내용은 깨진 채로 나온다.
  // 반면 pdf.js는 화면에 보여주려고 이미 암호를 풀고 있으니(스캔 때 쓰던 바로 그 기능),
  // 그 결과(화면에 그려진 모습)를 그대로 사진처럼 떠서 새 PDF를 만든다. 글자를 선택은
  // 못 하게 되지만, 내용이 깨지지 않고 확실하게 열린다.
  // onlyPages를 주면(배열이 1개 이상) 그 쪽들만 포함한다(해설지 뽑을 때 씀).
  // 안 주면 excludePages만 빼고 전부 포함한다(학생용 시험지 만들 때 씀).
  async function rasterizeToPdf(PDFLib, doc, excludePages, scale, onlyPages) {
    const out = await PDFLib.PDFDocument.create();
    const exclude = new Set(excludePages || []);
    const only = onlyPages && onlyPages.length ? new Set(onlyPages) : null;
    const sc = scale || 2.2;
    for (let p = 1; p <= doc.numPages; p++) {
      if (only ? !only.has(p) : exclude.has(p)) continue;
      const page = await doc.getPage(p);
      const vp1 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: sc });
      const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const bytes = b64ToBytes(canvasToBase64(canvas));
      const img = await out.embedPng(bytes);
      const newPage = out.addPage([vp1.width, vp1.height]);
      newPage.drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });
    }
    return out;
  }

  // pdf-lib으로 이 PDF를 다룰 수 있는지(암호 때문에 내용이 깨지지 않는지) 확인한다.
  // 진짜 열어 보는 것 말고는 확실한 방법이 없어서, 실제로 열어서 /Encrypt 표시가 있는지 본다.
  async function needsRasterize(PDFLib, bytes) {
    try {
      await PDFLib.PDFDocument.load(bytes.slice(0));
      return false;   // 암호가 없으면 평소대로 처리
    } catch (e) {
      return /encrypted/i.test(e.message || '');
    }
  }

  // ── PDF 위에 표시한 "이 자리 지우기" 영역을 실제로 흰색으로 덮는다 ──
  // redactions: [{page, rect:[x0,top,x1,bottom]}] (rect는 페이지 위쪽 기준 좌표, PdfPane이 쓰는 것과 동일)
  function applyRedactions(PDFLib, doc, redactions) {
    const { rgb } = PDFLib;
    (redactions || []).forEach(r => {
      const idx = r.page - 1;
      if (idx < 0 || idx >= doc.getPageCount()) return;
      const page = doc.getPage(idx);
      const h = page.getHeight();
      const [x0, top, x1, bottom] = r.rect;
      page.drawRectangle({
        x: Math.min(x0, x1), y: h - Math.max(top, bottom),
        width: Math.abs(x1 - x0), height: Math.abs(bottom - top),
        color: rgb(1, 1, 1),
      });
    });
  }

  // ── 출처 워터마크·사이트명처럼 흔히 지우고 싶어하는 글자를 자동으로 찾아 위치를 알려준다 ──
  // (정확한 글자를 못 찾아도 괜찮다 — 어차피 선생님이 직접 드래그로 지울 수 있으니, 이건 "그냥 도와주는" 정도)
  const WATERMARK_RE = /족보\s*닷\s*컴|족보닷컴|zocbo|기출비급|교육지대|스카이에듀|이투스|해법교육|해커스|메가스터디|엠베스트|비상교육|천재교육|미래엔|동아출판|지학사|\.com\b|\.co\.kr\b|워터마크/i;
  const NAME_FIELD_RE = /이\s*름\s*[:：]|성\s*명\s*[:：]|반\s*[:：]|번\s*호\s*[:：]/;
  async function findWatermarkCandidates(doc) {
    const n = doc.numPages;
    const out = [];
    for (let p = 1; p <= n; p++) {
      const pd = await pageItems(doc, p);
      pd.items.forEach(it => {
        const t = it.str.trim();
        if (!t) return;
        if (WATERMARK_RE.test(t) || NAME_FIELD_RE.test(t)) {
          out.push({ page: p, rect: [it.x - 2, it.top - 2, it.x + it.w + 2, it.bottom + 2], text: t });
        }
      });
    }
    return out;
  }

  // ── 글자 내용으로 "비슷한 문제" 찾기 (문제은행 연결 정보가 없는 시험에서 씀) ──
  // 한글은 띄어쓰기로 깔끔하게 안 나뉘어서, 2글자씩 겹쳐 자른 조각(bigram)의 겹치는 정도로 비슷함을 어림한다.
  function bigrams(text) {
    const clean = String(text || '').replace(/[\s\d.,()·%℃∼~\-]/g, '');
    const set = new Set();
    for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2));
    return set;
  }
  function textSimilarity(a, b) {
    const A = bigrams(a), B = bigrams(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    A.forEach(g => { if (B.has(g)) inter++; });
    return inter / (A.size + B.size - inter);   // 자카드 유사도: 0(안 비슷)~1(똑같음)
  }
  // queries: [{num, text}, ...] 틀린 문항들. pool: 문제은행 문항 목록(.id, .textPreview 필요).
  // 각 틀린 문항마다 가장 비슷한 것부터 최대 perQuery개, 전체에서 중복 없이 고른다.
  function findSimilarQuestions(queries, pool, excludeIds, perQuery) {
    const used = new Set(excludeIds || []);
    const picks = [], detail = [];
    queries.forEach(q => {
      const scored = pool.filter(p => !used.has(p.id))
        .map(p => ({ p: p, score: textSimilarity(q.text, p.textPreview) }))
        .sort((a, b) => b.score - a.score);
      const chosen = scored.slice(0, perQuery || 1).filter(s => s.score > 0.04);
      chosen.forEach(c => { picks.push(c.p); used.add(c.p.id); });
      detail.push({ num: q.num, matched: chosen.length });
    });
    return { picks: picks, detail: detail };
  }

  // ── 정답표(글자로 된 "1 ① 2 ③ ..." 형태) 읽기: 문제 페이지 뒤쪽 페이지에서만 찾는다 ──
  async function parseAnswerTable(doc, scan) {
    const lastQ = scan.questionPages && scan.questionPages.length ? Math.max.apply(null, scan.questionPages) : 0;
    const found = {}, usedPages = [];
    for (let p = lastQ + 1; p <= scan.pageCount; p++) {
      const pd = await pageItems(doc, p);
      const its = pd.items.slice().sort((a, b) => Math.round(a.top / 4) - Math.round(b.top / 4) || a.x - b.x);
      const text = its.map(i => i.str).join(' ');
      const re = /(\d{1,2})\s*[.)번:]?\s*([①②③④⑤])/g;
      let m, cnt = 0;
      while ((m = re.exec(text))) { const n = parseInt(m[1], 10); if (!(n in found)) { found[n] = CIRCLED[m[2]]; cnt++; } }
      if (cnt) usedPages.push(p);
    }
    const out = {}; let n = 1;
    while (found[n]) { out[n] = found[n]; n++; }        // 1번부터 끊기지 않고 이어지는 부분만 인정
    const need = Math.max(5, Math.round((scan.questionCount || 0) * 0.6));
    if (n - 1 < need) return { answers: {}, pages: [] };
    return { answers: out, pages: usedPages };
  }

  // ── 주관식(서술형·단답형) 문항 추정: 문제 글자에 "쓰시오/서술하시오/설명하시오…" 같은 말이 있으면 주관식으로 본다.
  //    ①②③④⑤ 보기가 3개 이상 글자로 읽히면 객관식으로 본다.
  const SUBJ_RE = /서술형|서답형|서술하시오|서술하고|쓰시오|설명하시오|밝히시오|적으시오|말하시오|구하시오|풀이 과정|과정을 쓰|이유를 쓰|쓰고|물음에 답하시오|답하시오|서술|논술|빈칸에?\s*들어갈 말을?\s*쓰|들어갈 말을 쓰/;
  async function subjectiveGuess(doc, scan) {
    const cache = {}, out = {};
    for (const q of scan.questions) {
      const qt = await textInRect(doc, cache, q.page, q.rect);
      const choices = (qt.match(/[①②③④⑤]/g) || []).length;
      const ans = scan.answers && scan.answers[q.num];
      out[q.num] = choices < 3 && (SUBJ_RE.test(qt) || !!(ans && ans.written));
    }
    return out;
  }

  // ── 난이도 추정 (외부 AI 없이, 문제·해설의 특징으로 점수를 매긴다) ──
  // 점수가 높을수록 어려운 문항. 절대 기준이 없으니 "같은 문제집 안에서의 상대 순위"로 상·중·하를 나눈다.
  function difficultyScore(qText, eText) {
    const q = qText || '', e = eText || '';
    const qLen = q.replace(/\s/g, '').length, eLen = e.replace(/\s/g, '').length;
    const stm = (q.match(/[ㄱㄴㄷㄹㅁㅂ]\./g) || []).length + (q.match(/\([가나다라마]\)/g) || []).length;
    const calc = /구하|몇 ?g|몇 ?mL|몇 ?%|질량비|부피비|계수의 총합|계산|화학 반응식으로|질량은|비율은|속력|밀도|농도/.test(q);
    const vis = /그림|그래프|모형|표|실험 결과|장치|비율/.test(q);
    const steps = /자료 분석|손풀이|❶|➊/.test(e);
    const sc = Math.min(eLen / 100, 6) + (steps ? 1.5 : 0) + (calc ? 0.8 : 0) + (vis ? 0.5 : 0) +
      Math.min(stm, 6) * 0.15 + qLen / 300;
    return Math.round(sc * 100) / 100;
  }

  async function textInRect(doc, cache, pageNum, rect) {
    if (!cache[pageNum]) cache[pageNum] = await pageItems(doc, pageNum);
    const pd = cache[pageNum];
    const inside = pd.items.filter(it => it.x >= rect[0] - 2 && it.x <= rect[2] && it.top >= rect[1] - 2 && it.top <= rect[3]);
    inside.sort((a, b) => Math.round(a.top / 3) - Math.round(b.top / 3) || a.x - b.x);
    return inside.map(it => it.str).join(' ');
  }

  // scan 결과의 각 문항에 난이도 점수를 붙여서 {문항번호: 점수}로 돌려준다
  async function difficultyScores(doc, scan) {
    const cache = {}, out = {};
    for (const q of scan.questions) {
      const qt = await textInRect(doc, cache, q.page, q.rect);
      let et = '';
      const ex = scan.explanations && scan.explanations[q.num];
      if (ex) for (const sg of ex.segments) et += ' ' + await textInRect(doc, cache, sg.page, sg.rect);
      out[q.num] = difficultyScore(qt, et);
    }
    return out;
  }

  // 점수 목록을 순위로 나눠 상/중/하를 붙인다. topPct·lowPct는 상·하 비율(%)
  function classifyByRank(scores, topPct, lowPct) {
    const idx = scores.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const n = idx.length, lo = Math.round(n * lowPct / 100), hi = n - Math.round(n * topPct / 100);
    const res = new Array(n);
    idx.forEach((pair, r) => { res[pair[1]] = r < lo ? '하' : (r >= hi ? '상' : '중'); });
    return res;
  }

  root.BankCore = {
    scanPdf: scanPdf, parseAnswerTable: parseAnswerTable, subjectiveGuess: subjectiveGuess, difficultyScores: difficultyScores, difficultyScore: difficultyScore, classifyByRank: classifyByRank, renderRect: renderRect, renderExplanation: renderExplanation, canvasToBase64: canvasToBase64,
    textPreview: textPreview, composeExamPdf: composeExamPdf, mergePdfs: mergePdfs, addPageNumbers: addPageNumbers,
    textSimilarity: textSimilarity, findSimilarQuestions: findSimilarQuestions,
    applyRedactions: applyRedactions, findWatermarkCandidates: findWatermarkCandidates,
    rasterizeToPdf: rasterizeToPdf, needsRasterize: needsRasterize,
    b64ToBytes: b64ToBytes, CROP_SCALE: 2.5,
  };
})(typeof window !== 'undefined' ? window : globalThis);
