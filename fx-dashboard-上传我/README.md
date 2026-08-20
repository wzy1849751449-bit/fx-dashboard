# USD / TZS 汇率与议价看板

坦桑尼亚先令兑美元的汇率跟踪与换汇议价复盘。每个工作日自动抓取三个数据源，
在网页上对比银行牌价、央行中间价、国际中间价，并分析自己谈下来的议价汇率相对这些基准的位置。

**在线地址**：https://wzy1849751449-bit.github.io/fx-dashboard/

---

## 数据来源

| 源 | 取什么 | 地址 |
|---|---|---|
| BOT（坦桑尼亚央行） | USD 买入 / 卖出 / 中间价 | https://www.bot.go.tz/exchangerate/excrates |
| CRDB Bank | USD 买入 / 卖出牌价 | https://crdbbank.co.tz/en/forex |
| XE | 国际中间市场价（失败时回退 open.er-api.com） | https://www.xe.com/currencyconverter/convert/?From=USD&To=TZS |

抓取时间：每周一至周五，东非时间上午 11:00（`cron: 0 8 * * 1-5`，UTC）。
可以在 Actions 页面点 **Run workflow** 手动触发。

---

## 安全模型

网站托管在 GitHub Pages，仓库是公开的。数据分两类处理：

- **行情数据**（`data/rates.json`）——各家银行公开挂牌价，明文存放，无需保护。
- **议价数据**（`data/deals.enc.json`）——议价汇率、换汇金额、备注等商业敏感内容，
  以 **AES-256-GCM** 加密存放，密钥由访问口令经 **PBKDF2-SHA256 / 250,000 轮**派生，
  只在浏览器内解密。没有口令的人即使直接下载源文件也无法还原任何内容。

口令是**共享口令**，不是账号体系。要收回某个人的访问权限，在网页「设置 → 访问口令」里
换一个新口令（会自动用新口令重新加密并上传），然后把新口令发给仍需访问的人。

写入令牌（GitHub fine-grained PAT）只保存在使用者自己浏览器的 localStorage 里，
不进仓库、不进构建产物、其他访问者看不到。

---

## 目录结构

```
index.html                     页面骨架、口令门、五个标签页
assets/
  style.css                    设计令牌与全部样式（浅色 / 深色）
  app.js                       状态、计算、渲染、GitHub 写入编排
  charts.js                    无依赖 SVG 图表（折线 / 分组柱 / 发散柱 / 迷你线）
  crypto.js                    AES-GCM + PBKDF2 封装
  github.js                    GitHub Contents API 写入层
data/
  rates.json                   行情数据（明文，由定时任务追加）
  deals.enc.json               议价数据（密文）
scripts/
  fetch-rates.mjs              抓取脚本（零依赖，Node 20+）
  seal.mjs                     本地加解密工具
.github/workflows/site.yml     定时抓取 + 提交 + 发布 Pages
```

---

## 计算口径

- CRDB 中间价 =（买入价 + 卖出价）÷ 2
- **买入美元**（先令 → 美元）时对照 CRDB **卖出价**：省下的钱 =（卖出价 − 议价）× 美元金额
- **卖出美元**（美元 → 先令）时对照 CRDB **买入价**：多拿的钱 =（议价 − 买入价）× 美元金额
- BOT / XE 在周末与公众假期没有数据，计算时向前取最近一个有效值
- 换汇时机百分位 = 议价当日 BOT 中间价在此前 30 天区间 `[最低, 最高]` 中的位置；
  样本不足 4 个交易日时不给结论

---

## 本地开发

```bash
# 起一个静态服务器（ES module 不能用 file:// 直接打开）
python3 -m http.server 8080

# 手动跑一次抓取
node scripts/fetch-rates.mjs

# 用某个口令重新加密议价数据
node scripts/seal.mjs '<口令>' path/to/deals.json
node scripts/seal.mjs --open '<口令>'      # 解密校验
```

---

数据仅供内部分析参考，银行实际成交以柜台为准，不构成任何交易建议。
