function usableEmail(value) {
  const email = String(value || "").trim();
  if (!email || !email.includes("@") || email.toLowerCase() === "unknown") return "";
  return email;
}

function usableAuthId(value) {
  const id = String(value || "").trim().toLowerCase();
  if (!id || id === "unknown") return "";
  return id;
}

function accountFingerprint(account) {
  return usableAuthId(account?.auth_id || account?.tokens?.auth_id);
}

function hasQuotaData(account) {
  const quota = account?.quota;
  if (!quota || typeof quota !== "object") return false;
  return [
    quota.gemini_weekly_remaining,
    quota.gemini_five_hour_remaining,
    quota.third_party_weekly_remaining,
    quota.third_party_five_hour_remaining,
    quota.credits_remaining,
    quota.credits_remaining_percentage,
    quota.plan_remaining_percentage,
    quota.auto_remaining_percentage,
    quota.api_remaining_percentage,
    quota.hourly_remaining_percentage,
    quota.weekly_remaining_percentage,
    quota.hourly_percentage,
    quota.weekly_percentage,
    quota.primary_remaining_percentage,
  ].some((value) => value != null);
}

function pickIdentityKeeper(accounts, currentId) {
  if (!accounts.length) return null;
  return accounts.slice().sort((left, right) => {
    if (left.id === currentId) return -1;
    if (right.id === currentId) return 1;
    const quotaDelta = Number(hasQuotaData(right)) - Number(hasQuotaData(left));
    if (quotaDelta) return quotaDelta;
    const emailDelta = Number(!!usableEmail(right.email)) - Number(!!usableEmail(left.email));
    if (emailDelta) return emailDelta;
    return Number(left.created_at || 0) - Number(right.created_at || 0);
  })[0];
}

function unionIdentityGroups(accounts, sameIdentity) {
  const parent = new Map(accounts.map((account) => [account.id, account.id]));
  const find = (id) => {
    const current = parent.get(id);
    if (current !== id) parent.set(id, find(current));
    return parent.get(id);
  };
  for (let i = 0; i < accounts.length; i += 1) {
    for (let j = i + 1; j < accounts.length; j += 1) {
      if (!sameIdentity(accounts[i], accounts[j])) continue;
      const left = find(accounts[i].id);
      const right = find(accounts[j].id);
      if (left !== right) parent.set(left, right);
    }
  }
  const groups = new Map();
  for (const account of accounts) {
    const root = find(account.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(account);
  }
  return [...groups.values()];
}

function sharedAccountId(group) {
  const ids = [...new Set(group.map((account) => String(account?.account_id || account?.tokens?.account_id || "").trim()).filter(Boolean))];
  return ids.length === 1 ? ids[0] : "";
}

function splitGroupsByEmail(groups) {
  const result = [];
  for (const group of groups) {
    const emails = [...new Set(group.map((account) => usableEmail(account.email).toLowerCase()).filter(Boolean))];
    if (emails.length <= 1 || sharedAccountId(group)) {
      result.push(group);
      continue;
    }
    const byEmail = new Map(emails.map((email) => [
      email,
      group.filter((account) => usableEmail(account.email).toLowerCase() === email),
    ]));
    const emailFingerprints = new Map();
    for (const [email, members] of byEmail) {
      emailFingerprints.set(email, new Set(members.map(accountFingerprint).filter(Boolean)));
    }
    const unknowns = group.filter((account) => !usableEmail(account.email));
    const assigned = new Set();
    for (const unknown of unknowns) {
      const fingerprint = accountFingerprint(unknown);
      if (!fingerprint) continue;
      const matches = emails.filter((email) => emailFingerprints.get(email).has(fingerprint));
      if (matches.length !== 1) continue;
      byEmail.get(matches[0]).push(unknown);
      assigned.add(unknown.id);
    }
    result.push(...byEmail.values());
    const leftover = unknowns.filter((account) => !assigned.has(account.id));
    if (leftover.length) result.push(leftover);
  }
  return result;
}

function groupByIdentity(accounts, sameIdentity) {
  return splitGroupsByEmail(unionIdentityGroups(accounts, sameIdentity));
}

function absorbIdentitySource(keeper, source) {
  if (Number(source?.token_updated_at || 0) > Number(keeper?.token_updated_at || 0)) {
    keeper.tokens = source.tokens;
    keeper.auth_id = source.auth_id || keeper.auth_id;
    keeper.account_id = source.account_id || keeper.account_id;
    keeper.user_id = source.user_id || keeper.user_id;
    keeper.organization_id = source.organization_id || keeper.organization_id;
    keeper.token_updated_at = source.token_updated_at;
    keeper.token_generation = source.token_generation;
  }
  if (!usableEmail(keeper.email) && usableEmail(source.email)) keeper.email = source.email;
  if (source?.cursor_ui && typeof source.cursor_ui === "object") {
    keeper.cursor_ui = { ...(keeper.cursor_ui || {}), ...source.cursor_ui };
  }
  if (source?.cursor_session && typeof source.cursor_session === "object") {
    keeper.cursor_session = { ...(keeper.cursor_session || {}), ...source.cursor_session };
  }
  if (!hasQuotaData(keeper) && hasQuotaData(source)) {
    keeper.quota = source.quota;
    keeper.quota_error = source.quota_error;
    keeper.usage_updated_at = source.usage_updated_at;
    keeper.plan_type = source.plan_type || keeper.plan_type;
    keeper.probe = source.probe || keeper.probe;
  }
  return keeper;
}

function foldDuplicateAccounts(accounts, sameIdentity, currentId, persist, onError) {
  let changed = false;
  for (const group of groupByIdentity(accounts, sameIdentity)) {
    if (group.length < 2) continue;
    const keeper = pickIdentityKeeper(group, currentId);
    for (const extra of group) {
      if (extra.id === keeper.id) continue;
      absorbIdentitySource(keeper, extra);
    }
    try {
      persist(keeper, group.filter((item) => item.id !== keeper.id));
      changed = true;
    } catch (error) {
      if (typeof onError === "function") onError(error);
      else throw error;
    }
  }
  return changed;
}

function extraIdentityIds(preview, saveId, accounts, sameIdentity) {
  return accounts
    .filter((account) => account.id !== saveId && sameIdentity(preview, account))
    .map((account) => account.id);
}

function mergePreservedQuota(existing, incoming = {}) {
  if (hasQuotaData(incoming)) {
    return {
      quota: incoming.quota,
      quota_error: incoming.quota_error ?? null,
      probe: incoming.probe ?? existing?.probe ?? null,
      usage_updated_at: incoming.usage_updated_at || existing?.usage_updated_at || null,
    };
  }
  return {
    quota: existing?.quota || incoming.quota || null,
    quota_error: existing?.quota_error ?? incoming.quota_error ?? null,
    probe: existing?.probe || incoming.probe || null,
    usage_updated_at: existing?.usage_updated_at || incoming.usage_updated_at || null,
  };
}

module.exports = {
  usableEmail,
  usableAuthId,
  accountFingerprint,
  hasQuotaData,
  pickIdentityKeeper,
  unionIdentityGroups,
  splitGroupsByEmail,
  groupByIdentity,
  absorbIdentitySource,
  foldDuplicateAccounts,
  extraIdentityIds,
  mergePreservedQuota,
};
