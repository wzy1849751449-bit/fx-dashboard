/**
 * GitHub Contents API 写入层
 *
 * 令牌只存在使用者自己的浏览器 localStorage 里，不会离开这台设备，
 * 也不会写进仓库。建议使用「Fine-grained personal access token」，
 * 权限只勾这一个仓库的 Contents: Read and write。
 */
const TOKEN_KEY = "fx_gh_token";

export const setToken = (t) =>
  t ? localStorage.setItem(TOKEN_KEY, t.trim()) : localStorage.removeItem(TOKEN_KEY);
export const getToken = () => localStorage.getItem(TOKEN_KEY) || "";
export const hasToken = () => !!getToken();

let REPO = { owner: "", name: "", branch: "main" };
export const configure = (cfg) => (REPO = { ...REPO, ...cfg });

const api = (path) =>
  `https://api.github.com/repos/${REPO.owner}/${REPO.name}/contents/${path}`;

function headers() {
  const t = getToken();
  if (!t) throw new Error("还没有设置写入令牌");
  return {
    Authorization: `Bearer ${t}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function guard(res) {
  if (res.ok) return res.json();
  let detail = "";
  try {
    detail = (await res.json()).message || "";
  } catch {}
  const hint =
    res.status === 401 ? "令牌无效或已过期。"
    : res.status === 403 ? "令牌没有这个仓库的写入权限（需要 Contents: Read and write）。"
    : res.status === 404 ? "找不到仓库或文件，检查令牌的仓库授权范围。"
    : res.status === 409 ? "文件已被别处改动，请刷新页面后重试。"
    : "";
  throw new Error(`GitHub ${res.status}：${hint}${detail ? " " + detail : ""}`);
}

/** 读取当前文件的 sha（写入时必须带上，防止覆盖别人的改动） */
export async function getSha(path) {
  const res = await fetch(`${api(path)}?ref=${REPO.branch}`, { headers: headers() });
  if (res.status === 404) return null;
  return (await guard(res)).sha;
}

/** 写入（新建或更新）一个文件；contentBase64 为 base64 编码后的文件内容 */
export async function putFile(path, contentBase64, message) {
  const sha = await getSha(path);
  const res = await fetch(api(path), {
    method: "PUT",
    headers: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify({ message, content: contentBase64, branch: REPO.branch, ...(sha ? { sha } : {}) }),
  });
  return guard(res);
}

/** 校验令牌是否能读到这个仓库 */
export async function verify() {
  const res = await fetch(
    `https://api.github.com/repos/${REPO.owner}/${REPO.name}`,
    { headers: headers() }
  );
  await guard(res);
  return true;
}
