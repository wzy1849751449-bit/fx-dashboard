/* ============================================================
   USD/TZS 汇率与议价看板 —— 应用主逻辑
   ============================================================ */
import { seal, unseal, utf8ToBase64 } from "./crypto.js";
import * as gh from "./github.js";
import { lineChart, groupedBars, divergingBars, cssVar } from "./charts.js";

/* ---------------------------------------------------- 配置 */
export const CONFIG = {
  owner: "wzy1849751449-bit",
  repo: "fx-dashboard",
  branch: "main",
  ratesPath: "data/rates.json",
  dealsPath: "data/deals.enc.json",
};
gh.configure({ owner: CONFIG.owner, name: CONFIG.repo, branch: CONFIG.branch });

const SS_PASS = "fx_pass_session";
const LS_PASS = "fx_pass_device";

/* --------------------------------------------------- 运行态 */
const state = {
  pass: "",
  rates: [],       // [{d, crdbBuy, crdbSell, crdbMid, bot, xe}]
  deals: [],       // [{d, rate, usd, tzs, dir, bank, by, note}]
  ratesMeta: {},
  range: 0,        // 0=全部
  band: false,
  editing: null,   // 正在编辑的议价索引
};

/* --------------------------------------------------- 工具 */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const num = (v) => (v === null || v === undefined || v === "" || Number.isNaN(+v) ? null : +v);
const fmt = (v, n = 2) =>
  v === null || v === undefined || Number.isNaN(v)
    ? "—"
    : (+v).toLocaleString("en-US", { minimumFractionDigits: n, maximumFractionDigits: n });
const fmt0 = (v) => fmt(v, 0);
const sgn = (v, n = 2) =>
  v === null || v === undefined || Number.isNaN(v) ? "—" : (v > 0 ? "+" : "") + fmt(v, n);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function money(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const a = Math.abs(v), s = v < 0 ? "−" : "";
  if (a >= 1e8) return s + (a / 1e8).toFixed(2) + " 亿";
  if (a >= 1e4) return s + (a / 1e4).toFixed(1) + " 万";
  return s + fmt0(a);
}
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const sd = (a) => {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const shift = (d, n) => {
  const t = new Date(d + "T00:00:00Z");
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
/** 缺失值向前填充 */
function lookup(date, key) {
  let best = null;
  for (const r of state.rates) {
    if (r.d > date) break;
    if (r[key] !== null && r[key] !== undefined) best = r[key];
  }
  return best;
}

/** 主导方向：多数记录是「卖美元换先令」时为 true。决定各处措辞与好坏方向。 */
/** 恒按日期升序。enrich() 里的 idx 直接用于 state.deals 下标，两者必须保持同序，
 *  否则补录一笔旧日期的记录后，编辑/删除会命中错误的行。 */
const sortDeals = (a) => a.slice().sort((x, y) => (x.d < y.d ? -1 : x.d > y.d ? 1 : 0));

const sellSide = (D) => D.filter((d) => d.dir === "sellUSD" || !d.buyUSD).length >= D.length / 2;

/* ------------------------------------------------ 议价派生量 */
function enrich() {
  return state.deals.map((dl, idx) => {
      const mid = lookup(dl.d, "crdbMid"), buy = lookup(dl.d, "crdbBuy"),
        sell = lookup(dl.d, "crdbSell"), bot = lookup(dl.d, "bot"), xe = lookup(dl.d, "xe");
      const buyUSD = dl.dir !== "sellUSD";
      const usd = num(dl.usd);
      const card = buyUSD ? sell : buy;                       // 对照的挂牌价
      const save = card !== null && usd !== null ? (buyUSD ? card - dl.rate : dl.rate - card) * usd : null;
      const tzs = num(dl.tzs) !== null ? num(dl.tzs) : usd !== null ? usd * dl.rate : null;

      // 时机：当日 BOT 在此前 30 天区间中的位置
      let pct = null, lo = null, hi = null;
      if (bot !== null) {
        const from = shift(dl.d, -30);
        const win = state.rates.filter((r) => r.d >= from && r.d <= dl.d && r.bot !== null).map((r) => r.bot);
        if (win.length >= 4) {
          lo = Math.min(...win); hi = Math.max(...win);
          pct = hi > lo ? (bot - lo) / (hi - lo) : 0.5;
        }
      }
      return {
        ...dl, idx, mid, buy, sell, bot, xe, buyUSD, usd, tzs, card, save, pct, lo, hi,
        vsMid: mid !== null ? dl.rate - mid : null,
        vsBot: bot !== null ? dl.rate - bot : null,
        vsXe: xe !== null ? dl.rate - xe : null,
        vsCard: card !== null ? dl.rate - card : null,
      };
    });
}

/* ==================================================== 数据加载 */
async function loadRates() {
  const res = await fetch(`${CONFIG.ratesPath}?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error("读不到行情数据文件");
  const db = await res.json();
  state.ratesMeta = { updatedAt: db.updatedAt, sources: db.sources || {} };
  state.rates = (db.rates || [])
    .map((r) => {
      const b = num(r.crdbBuy), s = num(r.crdbSell);
      return { d: r.d, crdbBuy: b, crdbSell: s, crdbMid: b !== null && s !== null ? (b + s) / 2 : null,
               bot: num(r.bot), xe: num(r.xe) };
    })
    .sort((a, b) => (a.d < b.d ? -1 : 1));
}

async function loadDeals(pass) {
  const res = await fetch(`${CONFIG.dealsPath}?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error("读不到议价数据文件");
  const env = await res.json();
  state.deals = sortDeals(await unseal(pass, env));   // 口令错误会在这里抛出
}

/* ==================================================== 口令门 */
async function tryUnlock(pass, remember) {
  await loadDeals(pass);
  state.pass = pass;
  sessionStorage.setItem(SS_PASS, pass);
  if (remember) localStorage.setItem(LS_PASS, pass);
  $("#gate").hidden = true;
  $("#app").hidden = false;
  render();
}

function initGate() {
  const form = $("#gateForm"), err = $("#gateErr");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#gateBtn");
    btn.disabled = true; btn.textContent = "验证中…"; err.textContent = "";
    try {
      await tryUnlock($("#gatePass").value, $("#gateRemember").checked);
    } catch (ex) {
      err.textContent = /decrypt|operation-specific|OperationError/i.test(ex.name + ex.message)
        ? "口令不对，再试一次。" : "打不开：" + ex.message;
      $("#gatePass").select();
    } finally {
      btn.disabled = false; btn.textContent = "进入看板";
    }
  });
}

/* ==================================================== 渲染 */
function tile(lab, val, note, cls = "") {
  return `<div class="tile ${cls}"><div class="lab">${lab}</div>
    <div class="val">${val}</div>${note ? `<div class="note">${note}</div>` : ""}</div>`;
}

function render() {
  const R = state.rates, D = enrich();
  const last = R[R.length - 1] || {};
  const upd = state.ratesMeta.updatedAt
    ? new Date(state.ratesMeta.updatedAt).toLocaleString("zh-CN", { hour12: false, timeZone: "Africa/Nairobi" })
    : "—";
  $("#metaline").innerHTML =
    `数据至 ${last.d || "—"} · ${R.length} 个交易日 · ${D.length} 笔议价 <span class="muted">· 抓取于 ${upd} (EAT)</span>`;

  renderOverview(R, D, last);
  renderTrend(R, D);
  renderDeals(R, D);
  renderTable(R, D);
  renderAdmin();
}

/* --------------------------------------------------- 概览 */
function renderOverview(R, D, last) {
  const prev = [...R].reverse().find((r) => r.d < last.d && r.bot !== null);
  const dBot = last.bot !== null && prev?.bot != null ? last.bot - prev.bot : null;
  const spread = last.crdbMid !== null && last.bot !== null ? last.crdbMid - last.bot : null;

  $("#ovTiles").innerHTML = [
    tile("CRDB 中间价", fmt0(last.crdbMid) + '<span class="unit">TZS</span>',
      `买入 ${fmt0(last.crdbBuy)} · 卖出 ${fmt0(last.crdbSell)}`, "hero"),
    tile("BOT 央行中间价", fmt(last.bot, 2),
      dBot === null ? "较上一有效日 —" : `较上一有效日 <span class="${(dBot > 0) === sellSide(D) ? "down" : "up"}">${sgn(dBot)}</span>`),
    tile("XE 国际中间价", fmt(last.xe, 2)),
    tile("CRDB − BOT", sgn(spread), "牌价相对央行的偏离"),
  ].join("");

  // 议价战绩
  const sellUSDside = sellSide(D);
  const withUsd = D.filter((d) => d.usd !== null);
  const totUsd = withUsd.reduce((s, d) => s + d.usd, 0);
  const wavg = totUsd ? withUsd.reduce((s, d) => s + d.rate * d.usd, 0) / totUsd : mean(D.map((d) => d.rate));
  const totSave = D.reduce((s, d) => s + (d.save || 0), 0);
  const avgCard = mean(D.filter((d) => d.vsCard !== null).map((d) => Math.abs(d.vsCard)));
  const avgMidPrem = mean(D.filter((d) => d.vsMid !== null).map((d) => d.vsMid));

  $("#ovDeal").innerHTML = [
    tile(sellUSDside ? "累计比牌价多拿" : "累计比牌价省下", money(totSave) + '<span class="unit">TZS</span>',
      totUsd ? `${D.length} 笔 · 共 ${fmt0(totUsd)} USD` : `${D.length} 笔（部分未填金额）`, "hero"),
    tile("加权平均议价", fmt(wavg, 2), totUsd ? "按美元金额加权" : "按笔数平均"),
    tile("平均优于牌价", avgCard === null ? "—" : fmt(avgCard, 2),
      sellUSDside ? "点 / 每美元（高于挂牌买入价）" : "点 / 每美元"),
    tile(sellUSDside ? "平均高出中间价" : "平均高于中间价", sgn(avgMidPrem),
      sellUSDside ? "议价比中间价多拿的点数" : "议价相对 CRDB 中间价的溢价"),
  ].join("");

  renderAlerts(R, D);
}

/* ------------------------------------------------ 预警与建议 */
function renderAlerts(R, D) {
  const A = [];
  const last = R[R.length - 1] || {};
  const bots = R.filter((r) => r.bot !== null);
  const m5 = mean(bots.slice(-5).map((r) => r.bot));
  const m20 = mean(bots.slice(-20).map((r) => r.bot));

  const SELL = sellSide(D);   // 卖美元换先令：汇率越高越有利
  if (m5 !== null && m20 !== null) {
    const gap = m5 - m20, thr = Math.max(2, m20 * 0.0015);
    if (gap > thr)
      A.push({ t: SELL ? "good" : "warn", i: "↑", h: `<em>先令在贬值</em>：BOT 近 5 日均价 ${fmt(m5, 2)}，高于近 20 日均价 ${fmt(m20, 2)}（${sgn(gap)}）。${SELL
        ? "同样一笔美元现在能换回更多先令，对你有利；手上有美元不急着用的话，再等等可能还能多拿一点。"
        : "买美元的成本在往上走，近期有换汇计划的话早换通常更划算。"}` });
    else if (gap < -thr)
      A.push({ t: SELL ? "warn" : "good", i: "↓", h: `<em>先令在走强</em>：BOT 近 5 日均价 ${fmt(m5, 2)}，低于近 20 日均价 ${fmt(m20, 2)}（${sgn(gap)}）。${SELL
        ? "同样一笔美元换回的先令在变少，对你不利；有确定的换汇需求就别再等了。"
        : "买美元的成本在下行，不急用可以再观察几天。"}` });
    else
      A.push({ t: "info", i: "→", h: `<em>汇率平稳</em>：BOT 近 5 日与近 20 日均价只差 ${sgn(gap)}，不到 ${fmt(thr, 1)} 的波动门槛，属窄幅震荡，没有明确方向。` });
  }

  // 只跟最近 60 个有效日比。价差长期在漂移，拿全年均值当基准会得出错误结论。
  const sp = R.filter((r) => r.crdbMid !== null && r.bot !== null)
    .map((r) => r.crdbMid - r.bot).slice(-60);
  if (sp.length >= 6) {
    const cur = sp[sp.length - 1], m = mean(sp), s = sd(sp), z = s ? (cur - m) / s : 0;
    if (z < -1)
      A.push({ t: "warn", i: "!", h: `<em>CRDB 牌价被压得偏低</em>：当前 CRDB 中间价比 BOT 低 ${fmt(Math.abs(cur), 2)}，近 60 日均值只有 ${fmt(Math.abs(m), 2)}。这种时候柜台往上让价的空间通常更小，别按平常的幅度去谈。` });
    else if (z > 1)
      A.push({ t: "good", i: "✓", h: `<em>谈价窗口相对有利</em>：当前 CRDB 与 BOT 的价差 ${sgn(cur)}，高于近 60 日均值 ${sgn(m)}（${fmt(z, 1)} 个标准差）。` });
    else
      A.push({ t: "info", i: "·", h: `CRDB 中间价与 BOT 的价差 ${sgn(cur)}，处在近 60 日的正常区间（均值 ${sgn(m)}，标准差 ${fmt(s, 2)}）。` });
  }

  // 议价参考 —— 锚在 CRDB 中间价上。
  // 用 BOT 当锚点不可靠：CRDB 与 BOT 的价差本身在长期漂移，
  // 混不同时期的样本会把参考价拉偏十几个点。
  const offMid = D.filter((d) => d.vsMid !== null).map((d) => d.vsMid);
  if (offMid.length >= 1 && last.crdbMid !== null) {
    const m = mean(offMid), s = offMid.length >= 2 ? sd(offMid) : null;
    const target = last.crdbMid + m;
    const better = SELL ? target + (s ?? 0) : target - (s ?? 0);
    const worse = SELL ? target - (s ?? 0) : target + (s ?? 0);
    A.push({ t: "info", i: "◎", h: `<em>今日议价参考</em>：你谈成的价格平均比当日 CRDB 中间价高 ${fmt(m, 2)}${s !== null ? `（波动 ±${fmt(s, 2)}）` : ""}。按今天中间价 ${fmt0(last.crdbMid)} 推算，<b>${fmt0(target)}</b> 上下是你的正常水平${s !== null ? `，${SELL ? `谈到 ${fmt0(better)} 以上算谈得好，低于 ${fmt0(worse)} 就吃亏了` : `压到 ${fmt0(better)} 以下算谈得好，超过 ${fmt0(worse)} 就偏贵了`}` : ""}。样本 ${offMid.length} 笔。` });
  }

  // 牌价结构漂移 —— 看你实际成交对照的那个牌价（卖美元看买入价）相对央行怎么变。
  // 这决定了「相对牌价谈到 +X」这个习惯目标还成不成立。
  const cardKey = SELL ? "crdbBuy" : "crdbSell";
  const spAll = R.filter((r) => r[cardKey] !== null && r.bot !== null);
  if (spAll.length >= 60) {
    const recent = mean(spAll.slice(-20).map((r) => r[cardKey] - r.bot));
    const older = mean(spAll.slice(-90, -60).map((r) => r[cardKey] - r.bot));
    if (older !== null && Math.abs(recent - older) > 5) {
      const worse = SELL ? recent < older : recent > older;
      const cardName = SELL ? "买入价" : "卖出价";
      A.push({ t: worse ? "warn" : "good", i: worse ? "↘" : "↗",
        h: `<em>牌价结构在变</em>：CRDB ${cardName}相对 BOT 的位置，三个月前平均 ${sgn(older)}，最近 20 天平均 ${sgn(recent)}（挪了 ${sgn(recent - older, 1)}）。${worse
          ? (SELL
            ? "银行的收美元报价相对央行越挪越低，等于起谈点在往下走。就算你每次都能在牌价上加到老幅度，实际拿到手的相对价格仍在变差——目标应该盯住「相对央行差多少」，而不是「相对牌价加多少」。"
            : "银行卖美元的报价相对央行越抬越高，起谈点在往上走，同样的议价幅度换算下来成本其实在增加。")
          : (SELL
            ? "银行的收美元报价相对央行在回升，起谈点变好，这段时间谈同样的幅度实际更划算。"
            : "银行卖美元的报价相对央行在回落，起谈点变好。")}` });
    }
  }

  const missing = R.slice(-10).filter((r) => r.bot === null).length;
  if (missing >= 4)
    A.push({ t: "warn", i: "!", h: `最近 10 个记录日里有 ${missing} 天缺 BOT 中间价（周末和坦桑公众假期属正常）。缺口多的时候趋势判断会变粗糙。` });

  const scored = D.filter((d) => d.vsCard !== null);
  if (scored.length) {
    const best = scored.slice().sort((a, b) => (a.buyUSD ? a.vsCard - b.vsCard : b.vsCard - a.vsCard))[0];
    A.push({ t: "good", i: "★", h: `<em>最佳一笔</em>：${best.d} 议价 ${fmt0(best.rate)}，比当日 CRDB ${best.buyUSD ? "卖出" : "买入"}牌价 ${fmt0(best.card)} 优 ${fmt0(Math.abs(best.vsCard))}${best.usd ? `，${SELL ? "多拿" : "省下"}约 ${money(best.save)} TZS` : ""}。` });
  }
  if (D.length < 4)
    A.push({ t: "info", i: "·", h: `目前只有 ${D.length} 笔议价记录，统计规律还谈不上稳定。记满 8–10 笔之后，「议价参考」和「时机复盘」的参考价值会明显提升。` });

  $("#alerts").innerHTML = A.map(
    (a) => `<div class="alert ${a.t}"><div class="ico">${a.i}</div><div>${a.h}</div></div>`
  ).join("");
}

/* --------------------------------------------------- 走势 */
function visibleRates() {
  const R = state.rates;
  if (!state.range || !R.length) return R;
  return R.filter((r) => r.d >= shift(R[R.length - 1].d, -state.range));
}

function renderTrend(R, D) {
  const Rr = visibleRates();
  const S = [
    { name: "CRDB 中间价", color: "--s1", get: (r) => r.crdbMid },
    { name: "BOT 中间价", color: "--s2", get: (r) => r.bot },
    { name: "XE 中间价", color: "--s3", get: (r) => r.xe },
  ];
  const from = Rr[0]?.d || "0000";
  $("#legend1").innerHTML =
    S.map((s) => `<span><i style="background:${cssVar(s.color)}"></i>${s.name}</span>`).join("") +
    `<span><i class="diamond" style="background:${cssVar("--s4")}"></i>我的议价</span>` +
    (state.band ? `<span><i style="background:${cssVar("--band")}"></i>CRDB 买入–卖出区间</span>` : "");
  lineChart($("#chartTrend"), Rr, S, {
    band: state.band,
    marks: D.filter((d) => d.d >= from).map((d) => ({ d: d.d, v: d.rate })),
  });

  divergingBars($("#chartSpread"), Rr.map((r) => ({ d: r.d, v: r.crdbMid !== null && r.bot !== null ? r.crdbMid - r.bot : null })),
    { label: "CRDB 中间价 − BOT" });
  divergingBars($("#chartSpreadXe"), Rr.map((r) => ({ d: r.d, v: r.crdbMid !== null && r.xe !== null ? r.crdbMid - r.xe : null })),
    { label: "CRDB 中间价 − XE", h: 180 });
}

/* ------------------------------------------------ 议价复盘 */
function renderDeals(R, D) {
  const G = [
    { name: "vs CRDB 中间价", color: "--s1", get: (r) => r.vsMid },
    { name: "vs BOT 中间价", color: "--s2", get: (r) => r.vsBot },
    { name: "vs XE 中间价", color: "--s3", get: (r) => r.vsXe },
  ];
  $("#legend2").innerHTML = G.map((s) => `<span><i style="background:${cssVar(s.color)}"></i>${s.name}</span>`).join("");
  groupedBars($("#chartDeals"), D, G, { emptyMsg: "还没有议价记录" });

  const tSell = sellSide(D);
  $("#timingDesc").innerHTML =
    `每笔议价当天的 BOT 中间价，在此前 30 天区间里处在什么位置。${tSell
      ? "你是卖美元换先令，汇率越高换回的先令越多，所以越靠<b>高位</b>越好。"
      : "买美元时越靠<b>低位</b>越好。"}`;
  $("#timing").innerHTML = D.length
    ? `<div class="scroll"><table>
      <thead><tr><th class="txt">日期</th><th>议价</th><th>当日 BOT</th><th>近 30 日区间</th>
      <th class="txt" style="min-width:150px">低 ← 位置 → 高</th><th>百分位</th><th class="txt">评价</th></tr></thead>
      <tbody>${D.slice().reverse().map((d) => {
        if (d.pct === null)
          return `<tr><td>${d.d}</td><td>${fmt0(d.rate)}</td><td>${fmt(d.bot, 2)}</td>
            <td colspan="4" class="txt muted">该日 BOT 样本不足，无法评估</td></tr>`;
        const p = d.pct;
        const good = d.buyUSD ? p < 0.35 : p > 0.65;
        const bad = d.buyUSD ? p > 0.65 : p < 0.35;
        const verdict = good ? `<span class="down">✓ 时机不错</span>`
          : bad ? `<span class="up">△ 点位偏${d.buyUSD ? "高" : "低"}</span>` : "中性";
        return `<tr><td>${d.d}</td><td><b>${fmt0(d.rate)}</b></td><td>${fmt(d.bot, 2)}</td>
          <td>${fmt(d.lo, 2)} – ${fmt(d.hi, 2)}</td>
          <td><div class="meter${d.buyUSD ? "" : " hi-good"}"><div class="pin" style="left:calc(${(p * 100).toFixed(1)}% - 1.5px)"></div></div></td>
          <td>${(p * 100).toFixed(0)}%</td><td class="txt">${verdict}</td></tr>`;
      }).join("")}</tbody></table></div>`
    : `<div class="empty">还没有议价记录</div>`;

  $("#dealList").innerHTML = D.length
    ? `<div class="scroll"><table>
      <thead><tr><th class="txt">日期</th><th class="txt">方向</th><th>议价</th><th>美元金额</th>
      <th>先令总额</th><th>当日中间价</th><th>vs 中间价</th><th>当日牌价</th><th>${sellSide(D) ? "比牌价多拿" : "比牌价省"}</th>
      <th class="txt">银行/经办</th><th class="txt">备注</th><th></th></tr></thead>
      <tbody>${D.slice().reverse().map((d) => `<tr>
        <td>${d.d}</td><td class="txt">${d.buyUSD ? "买入美元" : "卖出美元"}</td>
        <td><b>${fmt(d.rate, 2)}</b></td><td>${d.usd === null ? "—" : fmt0(d.usd)}</td>
        <td>${money(d.tzs)}</td><td>${fmt0(d.mid)}</td>
        <td class="${(d.vsMid > 0) === !d.buyUSD ? "down" : "up"}">${sgn(d.vsMid)}</td>
        <td>${fmt0(d.card)}</td>
        <td class="${d.save > 0 ? "down" : d.save < 0 ? "up" : ""}">${d.save === null ? "—" : money(d.save)}</td>
        <td class="txt">${esc([d.bank, d.by].filter(Boolean).join(" / ")) || "—"}</td>
        <td class="txt wrap">${esc(d.note)}</td>
        <td><button class="iconbtn" data-edit="${d.idx}" title="编辑">✎</button>
            <button class="iconbtn" data-del="${d.idx}" title="删除">✕</button></td></tr>`).join("")}
      </tbody></table></div>`
    : `<div class="empty">还没有议价记录</div>`;

  $$("[data-del]").forEach((b) => (b.onclick = () => removeDeal(+b.dataset.del)));
  $$("[data-edit]").forEach((b) => (b.onclick = () => editDeal(+b.dataset.edit)));
}

/* ------------------------------------------------ 数据明细 */
function renderTable(R, D) {
  const dm = {};
  D.forEach((d) => (dm[d.d] = d.rate));
  $("#rateTable").innerHTML = `<div class="scroll"><table>
    <thead><tr><th class="txt">日期</th><th>CRDB 买入</th><th>CRDB 卖出</th><th>CRDB 中间价</th>
    <th>BOT 中间价</th><th>CRDB−BOT</th><th>XE 中间价</th><th>CRDB−XE</th><th>我的议价</th></tr></thead>
    <tbody>${[...R].reverse().map((r) => `<tr>
      <td>${r.d}</td><td>${fmt0(r.crdbBuy)}</td><td>${fmt0(r.crdbSell)}</td><td>${fmt0(r.crdbMid)}</td>
      <td>${fmt(r.bot, 2)}</td>
      <td>${r.crdbMid !== null && r.bot !== null ? sgn(r.crdbMid - r.bot) : "—"}</td>
      <td>${fmt(r.xe, 2)}</td>
      <td>${r.crdbMid !== null && r.xe !== null ? sgn(r.crdbMid - r.xe) : "—"}</td>
      <td>${dm[r.d] ? "<b>" + fmt0(dm[r.d]) + "</b>" : ""}</td></tr>`).join("")}
    </tbody></table></div>`;
}

/* ==================================================== 写入 */
function setSaveState(msg, kind) {
  const b = $("#saveBanner");
  if (!msg) { b.hidden = true; return; }
  b.hidden = false;
  b.className = "banner " + (kind || "warn");
  b.innerHTML = msg;
}

async function pushDeals(message) {
  const env = await seal(state.pass, state.deals);
  const body = JSON.stringify(env, null, 2) + "\n";
  await gh.putFile(CONFIG.dealsPath, utf8ToBase64(body), message);
}

async function saveDeals(message) {
  if (!gh.hasToken()) {
    setSaveState("改动只在这个浏览器里，<b>还没有存到云端</b>。到「设置」里填写写入令牌后才能同步。", "warn");
    return false;
  }
  setSaveState("正在保存到 GitHub…", "warn");
  try {
    await pushDeals(message);
    setSaveState("已保存到云端。GitHub 大约 1 分钟后完成发布，其他人刷新即可看到。", "good");
    setTimeout(() => setSaveState(""), 9000);
    return true;
  } catch (e) {
    setSaveState("保存失败：" + esc(e.message), "crit");
    return false;
  }
}

async function removeDeal(idx) {
  const d = state.deals[idx];
  if (!confirm(`删除 ${d.d} 的议价记录（${d.rate}）？`)) return;
  state.deals.splice(idx, 1);
  render();
  await saveDeals(`删除议价记录 ${d.d}`);
}

function editDeal(idx) {
  const d = state.deals[idx];
  const f = $("#dealForm");
  f.d.value = d.d; f.rate.value = d.rate; f.dir.value = d.dir || "sellUSD";
  f.usd.value = d.usd ?? ""; f.tzs.value = d.tzs ?? "";
  f.bank.value = d.bank || ""; f.by.value = d.by || ""; f.note.value = d.note || "";
  state.editing = idx;
  $("#dealSubmit").textContent = "保存修改";
  $("#dealCancel").hidden = false;
  switchTab("deals");
  f.scrollIntoView({ behavior: "smooth", block: "center" });
}

function resetDealForm() {
  const f = $("#dealForm");
  f.reset();
  f.bank.value = "CRDB";
  state.editing = null;
  $("#dealSubmit").textContent = "添加记录";
  $("#dealCancel").hidden = true;
}

/* ==================================================== 设置页 */
function renderAdmin() {
  $("#tokenState").innerHTML = gh.hasToken()
    ? `<span class="pill" style="color:var(--good-ink)">✓ 已设置写入令牌</span>`
    : `<span class="pill">未设置 — 目前只能查看，不能保存</span>`;
  $("#repoLine").innerHTML =
    `仓库 <code>${CONFIG.owner}/${CONFIG.repo}</code> · 分支 <code>${CONFIG.branch}</code>`;
  const src = state.ratesMeta.sources || {};
  $("#srcLine").innerHTML = Object.entries(src)
    .map(([k, v]) => `${k.toUpperCase()}: ${/^https?:/.test(v) ? `<a href="${esc(v)}" target="_blank" rel="noopener">${esc(v)}</a>` : esc(v)}`)
    .join("<br>");
}

/* ==================================================== 标签页 */
function switchTab(name) {
  $$(".tab").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.tab === name)));
  $$(".panel").forEach((p) => p.classList.toggle("active", p.dataset.panel === name));
  location.hash = name;
  window.scrollTo({ top: 0 });
}

/* ==================================================== 主题 */
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem("fx_theme", t);
  $("#themeBtn").textContent = t === "dark" ? "浅色" : "深色";
  if (!$("#app").hidden) render();
}

/* ==================================================== 启动 */
function bind() {
  $$(".tab").forEach((t) => (t.onclick = () => switchTab(t.dataset.tab)));
  $("#themeBtn").onclick = () =>
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  $("#lockBtn").onclick = () => {
    sessionStorage.removeItem(SS_PASS);
    localStorage.removeItem(LS_PASS);
    location.reload();
  };
  $("#range").onchange = (e) => { state.range = +e.target.value; renderTrend(state.rates, enrich()); };
  $("#showBand").onchange = (e) => { state.band = e.target.checked; renderTrend(state.rates, enrich()); };

  $("#dealForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const rec = {
      d: f.d.value, rate: +f.rate.value, dir: f.dir.value,
      usd: f.usd.value ? +f.usd.value : null,
      tzs: f.tzs.value ? +f.tzs.value : null,
      bank: f.bank.value.trim(), by: f.by.value.trim(), note: f.note.value.trim(),
    };
    if (state.editing !== null) state.deals[state.editing] = rec;
    else state.deals.push(rec);
    state.deals = sortDeals(state.deals);
    const wasEdit = state.editing !== null;
    resetDealForm();
    render();
    await saveDeals(`${wasEdit ? "修改" : "新增"}议价记录 ${rec.d}`);
  });
  $("#dealCancel").onclick = resetDealForm;

  $("#tokenForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const out = $("#tokenMsg");
    const t = $("#tokenInput").value.trim();
    if (!t) { gh.setToken(""); renderAdmin(); out.innerHTML = "已清除本机令牌。"; return; }
    gh.setToken(t);
    out.innerHTML = "正在校验…";
    try {
      await gh.verify();
      out.innerHTML = `<span class="down">✓ 令牌可用，已保存在这台浏览器。</span>`;
      $("#tokenInput").value = "";
    } catch (ex) {
      gh.setToken("");
      out.innerHTML = `<span class="up">✗ ${esc(ex.message)}</span>`;
    }
    renderAdmin();
  });
  $("#tokenClear").onclick = () => {
    gh.setToken(""); renderAdmin();
    $("#tokenMsg").innerHTML = "已清除本机令牌。";
  };

  $("#passForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const out = $("#passMsg");
    const a = $("#passNew").value, b = $("#passNew2").value;
    if (a.length < 6) { out.innerHTML = `<span class="up">口令至少 6 位。</span>`; return; }
    if (a !== b) { out.innerHTML = `<span class="up">两次输入不一致。</span>`; return; }
    if (!gh.hasToken()) { out.innerHTML = `<span class="up">需要先设置写入令牌。</span>`; return; }
    out.innerHTML = "正在用新口令重新加密并上传…";
    const old = state.pass;
    state.pass = a;
    try {
      await pushDeals("修改访问口令");
      sessionStorage.setItem(SS_PASS, a);
      if (localStorage.getItem(LS_PASS)) localStorage.setItem(LS_PASS, a);
      $("#passForm").reset();
      out.innerHTML = `<span class="down">✓ 口令已更换。请把新口令通知所有需要访问的人；旧口令约 1 分钟后失效。</span>`;
    } catch (ex) {
      state.pass = old;
      out.innerHTML = `<span class="up">✗ ${esc(ex.message)}</span>`;
    }
  });

  $("#exportCsv").onclick = () => {
    const D = enrich(), dm = {};
    D.forEach((d) => (dm[d.d] = d));
    const head = "日期,CRDB买入,CRDB卖出,CRDB中间价,BOT中间价,CRDB减BOT,XE中间价,CRDB减XE,我的议价,方向,美元金额,先令总额,比牌价省TZS,银行,经办,备注";
    const rows = state.rates.map((r) => {
      const d = dm[r.d] || {};
      const q = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
      return [r.d, r.crdbBuy ?? "", r.crdbSell ?? "", r.crdbMid ?? "", r.bot ?? "",
        r.crdbMid !== null && r.bot !== null ? (r.crdbMid - r.bot).toFixed(2) : "",
        r.xe ?? "", r.crdbMid !== null && r.xe !== null ? (r.crdbMid - r.xe).toFixed(2) : "",
        d.rate ?? "", d.rate ? (d.buyUSD ? "买入美元" : "卖出美元") : "", d.usd ?? "", d.tzs ?? "",
        d.save != null ? Math.round(d.save) : "", q(d.bank), q(d.by), q(d.note)].join(",");
    });
    const blob = new Blob(["﻿" + [head, ...rows].join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `汇率与议价明细_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
}

(async function boot() {
  applyTheme(localStorage.getItem("fx_theme") ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  bind();
  initGate();
  resetDealForm();
  try {
    await loadRates();
  } catch (e) {
    $("#gateErr").textContent = "行情数据加载失败：" + e.message;
    return;
  }
  const saved = sessionStorage.getItem(SS_PASS) || localStorage.getItem(LS_PASS);
  if (saved) {
    try { await tryUnlock(saved, !!localStorage.getItem(LS_PASS)); return; } catch { /* 口令已改，回到登录 */ }
  }
  $("#gate").hidden = false;
  $("#gatePass").focus();
  if (location.hash) { /* 记住目标标签页 */ }
})();

window.addEventListener("hashchange", () => {
  const n = location.hash.slice(1);
  if (n && $$(".tab").some((t) => t.dataset.tab === n)) switchTab(n);
});
