#!/usr/bin/env node
/**
 * 本地加密工具：把明文议价记录封成 data/deals.enc.json
 * 与浏览器端 assets/crypto.js 使用完全相同的算法参数。
 *
 *   node scripts/seal.mjs <口令> [明文json路径]     加密
 *   node scripts/seal.mjs --open <口令>             解密并打印（用于校验）
 */
import { webcrypto as crypto } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "data/deals.enc.json");
const ITER = 250000;
const enc = new TextEncoder();

async function key(pass, salt) {
  const base = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: ITER, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
  );
}
const b64 = (b) => Buffer.from(b).toString("base64");
const unb64 = (s) => new Uint8Array(Buffer.from(s, "base64"));

const [a1, a2, a3] = process.argv.slice(2);

if (a1 === "--open") {
  const env = JSON.parse(readFileSync(OUT, "utf8"));
  const k = await key(a2, unb64(env.salt));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(env.iv) }, k, unb64(env.ct));
  console.log(Buffer.from(pt).toString("utf8"));
  process.exit(0);
}

if (!a1) {
  console.error("用法：node scripts/seal.mjs <口令> [明文json路径]");
  process.exit(1);
}

const data = a2 ? JSON.parse(readFileSync(resolve(a2), "utf8")) : [];
const salt = crypto.getRandomValues(new Uint8Array(16));
const iv = crypto.getRandomValues(new Uint8Array(12));
const k = await key(a1, salt);
const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, enc.encode(JSON.stringify(data)));

writeFileSync(OUT, JSON.stringify({
  v: 1, kdf: "PBKDF2-SHA256", cipher: "AES-256-GCM", iter: ITER,
  salt: b64(salt), iv: b64(iv), ct: b64(ct),
}, null, 2) + "\n");

console.log(`已加密 ${Array.isArray(data) ? data.length : "?"} 条记录 → data/deals.enc.json`);
