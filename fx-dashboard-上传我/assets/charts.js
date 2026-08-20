/* ============================================================
   轻量 SVG 图表 —— 无第三方依赖
   规范：细笔画、2px 线宽、4px 圆角柱端、相邻填充留 2px 间隙、
        网格线弱化、十字准星 + 悬浮提示、直接标注代替满图数字
   ============================================================ */
const NS = "http://www.w3.org/2000/svg";
const el = (t, a = {}) => {
  const n = document.createElementNS(NS, t);
  for (const k in a) n.setAttribute(k, a[k]);
  return n;
};
export const cssVar = (v) =>
  getComputedStyle(document.documentElement).getPropertyValue(v).trim();

const dayNo = (d) => Math.round(Date.parse(d + "T00:00:00Z") / 864e5);
const fmt = (v, n = 2) =>
  v === null || v === undefined || Number.isNaN(v)
    ? "—"
    : (+v).toLocaleString("en-US", { minimumFractionDigits: n, maximumFractionDigits: n });
const sgn = (v, n = 2) =>
  v === null || v === undefined || Number.isNaN(v) ? "—" : (v > 0 ? "+" : "") + fmt(v, n);
const mdLabel = (d) => d.slice(5).replace("-", "/");

function niceTicks(lo, hi, n = 5) {
  const span = hi - lo || 1;
  const raw = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}

function reset(box) {
  [...box.querySelectorAll("svg,.empty")].forEach((n) => n.remove());
  let tip = box.querySelector(".tip");
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "tip";
    box.appendChild(tip);
  }
  return tip;
}
function showTip(box, tip, ev, html) {
  tip.innerHTML = html;
  tip.style.opacity = 1;
  const b = box.getBoundingClientRect();
  const w = tip.offsetWidth || 170;
  let left = ev.clientX - b.left + 16;
  if (left + w > b.width) left = ev.clientX - b.left - w - 12;
  tip.style.left = Math.max(0, left) + "px";
  tip.style.top = Math.max(0, ev.clientY - b.top - tip.offsetHeight - 12) + "px";
}
const empty = (box, msg) => {
  const d = document.createElement("div");
  d.className = "empty";
  d.textContent = msg;
  box.appendChild(d);
};

/* ------------------------------------------------ 折线图 */
export function lineChart(box, rows, series, opts = {}) {
  const tip = reset(box);
  if (!rows.length) return empty(box, "暂无数据");
  const W = 1120, H = opts.h || 330, M = { t: 22, r: 18, b: 30, l: 54 };
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none" });
  box.appendChild(svg);

  const xs = rows.map((r) => dayNo(r.d));
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const vals = [];
  series.forEach((s) => rows.forEach((r) => {
    const v = s.get(r);
    if (v !== null && v !== undefined && !Number.isNaN(v)) vals.push(v);
  }));
  (opts.marks || []).forEach((m) => m.v != null && vals.push(m.v));
  if (opts.band) rows.forEach((r) => {
    if (r.crdbBuy != null) vals.push(r.crdbBuy);
    if (r.crdbSell != null) vals.push(r.crdbSell);
  });
  if (!vals.length) return empty(box, "暂无数据");

  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo || 1) * 0.14;
  lo -= pad; hi += pad;
  const X = (d) => M.l + ((dayNo(d) - x0) / ((x1 - x0) || 1)) * (W - M.l - M.r);
  const Y = (v) => H - M.b - ((v - lo) / ((hi - lo) || 1)) * (H - M.t - M.b);

  niceTicks(lo, hi, 5).forEach((t) => {
    if (t < lo || t > hi) return;
    svg.appendChild(el("line", { x1: M.l, x2: W - M.r, y1: Y(t), y2: Y(t), stroke: cssVar("--grid"), "stroke-width": 1 }));
    const lb = el("text", { x: M.l - 9, y: Y(t) + 4, "text-anchor": "end", "font-size": 11, fill: cssVar("--ink-3") });
    lb.textContent = fmt(t, 0);
    svg.appendChild(lb);
  });
  svg.appendChild(el("line", { x1: M.l, x2: W - M.r, y1: H - M.b, y2: H - M.b, stroke: cssVar("--axis"), "stroke-width": 1 }));
  const nT = Math.min(9, rows.length);
  for (let i = 0; i < nT; i++) {
    const r = rows[Math.round((i * (rows.length - 1)) / Math.max(1, nT - 1))];
    const lb = el("text", { x: X(r.d), y: H - M.b + 18, "text-anchor": "middle", "font-size": 11, fill: cssVar("--ink-3") });
    lb.textContent = mdLabel(r.d);
    svg.appendChild(lb);
  }

  if (opts.band) {
    const up = [], dn = [];
    rows.forEach((r) => r.crdbSell != null && up.push([X(r.d), Y(r.crdbSell)]));
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (r.crdbBuy != null) dn.push([X(r.d), Y(r.crdbBuy)]);
    }
    if (up.length && dn.length)
      svg.appendChild(el("polygon", {
        points: [...up, ...dn].map((p) => p.join(",")).join(" "),
        fill: cssVar("--band"), opacity: 0.3,
      }));
  }

  series.forEach((s) => {
    let seg = [];
    const flush = () => {
      if (seg.length > 1)
        svg.appendChild(el("polyline", {
          points: seg.map((p) => p.join(",")).join(" "), fill: "none",
          stroke: cssVar(s.color), "stroke-width": 2,
          "stroke-linejoin": "round", "stroke-linecap": "round",
        }));
      else if (seg.length === 1)
        svg.appendChild(el("circle", { cx: seg[0][0], cy: seg[0][1], r: 2.6, fill: cssVar(s.color) }));
      seg = [];
    };
    rows.forEach((r) => {
      const v = s.get(r);
      if (v === null || v === undefined || Number.isNaN(v)) flush();
      else seg.push([X(r.d), Y(v)]);
    });
    flush();
  });

  // 议价点：菱形 + 直接标注（形状与文字是颜色之外的次级编码）
  (opts.marks || []).forEach((m) => {
    if (m.v == null) return;
    const cx = X(m.d), cy = Y(m.v), s = 5.5;
    svg.appendChild(el("path", {
      d: `M${cx} ${cy - s - 2}L${cx + s + 2} ${cy}L${cx} ${cy + s + 2}L${cx - s - 2} ${cy}Z`,
      fill: cssVar("--surface"),
    }));
    svg.appendChild(el("path", {
      d: `M${cx} ${cy - s}L${cx + s} ${cy}L${cx} ${cy + s}L${cx - s} ${cy}Z`,
      fill: cssVar("--s4"),
    }));
    if (opts.labelMarks !== false) {
      const t = el("text", {
        x: Math.min(W - M.r - 26, Math.max(M.l + 26, cx)), y: cy - s - 8,
        "text-anchor": "middle", "font-size": 11.5, "font-weight": 620, fill: cssVar("--ink-1"),
      });
      t.textContent = fmt(m.v, 0);
      svg.appendChild(t);
    }
  });

  const cross = el("line", { y1: M.t, y2: H - M.b, stroke: cssVar("--axis"), "stroke-width": 1, opacity: 0 });
  svg.appendChild(cross);
  const dots = series.map((s) => {
    const c = el("circle", { r: 4.5, fill: cssVar(s.color), stroke: cssVar("--surface"), "stroke-width": 2, opacity: 0 });
    svg.appendChild(c);
    return c;
  });
  const hit = el("rect", { x: M.l, y: M.t, width: W - M.l - M.r, height: H - M.t - M.b, fill: "transparent" });
  svg.appendChild(hit);
  hit.addEventListener("mousemove", (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    let best = rows[0], bd = Infinity;
    rows.forEach((r) => { const d = Math.abs(X(r.d) - px); if (d < bd) { bd = d; best = r; } });
    cross.setAttribute("x1", X(best.d)); cross.setAttribute("x2", X(best.d)); cross.setAttribute("opacity", 1);
    let html = `<div class="hd">${best.d}</div>`;
    series.forEach((s, i) => {
      const v = s.get(best);
      if (v === null || v === undefined || Number.isNaN(v)) { dots[i].setAttribute("opacity", 0); return; }
      dots[i].setAttribute("cx", X(best.d)); dots[i].setAttribute("cy", Y(v)); dots[i].setAttribute("opacity", 1);
      html += `<div class="row"><span><i style="background:${cssVar(s.color)}"></i>${s.name}</span><b>${fmt(v, 2)}</b></div>`;
    });
    const mk = (opts.marks || []).find((m) => m.d === best.d);
    if (mk) html += `<div class="row"><span><i style="background:${cssVar("--s4")}"></i>我的议价</span><b>${fmt(mk.v, 2)}</b></div>`;
    showTip(box, tip, ev, html);
  });
  hit.addEventListener("mouseleave", () => {
    tip.style.opacity = 0; cross.setAttribute("opacity", 0);
    dots.forEach((d) => d.setAttribute("opacity", 0));
  });
}

/* ---------------------------------------- 圆角柱路径 */
function barPath(x, y, w, h, up) {
  const r = Math.min(4, w / 2, h);
  return up
    ? `M${x} ${y + h}L${x} ${y + r}Q${x} ${y} ${x + r} ${y}L${x + w - r} ${y}Q${x + w} ${y} ${x + w} ${y + r}L${x + w} ${y + h}Z`
    : `M${x} ${y}L${x} ${y + h - r}Q${x} ${y + h} ${x + r} ${y + h}L${x + w - r} ${y + h}Q${x + w} ${y + h} ${x + w} ${y + h - r}L${x + w} ${y}Z`;
}

/* ------------------------------------------------ 分组柱状图 */
export function groupedBars(box, rows, groups, opts = {}) {
  const tip = reset(box);
  if (!rows.length) return empty(box, opts.emptyMsg || "暂无数据");
  const vals = [];
  rows.forEach((r) => groups.forEach((g) => {
    const v = g.get(r);
    if (v !== null && v !== undefined && !Number.isNaN(v)) vals.push(v);
  }));
  if (!vals.length) return empty(box, opts.emptyMsg || "暂无可比数据");

  const W = 1120, H = opts.h || 280, M = { t: 24, r: 18, b: 36, l: 54 };
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}` });
  box.appendChild(svg);
  let lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  const pad = (hi - lo || 1) * 0.2;
  lo -= pad; hi += pad;
  const Y = (v) => H - M.b - ((v - lo) / ((hi - lo) || 1)) * (H - M.t - M.b);
  const gw = (W - M.l - M.r) / rows.length;
  const bw = Math.max(6, Math.min(34, (gw - 22) / groups.length - 3));

  niceTicks(lo, hi, 5).forEach((t) => {
    if (t < lo || t > hi) return;
    svg.appendChild(el("line", {
      x1: M.l, x2: W - M.r, y1: Y(t), y2: Y(t),
      stroke: t === 0 ? cssVar("--axis") : cssVar("--grid"), "stroke-width": 1,
    }));
    const lb = el("text", { x: M.l - 9, y: Y(t) + 4, "text-anchor": "end", "font-size": 11, fill: cssVar("--ink-3") });
    lb.textContent = sgn(t, 1);
    svg.appendChild(lb);
  });

  rows.forEach((r, i) => {
    const cx = M.l + gw * i + gw / 2;
    const lb = el("text", { x: cx, y: H - M.b + 18, "text-anchor": "middle", "font-size": 11, fill: cssVar("--ink-3") });
    lb.textContent = r.d.slice(5);
    svg.appendChild(lb);
    groups.forEach((g, j) => {
      const v = g.get(r);
      if (v === null || v === undefined || Number.isNaN(v)) return;
      const total = groups.length * (bw + 3) - 3;
      const x = cx - total / 2 + j * (bw + 3);
      const y = Math.min(Y(v), Y(0)), h = Math.max(2, Math.abs(Y(v) - Y(0)));
      const p = el("path", { d: barPath(x, y, bw, h, v >= 0), fill: cssVar(g.color) });
      p.addEventListener("mousemove", (ev) =>
        showTip(box, tip, ev,
          `<div class="hd">${r.d}</div><div class="row"><span><i style="background:${cssVar(g.color)}"></i>${g.name}</span><b>${sgn(v)}</b></div>`));
      p.addEventListener("mouseleave", () => (tip.style.opacity = 0));
      svg.appendChild(p);
      const t2 = el("text", {
        x: x + bw / 2, y: v >= 0 ? y - 6 : y + h + 14,
        "text-anchor": "middle", "font-size": 10.5, fill: cssVar("--ink-2"),
      });
      t2.textContent = sgn(v, 1);
      svg.appendChild(t2);
    });
  });
}

/* ------------------------------------------- 发散柱状图（正负） */
export function divergingBars(box, rows, opts = {}) {
  const tip = reset(box);
  rows = rows.filter((r) => r.v !== null && r.v !== undefined && !Number.isNaN(r.v));
  if (!rows.length) return empty(box, "暂无数据");
  const W = 1120, H = opts.h || 210, M = { t: 18, r: 18, b: 30, l: 54 };
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}` });
  box.appendChild(svg);
  const vals = rows.map((r) => r.v);
  let lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  const pad = (hi - lo || 1) * 0.16;
  lo -= pad; hi += pad;
  const Y = (v) => H - M.b - ((v - lo) / ((hi - lo) || 1)) * (H - M.t - M.b);
  const gw = (W - M.l - M.r) / rows.length;
  const bw = Math.max(3, Math.min(24, gw - 4));

  niceTicks(lo, hi, 4).forEach((t) => {
    if (t < lo || t > hi) return;
    svg.appendChild(el("line", {
      x1: M.l, x2: W - M.r, y1: Y(t), y2: Y(t),
      stroke: t === 0 ? cssVar("--axis") : cssVar("--grid"), "stroke-width": 1,
    }));
    const lb = el("text", { x: M.l - 9, y: Y(t) + 4, "text-anchor": "end", "font-size": 11, fill: cssVar("--ink-3") });
    lb.textContent = sgn(t, 1);
    svg.appendChild(lb);
  });

  const every = Math.max(1, Math.ceil(rows.length / 9));
  rows.forEach((r, i) => {
    const x = M.l + gw * i + (gw - bw) / 2;
    const y = Math.min(Y(r.v), Y(0)), h = Math.max(2, Math.abs(Y(r.v) - Y(0)));
    const p = el("path", { d: barPath(x, y, bw, h, r.v >= 0), fill: cssVar(r.v >= 0 ? "--s1" : "--s4") });
    p.addEventListener("mousemove", (ev) =>
      showTip(box, tip, ev, `<div class="hd">${r.d}</div><div class="row"><span>${opts.label || "价差"}</span><b>${sgn(r.v)}</b></div>`));
    p.addEventListener("mouseleave", () => (tip.style.opacity = 0));
    svg.appendChild(p);
    if (i % every === 0) {
      const lb = el("text", { x: x + bw / 2, y: H - M.b + 18, "text-anchor": "middle", "font-size": 11, fill: cssVar("--ink-3") });
      lb.textContent = mdLabel(r.d);
      svg.appendChild(lb);
    }
  });
}

/* --------------------------------------------------- 迷你走势线 */
export function sparkline(box, values, color = "--s1") {
  [...box.querySelectorAll("svg")].forEach((n) => n.remove());
  const v = values.filter((x) => x !== null && x !== undefined && !Number.isNaN(x));
  if (v.length < 2) return;
  const W = 120, H = 30;
  const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1;
  const pts = v.map((x, i) => [(i / (v.length - 1)) * W, H - 3 - ((x - lo) / span) * (H - 6)]);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, style: "width:120px;height:30px" });
  svg.appendChild(el("polyline", {
    points: pts.map((p) => p.join(",")).join(" "), fill: "none",
    stroke: cssVar(color), "stroke-width": 1.8, "stroke-linejoin": "round", "stroke-linecap": "round",
  }));
  const last = pts[pts.length - 1];
  svg.appendChild(el("circle", { cx: last[0], cy: last[1], r: 2.6, fill: cssVar(color) }));
  box.appendChild(svg);
}
