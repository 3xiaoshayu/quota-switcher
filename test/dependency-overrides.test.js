const assert = require("node:assert/strict");
const test = require("node:test");

function resolvedVersion(name, from) {
  return require(require.resolve(`${name}/package.json`, { paths: [from] })).version;
}

test("production yaml and socks IP helpers use patched releases", () => {
  const yaml = resolvedVersion("js-yaml", require.resolve("electron-updater"));
  const socks = require.resolve("socks/package.json", { paths: [require.resolve("proxy-agent")] });
  const ip = resolvedVersion("ip-address", socks);
  assert.match(yaml, /^4\.3\.[1-9]/);
  assert.match(ip, /^10\.(?:[4-9]|\d{2,})\./);
});

test("Electron download helper uses patched undici 7", () => {
  const electronGet = require.resolve("@electron/get");
  const undici = resolvedVersion("undici", electronGet);
  assert.ok(undici.localeCompare("7.29.0", undefined, { numeric: true }) >= 0, undici);
});

test("brace-expansion copies stay on patched majors", () => {
  const versions = new Set();
  for (const from of [
    require.resolve("minimatch"),
    require.resolve("vite"),
  ]) {
    try {
      versions.add(resolvedVersion("brace-expansion", from));
    } catch {
      // not every parent hoists this helper
    }
  }
  assert.ok(versions.size > 0, "expected at least one brace-expansion");
  for (const version of versions) {
    const [major, minor, patch] = version.split(".").map(Number);
    if (major === 1) assert.ok(minor > 1 || patch >= 18, version);
    else if (major === 2) assert.ok(minor > 1 || patch >= 4, version);
    else if (major === 5) assert.ok(minor > 0 || patch >= 9, version);
    else assert.fail(`unexpected brace-expansion ${version}`);
  }
});

test("build toolchain yaml-adjacent helpers use patched releases", () => {
  const postcss = require("postcss/package.json").version;
  const nanoid = resolvedVersion("nanoid", require.resolve("postcss"));
  assert.ok(postcss.localeCompare("8.5.23", undefined, { numeric: true }) >= 0, postcss);
  assert.ok(nanoid.localeCompare("3.3.18", undefined, { numeric: true }) >= 0, nanoid);
});
