// Small text helpers shared by adapters and the pipeline (no dependencies).
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', hellip: '...', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"' };

function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

// HTML -> plain text (used for Reddit RSS <content>, which is escaped HTML).
function htmlToText(html) {
  return decodeEntities(
    String(html ?? '')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<\s*(br|\/p|\/div|\/li)\s*\/?>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { decodeEntities, htmlToText };
