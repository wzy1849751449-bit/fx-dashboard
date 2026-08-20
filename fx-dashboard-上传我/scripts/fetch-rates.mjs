#!/usr/bin/env node
/**
 * 抓取 USD/TZS 汇率并合并进 data/rates.json
 *   · BOT  坦桑尼亚央行官网牌价（买入 / 卖出 / 中间价）
 *   · CRDB CRDB 银行官网牌价（买入 / 卖出）
 *   · XE   国际中间市场价（失败时回退 open.er-api.com）
 *
 * 设计原则：
 *   - 零依赖，只用 Node 20 内置 fetch
 *   - 单个源失败不影响其它源，缺失写 null，绝不编造数字
 *   - 幂等：同一天重复运行只补空字段，不覆盖已有的非空值
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = resolve(ROOT, "data/rates.json");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

/** 东非时间（UTC+3）的今天 */
function todayEAT() {
  return new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
}

async function get(url, { timeout = 30000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      redirect: "follow",
      headers: { "user-agent": UA, accept: "text/html,application/json,*/*", "accept-language": "en-US,en;q=0.9" },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

const num = (s) => {
  const v = parseFloat(String(s).replace(/,/g, "").trim());
  return Number.isFinite(v) ? v : null;
};
/** 汇率合理性闸门：USD/TZS 落在 1500–5000 之外一律视为解析错误 */
const sane = (v) => (v !== null && v > 1500 && v < 5000 ? v : null);

/* ---------------------------------------------------------- BOT */
/** 表格列序：# | 代码 | Buying | Selling | Mean | Date */
async function fetchBOT() {
  const html = await get("https://www.bot.go.tz/exchangerate/excrates");
  const m = html.match(
    />\s*USD\s*<\/td>\s*<td[^>]*>\s*([\d.,]+)\s*<\/td>\s*<td[^>]*>\s*([\d.,]+)\s*<\/td>\s*<td[^>]*>\s*([\d.,]+)\s*<\/td>\s*<td[^>]*>\s*([\w-]+)\s*<\/td>/i
  );
  if (!m) throw new Error("BOT：页面结构变了，找不到 USD 行");
  // "20-Aug-26" → "2026-08-20"
  const MON = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
                jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
  const p = m[4].split("-");
  const date =
    p.length === 3 && MON[p[1].toLowerCase().slice(0, 3)]
      ? `20${p[2].slice(-2)}-${MON[p[1].toLowerCase().slice(0, 3)]}-${p[0].padStart(2, "0")}`
      : null;
  return { date, buy: sane(num(m[1])), sell: sane(num(m[2])), mid: sane(num(m[3])) };
}

/* --------------------------------------------------------- CRDB */
/** 表格列序：币种名 | 代码 | Buying | Selling */
async function fetchCRDB() {
  const html = await get("https://crdbbank.co.tz/en/forex");
  const m = html.match(
    /<td>\s*USD\s*<\/td>\s*<td[^>]*>\s*([\d.,]+)\s*<\/td>\s*<td[^>]*>\s*([\d.,]+)\s*<\/td>/i
  );
  if (!m) throw new Error("CRDB：页面结构变了，找不到 USD 行");
  const buy = sane(num(m[1])), sell = sane(num(m[2]));
  if (buy !== null && sell !== null && sell <= buy) throw new Error("CRDB：买卖价顺序异常");
  return { buy, sell };
}

/* ----------------------------------------------------------- XE */
async function fetchXE() {
  try {
    const html = await get(
      "https://www.xe.com/currencyconverter/convert/?Amount=1&From=USD&To=TZS"
    );
    const m = html.match(/id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) throw new Error("XE：找不到 __NEXT_DATA__");
    const v = JSON.parse(m[1])?.props?.pageProps?.initialRatesData?.rates?.TZS;
    const r = sane(num(v));
    if (r === null) throw new Error("XE：TZS 字段缺失");
    return { mid: r, via: "xe.com" };
  } catch (e) {
    console.warn("  XE 主源失败，改用 open.er-api.com：" + e.message);
    const j = JSON.parse(await get("https://open.er-api.com/v6/latest/USD"));
    const r = sane(num(j?.rates?.TZS));
    if (r === null) throw new Error("回退源也拿不到 TZS");
    return { mid: r, via: "open.er-api.com" };
  }
}

/* --------------------------------------------------------- main */
const settle = async (name, fn) => {
  try {
    const v = await fn();
    console.log(`✓ ${name}`, JSON.stringify(v));
    return v;
  } catch (e) {
    console.warn(`✗ ${name} 失败：${e.message}`);
    return null;
  }
};

const day = todayEAT();
console.log(`抓取日期（东非时间）：${day}`);

const [bot, crdb, xe] = await Promise.all([
  settle("BOT", fetchBOT),
  settle("CRDB", fetchCRDB),
  settle("XE", fetchXE),
]);

// BOT 页面上的日期必须就是今天，否则当作今天还没发布
const botMid = bot && bot.date === day ? bot.mid : null;
if (bot && bot.date !== day) console.warn(`  BOT 页面日期为 ${bot.date}，非今日，本次不采用`);

const db = JSON.parse(readFileSync(FILE, "utf8"));
db.rates ||= [];

const incoming = {
  crdbBuy: crdb?.buy ?? null,
  crdbSell: crdb?.sell ?? null,
  bot: botMid,
  xe: xe?.mid ?? null,
};

if (Object.values(incoming).every((v) => v === null)) {
  console.error("三个源全部失败，不改动数据文件。");
  process.exit(1);
}

let row = db.rates.find((r) => r.d === day);
let action;
if (row) {
  action = "更新";
  // 只补空字段，已有的非空值保留（尊重人工修正）
  for (const [k, v] of Object.entries(incoming)) {
    if (v !== null && (row[k] === null || row[k] === undefined)) row[k] = v;
  }
} else {
  action = "新增";
  db.rates.push({ d: day, ...incoming });
  db.rates.sort((a, b) => (a.d < b.d ? -1 : 1));
}

db.updatedAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
db.sources = {
  bot: "https://www.bot.go.tz/exchangerate/excrates",
  crdb: "https://crdbbank.co.tz/en/forex",
  xe: xe?.via ?? "https://www.xe.com/currencyconverter/convert/?From=USD&To=TZS",
};

writeFileSync(FILE, JSON.stringify(db, null, 2) + "\n");

const r = db.rates.find((x) => x.d === day);
const mid = r.crdbBuy !== null && r.crdbSell !== null ? (r.crdbBuy + r.crdbSell) / 2 : null;
console.log(
  `\n${action} ${day}：CRDB ${r.crdbBuy ?? "—"}/${r.crdbSell ?? "—"}` +
    `（中间价 ${mid ?? "—"}） · BOT ${r.bot ?? "—"} · XE ${r.xe?.toFixed(2) ?? "—"}` +
    (mid !== null && r.bot !== null ? ` · CRDB−BOT ${(mid - r.bot).toFixed(2)}` : "")
);
console.log(`共 ${db.rates.length} 个交易日。`);
