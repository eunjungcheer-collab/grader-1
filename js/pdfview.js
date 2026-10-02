// 왼쪽에 PDF를 크게 띄워 놓고 보면서 정답을 입력할 수 있게 해주는 뷰어
// - 화면에 보이는 쪽만 그려서(지연 렌더링) 쪽수가 많아도 가벼워요
// - highlight(): 특정 쪽의 특정 위치에 빨간 테두리를 표시하고 그 자리로 스크롤해요
(function (root) {
  function PdfPane(scrollEl) {
    this.el = scrollEl;
    this.el.style.position = 'relative';
    this.doc = null;
    this.scale = 1.25;
    this.token = 0;
    this.io = null;
    this.pageEls = [];
    this.hl = null;
    this.redactMode = false;
    this.redactions = [];          // [{page, rect:[x0,top,x1,bottom]}]
    this.onRedactionsChange = null; // 목록이 바뀔 때마다 호출(선택)
  }

  PdfPane.prototype.setDoc = async function (doc, startPage) {
    this.doc = doc;
    await this._build(startPage || 1);
  };

  PdfPane.prototype._build = async function (goPage) {
    const my = ++this.token;
    if (this.io) this.io.disconnect();
    this.el.innerHTML = '';
    this.pageEls = [];
    this.hl = null;
    if (!this.doc) return;
    const n = this.doc.numPages;
    const first = await this.doc.getPage(1);
    const vp1 = first.getViewport({ scale: this.scale });
    if (my !== this.token) return;
    const self = this;
    this.io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) self._render(parseInt(e.target.dataset.page, 10), my); });
    }, { root: this.el, rootMargin: '700px 0px' });
    for (let p = 1; p <= n; p++) {
      const d = document.createElement('div');
      d.className = 'pdf-page';
      d.dataset.page = p;
      d.style.width = Math.round(vp1.width) + 'px';
      d.style.height = Math.round(vp1.height) + 'px';
      d.innerHTML = '<span class="plabel">' + p + '쪽</span>';
      this.el.appendChild(d);
      this.pageEls.push(d);
      this.io.observe(d);
      this._attachDrag(d, p);
    }
    this._repaintRedactions();
    if (goPage) this.scrollToPage(goPage);
  };

  // ── 드래그로 "이 자리 지우기" 영역 표시 ──
  PdfPane.prototype.setRedactMode = function (on) {
    this.redactMode = !!on;
    this.el.classList.toggle('redact-mode', this.redactMode);
  };

  PdfPane.prototype._attachDrag = function (pageEl, pageNum) {
    const self = this;
    let box = null, startX = 0, startY = 0, dragging = false;
    pageEl.addEventListener('pointerdown', function (e) {
      if (!self.redactMode || e.button === 2) return;
      const rect = pageEl.getBoundingClientRect();
      startX = e.clientX - rect.left; startY = e.clientY - rect.top;
      dragging = true;
      box = document.createElement('div');
      box.className = 'redact-draft';
      pageEl.appendChild(box);
      e.preventDefault();
    });
    pageEl.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      const rect = pageEl.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      const left = Math.min(startX, x), top = Math.min(startY, y);
      box.style.left = left + 'px'; box.style.top = top + 'px';
      box.style.width = Math.abs(x - startX) + 'px'; box.style.height = Math.abs(y - startY) + 'px';
    });
    pageEl.addEventListener('pointerup', function (e) {
      if (!dragging) return;
      dragging = false;
      const rect = pageEl.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      const left = Math.min(startX, x), top = Math.min(startY, y);
      const w = Math.abs(x - startX), h = Math.abs(y - startY);
      box.remove(); box = null;
      if (w < 6 || h < 6) return;
      const s = self.scale;
      self.addRedaction(pageNum, [left / s, top / s, (left + w) / s, (top + h) / s]);
    });
    pageEl.addEventListener('pointerleave', function () { if (dragging && box) { box.remove(); box = null; dragging = false; } });
  };

  PdfPane.prototype.addRedaction = function (page, rect) {
    this.redactions.push({ page: page, rect: rect });
    this._repaintRedactions();
    if (this.onRedactionsChange) this.onRedactionsChange(this.redactions);
  };

  PdfPane.prototype.removeRedaction = function (i) {
    this.redactions.splice(i, 1);
    this._repaintRedactions();
    if (this.onRedactionsChange) this.onRedactionsChange(this.redactions);
  };

  PdfPane.prototype.clearRedactions = function () {
    this.redactions = [];
    this._repaintRedactions();
    if (this.onRedactionsChange) this.onRedactionsChange(this.redactions);
  };

  PdfPane.prototype._repaintRedactions = function () {
    this.pageEls.forEach(h => { h.querySelectorAll('.redact-box').forEach(b => b.remove()); });
    const s = this.scale;
    this.redactions.forEach((r, i) => {
      const h = this.pageEls[r.page - 1];
      if (!h) return;
      const box = document.createElement('div');
      box.className = 'redact-box';
      box.style.left = Math.round(r.rect[0] * s) + 'px';
      box.style.top = Math.round(r.rect[1] * s) + 'px';
      box.style.width = Math.round((r.rect[2] - r.rect[0]) * s) + 'px';
      box.style.height = Math.round((r.rect[3] - r.rect[1]) * s) + 'px';
      const rm = document.createElement('button');
      rm.type = 'button'; rm.className = 'redact-rm'; rm.textContent = '×';
      rm.title = '이 영역 지우기 취소';
      rm.addEventListener('pointerdown', e => e.stopPropagation());
      rm.addEventListener('click', e => { e.stopPropagation(); this.removeRedaction(i); });
      box.appendChild(rm);
      h.appendChild(box);
    });
  };

  PdfPane.prototype._render = async function (p, tok) {
    const holder = this.pageEls[p - 1];
    if (!holder || holder.dataset.done || tok !== this.token) return;
    holder.dataset.done = '1';
    try {
      const page = await this.doc.getPage(p);
      const vp = page.getViewport({ scale: this.scale });
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const c = document.createElement('canvas');
      c.width = Math.round(vp.width * dpr); c.height = Math.round(vp.height * dpr);
      c.style.width = Math.round(vp.width) + 'px'; c.style.height = Math.round(vp.height) + 'px';
      holder.style.width = c.style.width; holder.style.height = c.style.height;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: page.getViewport({ scale: this.scale * dpr }) }).promise;
      if (tok !== this.token) return;
      holder.insertBefore(c, holder.firstChild);
    } catch (e) { holder.dataset.done = ''; }
  };

  PdfPane.prototype.scrollToPage = function (p) {
    const h = this.pageEls[Math.max(1, Math.min(p, this.pageEls.length)) - 1];
    if (h) this.el.scrollTo({ top: Math.max(0, h.offsetTop - 8), behavior: 'auto' });
  };

  PdfPane.prototype.currentPage = function () {
    let best = 1, bd = Infinity;
    const top = this.el.scrollTop;
    this.pageEls.forEach(function (h, i) { const d = Math.abs(h.offsetTop - top); if (d < bd) { bd = d; best = i + 1; } });
    return best;
  };

  PdfPane.prototype.setScale = async function (s) {
    const cur = this.currentPage();
    this.scale = Math.max(0.6, Math.min(2.6, s));
    await this._build(cur);
  };

  // rect = [x0, top, x1, bottom] (PDF pt, 위에서 잰 좌표)
  PdfPane.prototype.highlight = function (p, rect) {
    if (this.hl) { this.hl.remove(); this.hl = null; }
    const h = this.pageEls[p - 1];
    if (!h) return;
    if (rect) {
      const s = this.scale, d = document.createElement('div');
      d.className = 'hl';
      d.style.left = Math.round(rect[0] * s - 4) + 'px';
      d.style.top = Math.round(rect[1] * s - 4) + 'px';
      d.style.width = Math.round((rect[2] - rect[0]) * s + 8) + 'px';
      d.style.height = Math.round((rect[3] - rect[1]) * s + 8) + 'px';
      h.appendChild(d);
      this.hl = d;
      this.el.scrollTo({ top: Math.max(0, h.offsetTop + rect[1] * s - this.el.clientHeight * 0.3), behavior: 'auto' });
    } else {
      this.scrollToPage(p);
    }
  };

  root.PdfPane = PdfPane;
})(window);
