/**
 * 一次性修正：把「按生成时刻命名」的成品日记改成「按日记写的那一天」命名。
 *
 * 背景：以前定时日记过了零点才生成（00:41），文件名取的是生成那一刻，
 * 于是 14 号的日记叫 2026-10-15.md。新代码已经按日记流水最后一条消息的日期
 * 命名了（memory.js:diaryDayOf），这里只是把已经错位的老文件挪回去。
 *
 * 用的地方：
 *  - 网页「记忆库 → 日记 → 修正日记日期」（POST /api/memories/:key/diary-fix-dates），
 *    小手机（Cloudflare）版只有这一条路，那边没有能打开的文件夹；
 *  - 桌面版也可以跑 scripts/fix-diary-dates.mjs。
 *
 * 自保规则：
 *  1. 先出计划、不改：每一篇「现在叫什么 → 应该叫什么 → 依据」。确认了才改。
 *  2. 日期只从日记**自己顶部的时间栏**读，不猜。下面任何一条对不上就跳过那一篇：
 *       - 顶部读不出日期；
 *       - 顶部写了星期几，但和那个日期对不上；
 *       - 算出来的日期比文件名还晚，或者早了 3 天以上（不像是「零点后才生成」造成的）。
 *     凌晨 05:00 前的时间栏算前一天，和 memory.js:diaryDayOf、Companion 的规则一致。
 *  3. 改之前把这个角色的日记全部复制一份到 data/backups/ 下，附「旧名 → 新名」对照表。
 *  4. 绝不覆盖：先全部挪到临时名，再按日期从早到晚落到新名字上；被占了就 -2、-3。
 *
 * 只用 existsSync / readFileSync / writeFileSync / readdirSync / renameSync /
 * copyFileSync / mkdirSync —— 小手机的 fs 替身（DO 存储）都实现了这几个。
 */
import fs from "node:fs";
import path from "node:path";

const DIARY_FILE = /^(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.md$/;
const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
const DAY = 86400000;
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
// 只拿来做纯日期运算：按 UTC 的年月日算，跟服务器 / Worker 的时区设定无关
const toDate = (s) => new Date(Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10))));

/**
 * 从日记顶部读日期。只看前 3 个非空行，认两种写法：
 *   2026-10-14 星期三 22:30:09
 *   2026年10月16日 星期五（可以没有时间）
 * @returns {{date: string, why: string} | {skip: string}}
 */
export function headerDay(text) {
  const head = String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 3);
  for (const line of head) {
    const m =
      /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?\s*(?:(?:星期|周|礼拜)([日天一二三四五六]))?[^\d\n]{0,6}(?:(\d{1,2}):(\d{2}))?/.exec(line);
    if (!m) continue;
    const s = `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
    const d = toDate(s);
    if (isNaN(d) || iso(d) !== s) return { skip: `顶部日期不是有效日期：「${line.slice(0, 40)}」` };
    if (m[4]) {
      const want = m[4] === "天" ? "日" : m[4];
      if (WEEK[d.getUTCDay()] !== want) return { skip: `顶部写的星期${want}和 ${s}（星期${WEEK[d.getUTCDay()]}）对不上` };
    }
    let day = d;
    let why = `顶部时间栏 ${s}${m[5] !== undefined ? ` ${pad(m[5])}:${m[6]}` : ""}`;
    if (m[5] !== undefined && Number(m[5]) < 5) {
      day = new Date(d.getTime() - DAY);
      why += "（凌晨 5 点前，算前一天）";
    }
    return { date: iso(day), why };
  }
  return { skip: "顶部读不出日期" };
}

/**
 * 一个角色日记文件夹的改名计划。
 * @returns {Array<{name, keep: boolean, newName?: string, note: string}>}
 */
export function planDiaryDates(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .map(String)
    .filter((n) => DIARY_FILE.test(n))
    .sort();
  const rows = files.map((name) => {
    const [, fileDate, seq] = DIARY_FILE.exec(name);
    const base = { name, fileDate, seq: Number(seq || 1) };
    const h = headerDay(fs.readFileSync(path.join(dir, name), "utf-8"));
    if (h.skip) return { ...base, keep: true, note: `跳过：${h.skip}` };
    if (h.date === fileDate) return { ...base, keep: true, note: "日期本来就对" };
    const diff = (toDate(fileDate) - toDate(h.date)) / DAY;
    if (diff < 0 || diff > 3)
      return { ...base, keep: true, note: `跳过：${h.why} 推出 ${h.date}，和文件名差 ${diff} 天，不像是零点后生成造成的` };
    return { ...base, keep: false, target: h.date, note: h.why };
  });
  // 不动的文件先占位；要动的按（新日期、原文件日期、原序号）从早到晚落名字，同一天被占了就 -2、-3
  const taken = new Set(rows.filter((r) => r.keep).map((r) => r.name));
  const moving = rows
    .filter((r) => !r.keep)
    .sort((a, b) => a.target.localeCompare(b.target) || a.fileDate.localeCompare(b.fileDate) || a.seq - b.seq);
  for (const r of moving) {
    let n = 1;
    let nm = `${r.target}.md`;
    while (taken.has(nm)) nm = `${r.target}-${++n}.md`;
    taken.add(nm);
    r.newName = nm;
    if (nm === r.name) r.keep = true;
  }
  return rows.map(({ name, keep, newName, note }) => (keep ? { name, keep, note } : { name, keep, newName, note }));
}

/**
 * 按计划改名。先备份到 backupDir，再两步改名（临时名 → 新名），绝不覆盖。
 * @returns {{moved: number, backup: string | null}}
 */
export function applyDiaryDates(dir, rows, backupDir) {
  const moves = rows.filter((r) => !r.keep && r.newName);
  if (!moves.length) return { moved: 0, backup: null };
  fs.mkdirSync(backupDir, { recursive: true });
  for (const name of fs.readdirSync(dir).map(String)) {
    if (DIARY_FILE.test(name)) fs.copyFileSync(path.join(dir, name), path.join(backupDir, name));
  }
  fs.writeFileSync(
    path.join(backupDir, "_改名对照.txt"),
    moves.map((r) => `${r.name} -> ${r.newName}    (${r.note})`).join("\r\n") + "\r\n",
    "utf-8"
  );
  // 第一步：全部挪到临时名（不符合日记文件名格式，列表里看不到，也不会被别的改名撞上）
  for (const r of moves) fs.renameSync(path.join(dir, r.name), path.join(dir, `.fixing-${r.name}`));
  // 第二步：落到新名字。计划里已经保证新名字不和留下的文件、别的新名字撞；这里再查一遍
  for (const r of moves) {
    const to = path.join(dir, r.newName);
    if (fs.existsSync(to)) throw new Error(`意外：${r.newName} 已存在，停下了。备份在 ${backupDir}`);
    fs.renameSync(path.join(dir, `.fixing-${r.name}`), to);
  }
  return { moved: moves.length, backup: backupDir };
}
