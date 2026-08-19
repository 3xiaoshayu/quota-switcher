const { DATA_DIR, CURSOR_ACCTS_DIR, CURSOR_IDX_PATH } = require("./config");
const { createAccountFileStore } = require("./account-file-store");

function decorateCursorAccount(account) {
  account.platform = "cursor";
  account.banned = false;
  return account;
}

const store = createAccountFileStore({
  prefix: "cursor_",
  accountsDir: CURSOR_ACCTS_DIR,
  indexPath: CURSOR_IDX_PATH,
  dataDir: DATA_DIR,
  currentField: "current_cursor_account_id",
  indexVersion: "1.0",
  pathRequiresPrefix: true,
  logIndexRebuild: true,
  rebuildLogLabel: "Cursor account index",
  saveForeignPrefixError: "Invalid cursor account id",
  deleteRollbackLabel: "Cursor account rollback failed",
  indexInvalidMessage: "Cursor account index has an invalid structure",
  invalidIdError: "Invalid cursor account id",
  decorateAccount: decorateCursorAccount,
});

module.exports = {
  cursorAccountFilePath: store.accountFilePath,
  loadCursorIdx: store.loadIdx,
  saveCursorIdx: store.saveIdx,
  loadCursorAcct: store.loadAcct,
  saveCursorAcct: store.saveAcct,
  listCursorAccts: store.listAccts,
  currentCursorAcct: store.currentAcct,
  setCurrentCursorAccountId: store.setCurrentAccountId,
  deleteCursorAcct: store.deleteAcct,
  upsertCursorIndex: store.upsertIndex,
  snapshotCursorMeta: store.snapshotMeta,
  restoreCursorMeta: store.restoreMeta,
  scanCursorAccounts: store.scanAccounts,
};
