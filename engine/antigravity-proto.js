const { codedError } = require("./errors");
const OAUTH_TOKEN_SENTINEL = "oauthTokenInfoSentinelKey";
const AUTH_STATE_SENTINEL = "authStateWithContextSentinelKey";

function encodeVarint(value) {
  let number = BigInt(value);
  if (number < 0n) number = 0n;
  const bytes = [];
  while (number >= 0x80n) {
    bytes.push(Number((number & 0x7fn) | 0x80n));
    number >>= 7n;
  }
  bytes.push(Number(number));
  return Buffer.from(bytes);
}

function encodeKey(field, wire) {
  return encodeVarint((field << 3) | wire);
}

function encodeBytes(field, value) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  return Buffer.concat([encodeKey(field, 2), encodeVarint(payload.length), payload]);
}

function encodeVarintField(field, value) {
  return Buffer.concat([encodeKey(field, 0), encodeVarint(value)]);
}

function readVarint(buffer, start) {
  let value = 0n;
  let shift = 0n;
  let index = start;
  while (index < buffer.length) {
    const byte = BigInt(buffer[index++]);
    value |= (byte & 0x7fn) << shift;
    if ((byte & 0x80n) === 0n) return { value: Number(value), next: index };
    shift += 7n;
    if (shift > 63n) throw codedError("protobuf_invalid", "varint too long");
  }
  throw codedError("protobuf_invalid", "truncated varint");
}

function decodeFields(buffer) {
  const fields = [];
  let index = 0;
  while (index < buffer.length) {
    const key = readVarint(buffer, index);
    index = key.next;
    const field = key.value >>> 3;
    const wire = key.value & 7;
    if (wire === 0) {
      const varint = readVarint(buffer, index);
      index = varint.next;
      fields.push({ field, wire: "varint", value: varint.value });
    } else if (wire === 2) {
      const length = readVarint(buffer, index);
      index = length.next;
      const slice = buffer.subarray(index, index + length.value);
      index += length.value;
      fields.push({ field, wire: "bytes", value: slice });
    } else if (wire === 1) {
      index += 8;
    } else if (wire === 5) {
      index += 4;
    } else {
      break;
    }
  }
  return fields;
}

function fieldBytes(fields, field) {
  const match = fields.find((item) => item.field === field && item.wire === "bytes");
  return match ? match.value : null;
}

function fieldText(fields, field) {
  const value = fieldBytes(fields, field);
  return value ? value.toString("utf8") : "";
}

function encodeTimestampSeconds(seconds) {
  return encodeVarintField(1, Math.max(0, Number(seconds) || 0));
}

function decodeTimestampSeconds(buffer) {
  if (!buffer || !buffer.length) return 0;
  const fields = decodeFields(buffer);
  const match = fields.find((item) => item.field === 1 && item.wire === "varint");
  return match ? Number(match.value) || 0 : 0;
}

function encodeOauthTokenInfo(token) {
  const parts = [
    encodeBytes(1, token.access_token || ""),
    encodeBytes(2, token.token_type || "Bearer"),
    encodeBytes(3, token.refresh_token || ""),
    encodeBytes(4, encodeTimestampSeconds(token.expiry_timestamp || 0)),
  ];
  if (token.is_gcp_tos === true) parts.push(encodeVarintField(5, 1));
  return Buffer.concat(parts);
}

function decodeOauthTokenInfo(buffer) {
  const fields = decodeFields(buffer);
  return {
    access_token: fieldText(fields, 1),
    token_type: fieldText(fields, 2) || "Bearer",
    refresh_token: fieldText(fields, 3),
    expiry_timestamp: decodeTimestampSeconds(fieldBytes(fields, 4)),
    is_gcp_tos: fields.some((item) => item.field === 5 && item.wire === "varint" && item.value === 1),
  };
}

function encodeTopicEntry(key, payload) {
  return encodeBytes(1, Buffer.concat([
    encodeBytes(1, key),
    encodeBytes(2, payload),
  ]));
}

function decodeTopicEntries(buffer) {
  return decodeFields(buffer)
    .filter((item) => item.field === 1 && item.wire === "bytes")
    .map((item) => {
      const inner = decodeFields(item.value);
      return {
        key: fieldText(inner, 1),
        payload: fieldBytes(inner, 2) || Buffer.alloc(0),
      };
    })
    .filter((item) => item.key);
}

function encodeTopic(entries) {
  return Buffer.concat(entries.map((entry) => encodeTopicEntry(entry.key, entry.payload)));
}

function encodeOauthTokenTopic(token, existingTopic) {
  const current = existingTopic && existingTopic.length
    ? decodeTopicEntries(existingTopic).filter((entry) => entry.key !== OAUTH_TOKEN_SENTINEL)
    : [];
  const info = encodeOauthTokenInfo(token);
  current.push({
    key: OAUTH_TOKEN_SENTINEL,
    payload: encodeBytes(1, info.toString("base64")),
  });
  if (!current.some((entry) => entry.key === AUTH_STATE_SENTINEL)) {
    current.unshift({
      key: AUTH_STATE_SENTINEL,
      payload: encodeBytes(1, JSON.stringify({ state: "signedIn", context: {} })),
    });
  }
  return encodeTopic(current);
}

function decodeOauthTokenTopic(buffer) {
  const entries = decodeTopicEntries(buffer);
  const row = entries.find((entry) => entry.key === OAUTH_TOKEN_SENTINEL);
  if (!row) return null;
  const wrapper = decodeFields(row.payload);
  const encoded = fieldText(wrapper, 1).replace(/\s+/g, "");
  if (!encoded) return null;
  let infoBuffer = Buffer.from(encoded, "utf8");
  try {
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.length) infoBuffer = decoded;
  } catch {}
  const token = decodeOauthTokenInfo(infoBuffer);
  if (!token.access_token && !token.refresh_token) return null;
  return token;
}

function decodeItemTableValue(raw) {
  if (raw == null) return null;
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const text = buffer.toString("utf8").trim().replace(/\s+/g, "");
  if (/^[A-Za-z0-9+/=]+$/.test(text) && text.length > 8) {
    try {
      return Buffer.from(text, "base64");
    } catch {}
  }
  return buffer;
}

function encodeItemTableValue(topic) {
  return topic.toString("base64");
}

module.exports = {
  OAUTH_TOKEN_SENTINEL,
  AUTH_STATE_SENTINEL,
  encodeOauthTokenInfo,
  decodeOauthTokenInfo,
  encodeOauthTokenTopic,
  decodeOauthTokenTopic,
  decodeTopicEntries,
  decodeItemTableValue,
  encodeItemTableValue,
};
