// 邀请上级页：只负责把选择写进本插件的 options（inviteBySite），
// 真正用它的是 index.mjs 里的 getOpts() 与 src/hooks/methods.mjs 的 inviteFromOptions()。
//
// 账号清单来自 codes.js —— 那是插件在 Node 侧生成的静态脚本
// （页面是沙箱：没有 fetch、读不到磁盘，也拿不到账号）。

const SITES = [
  { id: "magicrew", name: "超级麦吉（国内站）" },
  { id: "magicrew-intl", name: "MagiCrew（国际站）" },
];

const state = {
  options: {}, // 服务端已知的完整 options，保存时原样带回去
  pick: {}, // siteId -> { mode, code, org, accountId }
};

const data = () => window.MAGICREW_CODES?.sites ?? {};
const $ = (id) => document.getElementById(id);

function currentOf(siteId) {
  const per = state.options?.inviteBySite?.[siteId];
  if (per && (per.mode === "fixed" || per.mode === "custom") && per.code) return per;
  const pol = data()[siteId]?.policy;
  if (pol && (pol.mode === "fixed" || pol.mode === "custom") && pol.code) return pol;
  return { mode: "auto", code: "" };
}

function labelOf(siteId) {
  const cur = currentOf(siteId);
  if (cur.mode === "fixed" || cur.mode === "custom") {
    const who = cur.accountId || cur.org || "";
    return (who ? who + " · " : "") + cur.code;
  }
  const rolling = data()[siteId]?.rolling || "";
  return "自动（跟随最后一个登录 / 签到的号" + (rolling ? "，当前 " + rolling : "") + "）";
}

function render() {
  const app = $("app");
  app.innerHTML = "";

  for (const site of SITES) {
    const info = data()[site.id] || {};
    const codes = info.codes || {};
    const cur = currentOf(site.id);

    const sec = document.createElement("section");
    sec.innerHTML = `<h2>${site.name}</h2>`;

    const now = document.createElement("div");
    now.className = "now";
    now.innerHTML = `当前：<b>${labelOf(site.id)}</b>`;
    sec.appendChild(now);

    // 当前选择指向已删除的账号（登录侧已自动回退）—— 页面上要说明白
    const warn = document.createElement("div");
    warn.className = "hint";
    if (info.policyStale && (cur.mode === "fixed" || cur.mode === "custom") && cur.code === info.policy?.code) {
      warn.textContent = "⚠ 当前固定的账号已删除，新号会自动回退到滚动 / 作者码。点「自动」或重新选一个账号。";
      warn.style.color = "#f2b277";
      sec.appendChild(warn);
    } else if (info.rollingStale && cur.mode === "auto") {
      warn.textContent = "⚠ 滚动码属于已删除的账号，新号将改用作者码兜底。选一个账号或自定义码可避免。";
      warn.style.color = "#f2b277";
      sec.appendChild(warn);
    }

    const chips = document.createElement("div");
    chips.className = "chips";

    const mkChip = (text, active, onClick) => {
      const b = document.createElement("button");
      b.className = "chip";
      b.textContent = text;
      b.setAttribute("aria-pressed", active ? "true" : "false");
      b.onclick = onClick;
      chips.appendChild(b);
    };

    mkChip("自动（滚动）", cur.mode === "auto", () => {
      state.pick[site.id] = { mode: "auto", code: "" };
      render();
      save(site.id);
    });

    for (const [org, v] of Object.entries(codes)) {
      if (!v?.code) continue;
      const who = v.accountId || org;
      mkChip(`${who}（${v.code}）`, cur.code === v.code && cur.mode !== "auto", () => {
        state.pick[site.id] = { mode: "fixed", code: v.code, org, accountId: v.accountId || "" };
        render();
        save(site.id);
      });
    }
    sec.appendChild(chips);

    const custom = document.createElement("div");
    custom.className = "custom";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "自定义邀请码（IV 开头 12 位）";
    input.value = cur.mode === "custom" ? cur.code : "";
    const btn = document.createElement("button");
    btn.className = "save";
    btn.textContent = "保存自定义码";
    btn.onclick = () => {
      const code = input.value.trim().toUpperCase();
      if (!/^IV[A-Z0-9]{6,}$/.test(code)) {
        setStatus("邀请码格式不对：应以 IV 开头、至少 8 位", "bad");
        return;
      }
      state.pick[site.id] = { mode: "custom", code };
      render();
      save(site.id);
    };
    custom.append(input, btn);
    sec.appendChild(custom);

    if (!Object.keys(codes).length) {
      const hint = document.createElement("div");
      hint.className = "hint";
      hint.textContent = "还没有记录到任何账号的邀请码 —— 等这个站点签到 / 登录过一次就会出现在这里。";
      sec.appendChild(hint);
    }

    app.appendChild(sec);
  }
}

function setStatus(msg, kind) {
  const el = $("status");
  el.textContent = msg || "";
  el.className = kind || "";
}

// ── 写 options：magpie 限「每个页面每秒最多一次」 ─────────────────
//
// 连点两个账号会撞上 "a page sets its options once a second at most"。
// 所以这里串行 + 合并：同一时刻只有一个请求在飞，期间的新状态只保留最后一个，
// 两次之间至少隔 1 秒；被限流就再等一轮重试（最多 3 次）。
let inFlight = null;
let pending = null;
let lastAt = 0;
const GAP_MS = 1050;

function queueSave(patch, okMsg) {
  pending = { body: { ...(state.options || {}), ...patch }, okMsg };
  if (inFlight) return inFlight;
  inFlight = (async () => {
    let tries = 0;
    while (pending) {
      const wait = Math.max(0, GAP_MS - (Date.now() - lastAt));
      if (wait) await new Promise((r) => setTimeout(r, wait));
      const job = pending;
      pending = null;
      lastAt = Date.now();
      try {
        const saved = (await magpie.options.set(job.body)) ?? job.body;
        state.options = typeof saved === "object" && saved ? { ...job.body, ...saved } : job.body;
        setStatus(job.okMsg || "已保存", "ok")
        render() // 当前那一行跟着变;
        tries = 0;
      } catch (e) {
        const msg = String(e?.message ?? e);
        if (/once a second|too often/i.test(msg) && tries < 3) {
          tries += 1;
          if (!pending) pending = job; // 放回去，下一轮再试
          continue;
        }
        setStatus("保存失败：" + msg, "bad");
      }
    }
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function save(siteId) {
  const pick = state.pick[siteId];
  if (!pick) return;
  const base = { ...(state.options || {}) };
  const bySite = { ...(base.inviteBySite || {}), [siteId]: pick };
  await queueSave({ inviteBySite: bySite }, "已保存 —— 下一个新号就按这个走");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot() {
  // 先用 codes.js 画出来 —— 不依赖宿主回应；桥慢 / 挂了页面也不是空的
  render();
  try {
    await Promise.race([magpie.ready, sleep(3000)]);
  } catch {}
  try {
    state.options = (await Promise.race([magpie.options.get(), sleep(5000)])) ?? {};
  } catch (e) {
    setStatus("读不到当前设置：" + (e?.message ?? e), "bad");
  }
  render();
}

boot();
