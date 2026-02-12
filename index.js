// index.js (CommonJS) — Node.js >= 18 has global fetch by default
const fs = require("fs");
const path = require("path");
const readline = require("readline/promises");
const { stdin: input, stdout: output } = require("process");
const BASE_URL = "https://xage.app";
const REFERER_APP = "https://xage.app/app";
const REFERER_TRADEX = "https://xage.app/app/games/tradex";
const CONFIG_PATH = path.join(__dirname, "config.json");
// Task delay (12–15 seconds)
const TASK_DELAY_MIN_MS = 12000;
const TASK_DELAY_MAX_MS = 15000;
// Delay antara token 1 dan token 2 dalam satu pair (~5 menit)
const TRADEX_BETWEEN_TOKENS_MIN_MS = 315000;
const TRADEX_BETWEEN_TOKENS_MAX_MS = 330000;
// Delay setelah token 2 (sebelum pair berikutnya) (~1 jam)
const TRADEX_AFTER_PAIR_MIN_MS = 3600000;   // 60 menit
const TRADEX_AFTER_PAIR_MAX_MS = 3660000;   // 61 menit
// TradeX defaults
const TRADEX_DEFAULT_TTL_SECONDS = 300;
const TRADEX_DEFAULT_SHOW_BALANCE_EACH_CYCLE = true;
// Retry on 429
const RATE_LIMIT_MAX_RETRY = 3;
const RATE_LIMIT_FALLBACK_WAIT_MS = 8000;
// How many times to re-prompt cookie if invalid/expired
const AUTH_MAX_RETRY = 3;
const C = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  bold: "\x1b[1m",
};
const paint = (code, s) => `${code}${s}${C.reset}`;
const tag = (label, color) => paint(color, label.padEnd(7));
const logInfo = (s) => console.log(`${tag("[INFO]", C.cyan)} ${s}`);
const logOk = (s) => console.log(`${tag("[OK]", C.green)} ${s}`);
const logWarn = (s) => console.log(`${tag("[WARN]", C.yellow)} ${s}`);
const logErr = (s) => console.log(`${tag("[ERR]", C.red)} ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
// Modified: interruptible sleep untuk delay panjang di TradeX
async function sleepRandom(minMs, maxMs, label = "Delay", state = null) {
  const ms = randInt(minMs, maxMs);
  logInfo(`${label}: ${ms / 1000}s${state ? " (interruptible)" : ""}`);
  
  if (state && state.stopRequested) return;
  
  const chunk = 5000; // cek tiap 5 detik
  let remaining = ms;
  while (remaining > 0) {
    if (state && state.stopRequested) {
      logWarn(`${label} interrupted by Ctrl+C!`);
      return;
    }
    const sleepTime = Math.min(chunk, remaining);
    await sleep(sleepTime);
    remaining -= sleepTime;
  }
}
function readConfigIfExists() {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function atomicWriteJson(filePath, obj) {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
}
function normalizeConfig(cfg) {
  const out = cfg && typeof cfg === "object" ? cfg : {};
  if (!Array.isArray(out.accounts)) out.accounts = [];
  if (typeof out.cookie === "string" && out.cookie.trim() && out.accounts.length === 0) {
    out.accounts.push({ label: "acc1", cookie: out.cookie.trim() });
    delete out.cookie;
  }
  out.accounts = out.accounts
    .filter((a) => a && typeof a === "object")
    .map((a, idx) => ({
      label: (typeof a.label === "string" && a.label.trim()) ? a.label.trim() : `acc${idx + 1}`,
      cookie: (typeof a.cookie === "string") ? a.cookie.trim() : "",
    }));
  return out;
}
function saveConfig(cfg) {
  atomicWriteJson(CONFIG_PATH, cfg);
}
function setAccountCookie(cfg, index, newCookie) {
  cfg.accounts[index].cookie = (newCookie || "").trim();
  saveConfig(cfg);
}
async function promptLine(question) {
  const rl = readline.createInterface({ input, output });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}
async function promptYesNo(question, defaultYes = false) {
  const suffix = defaultYes ? " [Y/n]: " : " [y/N]: ";
  const ans = (await promptLine(question + suffix)).toLowerCase();
  if (!ans) return defaultYes;
  return ans === "y" || ans === "yes";
}
async function promptCookie(reason) {
  if (reason) logWarn(reason);
  return await promptLine("Enter cookie (paste the full value): ");
}
async function promptLabel(defaultLabel) {
  const s = await promptLine(`Account label (default: ${defaultLabel}): `);
  return s ? s : defaultLabel;
}
async function promptMenu() {
  console.log("");
  console.log(paint(C.bold, "Select mode:"));
  console.log("1) Auto task completion");
  console.log("2) TradeX game (Token creations)");
  const ans = await promptLine("Enter choice (1/2): ");
  if (ans === "1") return "TASKS";
  if (ans === "2") return "TRADEX";
  return null;
}
function makeHeaders(cookie, { extra = {}, referer = REFERER_APP } = {}) {
  return {
    accept: "*/*",
    "accept-language": "en-US,en;q=0.5",
    cookie,
    Referer: referer,
    ...extra,
  };
}
function parseRetryAfterMs(retryAfterValue) {
  if (!retryAfterValue) return null;
  const secs = Number(retryAfterValue);
  if (!Number.isNaN(secs)) return Math.max(1000, Math.floor(secs * 1000));
  const t = Date.parse(retryAfterValue);
  if (!Number.isNaN(t)) return Math.max(1000, t - Date.now());
  return null;
}
function looksLikeAuthProblem(resStatus, json, text) {
  if (resStatus === 401 || resStatus === 403) return true;
  const msg = (
    (json && (json.message || json.error)) ||
    (typeof text === "string" ? text : "")
  ).toString();
  return /unauth|unauthoriz|forbidden|expired|cookie|login|session/i.test(msg);
}
async function requestJson(url, { method = "GET", headers = {}, body = null } = {}) {
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  if (res.status === 429) {
    const ra = res.headers.get("retry-after");
    const waitMs = parseRetryAfterMs(ra) ?? RATE_LIMIT_FALLBACK_WAIT_MS;
    const err = new Error("HTTP 429: RATE_LIMIT");
    err.code = "RATE_LIMIT";
    err.waitMs = waitMs;
    err.retryAfterRaw = ra;
    throw err;
  }
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    if (looksLikeAuthProblem(res.status, null, text)) {
      const err = new Error(`AUTH: Cookie invalid/expired (HTTP ${res.status})`);
      err.code = "AUTH";
      err.status = res.status;
      throw err;
    }
    throw new Error(`Response is not JSON. HTTP ${res.status}. Snippet: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const msg = (json && (json.message || json.error))
      ? (json.message || json.error)
      : text.slice(0, 200);
    const err = new Error(`HTTP ${res.status}: ${msg}`);
    if (looksLikeAuthProblem(res.status, json, text)) {
      err.code = "AUTH";
      err.status = res.status;
    }
    throw err;
  }
  return json;
}
// ----- Xage APIs -----
async function getMe(cookie) {
  return requestJson(`${BASE_URL}/api/auth/me`, {
    method: "GET",
    headers: makeHeaders(cookie),
  });
}
async function getTasks(cookie) {
  return requestJson(`${BASE_URL}/api/tasks`, {
    method: "GET",
    headers: makeHeaders(cookie),
  });
}
async function completeTask(cookie, taskId) {
  return requestJson(`${BASE_URL}/api/tasks/${encodeURIComponent(taskId)}/complete`, {
    method: "POST",
    headers: makeHeaders(cookie, { extra: { "content-type": "application/json" } }),
    body: null,
  });
}
async function createTradeXToken(cookie, payload) {
  return requestJson(`${BASE_URL}/api/simulex/tokens`, {
    method: "POST",
    headers: makeHeaders(cookie, {
      referer: REFERER_TRADEX,
      extra: { "content-type": "application/json" },
    }),
    body: JSON.stringify(payload),
  });
}
async function getTradeXBalance(cookie) {
  return requestJson(`${BASE_URL}/api/simulex/balance`, {
    method: "GET",
    headers: makeHeaders(cookie, { referer: REFERER_TRADEX }),
  });
}
// ----- Helpers -----
function printAccount(user, prefix = "ACCOUNT") {
  const xHandle = user?.xHandle ?? "-";
  const accountAge = user?.accountAge ?? "-";
  const points = user?.points ?? "-";
  console.log(
    `${paint(C.bold, prefix)} | xHandle=${paint(C.cyan, xHandle)} | accountAge=${paint(C.gray, String(accountAge))} | points=${paint(C.green, String(points))}`
  );
}
async function ensureAccountsExist(cfg) {
  if (cfg.accounts.length > 0) return;
  logWarn("No accounts found in config.json. Let's add at least one account.");
  while (true) {
    const defaultLabel = `acc${cfg.accounts.length + 1}`;
    const label = await promptLabel(defaultLabel);
    const cookie = (await promptCookie(`Creating account "${label}".`)).trim();
    if (!cookie) {
      logWarn("Cookie cannot be empty.");
      continue;
    }
    cfg.accounts.push({ label, cookie });
    saveConfig(cfg);
    const addMore = await promptYesNo("Add another account?", false);
    if (!addMore) break;
  }
}
async function maybeAppendMoreAccounts(cfg) {
  const addMore = await promptYesNo("Do you want to add another account now?", false);
  if (!addMore) return;
  while (true) {
    const defaultLabel = `acc${cfg.accounts.length + 1}`;
    const label = await promptLabel(defaultLabel);
    const cookie = (await promptCookie(`Adding account "${label}".`)).trim();
    if (!cookie) {
      logWarn("Cookie cannot be empty.");
      continue;
    }
    cfg.accounts.push({ label, cookie });
    saveConfig(cfg);
    const again = await promptYesNo("Add one more account?", false);
    if (!again) break;
  }
}
async function ensureValidCookieForAccount(cfg, index) {
  let cookie = cfg.accounts[index].cookie || "";
  const label = cfg.accounts[index].label || `acc${index + 1}`;
  for (let i = 1; i <= AUTH_MAX_RETRY; i++) {
    if (!cookie.trim()) {
      cookie = (await promptCookie(`Cookie is missing for "${label}". Please enter it.`)).trim();
    }
    if (!cookie) {
      logWarn("Cookie cannot be empty.");
      continue;
    }
    try {
      const me = await getMe(cookie);
      if (!me?.success || !me?.user) throw new Error("Invalid /auth/me response.");
      setAccountCookie(cfg, index, cookie);
      return { cookie, me };
    } catch (e) {
      if (e && e.code === "AUTH") {
        cookie = "";
        logWarn(`"${label}" cookie invalid/expired. Please re-enter it. (attempt ${i}/${AUTH_MAX_RETRY})`);
        continue;
      }
      throw e;
    }
  }
  throw new Error(`Failed to validate cookie for "${label}" after multiple attempts.`);
}
async function refreshCookieForAccount(cfg, index, reason) {
  const label = cfg.accounts[index].label || `acc${index + 1}`;
  let cookie = "";
  for (let i = 1; i <= AUTH_MAX_RETRY; i++) {
    cookie = (await promptCookie(reason || `"${label}" cookie expired/invalid. Please enter a new cookie.`)).trim();
    if (!cookie) {
      logWarn("Cookie cannot be empty.");
      continue;
    }
    try {
      const me = await getMe(cookie);
      if (!me?.success || !me?.user) throw new Error("Invalid /auth/me response.");
      setAccountCookie(cfg, index, cookie);
      logOk(`Saved new cookie for "${label}" to config.json.`);
      return { cookie, me };
    } catch (e) {
      if (e && e.code === "AUTH") {
        logWarn(`"${label}" cookie still invalid/expired. (attempt ${i}/${AUTH_MAX_RETRY})`);
        continue;
      }
      throw e;
    }
  }
  throw new Error(`Failed to refresh cookie for "${label}" after multiple attempts.`);
}
// ----- Mode 1: Auto tasks -----
async function runTasksForAccount(cfg, index) {
  const label = cfg.accounts[index].label || `acc${index + 1}`;
  logInfo(`========== MODE: TASKS | ACCOUNT: ${label} ==========`);

  let { cookie, me: me0 } = await ensureValidCookieForAccount(cfg, index);
  printAccount(me0.user, `START (${label})`);

  let t0;
  while (true) {
    try {
      t0 = await getTasks(cookie);
      break;
    } catch (e) {
      if (e && e.code === "AUTH") {
        const refreshed = await refreshCookieForAccount(cfg, index, `"${label}" cookie expired while fetching tasks.`);
        cookie = refreshed.cookie;
        continue;
      }
      throw e;
    }
  }

  if (!t0?.success || !Array.isArray(t0?.tasks)) throw new Error(`"${label}": failed to fetch /tasks.`);

  const pending = t0.tasks.filter((t) => t && t.completed === false);
  logInfo(`"${label}" pending tasks: ${pending.length}`);

  if (pending.length === 0) {
    logOk(`"${label}": no tasks to complete.`);
    return;
  }

  for (let i = 0; i < pending.length; i++) {
    const t = pending[i];
    logInfo(`"${label}" (${i + 1}/${pending.length}) Processing: ${t.name} | type=${t.type} | reward=${t.points} | id=${t.id}`);

    await sleepRandom(TASK_DELAY_MIN_MS, TASK_DELAY_MAX_MS, `"${label}" task delay`);

    let attempt = 0;
    while (attempt < RATE_LIMIT_MAX_RETRY) {
      attempt++;
      try {
        const done = await completeTask(cookie, t.id);
        if (done?.success) logOk(`"${label}" done. pointsAwarded=${done.pointsAwarded}, newTotal=${done.newTotal}`);
        else logWarn(`"${label}" success=false for task id=${t.id}`);
        break;
      } catch (e) {
        if (e && e.code === "AUTH") {
          const refreshed = await refreshCookieForAccount(cfg, index, `"${label}" cookie expired while completing a task.`);
          cookie = refreshed.cookie;
          attempt--;
          continue;
        }

        if (e && e.code === "RATE_LIMIT") {
          const waitMs = e.waitMs ?? RATE_LIMIT_FALLBACK_WAIT_MS;
          const raRaw = e.retryAfterRaw ? ` (Retry-After=${e.retryAfterRaw})` : "";
          logWarn(`"${label}" HTTP 429. Waiting ${waitMs}ms${raRaw}, then retry (${attempt}/${RATE_LIMIT_MAX_RETRY})`);
          await sleep(waitMs);
          await sleepRandom(500, 1500, `"${label}" jitter`);
          continue;
        }

        logWarn(`"${label}" failed to complete task id=${t.id}: ${e.message}`);
        break;
      }
    }

    while (true) {
      try {
        const meAfter = await getMe(cookie);
        if (meAfter?.success && meAfter?.user) printAccount(meAfter.user, `AFTER (${label})`);
        else logWarn(`"${label}" failed to refresh /auth/me after task.`);
        break;
      } catch (e) {
        if (e && e.code === "AUTH") {
          const refreshed = await refreshCookieForAccount(cfg, index, `"${label}" cookie expired while refreshing /auth/me.`);
          cookie = refreshed.cookie;
          continue;
        }
        logWarn(`"${label}" error refreshing /auth/me: ${e.message}`);
        break;
      }
    }
  }

  logOk(`"${label}" finished processing incomplete tasks.`);
}
// ----- Mode 2: TradeX  -----
function randomLetters(len, upper = false) {
  const A = upper ? "ABCDEFGHIJKLMNOPQRSTUVWXYZ" : "abcdefghijklmnopqrstuvwxyz";
  let s = "";
  for (let i = 0; i < len; i++) s += A[randInt(0, A.length - 1)];
  return s;
}
function randomTradeXName() {
  return randomLetters(randInt(2, 5), false);
}
function randomTicker() {
  return randomLetters(randInt(3, 4), true);
}
function randomDescription(name, ticker) {
  const templates = [
    `${name} (${ticker}) is live on TradeX.`,
    `Auto token ${ticker}.`,
    `Launch: ${name} / ${ticker}.`,
    `TradeX drop: ${ticker}.`,
    `New sim token: ${name}.`,
  ];
  return templates[randInt(0, templates.length - 1)];
}
async function createOneTokenForAccount(cfg, index, state) {
  const label = cfg.accounts[index].label || `acc${index + 1}`;

  // Ensure cookie is valid (and saved)
  let cookie = cfg.accounts[index].cookie || "";
  let me;
  try {
    const r = await ensureValidCookieForAccount(cfg, index);
    cookie = r.cookie;
    me = r.me;
  } catch (e) {
    logErr(`"${label}" cannot validate cookie: ${e.message}`);
    return;
  }

  if (me?.user) {
    printAccount(me.user, `TRADEX (${label})`);
  }

  const name = randomTradeXName();
  const ticker = randomTicker();
  const description = randomDescription(name, ticker);

  const payload = {
    name,
    ticker,
    description,
    ttlSeconds: TRADEX_DEFAULT_TTL_SECONDS,
    image: null,
  };

  let attempt = 0;
  while (attempt < RATE_LIMIT_MAX_RETRY) {
    attempt++;
    try {
      const res = await createTradeXToken(cookie, payload);
      if (res?.success && res?.token) {
        logOk(`"${label}" token created: id=${res.token.id} name=${res.token.name} ticker=${res.token.ticker} ttlSeconds=${res.token.ttlSeconds}`);
      } else {
        logWarn(`"${label}" token create returned success=false`);
      }
      return;
    } catch (e) {
      if (state.stopRequested) return;

      if (e && e.code === "AUTH") {
        const refreshed = await refreshCookieForAccount(cfg, index, `"${label}" cookie expired while creating a token.`);
        cookie = refreshed.cookie;
        attempt--;
        continue;
      }

      if (e && e.code === "RATE_LIMIT") {
        const waitMs = e.waitMs ?? RATE_LIMIT_FALLBACK_WAIT_MS;
        const raRaw = e.retryAfterRaw ? ` (Retry-After=${e.retryAfterRaw})` : "";
        logWarn(`"${label}" HTTP 429. Waiting ${waitMs}ms${raRaw}, then retry (${attempt}/${RATE_LIMIT_MAX_RETRY})`);
        await sleep(waitMs);
        await sleepRandom(500, 1500, `"${label}" jitter`);
        continue;
      }

      logWarn(`"${label}" token create failed: ${e.message}`);
      return;
    }
  }
}

async function showBalancesForAll(cfg, state) {
  if (!TRADEX_DEFAULT_SHOW_BALANCE_EACH_CYCLE) return;

  for (let i = 0; i < cfg.accounts.length; i++) {
    if (state.stopRequested) return;

    const label = cfg.accounts[i].label || `acc${i + 1}`;
    let cookie = cfg.accounts[i].cookie || "";

    try {
      const r = await ensureValidCookieForAccount(cfg, i);
      cookie = r.cookie;
    } catch (e) {
      logWarn(`"${label}" skip balance (cookie invalid): ${e.message}`);
      continue;
    }

    try {
      const b = await getTradeXBalance(cookie);
      if (b?.success) logInfo(`"${label}" TradeX balance: ${b.balance}`);
      else logWarn(`"${label}" balance returned success=false`);
    } catch (e) {
      if (e && e.code === "AUTH") {
        await refreshCookieForAccount(cfg, i, `"${label}" cookie expired while fetching TradeX balance.`);
      } else {
        logWarn(`"${label}" failed to fetch TradeX balance: ${e.message}`);
      }
    }
  }
}
// Modified TradeX loop
async function runTradeXAllAccountsForever(cfg) {
  const state = { stopRequested: false };
  
  // SIGINT handler: Ctrl+C sekali → interrupt & exit clean, dua kali → force quit
  let forceQuit = false;
  process.on("SIGINT", () => {
    if (forceQuit) {
      logErr("Force quit requested!");
      process.exit(0);
    }
    if (state.stopRequested) {
      forceQuit = true;
      logWarn("Second Ctrl+C detected → force quit!");
      return;
    }
    state.stopRequested = true;
    console.log("");
    logWarn("Stop requested (Ctrl+C). Interrupting current delay and exiting soon...");
  });
  
  logInfo("TradeX mode: 2 token creations per account per ~1 hour. Running forever until Ctrl+C.");
  let cycle = 0;
  let pairNumber = 0;
  while (!state.stopRequested) {
    cycle++;
    const attemptInPair = (cycle % 2 === 1) ? 1 : 2;
    if (attemptInPair === 1) {
      pairNumber++;
      logInfo(`========== NEW PAIR #${pairNumber} : Starting 2 token creations ==========`);
    }
    logInfo(`========== TOKEN CREATION #${cycle} (attempt ${attemptInPair}/2 in pair ${pairNumber}) ==========`);
    
    // Create token untuk semua akun
    for (let i = 0; i < cfg.accounts.length; i++) {
      if (state.stopRequested) break;
      await createOneTokenForAccount(cfg, i, state);
    }
    
    // Show balance
    if (!state.stopRequested) {
      await showBalancesForAll(cfg, state);
    }
    
    // Delay sesuai posisi (interruptible karena pass state)
    if (!state.stopRequested) {
      if (attemptInPair === 1) {
        // Setelah token pertama → delay ~5 menit
        await sleepRandom(
          TRADEX_BETWEEN_TOKENS_MIN_MS,
          TRADEX_BETWEEN_TOKENS_MAX_MS,
          "Delay before second token",
          state
        );
      } else {
        // Setelah token kedua → delay ~1 jam
        await sleepRandom(
          TRADEX_AFTER_PAIR_MIN_MS,
          TRADEX_AFTER_PAIR_MAX_MS,
          "Delay ~1 hour before next pair",
          state
        );
      }
    }
  }
  logOk("TradeX stopped gracefully.");
}
(async function main() {
  try {
    const cfg = normalizeConfig(readConfigIfExists());
    saveConfig(cfg);
    await ensureAccountsExist(cfg);
    await maybeAppendMoreAccounts(cfg);
    let mode = await promptMenu();
    while (!mode) {
      logWarn("Invalid choice. Please enter 1 or 2.");
      mode = await promptMenu();
    }
    if (mode === "TASKS") {
      for (let i = 0; i < cfg.accounts.length; i++) {
        try {
          await runTasksForAccount(cfg, i);
        } catch (e) {
          logErr(`Account "${cfg.accounts[i]?.label || `acc${i + 1}`}" failed: ${e.message}`);
        }
      }
      logOk("All accounts processed (TASKS).");
      return;
    }
    if (mode === "TRADEX") {
      await runTradeXAllAccountsForever(cfg);
      return;
    }
  } catch (e) {
    logErr(e.message);
    process.exitCode = 1;
  }
})();
