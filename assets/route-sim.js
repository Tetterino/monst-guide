// ダメージリンクのルート探しシミュレーター（各クエストのステージページで共用）
// - 自キャラは敵を貫通し、壁でのみ反射する
// - 成功条件はステージごとの「狙い」(rule) で決まる
//   linkAll:          最初に本に触れるまでに、ON の敵すべてに触れる
//   targetWallsBook:  対象の敵 → 何にも触れずに上下左右の壁4面 → 本
(function () {
  const FIELD_PADDING = 24;
  const BALL_RADIUS = 14;
  const GRID_COLS = 8;
  const GRID_ROWS = 8;
  const SEARCH_STEPS = 720; // 自動探索の分解能（0.5°刻み）

  const WALLS = ['top', 'right', 'bottom', 'left'];
  const WALL_LABEL = { top: '上', right: '右', bottom: '下', left: '左' };
  const WALL_COLOR = { top: '#f8e71c', right: '#1abc9c', bottom: '#b06cff', left: '#ff8a3d' };
  const TYPE_LABEL = { enemy: '敵', book: '本' };
  const TYPE_COLOR = { enemy: '#e94560', book: '#4a90d9' };

  const SEGMENT_COLORS = [
    '#e94560', '#f5a623', '#f8e71c', '#7ed321',
    '#4a90d9', '#9b59b6', '#1abc9c', '#e67e22',
    '#e74c3c', '#2ecc71', '#3498db', '#9b59b6',
  ];

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  // 0° = 真上、時計回り
  function dirFromDeg(deg) {
    const rad = deg * Math.PI / 180;
    return { x: Math.sin(rad), y: -Math.cos(rad) };
  }
  function degFromDir(dir) {
    const deg = Math.atan2(dir.x, -dir.y) * 180 / Math.PI;
    return (deg + 360) % 360;
  }

  // 線分 a→b 上で、中心 c・半径 r の円に外側から入る最初の t (0〜1)。入らなければ null
  function entryT(a, b, c, r) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const fx = a.x - c.x, fy = a.y - c.y;
    const A = dx * dx + dy * dy;
    const B = 2 * (fx * dx + fy * dy);
    const C = fx * fx + fy * fy - r * r;
    if (A === 0 || C < 0) return null; // 始点がすでに円の中
    const disc = B * B - 4 * A * C;
    if (disc < 0) return null;
    const t = (-B - Math.sqrt(disc)) / (2 * A);
    return t >= 0 && t <= 1 ? t : null;
  }

  function mount({ canvas, stage, storageKey, ui }) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    const FIELD_W = W - FIELD_PADDING * 2;
    const FIELD_H = H - FIELD_PADDING * 2;
    // 自キャラ中心が動ける範囲（自キャラの縁が壁に当たったら反射）
    const minX = FIELD_PADDING + BALL_RADIUS;
    const maxX = W - FIELD_PADDING - BALL_RADIUS;
    const minY = FIELD_PADDING + BALL_RADIUS;
    const maxY = H - FIELD_PADDING - BALL_RADIUS;

    // ---- State ----
    // 敵・本の位置と大きさはプリセット固定。変えられるのは ON/OFF と自キャラの位置だけ
    let objects = [];
    let ball = null;
    let shotDir = null;       // 確定したショット方向
    let pointer = null;       // 押している間の状態 { kind: 'aim' | 'ball', start, end, obj }
    let searchResult = null;  // 自動探索の結果

    const rules = stage.rules && stage.rules.length
      ? stage.rules
      : [{ id: 'link', label: '敵すべて → 本', kind: 'linkAll' }];
    let rule = rules[0];

    // ---- Load / save ----
    function applyPreset() {
      ball = { x: stage.ball.x, y: stage.ball.y };
      objects = stage.objects.map(o => ({ ...o, on: o.on !== false }));
      applyRuleOff();
    }

    // 狙いごとに「処理済みなので OFF」の敵がある（例: 中ボス削りでは目玉は倒している）
    function applyRuleOff() {
      const off = new Set(rule.off || []);
      for (const o of objects) o.on = !off.has(o.id);
    }

    // 保存するのは ON/OFF と自キャラの位置だけ（プリセットを更新したら位置はそちらが反映される）
    function save() {
      const data = {
        rule: rule.id,
        ball: { x: Math.round(ball.x), y: Math.round(ball.y) },
        on: Object.fromEntries(objects.map(o => [o.id, o.on])),
      };
      try { localStorage.setItem(storageKey, JSON.stringify(data)); } catch (e) { /* 保存できなくても動作は続ける */ }
    }

    function loadSaved() {
      try {
        const data = JSON.parse(localStorage.getItem(storageKey));
        if (!data) return;
        rule = rules.find(r => r.id === data.rule) || rule;
        if (data.ball) {
          ball = { x: clamp(data.ball.x, minX, maxX), y: clamp(data.ball.y, minY, maxY) };
        }
        for (const o of objects) {
          if (data.on && typeof data.on[o.id] === 'boolean') o.on = data.on[o.id];
        }
      } catch (e) { /* 壊れた保存データは無視してプリセットのまま */ }
    }

    // ON/OFF・自キャラ位置・条件が変わったら探索結果は無効
    function changed({ persist = true } = {}) {
      searchResult = null;
      if (persist) save();
      renderObjectList();
      renderSearch();
      update();
    }

    // ---- Reflection & touch logic ----
    function computePath(origin, dir, maxBounces) {
      const segs = [];
      let cx = origin.x, cy = origin.y;
      let dx = dir.x, dy = dir.y;

      // 壁に接した位置から壁方向に撃った場合はその場で反射
      const eps = 0.5;
      if (cx <= minX + eps && dx < 0) dx = -dx;
      if (cx >= maxX - eps && dx > 0) dx = -dx;
      if (cy <= minY + eps && dy < 0) dy = -dy;
      if (cy >= maxY - eps && dy > 0) dy = -dy;

      for (let i = 0; i < maxBounces; i++) {
        let tMin = Infinity;
        if (dx < 0) { const t = (minX - cx) / dx; if (t > 0.01 && t < tMin) tMin = t; }
        if (dx > 0) { const t = (maxX - cx) / dx; if (t > 0.01 && t < tMin) tMin = t; }
        if (dy < 0) { const t = (minY - cy) / dy; if (t > 0.01 && t < tMin) tMin = t; }
        if (dy > 0) { const t = (maxY - cy) / dy; if (t > 0.01 && t < tMin) tMin = t; }
        if (tMin === Infinity) break;

        const nx = cx + dx * tMin;
        const ny = cy + dy * tMin;
        const walls = [];
        if (nx <= minX + eps) walls.push('left');
        if (nx >= maxX - eps) walls.push('right');
        if (ny <= minY + eps) walls.push('top');
        if (ny >= maxY - eps) walls.push('bottom');
        segs.push({ a: { x: cx, y: cy }, b: { x: nx, y: ny }, walls });

        if (walls.includes('left') || walls.includes('right')) dx = -dx;
        if (walls.includes('top') || walls.includes('bottom')) dy = -dy;
        cx = nx;
        cy = ny;
      }
      return segs;
    }

    function simulate(dir) {
      const segs = computePath(ball, dir, maxBounces());
      const active = objects.filter(o => o.on);
      const seen = new Set();
      // 触れた順: { kind: 'obj', obj, seg, t, repeat } | { kind: 'wall', side, seg }
      // 同じ敵に入り直した場合も記録する（repeat: true）
      const events = [];

      segs.forEach((s, si) => {
        const hits = [];
        for (const o of active) {
          const t = entryT(s.a, s.b, o, o.r + BALL_RADIUS);
          if (t !== null) hits.push({ t, o });
        }
        hits.sort((p, q) => p.t - q.t);
        for (const h of hits) {
          events.push({ kind: 'obj', obj: h.o, seg: si, t: h.t, repeat: seen.has(h.o.id) });
          seen.add(h.o.id);
        }
        for (const side of s.walls) events.push({ kind: 'wall', side, seg: si });
      });

      const bookIdx = events.findIndex(e => e.kind === 'obj' && e.obj.type === 'book');
      const judged = rule.kind === 'targetWallsBook'
        ? judgeTargetWallsBook(events, bookIdx)
        : judgeLinkAll(events, bookIdx, active);
      return { segs, events, bookIdx, ...judged };
    }

    function nameOf(o) { return o.label || TYPE_LABEL[o.type]; }

    // 最初に本に触れるまでに、ON の敵すべてに触れる
    function judgeLinkAll(events, bookIdx, active) {
      const before = bookIdx < 0 ? events : events.slice(0, bookIdx);
      const linked = new Set(before.filter(e => e.kind === 'obj').map(e => e.obj.id));
      const missing = active.filter(o => o.type === 'enemy' && !linked.has(o.id));
      const result = { needsWalls: false, wallFrom: 0, wallTo: bookIdx < 0 ? events.length : bookIdx, wallsHit: new Set() };
      if (bookIdx < 0) return { ...result, success: false, message: '本に当たっていません' };
      if (missing.length) return { ...result, success: false, message: `本より先に触れていない: ${missing.map(nameOf).join('、')}` };
      return { ...result, success: true, message: '本に当たる前に、すべての敵に触れています' };
    }

    // 対象の敵 → 何にも触れずに上下左右の壁4面 → 本
    function judgeTargetWallsBook(events, bookIdx) {
      const target = objects.find(o => o.id === rule.target);
      const tName = target ? nameOf(target) : rule.target;
      const ti = events.findIndex(e => e.kind === 'obj' && e.obj.id === rule.target);
      const base = { needsWalls: true, wallFrom: 0, wallTo: 0, wallsHit: new Set() };

      if (bookIdx >= 0 && (ti < 0 || bookIdx < ti)) {
        return { ...base, success: false, message: `${tName}より先に本に触れています` };
      }
      if (ti < 0) return { ...base, success: false, message: `${tName}に触れていません` };

      const wallsHit = new Set();
      const missing = () => WALLS.filter(w => !wallsHit.has(w)).map(w => WALL_LABEL[w]).join('・');
      for (let i = ti + 1; i < events.length; i++) {
        const e = events[i];
        const res = { ...base, wallFrom: ti + 1, wallTo: i, wallsHit };
        if (e.kind === 'wall') { wallsHit.add(e.side); continue; }
        if (wallsHit.size < WALLS.length) {
          return { ...res, success: false, message: `壁4面がそろう前に「${nameOf(e.obj)}」に触れています（残り: ${missing()}）` };
        }
        if (e.obj.type !== 'book') {
          return { ...res, success: false, message: `壁4面の後、本より先に「${nameOf(e.obj)}」に触れています` };
        }
        return { ...res, success: true, goalIdx: i, message: `${tName} → 壁4面 → ${nameOf(e.obj)} の順に触れています` };
      }
      const res = { ...base, wallFrom: ti + 1, wallTo: events.length, wallsHit };
      return wallsHit.size < WALLS.length
        ? { ...res, success: false, message: `${tName}の後、壁が足りません（残り: ${missing()}）` }
        : { ...res, success: false, message: '壁4面の後、本に当たっていません（反射回数を増やすと届くかもしれません）' };
    }

    function search() {
      const ok = [];
      for (let i = 0; i < SEARCH_STEPS; i++) {
        ok.push(simulate(dirFromDeg(i * 360 / SEARCH_STEPS)).success);
      }
      const step = 360 / SEARCH_STEPS;
      const ranges = [];
      if (ok.every(Boolean)) {
        ranges.push({ from: 0, to: 360 - step, count: SEARCH_STEPS });
      } else {
        // 失敗方向の直後から一周して、連続する成功方向をまとめる
        const start = ok.indexOf(false);
        let cur = null;
        for (let k = 1; k <= SEARCH_STEPS; k++) {
          const i = (start + k) % SEARCH_STEPS;
          if (ok[i]) {
            if (!cur) cur = { first: i, count: 0 };
            cur.count++;
          } else if (cur) {
            ranges.push({ from: cur.first * step, to: ((cur.first + cur.count - 1) % SEARCH_STEPS) * step, count: cur.count });
            cur = null;
          }
        }
      }
      ranges.forEach(r => {
        r.width = r.count * step;
        r.mid = (r.from + (r.count - 1) * step / 2) % 360;
      });
      ranges.sort((p, q) => q.count - p.count); // 幅が広い = ズレに強い順
      searchResult = { ok, ranges };
    }

    // ---- UI wiring ----
    function maxBounces() { return parseInt(ui.bounceCount.value, 10); }

    ui.bounceCount.addEventListener('input', () => {
      ui.bounceVal.textContent = ui.bounceCount.value;
      searchResult = null;
      renderSearch();
      update();
    });
    ui.rule.addEventListener('change', () => {
      rule = rules.find(r => r.id === ui.rule.value) || rules[0];
      applyRuleOff();
      shotDir = null;
      changed();
    });

    ui.angle.addEventListener('change', () => {
      const deg = parseFloat(ui.angle.value);
      if (Number.isFinite(deg)) {
        shotDir = dirFromDeg(((deg % 360) + 360) % 360);
        update();
      }
    });

    ui.searchBtn.addEventListener('click', () => {
      search();
      renderSearch();
      update();
    });

    ui.clearBtn.addEventListener('click', () => {
      shotDir = null;
      update();
    });

    // 狙いの初期 ON/OFF・自キャラの初期位置に戻す。保存は消す
    ui.resetBtn.addEventListener('click', () => {
      applyPreset();
      try { localStorage.removeItem(storageKey); } catch (e) { /* noop */ }
      shotDir = null;
      changed({ persist: false });
    });

    function toggle(o) {
      o.on = !o.on;
      changed();
    }

    function renderObjectList() {
      ui.objectList.textContent = '';
      for (const o of objects) {
        const row = document.createElement('li');
        const label = document.createElement('label');
        label.className = 'obj-row';

        const check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = o.on;
        check.addEventListener('change', () => toggle(o));

        const dot = document.createElement('span');
        dot.className = 'obj-dot';
        dot.style.background = TYPE_COLOR[o.type];

        const name = document.createElement('span');
        name.className = 'obj-name';
        name.textContent = o.label;

        const type = document.createElement('span');
        type.className = 'obj-type';
        type.textContent = TYPE_LABEL[o.type];

        label.append(check, dot, name, type);
        row.appendChild(label);
        ui.objectList.appendChild(row);
      }
    }

    function renderSearch() {
      ui.searchList.textContent = '';
      if (!searchResult) {
        ui.searchSummary.textContent = '';
        return;
      }
      const { ranges } = searchResult;
      ui.searchSummary.textContent = ranges.length
        ? `${ranges.length} 件見つかりました（幅が広い順。押すとその角度で撃ちます）`
        : '条件を満たす角度はありませんでした（反射回数や配置を見直してください）';
      for (const r of ranges.slice(0, 20)) {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.textContent = r.count === 1
          ? `${r.mid.toFixed(1)}°`
          : `${r.mid.toFixed(1)}°（${r.from.toFixed(1)}〜${r.to.toFixed(1)}° / 幅 ${r.width.toFixed(1)}°）`;
        btn.addEventListener('click', () => {
          shotDir = dirFromDeg(r.mid);
          update();
        });
        li.appendChild(btn);
        ui.searchList.appendChild(li);
      }
    }

    function renderResult(result) {
      if (!result) {
        ui.result.className = 'result';
        ui.result.textContent = '引っ張って撃つか、自動探索の候補を選んでください';
        return;
      }
      const last = result.goalIdx ?? (result.bookIdx < 0 ? result.events.length - 1 : result.bookIdx);
      const order = result.events
        .slice(0, last + 1)
        .map(e => e.kind === 'wall' ? `壁(${WALL_LABEL[e.side]})` : nameOf(e.obj) + (e.repeat ? '(再)' : ''));
      ui.result.className = 'result ' + (result.success ? 'ok' : 'ng');
      ui.result.textContent = [
        `${result.success ? '✅ 成功' : '❌ 失敗'}: ${result.message}`,
        `順番: ${order.length ? order.join(' → ') : '（何にも触れていません）'}`,
      ].join('\n');
    }

    // ---- Pointer events ----
    function getPos(e) {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (e.clientX - rect.left) * (W / rect.width),
        y: (e.clientY - rect.top) * (H / rect.height),
      };
    }

    function hitObject(p) {
      for (let i = objects.length - 1; i >= 0; i--) {
        if (dist(p, objects[i]) <= objects[i].r) return objects[i];
      }
      return null;
    }

    // 自キャラの上から引っ張る → 自キャラを移動
    // 円の上でタップ（ほぼ動かさずに離す） → その円の ON/OFF
    // それ以外の引っ張り → ショット
    const TAP_SLOP = 6;

    canvas.addEventListener('pointerdown', e => {
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      const p = getPos(e);
      if (dist(p, ball) <= BALL_RADIUS + 4) {
        pointer = { kind: 'ball', start: p, end: p, offX: ball.x - p.x, offY: ball.y - p.y };
      } else {
        pointer = { kind: 'aim', start: p, end: p, obj: hitObject(p) };
      }
      update();
    });

    canvas.addEventListener('pointermove', e => {
      if (!pointer) return;
      const p = getPos(e);
      pointer.end = p;
      if (pointer.kind === 'ball') {
        ball.x = clamp(p.x + pointer.offX, minX, maxX);
        ball.y = clamp(p.y + pointer.offY, minY, maxY);
        searchResult = null;
        renderSearch();
      }
      update();
    });

    function endPointer() {
      if (!pointer) return;
      const done = pointer;
      pointer = null;
      const moved = dist(done.start, done.end) > TAP_SLOP;
      if (done.kind === 'ball') {
        changed();
      } else if (!moved && done.obj) {
        toggle(done.obj);
      } else {
        const dir = aimDirOf(done);
        if (dir) shotDir = dir;
        update();
      }
    }
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);

    // 引っ張った逆方向に飛ぶ
    function aimDirOf(ptr) {
      if (!ptr || ptr.kind !== 'aim') return null;
      const dx = ptr.start.x - ptr.end.x;
      const dy = ptr.start.y - ptr.end.y;
      const len = Math.hypot(dx, dy);
      return len > TAP_SLOP ? { x: dx / len, y: dy / len } : null;
    }

    // ---- Drawing ----
    function update() {
      const aiming = aimDirOf(pointer);
      const dir = aiming || shotDir;
      const result = dir ? simulate(dir) : null;
      if (dir && document.activeElement !== ui.angle) ui.angle.value = degFromDir(dir).toFixed(1);
      if (!dir) ui.angle.value = '';
      renderResult(result);
      draw(result, !!aiming);
    }

    function draw(result, preview) {
      ctx.clearRect(0, 0, W, H);

      ctx.fillStyle = '#16213e';
      ctx.fillRect(FIELD_PADDING, FIELD_PADDING, FIELD_W, FIELD_H);

      ctx.strokeStyle = 'rgba(255,255,255,0.1)';
      ctx.lineWidth = 1;
      for (let i = 0; i <= GRID_COLS; i++) {
        const x = FIELD_PADDING + i * FIELD_W / GRID_COLS;
        ctx.beginPath(); ctx.moveTo(x, FIELD_PADDING); ctx.lineTo(x, H - FIELD_PADDING); ctx.stroke();
      }
      for (let i = 0; i <= GRID_ROWS; i++) {
        const y = FIELD_PADDING + i * FIELD_H / GRID_ROWS;
        ctx.beginPath(); ctx.moveTo(FIELD_PADDING, y); ctx.lineTo(W - FIELD_PADDING, y); ctx.stroke();
      }

      if (result && result.needsWalls) drawWalls(result.wallsHit);
      if (searchResult) drawSearchFan();

      for (const o of objects) drawObject(o);

      if (result) {
        drawPath(result, preview ? 0.55 : 1);
        drawWallContacts(result);
        drawTouchOrder(result);
      }

      if (preview) {
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = 'rgba(255,255,255,0.3)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(pointer.start.x, pointer.start.y);
        ctx.lineTo(pointer.end.x, pointer.end.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      drawBall(ball.x, ball.y);
    }

    // 本に当たる前に触れた壁を緑、まだの壁を灰色で示す
    function drawWalls(wallsHit) {
      const L = FIELD_PADDING, R = W - FIELD_PADDING, T = FIELD_PADDING, B = H - FIELD_PADDING;
      const lines = {
        top: [L, T, R, T], right: [R, T, R, B], bottom: [L, B, R, B], left: [L, T, L, B],
      };
      ctx.lineWidth = 5;
      for (const side of WALLS) {
        const [x1, y1, x2, y2] = lines[side];
        ctx.strokeStyle = wallsHit.has(side) ? 'rgba(126,211,33,0.9)' : 'rgba(255,255,255,0.15)';
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      }
    }

    // 成功する方向を自キャラの周りに扇形で示す
    function drawSearchFan() {
      const step = 360 / SEARCH_STEPS;
      ctx.strokeStyle = 'rgba(126,211,33,0.35)';
      ctx.lineWidth = 1.5;
      searchResult.ok.forEach((good, i) => {
        if (!good) return;
        const d = dirFromDeg(i * step);
        ctx.beginPath();
        ctx.moveTo(ball.x + d.x * (BALL_RADIUS + 4), ball.y + d.y * (BALL_RADIUS + 4));
        ctx.lineTo(ball.x + d.x * (BALL_RADIUS + 40), ball.y + d.y * (BALL_RADIUS + 40));
        ctx.stroke();
      });
    }

    function drawObject(o) {
      const color = TYPE_COLOR[o.type];
      ctx.save();
      ctx.globalAlpha = o.on ? 1 : 0.35;
      ctx.beginPath();
      ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2);
      ctx.fillStyle = o.on ? color + '55' : 'transparent';
      ctx.fill();
      ctx.setLineDash(o.on ? [] : [4, 4]);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#fff';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(o.label, o.x, o.y);
      ctx.restore();
    }

    function drawPath(result, alpha) {
      const { segs, events, bookIdx } = result;
      // 本に当たった地点より後ろは薄く描く
      let cutSeg = Infinity, cutT = 1;
      if (bookIdx >= 0) { cutSeg = events[bookIdx].seg; cutT = events[bookIdx].t; }

      segs.forEach((s, i) => {
        const color = SEGMENT_COLORS[i % SEGMENT_COLORS.length];
        const lerp = t => ({ x: s.a.x + (s.b.x - s.a.x) * t, y: s.a.y + (s.b.y - s.a.y) * t });
        if (i < cutSeg) {
          strokeSeg(s.a, s.b, color, 3, alpha);
        } else if (i === cutSeg) {
          strokeSeg(s.a, lerp(cutT), color, 3, alpha);
          strokeSeg(lerp(cutT), s.b, '#888', 1.5, alpha * 0.35);
        } else {
          strokeSeg(s.a, s.b, '#888', 1.5, alpha * 0.35);
        }
        if (i <= cutSeg) drawChevron(s, color, alpha);
      });
    }

    function strokeSeg(a, b, color, width, alpha) {
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    function drawChevron(s, color, alpha) {
      const mx = (s.a.x + s.b.x) / 2;
      const my = (s.a.y + s.b.y) / 2;
      const angle = Math.atan2(s.b.y - s.a.y, s.b.x - s.a.x);
      const size = 8;
      const spread = Math.PI * 0.75;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(mx + size * Math.cos(angle + spread), my + size * Math.sin(angle + spread));
      ctx.lineTo(mx, my);
      ctx.lineTo(mx + size * Math.cos(angle - spread), my + size * Math.sin(angle - spread));
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // 壁4面を数える区間（中ボス削りなら中ボスに触れた後〜次に何かに触れるまで）の壁との接点
    // 各面に初めて触れた点は面の色の丸＋ラベル、2回目以降は小さい点
    function drawWallContacts(result) {
      if (!result.needsWalls) return;
      const L = FIELD_PADDING, R = W - FIELD_PADDING, T = FIELD_PADDING, B = H - FIELD_PADDING;
      const seen = new Set();
      for (const e of result.events.slice(result.wallFrom, result.wallTo)) {
        if (e.kind !== 'wall') continue;
        // 自キャラの中心ではなく、縁が壁に触れた位置に描く
        const c = result.segs[e.seg].b;
        const p = {
          top: { x: c.x, y: T }, bottom: { x: c.x, y: B },
          left: { x: L, y: c.y }, right: { x: R, y: c.y },
        }[e.side];
        const color = WALL_COLOR[e.side];

        if (seen.has(e.side)) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
          continue;
        }
        seen.add(e.side);

        ctx.beginPath();
        ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = '#111';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = '#111';
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(WALL_LABEL[e.side], p.x, p.y);
      }
    }

    // 初めて触れた順番を円の右上にバッジで表示（本より後に触れたものは灰色）
    function drawTouchOrder(result) {
      let n = 0;
      result.events.forEach((e, idx) => {
        if (e.kind !== 'obj' || e.repeat) return;
        n++;
        const late = result.bookIdx >= 0 && idx > result.bookIdx;
        const bx = e.obj.x + e.obj.r * 0.75;
        const by = e.obj.y - e.obj.r * 0.75;
        ctx.beginPath();
        ctx.arc(bx, by, 9, 0, Math.PI * 2);
        ctx.fillStyle = late ? '#555' : (e.obj.type === 'book' ? '#4a90d9' : '#7ed321');
        ctx.fill();
        ctx.fillStyle = late ? '#bbb' : '#111';
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(n), bx, by);
      });
    }

    function drawBall(x, y) {
      ctx.beginPath();
      ctx.arc(x + 2, y + 2, BALL_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fill();

      const grad = ctx.createRadialGradient(x - 4, y - 4, 2, x, y, BALL_RADIUS);
      grad.addColorStop(0, '#fff');
      grad.addColorStop(0.3, '#e94560');
      grad.addColorStop(1, '#a11d33');
      ctx.beginPath();
      ctx.arc(x, y, BALL_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // ---- Init ----
    applyPreset();
    loadSaved();
    for (const r of rules) {
      const opt = document.createElement('option');
      opt.value = r.id;
      opt.textContent = r.label;
      ui.rule.appendChild(opt);
    }
    ui.rule.value = rule.id;
    ui.bounceVal.textContent = ui.bounceCount.value;
    renderObjectList();
    renderSearch();
    update();

    // テスト・デバッグ用
    return { simulate, search, dirFromDeg, getSearchResult: () => searchResult };
  }

  window.RouteSim = { mount };
})();
