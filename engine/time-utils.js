const { ts } = require("./crypto-utils");

function parseTsStr(raw) {
  const trimmed = (raw || "").trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    let tsNum = parseInt(trimmed);
    if (tsNum > 1e12) tsNum = Math.floor(tsNum / 1000);
    return tsNum;
  }
  const d = new Date(trimmed);
  return isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
}

module.exports = { parseTsStr, ts };
