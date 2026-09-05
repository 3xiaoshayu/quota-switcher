// Every failure the engine raises on purpose carries a stable `code`. The
// window picks user-facing copy by that code (CODE_MESSAGES in the renderer);
// the message is diagnostic text for logs and may change wording freely.
function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = { codedError };
