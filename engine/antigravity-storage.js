const { DATA_DIR, ANTIGRAVITY_ACCTS_DIR, ANTIGRAVITY_IDX_PATH } = require("./config");
const { createAccountFileStore } = require("./account-file-store");

function decorateAntigravityAccount(account) {
  account.platform = "antigravity";
  account.banned = false;
  return account;
}

const store = createAccountFileStore({
  prefix: "antigravity_",
  accountsDir: ANTIGRAVITY_ACCTS_DIR,
  indexPath: ANTIGRAVITY_IDX_PATH,
  dataDir: DATA_DIR,
  currentField: "current_antigravity_account_id",
  indexVersion: "1.0",
  pathRequiresPrefix: true,
  logIndexRebuild: true,
  rebuildLogLabel: "Antigravity account index",
  saveForeignPrefixError: "Invalid antigravity account id",
  deleteRollbackLabel: "Antigravity account rollback failed",
  indexInvalidMessage: "Antigravity account index has an invalid structure",
  invalidIdError: "Invalid antigravity account id",
  decorateAccount: decorateAntigravityAccount,
});

module.exports = {
  antigravityAccountFilePath: store.accountFilePath,
  loadAntigravityIdx: store.loadIdx,
  saveAntigravityIdx: store.saveIdx,
  loadAntigravityAcct: store.loadAcct,
  saveAntigravityAcct: store.saveAcct,
  listAntigravityAccts: store.listAccts,
  currentAntigravityAcct: store.currentAcct,
  setCurrentAntigravityAccountId: store.setCurrentAccountId,
  deleteAntigravityAcct: store.deleteAcct,
  upsertAntigravityIndex: store.upsertIndex,
  snapshotAntigravityMeta: store.snapshotMeta,
  restoreAntigravityMeta: store.restoreMeta,
  scanAntigravityAccounts: store.scanAccounts,
};
