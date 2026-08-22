const { ANTIGRAVITY_CLOUDCODE_URL, ANTIGRAVITY_CLOUDCODE_DAILY_URL, REFRESH_TIMEOUT } = require("./config");
const { ts } = require("./crypto-utils");
const { extractErrorCode, stripXssiPrefix } = require("./http-client");
const { getAntigravityRuntime } = require("./antigravity-runtime");
const { saveAntigravityAcct, upsertAntigravityIndex } = require("./antigravity-storage");
const { refreshAntigravityToken, markAntigravityReauth, antigravityAccessExpired } = require("./antigravity-token");
const { clearQuotaRetry, scheduleQuotaRetry, throwIfQuotaRetryPending } = require("./quota-retry");
const { logInfo, logWarn } = require("./logger");

const CLOUD_CODE_IDE_VERSION = "1.20.5";
const CLOUD_CODE_USER_AGENT = "antigravity/1.20.5 windows/amd64";
const LOAD_CODE_ASSIST_USER_AGENT = "antigravity/1.20.5 windows/amd64 google-api-nodejs-client/10.3.0";
const ONBOARD_POLL_LIMIT = 8;
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const FIVE_HOUR_RESET_SLACK_MS = 20 * 60 * 1000;

function clampPercent(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function pickNumber(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function remainingFromUsed(used, limit) {
  const usedNumber = pickNumber(used);
  const limitNumber = pickNumber(limit);
  if (usedNumber == null) return null;
  if (limitNumber != null && limitNumber > 0) {
    return clampPercent(((limitNumber - usedNumber) / limitNumber) * 100);
  }
  if (usedNumber >= 0 && usedNumber <= 1) return clampPercent((1 - usedNumber) * 100);
  if (usedNumber >= 0 && usedNumber <= 100) return clampPercent(100 - usedNumber);
  return null;
}

function remainingFromFraction(remaining, limit) {
  const remainingNumber = pickNumber(remaining);
  const limitNumber = pickNumber(limit);
  if (remainingNumber == null) return null;
  if (limitNumber != null && limitNumber > 0) return clampPercent((remainingNumber / limitNumber) * 100);
  if (remainingNumber >= 0 && remainingNumber <= 1) return clampPercent(remainingNumber * 100);
  if (remainingNumber >= 0 && remainingNumber <= 100) return clampPercent(remainingNumber);
  return remainingNumber;
}

function walkObjects(root, visit) {
  const stack = [root];
  const seen = new Set();
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    visit(current);
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    for (const value of Object.values(current)) stack.push(value);
  }
}

function creditsFromList(list) {
  if (!Array.isArray(list)) return null;
  let total = 0;
  let found = false;
  for (const item of list) {
    const amount = pickNumber(item?.creditAmount, item?.credit_amount, item?.amount, item?.creditsRemaining);
    if (amount == null) continue;
    total += amount;
    found = true;
  }
  return found ? total : null;
}

function asTierObject(value) {
  return value && typeof value === "object" ? value : null;
}

function pickPaidTier(root) {
  return asTierObject(root.paidTier)
    || asTierObject(root.currentPaidTier)
    || asTierObject(root.current_paid_tier)
    || null;
}

function pickCurrentTier(root) {
  return asTierObject(root.currentTier) || asTierObject(root.current_tier) || null;
}

function pickDefaultAllowedTier(root) {
  const allowed = Array.isArray(root.allowedTiers) ? root.allowedTiers : [];
  const objects = allowed.filter((item) => item && typeof item === "object");
  return objects.find((item) => item.isDefault)
    || objects.find((item) => /free/i.test(String(item.id || item.name || "")))
    || null;
}

function pickSubscriptionTier(root) {
  return pickPaidTier(root) || pickCurrentTier(root) || pickDefaultAllowedTier(root) || {};
}

function isRecognizedAntigravityTier(tier) {
  const value = String(tier || "").toLowerCase();
  if (!value) return false;
  return /free|standard|pro|ultra|plus|team|enterprise|g1-/.test(value);
}

function projectId(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object") {
    const id = String(value.id || value.name || "").trim();
    return id || null;
  }
  return null;
}

function parseLoadCodeAssist(payload) {
  const root = payload && typeof payload === "object" ? payload : {};
  const paidTier = pickPaidTier(root) || {};
  const currentTier = pickCurrentTier(root) || {};
  const subscriptionTier = pickSubscriptionTier(root);
  const planInfo = root.planInfo || root.plan_info || {};
  const creditsRemaining = pickNumber(
    root.creditsRemaining,
    root.credits_remaining,
    root.remainingCredits,
    root.availablePromptCredits,
    root.available_prompt_credits,
    paidTier.creditsRemaining,
    paidTier.remainingCredits,
    currentTier.creditsRemaining,
    currentTier.remainingCredits,
    planInfo.creditsRemaining,
    planInfo.remainingCredits,
    creditsFromList(root.availableCredits),
    creditsFromList(paidTier.availableCredits),
    creditsFromList(currentTier.availableCredits),
  );
  const creditsLimit = pickNumber(
    root.creditsLimit,
    root.credits_limit,
    root.totalCredits,
    paidTier.creditsLimit,
    paidTier.totalCredits,
    currentTier.creditsLimit,
    currentTier.totalCredits,
    planInfo.creditsLimit,
    planInfo.totalCredits,
    creditsFromList(root.totalCreditsList),
  );
  return {
    tier: String(
      subscriptionTier.id
      || subscriptionTier.tierId
      || paidTier.id
      || paidTier.name
      || currentTier.id
      || currentTier.tierId
      || currentTier.name
      || currentTier.tierName
      || planInfo.planType
      || planInfo.tier
      || root.tier
      || "",
    ).trim() || null,
    credits_remaining: creditsRemaining,
    credits_limit: creditsLimit,
    credits_remaining_percentage: remainingFromFraction(creditsRemaining, creditsLimit),
    project: projectId(root.cloudaicompanionProject || root.cloudAiCompanionProject || root.project),
    allowedTiers: Array.isArray(root.allowedTiers) ? root.allowedTiers : [],
  };
}

function pickOnboardTierId(assist) {
  const allowed = Array.isArray(assist?.allowedTiers) ? assist.allowedTiers : [];
  const preferred = allowed.find((item) => item && item.isDefault && item.id)
    || allowed.find((item) => item && item.id)
    || null;
  return String(preferred?.id || assist?.tier || "LEGACY").trim() || "LEGACY";
}

function modelLabel(model) {
  return String(model.displayName || model.display_name || model.name || model.id || "").trim();
}

function modelRemaining(model) {
  const quota = model.quotaInfo || model.quota_info || model.quota || {};
  return remainingFromFraction(
    pickNumber(
      quota.remainingFraction,
      quota.remaining_fraction,
      quota.remainingPercent,
      quota.remaining_percent,
      quota.remaining,
      model.remainingFraction,
      model.remaining,
    ),
    pickNumber(quota.limit, quota.total, model.limit),
  ) ?? remainingFromUsed(
    pickNumber(quota.used, quota.usedFraction, quota.used_fraction, model.used),
    pickNumber(quota.limit, quota.total, model.limit),
  );
}

function modelResetTime(model) {
  const quota = model.quotaInfo || model.quota_info || model.quota || {};
  return quota.resetTime || quota.reset_time || model.resetTime || model.reset_time || null;
}

function isUsableModelLabel(label) {
  if (!label) return false;
  if (/^chat_\d+$/i.test(label)) return false;
  return true;
}

function pushParsedModel(models, model, fallbackId) {
  if (!model || typeof model !== "object") return;
  const label = modelLabel(model) || String(fallbackId || "").trim();
  if (!isUsableModelLabel(label)) return;
  models.push({
    name: label,
    remaining_percentage: modelRemaining(model),
    reset_time: modelResetTime(model),
  });
}

function parseAvailableModels(payload) {
  const root = payload && typeof payload === "object" ? payload : {};
  const models = [];
  if (root.models && !Array.isArray(root.models) && typeof root.models === "object") {
    for (const [id, model] of Object.entries(root.models)) {
      pushParsedModel(models, { ...model, name: model?.name || id }, id);
    }
  }
  walkObjects(root, (item) => {
    if (Array.isArray(item.models)) {
      for (const model of item.models) pushParsedModel(models, model);
    }
    if (Array.isArray(item.buckets)) {
      for (const bucket of item.buckets) {
        pushParsedModel(models, {
          name: bucket.bucketId || bucket.modelId || bucket.tokenType,
          displayName: bucket.displayName || bucket.modelId || bucket.tokenType,
          quotaInfo: {
            remainingFraction: bucket.remainingFraction,
            remaining: bucket.remainingAmount,
            resetTime: bucket.resetTime,
          },
        }, bucket.bucketId);
      }
    }
  });
  const unique = [];
  const seen = new Set();
  for (const model of models) {
    const key = model.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(model);
  }
  return unique;
}

function emptyFamilyWindows() {
  return {
    gemini_five_hour_remaining: null,
    gemini_five_hour_reset_time: null,
    gemini_weekly_remaining: null,
    gemini_weekly_reset_time: null,
    third_party_five_hour_remaining: null,
    third_party_five_hour_reset_time: null,
    third_party_weekly_remaining: null,
    third_party_weekly_reset_time: null,
  };
}

function setFamilyWindow(windows, key, remaining, resetTime) {
  if (windows[key] == null && remaining != null) windows[key] = remaining;
  const resetKey = key.replace(/_remaining$/, "_reset_time");
  if (windows[resetKey] == null && resetTime) windows[resetKey] = resetTime;
}

function classifyFamilyWindow(name) {
  const text = String(name || "").trim().toLowerCase();
  if (!text) return null;
  if (text === "gemini-5h" || text === "gemini:5h") return "gemini_five_hour_remaining";
  if (text === "gemini-weekly" || text === "gemini:weekly") return "gemini_weekly_remaining";
  if (text === "3p-5h" || text === "claude:5h" || text === "3p:5h") return "third_party_five_hour_remaining";
  if (text === "3p-weekly" || text === "claude:weekly" || text === "3p:weekly") return "third_party_weekly_remaining";

  const gemini = text.includes("gemini");
  const third = text.includes("3p") || text.includes("claude") || text.includes("gpt") || text.includes("third");
  if (!gemini && !third) return null;
  const weekly = text.includes("weekly") || /\bweek\b/.test(text) || /\b7d\b/.test(text);
  const fiveHour = text.includes("5h")
    || text.includes("five-hour")
    || text.includes("5-hour")
    || text.includes("5 hour");
  if (gemini && fiveHour) return "gemini_five_hour_remaining";
  if (gemini && weekly) return "gemini_weekly_remaining";
  if (third && fiveHour) return "third_party_five_hour_remaining";
  if (third && weekly) return "third_party_weekly_remaining";
  return null;
}

function applyFamilyModel(windows, model) {
  const key = classifyFamilyWindow(model?.name)
    || classifyFamilyWindow(model?.displayName)
    || classifyFamilyWindow(`${model?.name || ""} ${model?.displayName || ""}`);
  if (!key || model?.remaining_percentage == null) return;
  setFamilyWindow(windows, key, model.remaining_percentage, model.reset_time);
}

function familyWindowsFromModels(models) {
  const windows = emptyFamilyWindows();
  for (const model of models || []) applyFamilyModel(windows, model);
  return windows;
}

function summaryGroups(payload) {
  const root = payload && typeof payload === "object" ? payload : {};
  if (Array.isArray(root.groups)) return root.groups;
  if (Array.isArray(root.quotaSummary?.groups)) return root.quotaSummary.groups;
  if (Array.isArray(root.response?.groups)) return root.response.groups;
  return [];
}

function remainingFromBucket(bucket) {
  const nested = bucket?.remaining && typeof bucket.remaining === "object" ? bucket.remaining : {};
  return remainingFromFraction(
    pickNumber(
      bucket?.remainingFraction,
      bucket?.remaining_fraction,
      bucket?.remainingPercent,
      nested.remainingFraction,
      nested.remaining_fraction,
      nested.remainingPercent,
      typeof bucket?.remaining === "number" ? bucket.remaining : null,
    ),
    pickNumber(bucket?.limit, bucket?.total, nested.limit, nested.total),
  ) ?? remainingFromUsed(
    pickNumber(bucket?.usedFraction, bucket?.used, bucket?.used_fraction, nested.usedFraction, nested.used),
    pickNumber(bucket?.limit, bucket?.total, nested.limit, nested.total, 1),
  );
}

function familyWindowsFromSummary(payload) {
  const windows = emptyFamilyWindows();
  for (const group of summaryGroups(payload)) {
    const groupName = group?.displayName || group?.name || "";
    const buckets = Array.isArray(group?.buckets) ? group.buckets : [];
    for (const bucket of buckets) {
      if (!bucket || bucket.disabled === true) continue;
      applyFamilyModel(windows, {
        name: `${groupName} ${bucket.bucketId || bucket.id || bucket.modelId || bucket.tokenType || ""}`.trim(),
        displayName: bucket.displayName,
        remaining_percentage: remainingFromBucket(bucket),
        reset_time: bucket.resetTime || bucket.reset_time || nestedResetTime(bucket),
      });
    }
  }
  return windows;
}

function nestedResetTime(bucket) {
  const nested = bucket?.remaining && typeof bucket.remaining === "object" ? bucket.remaining : {};
  return nested.resetTime || nested.reset_time || null;
}

function familyWindowsFromQuotaBuckets(payload) {
  const windows = emptyFamilyWindows();
  const root = payload && typeof payload === "object" ? payload : {};
  const buckets = Array.isArray(root.buckets) ? root.buckets : [];
  for (const bucket of buckets) {
    if (!bucket || bucket.disabled === true) continue;
    applyFamilyModel(windows, {
      name: bucket.bucketId || bucket.id || bucket.modelId || bucket.tokenType,
      displayName: bucket.displayName,
      remaining_percentage: remainingFromBucket(bucket),
      reset_time: bucket.resetTime || bucket.reset_time || nestedResetTime(bucket),
    });
  }
  return windows;
}

function mergeFamilyWindows(...sources) {
  const windows = emptyFamilyWindows();
  for (const source of sources) {
    if (!source) continue;
    for (const key of Object.keys(windows)) {
      if (windows[key] == null && source[key] != null && source[key] !== "") {
        windows[key] = source[key];
      }
    }
  }
  return windows;
}

function dropImplausibleFiveHourWindow(windows, remainingKey, resetKey, now) {
  const reset = windows[resetKey];
  if (!reset) return;
  const resetTs = Date.parse(reset);
  if (!Number.isFinite(resetTs)) return;
  if (resetTs - now > FIVE_HOURS_MS + FIVE_HOUR_RESET_SLACK_MS) {
    windows[remainingKey] = null;
    windows[resetKey] = null;
  }
}

function applyGeminiFiveHourCap(windows, now = Date.now()) {
  dropImplausibleFiveHourWindow(windows, "gemini_five_hour_remaining", "gemini_five_hour_reset_time", now);
  dropImplausibleFiveHourWindow(windows, "third_party_five_hour_remaining", "third_party_five_hour_reset_time", now);
  return windows;
}

function summarizeQuotaBuckets(payload) {
  const labels = [];
  for (const group of summaryGroups(payload)) {
    const groupName = String(group?.displayName || group?.name || "").trim();
    const buckets = Array.isArray(group?.buckets) ? group.buckets : [];
    for (const bucket of buckets) {
      const id = String(bucket?.bucketId || bucket?.id || bucket?.displayName || "").trim();
      if (!id && !groupName) continue;
      labels.push(groupName ? `${groupName}:${id || "?"}` : id);
    }
  }
  return labels;
}

function tighterRemaining(...values) {
  const numbers = values.map((value) => clampPercent(value)).filter((value) => value != null);
  if (!numbers.length) return null;
  return Math.min(...numbers);
}

function parseAntigravityUsage(assistPayload, modelsPayload, summaryPayload) {
  const assist = parseLoadCodeAssist(assistPayload);
  const models = parseAvailableModels(modelsPayload);
  const windows = applyGeminiFiveHourCap(mergeFamilyWindows(
    familyWindowsFromSummary(summaryPayload),
    familyWindowsFromSummary(modelsPayload),
    familyWindowsFromQuotaBuckets(modelsPayload),
    familyWindowsFromQuotaBuckets(summaryPayload),
    familyWindowsFromModels(models),
  ));
  return {
    tier: assist.tier,
    credits_remaining: assist.credits_remaining,
    credits_limit: assist.credits_limit,
    credits_remaining_percentage: assist.credits_remaining_percentage,
    ...windows,
    primary_model: null,
    primary_remaining_percentage: tighterRemaining(
      windows.gemini_five_hour_remaining,
      windows.gemini_weekly_remaining,
    ),
    secondary_model: null,
    secondary_remaining_percentage: tighterRemaining(
      windows.third_party_five_hour_remaining,
      windows.third_party_weekly_remaining,
    ),
    models,
  };
}

function antigravityQuotaHasWindows(quota) {
  if (!quota) return false;
  return [
    quota.gemini_weekly_remaining,
    quota.gemini_five_hour_remaining,
    quota.third_party_weekly_remaining,
    quota.third_party_five_hour_remaining,
    quota.credits_remaining,
    quota.credits_remaining_percentage,
  ].some((value) => value != null);
}

function usageLimited(quota) {
  if (!quota) return false;
  const windows = [
    quota.gemini_five_hour_remaining,
    quota.gemini_weekly_remaining,
    quota.third_party_five_hour_remaining,
    quota.third_party_weekly_remaining,
  ].filter((value) => value != null);
  if (windows.length) return windows.every((value) => value === 0);
  return quota.credits_remaining_percentage === 0;
}

function cloudCodeMetadata(project) {
  const metadata = {
    ideName: "antigravity",
    ideType: "ANTIGRAVITY",
    ideVersion: CLOUD_CODE_IDE_VERSION,
    pluginVersion: "unknown",
    platform: process.platform === "win32" ? "WINDOWS_AMD64" : "PLATFORM_UNSPECIFIED",
    updateChannel: "stable",
    pluginType: "GEMINI",
  };
  if (project) metadata.duetProject = project;
  return metadata;
}

function cloudCodeBases() {
  return [ANTIGRAVITY_CLOUDCODE_DAILY_URL, ANTIGRAVITY_CLOUDCODE_URL];
}

function isCloudCodeHostFailoverStatus(status) {
  const code = Number(status);
  return code === 404
    || code === 408
    || code === 500
    || code === 502
    || code === 503
    || code === 504
    || (code >= 520 && code <= 527)
    || code === 530;
}

async function cloudCodePost(path, accessToken, body, options = {}) {
  const runtime = getAntigravityRuntime();
  const bases = options.bases || cloudCodeBases();
  const userAgent = options.userAgent || CLOUD_CODE_USER_AGENT;
  const budget = Number(options.timeout) > 0 ? Number(options.timeout) : REFRESH_TIMEOUT;
  let last = null;
  let lastError = null;
  for (const base of bases) {
    // A hung first host can consume one full budget. The next Cloud Code
    // host still gets its own, same as HTTP proxy failover.
    const timeout = budget;
    try {
      last = await runtime.httpJson(`${base}${path}`, {
        method: options.method || "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": userAgent,
        },
        body: options.method === "GET" ? undefined : body,
        timeout,
      });
      lastError = null;
    } catch (error) {
      lastError = error;
      last = null;
      continue;
    }
    if (!isCloudCodeHostFailoverStatus(last.status)) return last;
  }
  if (last) return last;
  if (lastError) throw lastError;
  const timeoutError = new Error("请求超时");
  timeoutError.code = "antigravity_cloudcode_timeout";
  throw timeoutError;
}

function parseJsonBody(body, fallback = {}) {
  try {
    return JSON.parse(stripXssiPrefix(body) || "{}");
  } catch {
    return fallback;
  }
}

async function onboardAntigravityUser(accessToken, assist) {
  const runtime = getAntigravityRuntime();
  const tierId = pickOnboardTierId(assist);
  const response = await cloudCodePost("/v1internal:onboardUser", accessToken, {
    tierId,
    metadata: cloudCodeMetadata(assist.project || undefined),
  }, { userAgent: LOAD_CODE_ASSIST_USER_AGENT });
  if (response.status < 200 || response.status >= 300) return null;
  let payload = parseJsonBody(response.body);
  for (let attempt = 0; attempt < ONBOARD_POLL_LIMIT; attempt += 1) {
    if (payload.done) {
      return projectId(payload.response?.cloudaicompanionProject || payload.response?.project) || assist.project || null;
    }
    const opName = String(payload.name || "").trim();
    if (!opName) return projectId(payload.cloudaicompanionProject || payload.project) || assist.project || null;
    if (typeof runtime.sleep === "function") await runtime.sleep(500);
    const poll = await cloudCodePost(`/v1internal/${opName}`, accessToken, undefined, {
      method: "GET",
      userAgent: LOAD_CODE_ASSIST_USER_AGENT,
    });
    if (poll.status < 200 || poll.status >= 300) return assist.project || null;
    payload = parseJsonBody(poll.body);
  }
  return projectId(payload.response?.cloudaicompanionProject || payload.cloudaicompanionProject) || assist.project || null;
}

async function refreshAntigravityQuota(account, options = {}) {
  const force = options.force !== false;
  const now = ts();
  throwIfQuotaRetryPending(account, force, now);
  if (account.tokens?.refresh_token) {
    let refreshed;
    try {
      refreshed = await refreshAntigravityToken(account, { force: false });
    } catch (error) {
      account.quota_error = {
        code: error.code || "probe_failed",
        message: error.message || String(error),
        timestamp: ts(),
      };
      account.banned = false;
      scheduleQuotaRetry(account, error, now);
      saveAntigravityAcct(account);
      upsertAntigravityIndex(account);
      if (force) throw error;
      return account.quota;
    }
    if (refreshed.account) account = refreshed.account;
    const accessUsable = !antigravityAccessExpired(account);
    if (!refreshed.ok && refreshed.reauthRequired && !accessUsable) {
      account.quota_error = { code: "reauthorization_required", message: refreshed.error, timestamp: ts() };
      saveAntigravityAcct(account);
      upsertAntigravityIndex(account);
      return account.quota;
    }
    if (!refreshed.ok && !accessUsable) {
      const tokenError = new Error(refreshed.error || "Token refresh failed");
      tokenError.code = "probe_failed";
      account.quota_error = { code: "probe_failed", message: tokenError.message, timestamp: ts() };
      account.banned = false;
      scheduleQuotaRetry(account, tokenError, now);
      saveAntigravityAcct(account);
      upsertAntigravityIndex(account);
      if (force) throw tokenError;
      return account.quota;
    }
  }

  if (!account.tokens?.access_token) {
    account.quota_error = {
      code: "antigravity_session_missing",
      message: "这次没查清额度，请稍后重试。",
      timestamp: ts(),
    };
    account.probe = {
      status: "probe_failed",
      error_code: "antigravity_session_missing",
      http_status: null,
      checked_at: ts(),
    };
    account.banned = false;
    const sessionError = new Error("这次没查清额度，请稍后重试。");
    sessionError.code = "antigravity_session_missing";
    scheduleQuotaRetry(account, sessionError, now);
    saveAntigravityAcct(account);
    upsertAntigravityIndex(account);
    if (force) throw sessionError;
    return account.quota;
  }

  try {
    const postOpts = (extra = {}) => ({ timeout: options.timeout, ...extra });
    const assistResponse = await cloudCodePost("/v1internal:loadCodeAssist", account.tokens.access_token, {
      metadata: cloudCodeMetadata(),
      mode: "FULL_ELIGIBILITY_CHECK",
    }, postOpts({ userAgent: LOAD_CODE_ASSIST_USER_AGENT }));
    if (assistResponse.status === 401 || assistResponse.status === 403) {
      markAntigravityReauth(account, "Google 登录已失效，请重新授权");
      const authError = new Error("Google 登录已失效，请重新授权");
      authError.code = "reauthorization_required";
      authError.httpStatus = assistResponse.status;
      account.quota_error = { code: "reauthorization_required", message: authError.message, timestamp: ts() };
      scheduleQuotaRetry(account, authError, now);
      saveAntigravityAcct(account);
      upsertAntigravityIndex(account);
      return account.quota;
    }
    if (assistResponse.status < 200 || assistResponse.status >= 300) {
      const code = extractErrorCode(assistResponse.body) || `HTTP ${assistResponse.status}`;
      throw Object.assign(new Error(`Antigravity usage request failed: ${code}`), {
        code,
        httpStatus: assistResponse.status,
        headers: assistResponse.headers || {},
        retryAfter: assistResponse.headers?.["retry-after"] || assistResponse.headers?.["Retry-After"],
      });
    }
    let assistPayload = parseJsonBody(assistResponse.body, null);
    if (!assistPayload || typeof assistPayload !== "object") {
      throw Object.assign(new Error("Antigravity usage response was not JSON"), { code: "invalid_usage_json" });
    }
    let assist = parseLoadCodeAssist(assistPayload);
    if (!assist.project) {
      try {
        const onboarded = await onboardAntigravityUser(account.tokens.access_token, assist);
        if (onboarded) assist = { ...assist, project: onboarded };
      } catch (error) {
        logWarn(`Antigravity onboard failed for ${account.email}: ${error.message}`);
      }
    }
    if (!assist.project) {
      try {
        const retryResponse = await cloudCodePost("/v1internal:loadCodeAssist", account.tokens.access_token, {
          metadata: cloudCodeMetadata(),
          mode: "FULL_ELIGIBILITY_CHECK",
        }, postOpts({ userAgent: LOAD_CODE_ASSIST_USER_AGENT }));
        if (retryResponse.status >= 200 && retryResponse.status < 300) {
          const retryPayload = parseJsonBody(retryResponse.body, null);
          if (retryPayload && typeof retryPayload === "object") {
            assistPayload = retryPayload;
            const retried = parseLoadCodeAssist(retryPayload);
            assist = {
              ...retried,
              project: retried.project || assist.project,
            };
          }
        }
      } catch (error) {
        logWarn(`Antigravity loadCodeAssist retry failed for ${account.email}: ${error.message}`);
      }
    }
    let modelsPayload = {};
    try {
      const modelsResponse = await cloudCodePost("/v1internal:fetchAvailableModels", account.tokens.access_token, {
        project: assist.project || undefined,
      }, postOpts());
      if (modelsResponse.status >= 200 && modelsResponse.status < 300) {
        modelsPayload = parseJsonBody(modelsResponse.body);
      }
    } catch {}
    let summaryPayload = {};
    try {
      const summaryResponse = await cloudCodePost("/v1internal:retrieveUserQuotaSummary", account.tokens.access_token, {
        project: assist.project || undefined,
      }, postOpts());
      if (summaryResponse.status >= 200 && summaryResponse.status < 300) {
        summaryPayload = parseJsonBody(summaryResponse.body);
      }
    } catch {}
    if (assist.project) {
      try {
        const quotaResponse = await cloudCodePost("/v1internal:retrieveUserQuota", account.tokens.access_token, {
          project: assist.project,
        }, postOpts());
        if (quotaResponse.status >= 200 && quotaResponse.status < 300) {
          const quotaPayload = parseJsonBody(quotaResponse.body);
          if (Array.isArray(quotaPayload.buckets) && quotaPayload.buckets.length) {
            modelsPayload = { ...modelsPayload, buckets: quotaPayload.buckets };
          }
        }
      } catch {}
    }
    const quota = parseAntigravityUsage(assistPayload, modelsPayload, summaryPayload);
    logInfo(`Antigravity quota windows for ${account.email}: tier=${quota.tier || ""} geminiW=${quota.gemini_weekly_remaining} gemini5h=${quota.gemini_five_hour_remaining} thirdW=${quota.third_party_weekly_remaining} third5h=${quota.third_party_five_hour_remaining} summary=${summarizeQuotaBuckets(summaryPayload).join(",") || "none"}`);
    if (!antigravityQuotaHasWindows(quota) && !isRecognizedAntigravityTier(quota.tier)) {
      logWarn(`Antigravity quota empty for ${account.email}: project=${assist.project || ""} tier=${quota.tier || ""} models=${Array.isArray(quota.models) ? quota.models.length : 0} assistKeys=${Object.keys(assistPayload).join(",")}`);
      throw Object.assign(new Error("这次没查清额度，请稍后重试。"), { code: "probe_failed" });
    }
    account.quota = quota;
    account.quota_error = null;
    clearQuotaRetry(account);
    account.usage_updated_at = ts();
    account.banned = false;
    account.probe = {
      status: usageLimited(quota) ? "usage_limited" : "active",
      error_code: usageLimited(quota) ? "usage_limit_reached" : null,
      http_status: assistResponse.status,
      checked_at: ts(),
    };
    if (quota.tier) account.plan_type = quota.tier;
    saveAntigravityAcct(account);
    upsertAntigravityIndex(account);
    return quota;
  } catch (error) {
    account.quota_error = {
      code: error.code || "probe_failed",
      message: error.message || String(error),
      timestamp: ts(),
    };
    account.probe = {
      status: "probe_failed",
      error_code: error.code || "probe_failed",
      http_status: error.httpStatus || null,
      checked_at: ts(),
    };
    account.banned = false;
    scheduleQuotaRetry(account, error, now);
    saveAntigravityAcct(account);
    upsertAntigravityIndex(account);
    logWarn(`Antigravity quota refresh failed for ${account.email}: ${error.message}${error.stack ? `\n${error.stack}` : ""}`);
    if (force) throw error;
    return account.quota;
  }
}

module.exports = {
  parseLoadCodeAssist,
  parseAvailableModels,
  parseAntigravityUsage,
  refreshAntigravityQuota,
};
