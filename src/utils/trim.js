function normalizeContent(text) {
  if (typeof text !== 'string') return text;

  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function trimMessages(messages) {
  if (!Array.isArray(messages)) return messages;

  return messages.map((m) => ({
    ...m,
    content: normalizeContent(m.content),
  }));
}

module.exports = { trimMessages };