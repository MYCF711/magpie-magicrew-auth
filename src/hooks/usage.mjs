// ⑤ auth.usage(getAuth) —— 额度
//
// 画进度条，**同时是路由排序输入**：`used` 缺了会被当成 0% = 满额，
// 空号反而排到队首。
//
// ⚠ 预充值积分制放 aside：只显示余额、不参与排序；余额 0 时 used 置 100，
//   让它老老实实排到最后。

import { fetchPoints } from "../api.mjs"

export function makeUsage(c) {
  return async (getAuth) => {
    const auth = await getAuth()
    if (!auth) return { error: "未登录", windows: [] }
    try {
      const p = await fetchPoints(auth.jwt, auth.org, c.host)
      const nextExpiry = p.expiring?.[0]?.expiresAt
      return {
        plan: p.total > 0 ? "积分制" : "已耗尽",
        balance: `${p.total.toLocaleString("zh-CN")} 积分`,
        windows: [
          p.total > 0
            ? {
                name: "积分余额",
                used: 0,
                display: `${p.total.toLocaleString("zh-CN")} 积分`,
                amount: 0,
                limit: p.total,
                unit: "积分",
                resetsAt: nextExpiry,
                aside: true,
              }
            : { name: "积分余额", used: 100, display: "已耗尽" },
        ],
      }
    } catch (e) {
      return { error: String(e?.message ?? e), windows: [] }
    }
  }
}
