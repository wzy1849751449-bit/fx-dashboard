/**
 * 口令加密模块 —— AES-256-GCM + PBKDF2-SHA256
 *
 * 仓库里存的是密文；没有口令的人即使拿到 data/deals.enc.json 也解不开。
 * 这不是"前端密码框"式的假保护，是真正的加密。
 */
const enc = new TextEncoder();
const dec = new TextDecoder();

export const ITER = 250000;

const b64 = {
  to: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))),
  from: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
};

async function deriveKey(passphrase, salt, iterations) {
  const base = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/** 明文对象 → 密文信封 */
export async function seal(passphrase, data) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, ITER);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(JSON.stringify(data))
  );
  return {
    v: 1,
    kdf: "PBKDF2-SHA256",
    cipher: "AES-256-GCM",
    iter: ITER,
    salt: b64.to(salt),
    iv: b64.to(iv),
    ct: b64.to(ct),
  };
}

/** 密文信封 → 明文对象；口令错误会抛异常（GCM 校验失败） */
export async function unseal(passphrase, env) {
  const key = await deriveKey(passphrase, b64.from(env.salt), env.iter || ITER);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64.from(env.iv) },
    key,
    b64.from(env.ct)
  );
  return JSON.parse(dec.decode(pt));
}

/** UTF-8 字符串 → base64（GitHub Contents API 需要） */
export function utf8ToBase64(str) {
  return btoa(String.fromCharCode(...enc.encode(str)));
}
