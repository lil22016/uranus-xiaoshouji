/**
 * Uranus 小手机的后端：整个桌面版后端原样跑在一个 Durable Object 里。
 *
 * ── 怎么做到「原样」的 ──
 *
 *  - 数据：server 里全是同步的 fs 调用，底下换成 DO 的同步 KV（shims/fs.js）。
 *  - HTTP：桌面版是 express，Worker 现在能跑 node:http 服务器 ——
 *    index.js 照常 `app.listen(8787)`，这里用 handleAsNodeRequest 把请求递进去。
 *    控制台用的 140 个接口一个不用改。
 *  - iMessage：Photon SDK 只换传输层（shims/nice-grpc.js，grpc-web），
 *    收消息从「长连接订阅」换成「Photon 推 webhook 到 /hook」（shims/spectrum.js）。
 *  - 定时器：DO 没请求时会被收走，内存里的计时（主动消息、合并窗口）就没了。
 *    所以挂一个每 30 秒一次的 alarm 心跳让它一直醒着；万一还是被收走了，
 *    下一次心跳重新启动，桌面版自己会从磁盘把排着的主动消息捞回来接着数。
 *  - 时区：Worker 永远是 UTC，本地时间按 wrangler.toml 里的 TZ 算（shims/tz.js）。
 *
 * ── 控制台和这里不同源 ──
 *
 * 控制台不用登录：连后端时填一次部署时设的 URANUS_PASSWORD（界面上叫「后端密钥」），
 * 之后每个请求都带 `x-uranus-key`。这里对上了，就替它补一条桌面版认的会话
 * cookie，桌面版那套登录于是一直是「已登录」。
 *
 * 另一条路 `Authorization: Bearer <token>`（桌面版登录拿到的会话）也还认：
 * 登录 / 改密码回的 Set-Cookie 翻成 `x-uranus-token` 头。iOS Safari 拦第三方
 * cookie，所以两条路都不走 cookie。
 *
 * ── 控制台登录 ──
 *
 * 上面两条之外，所有 /api 请求（/api/health 除外）还得带一张控制台登录凭证
 * `x-uranus-pass`（见 gate.js）：Uranus 小手机的控制台要先登录才能用，
 * 自己另编一份不登录的界面连不上这里。
 */
import { DurableObject } from "cloudflare:workers";
import { handleAsNodeRequest } from "cloudflare:node";
import { setBackend, existsSync, readFileSync, writeFileSync, installFetchBodies } from "./shims/fs.js";
import { installTimers } from "./shims/timers.js";
import { installTimeZone } from "./shims/tz.js";
import { deliverWebhook, setWebhookRegistry, waitLive } from "./shims/spectrum.js";
import { BUILTIN_PRESETS, BUILTIN_TRANSFER_LOGOS } from "../core/assets.js";
import { verifyPass } from "./gate.js";

const PORT = 8787;
const HEARTBEAT_MS = 30_000;
const PHOTON = "https://spectrum.photon.codes";
const COOKIE = "uranus_session";
const RESTORE_PATHS = new Set(["/api/cloud/pull"]);

export class Uranus extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    setBackend(ctx.storage.kv);
    installTimers();
    installFetchBodies();
    this.kv = ctx.storage.kv;
    this.booting = null;
  }

  boot() {
    this.booting ??= this.#boot().catch((e) => {
      this.booting = null;
      throw e;
    });
    return this.booting;
  }

  async #boot() {
    Object.assign(process.env, {
      PORT: String(PORT),
      URANUS_IG_PORT: "off",
      URANUS_WORKER: "1",
      // 控制台没有思考模式开关：默认关闭 DeepSeek 思考；false 恢复上游默认。
      URANUS_DEEPSEEK_NON_THINKING: String(this.env.URANUS_DEEPSEEK_NON_THINKING ?? "true"),
      TZ: process.env.TZ || this.env.TZ || "Asia/Shanghai",
    });
    installTimeZone(process.env.TZ);
    seedPresets();
    seedTransferLogos();
    setWebhookRegistry({ ensure: (id, secret) => this.ensureWebhook(id, secret) });
    this.auth = await import("../core/server/src/auth.js");
    await this.seedPassword();
    await import("../core/server/src/index.js");
    await installRestart();
    await this.arm();
  }

  /**
   * 部署时设的 URANUS_PASSWORD 直接当成第一次的密码。
   *
   * 桌面版出厂是 Uranus / Uranus、登进来强制改。那在本机没问题，可 workers.dev
   * 是公网地址 —— 部署完到你第一次登录之间，谁先打开谁就能用出厂密码抢走。
   * 所以这里不给出厂密码的窗口：没设 URANUS_PASSWORD 的话出厂密码也登不进去
   * （见 fetch 里那道闸）。
   *
   * 这条 Secret 也是忘了密码时的出路：桌面版是去改 data/auth.json，这里没有能
   * 手改的文件。所以记下「上次用的是哪条 Secret」（只存哈希），到 Cloudflare
   * 后台把它改成新的，Worker 重新部署、醒来发现不一样，就把账号密码重置成
   * 它。Secret 没变就不动 —— 在控制台里改过的密码照旧有效。
   */
  async seedPassword() {
    const password = String(this.env.URANUS_PASSWORD ?? "");
    if (!password) return;
    const mark = await sha256(password);
    const seen = this.kv.get("passwordSecret");
    if (!this.auth.mustChangeCredentials()) {
      // 这条之前的部署没记过：当它已经用过，免得一升级就把改过的密码冲掉
      if (seen === undefined) this.kv.put("passwordSecret", mark);
      if (seen === undefined || seen === mark) return;
      console.log("URANUS_PASSWORD 换了，账号密码按它重置");
    }
    await this.resetPassword(password);
  }

  /** 桌面版的账号密码强制设成 password（清掉 auth.json 里的密码，再走一遍首次设置） */
  async resetPassword(password) {
    if (!this.auth.mustChangeCredentials()) {
      const { AUTH_PATH, readJson, writeJson } = await import("../core/server/src/datadir.js");
      writeJson(AUTH_PATH, { ...readJson(AUTH_PATH, {}), password: null });
    }
    const out = this.auth.changeCredentials({
      username: String(this.env.URANUS_USER || "Uranus"),
      password,
    });
    if (out.ok) this.kv.put("passwordSecret", await sha256(password));
    else console.warn(`URANUS_PASSWORD 没用上：${out.error}`);
    return out.ok;
  }

  /**
   * 控制台带来的后端密钥对不对；对的话给一条能塞进 cookie 的会话。
   *
   * 会话是拿密钥走一遍桌面版的 login 签出来的（密码哈希要算一阵，所以缓存，
   * 一天换一次，远早于它 30 天过期）。login 不过 —— 有人走 Bearer 那条路改过
   * 密码 —— 就把密码拉回密钥再签：密钥才是这个后端的钥匙。
   *
   * @returns {Promise<{ok: true, token: string} | {ok: false, error: string}>}
   */
  async keySession(key) {
    const secret = String(this.env.URANUS_PASSWORD ?? "");
    const bridgeSecret = String(this.env.URANUS_KEY ?? secret);
    if (!secret) {
      return {
        ok: false,
        error: "这个后端部署时没设 URANUS_PASSWORD。到 Cloudflare 后台给这个 Worker 加上这条 Secret 再来。",
      };
    }
    const [a, b] = await Promise.all([sha256(key), sha256(bridgeSecret)]);
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    if (diff) return { ok: false, error: "后端密钥不对。" };

    const cached = this.keyCache;
    if (cached?.mark === b && Date.now() - cached.at < 86_400_000) return { ok: true, token: cached.token };
    let out = this.auth.login(this.auth.currentUsername(), secret);
    if (!out.ok && (await this.resetPassword(secret))) out = this.auth.login(this.auth.currentUsername(), secret);
    if (!out.ok) {
      return { ok: false, error: "URANUS_PASSWORD 不合规（至少 8 位、带一个大写字母），到 Cloudflare 后台换一个。" };
    }
    this.keyCache = { mark: b, token: out.token, at: Date.now() };
    return { ok: true, token: out.token };
  }

  async arm() {
    const at = await this.ctx.storage.getAlarm();
    if (!at || at < Date.now()) await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
  }

  async alarm() {
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
    await this.boot();
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (this.kv.get("origin") !== url.origin) this.kv.put("origin", url.origin);
    await this.boot();

    if (url.pathname === "/hook") {
      if (req.method !== "POST") return new Response("ok");
      const body = new Uint8Array(await req.arrayBuffer());
      const headers = {};
      for (const [k, v] of req.headers) headers[k.toLowerCase()] = v;
      // 刚醒过来时线路可能还在连：等它一会儿，别把这条推送 503 掉
      let r;
      try {
        await waitLive(15_000);
        r = await deliverWebhook(body, headers);
      } catch (e) {
        r = { status: 500, text: String(e?.message ?? e) };
      }
      void this.hookSeen(body, headers, r).catch(() => {});
      if (r.status >= 400) void this.hookFailed(r).catch(() => {});
      return new Response(r.text, { status: r.status });
    }

    if (req.method === "OPTIONS") return withCors(new Response(null, { status: 204 }), req);

    const bridgeKeyHeader = req.headers.get("x-uranus-key");
    if (url.pathname.startsWith("/api/") && url.pathname !== "/api/health" && !bridgeKeyHeader) {
      if (!(await verifyPass(req.headers.get("x-uranus-pass")))) {
        return withCors(
          Response.json(
            { ok: false, error: "请先在 Uranus 小手机控制台登录（或者登录过期了）。", needPass: true },
            { status: 401 }
          ),
          req
        );
      }
    }

    if (url.pathname === "/api/auth/login" && this.auth.mustChangeCredentials()) {
      return withCors(
        Response.json(
          {
            ok: false,
            error:
              "这个后端部署时没设 URANUS_PASSWORD（或者不合规：至少 8 位、带一个大写字母）。" +
              "到 Cloudflare 后台给这个 Worker 加上这条 Secret 再来。",
          },
          { status: 403 }
        ),
        req
      );
    }

    const headers = new Headers(req.headers);
    const key = headers.get("x-uranus-key");
    const bearer = /^Bearer\s+(.+)$/i.exec(headers.get("authorization") ?? "")?.[1];
    headers.delete("cookie");
    headers.delete("x-uranus-key");
    headers.delete("x-uranus-pass");
    if (key) {
      const session = await this.keySession(key);
      if (!session.ok) {
        return withCors(Response.json({ ok: false, error: session.error, badKey: true }, { status: 401 }), req);
      }
      headers.set("cookie", `${COOKIE}=${encodeURIComponent(session.token)}`);
    } else if (bearer) headers.set("cookie", `${COOKIE}=${encodeURIComponent(bearer)}`);

    // 云备份（从云盘整包拉取）没做：那条路会先把包存一份在云盘上，小手机这边不管云盘
    if (req.method === "POST" && RESTORE_PATHS.has(url.pathname)) {
      return withCors(
        Response.json(
          {
            ok: false,
            error: "小手机不支持从云盘拉取备份。要恢复的话：用「从备份恢复」那里上传 .tar.gz 或 .json。",
          },
          { status: 400 }
        ),
        req
      );
    }

    const res = await handleAsNodeRequest(PORT, new Request(req, { headers }));
    return withCors(exposeToken(res), req);
  }

  /**
   * 每一次 Photon 推送都在控制台留一行：推来了什么、交出去了几条。
   *
   * 这一行是「消息到底有没有到这个 Worker」的唯一证据。以前推送到了 /hook、
   * SDK 回了 200 却一条消息都没解出来时，控制台一个字都没有，跟「根本没推过来」
   * 分不出来。
   */
  async hookSeen(body, headers, r) {
    const { logInfo, logWarn } = await import("../core/server/src/logs.js");
    let event = headers["x-spectrum-event"] || "?";
    let ctype = "?";
    try {
      const j = JSON.parse(new TextDecoder().decode(body));
      event = j?.event ?? event;
      ctype = j?.message?.content?.type ?? (Array.isArray(j?.messages) ? `批量 ${j.messages.length} 条` : "?");
    } catch {
      /* 不是 JSON 就算了 */
    }
    const line = `收到 Photon 推送（event=${event}，内容=${ctype}，${body.length} 字节）→ ${r.status}，交给 Uranus ${r.delivered ?? 0} 条`;
    if (r.status < 400 && !r.delivered) {
      logWarn("桥接", `${line}。SDK 回了成功却没解出任何消息，这条被丢了（推送格式可能变了）`);
    } else {
      logInfo("桥接", line);
    }
  }

  /**
   * Photon 推来了一条消息，但没能交给 Uranus。
   *
   * 以前这几种情况只回 Photon 一个状态码，Uranus 的控制台里一个字都没有 ——
   * 对方发了消息、角色毫无反应、日志一片空白，完全没法查。现在：
   *  - 在控制台说一声是哪种情况；
   *  - 自己修：没有在线的线路（503）就把连接重启一遍；验签过不去（401，存的
   *    签名密钥和 Photon 那边对不上）就删掉存的 webhook、重启，让它重新登记一个。
   *    修复限流，免得一阵推送连着触发。
   */
  async hookFailed(r) {
    const { logWarn, logError } = await import("../core/server/src/logs.js");
    const why =
      r.status === 503
        ? "现在没有在线的 iMessage 线路"
        : r.status === 401
          ? "验签没过（存的 webhook 签名密钥和 Photon 那边对不上）"
          : `处理出错（${r.status}）：${String(r.text).slice(0, 200)}`;
    logWarn("桥接", `收到一条 Photon 推送，但没交给 Uranus：${why}`);

    const now = Date.now();
    const gap = r.status === 401 ? 10 * 60_000 : 2 * 60_000;
    if (now - (this.lastHeal ?? 0) < gap) return;
    this.lastHeal = now;
    try {
      if (r.status === 401) {
        for (const [k] of this.kv.list({ prefix: "hook:" })) this.kv.delete(k);
      }
      const [{ restartBridges }, { loadConfig }] = await Promise.all([
        import("../core/server/src/imessage.js"),
        import("../core/server/src/config.js"),
      ]);
      logWarn("桥接", r.status === 401 ? "重新登记 webhook 并重连线路…" : "重连线路…");
      await restartBridges(loadConfig);
    } catch (e) {
      logError("桥接", "自动修复收消息失败", e);
    }
  }

  /**
   * 让 Photon 把这个项目的消息推到本 Worker 的 /hook，返回验签密钥。
   *
   * 密钥只在创建 webhook 时给一次，所以存在 DO 里。本地没存（或者地址变了，
   * 比如换了自定义域名）就把指向这里的旧 webhook 删了重建。
   */
  async ensureWebhook(projectId, projectSecret) {
    const origin = this.kv.get("origin");
    if (!origin) throw new Error("还不知道这个 Worker 的地址（先在浏览器里打开一次控制台）");
    const hookUrl = `${origin}/hook`;
    const key = `hook:${projectId}`;
    const saved = this.kv.get(key);
    const api = photonApi(projectId, projectSecret);

    const listed = (await api("/webhooks/")) ?? [];
    const hooks = Array.isArray(listed) ? listed : (listed.webhooks ?? []);
    // 在控制台说清楚 Photon 上登记了哪些地址 —— 收不到消息时第一件要核对的事
    try {
      const { logInfo } = await import("../core/server/src/logs.js");
      const urls = hooks.map((h) => `${h.webhookUrl}${h.webhookUrl === hookUrl ? "（就是这里）" : ""}`);
      logInfo("桥接", `Photon 上登记的 webhook：${urls.join("、") || "一个都没有"}；本后端的收消息地址是 ${hookUrl}`);
    } catch {
      /* 日志失败不影响登记 */
    }
    if (saved?.url === hookUrl && saved.signingSecret && hooks.some((h) => h.id === saved.id)) {
      return saved.signingSecret;
    }
    for (const h of hooks.filter((h) => h.webhookUrl === hookUrl)) {
      // 文档写的是 DELETE /webhooks/{id}/（带斜杠），老写法不带；两种都试
      try {
        await api(`/webhooks/${h.id}/`, { method: "DELETE" });
      } catch {
        await api(`/webhooks/${h.id}`, { method: "DELETE" });
      }
    }
    const created = await api("/webhooks/", { method: "POST", body: JSON.stringify({ webhookUrl: hookUrl }) });
    if (!created?.signingSecret) throw new Error("Photon 建 webhook 没回签名密钥");
    this.kv.put(key, { id: created.id, url: hookUrl, signingSecret: created.signingSecret });
    console.log(`webhook 已指向 ${hookUrl}（项目 ${projectId}）`);
    return created.signingSecret;
  }
}

function photonApi(projectId, projectSecret) {
  const auth = `Basic ${btoa(`${projectId}:${projectSecret}`)}`;
  return async (path, init = {}) => {
    const r = await fetch(`${PHOTON}/projects/${projectId}${path}`, {
      ...init,
      headers: { authorization: auth, "content-type": "application/json", ...init.headers },
    });
    const text = await r.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    if (!r.ok || body?.succeed === false) {
      throw new Error(`Photon ${path} → ${r.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
    }
    return body?.data;
  };
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 「重启整个服务」在这里的样子（控制台按钮、`/重启` 指令、定时重启三条路）。
 *
 * 桌面版是让进程退出、由启动器拉起来。这边退不了：重置 DO（ctx.abort）只会
 * 扔掉计时器和连接，模块还缓存在同一个 isolate 里，启动流程不会重跑 —— 日记、
 * IG、主动消息的定时器全停，比不重启还糟。
 *
 * 所以注册成「原地重来」：restart.js 先照旧停掉所有桥接，再调这里清缓存、
 * 按配置把连接重新连上。定时器本来就活着，不用动。
 */
async function installRestart() {
  const [{ setInProcessRestart }, { clearCaches }, { syncBridges }, { loadConfig }] = await Promise.all([
    import("../core/server/src/restart.js"),
    import("../core/server/src/maintenance.js"),
    import("../core/server/src/imessage.js"),
    import("../core/server/src/config.js"),
  ]);
  setInProcessRestart(async () => {
    clearCaches("重启");
    await syncBridges(loadConfig);
  });
}

/** 内置的两份默认预设放进虚拟盘，桌面版第一次建 data/presets 时会从这里拷 */
function seedPresets() {
  for (const [name, json] of Object.entries(BUILTIN_PRESETS)) {
    const p = `/app/assets/presets/${name}`;
    if (!existsSync(p)) writeFileSync(p, JSON.stringify(json, null, 2));
  }
}

/**
 * 自带的转账 logo 放进虚拟盘（桌面版在 assets/transfer-logos/），界面上才列得出来。
 * 内容变了就覆盖：这是随代码发的只读素材，不是用户的东西。真正画图靠的是
 * sync-core 预渲的位图，见 shims/canvas.js。
 */
function seedTransferLogos() {
  for (const [name, svg] of Object.entries(BUILTIN_TRANSFER_LOGOS)) {
    const p = `/app/assets/transfer-logos/${name}`;
    let old = null;
    try {
      old = String(readFileSync(p, "utf-8"));
    } catch {
      // 第一次启动还没有
    }
    if (old !== svg) writeFileSync(p, svg);
  }
}

/** 登录 / 改密码时桌面版回的 Set-Cookie 翻成 x-uranus-token 头 */
function exposeToken(res) {
  const set = res.headers.get("set-cookie");
  if (!set) return res;
  const m = new RegExp(`${COOKIE}=([^;]*)`).exec(set);
  if (!m) return res;
  const out = new Response(res.body, res);
  out.headers.delete("set-cookie");
  out.headers.set("x-uranus-token", decodeURIComponent(m[1]));
  return out;
}

function withCors(res, req) {
  const out = new Response(res.body, res);
  out.headers.set("access-control-allow-origin", req.headers.get("origin") || "*");
  out.headers.set("vary", "origin");
  out.headers.set("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  out.headers.set(
    "access-control-allow-headers",
    req.headers.get("access-control-request-headers") || "authorization, content-type"
  );
  out.headers.set("access-control-expose-headers", "x-uranus-token, content-disposition");
  out.headers.set("access-control-max-age", "86400");
  return out;
}

export default {
  fetch(req, env) {
    return env.URANUS.get(env.URANUS.idFromName("main")).fetch(req);
  },
};
