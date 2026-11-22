/**
 * Independent phrase evidence for the smoke test's plain Hebrew query.
 *
 * Pinned Pagefind 1.6.0 indexes Hebrew by Rust split_whitespace positions, not
 * UAX 29 word boundaries. A primary token removes non-alphanumeric characters
 * and canonical diacritics; ASCII compound parts and dotted tails occupy that
 * same position. A punctuation-only word still advances the position. Hebrew
 * has no stemmer. See the pinned upstream implementation:
 * https://github.com/Pagefind/pagefind/blob/v1.6.0/pagefind/src/fossick/mod.rs
 * https://github.com/Pagefind/pagefind/blob/v1.6.0/pagefind/src/fossick/splitting.rs
 *
 * This is deliberately a Hebrew QA oracle, not another search implementation.
 * It accepts plain Hebrew query words and retains only their possible Hebrew
 * matches. Case-conversion boundaries, emoji and CJK suffixes cannot produce
 * such a token. Native differential tests guard the relevant normalization,
 * same-position compounds and consecutive-position phrase semantics.
 */

const VERSION = '1.6.0';
const ASCII_PUNCTUATION = /[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/gu;
const ALPHANUMERIC = /[\p{Alphabetic}\p{Number}]/u;
const HEBREW_LETTER = /\p{Script=Hebrew}/u;
const LETTERS = /^\p{Letter}+$/u;
const WHITESPACE_WORDS = /[^\p{White_Space}]+/gu;

function isHebrewWord(word) {
  return LETTERS.test(word) && [...word].every(character => HEBREW_LETTER.test(character));
}

function normalizeDiacritics(word) {
  // Native normalization is canonical NFD, not compatibility NFKD. The two
  // kana exceptions mirror upstream, although neither can match our query.
  const decomposed = word.normalize('NFD').replace(/\p{Mark}/gu, character =>
    character === '\u3099' || character === '\u309a' ? character : '');
  return /[\u3099\u309a]/u.test(decomposed) ? decomposed.normalize('NFC') : decomposed;
}

function normalizeWord(word) {
  return [...word].filter(character => ALPHANUMERIC.test(character))
    .map(character => character.toLowerCase()).join('');
}

function primaryToken(word) {
  return normalizeDiacritics(normalizeWord(word));
}

function hebrewVariants(raw) {
  const tokens = new Set();
  const add = word => { if (isHebrewWord(word)) tokens.add(word); };
  add(primaryToken(raw));

  // convert_case's lower/upper/digit boundaries do not split Hebrew letters.
  // Only ASCII punctuation and whitespace can isolate a plain Hebrew part.
  // A lone part that upstream omits is already the identical primary token.
  for (const part of raw.replace(ASCII_PUNCTUATION, ' ').match(WHITESPACE_WORDS) || []) {
    if (Buffer.byteLength(part, 'utf8') > 1) add(normalizeDiacritics(part));
  }

  // Pagefind also indexes a bounded normalized suffix of compound dotted words.
  // For example foo.בראש"ית has a בראשית token at the original word position.
  const characters = [...raw];
  for (let index = 0; index < characters.length; index++) {
    if (characters[index] !== '.') continue;
    const tail = characters.slice(index + 1, index + 65);
    if (!tail.some(character => !ALPHANUMERIC.test(character)) &&
        !tail.slice(1).some(character => /\p{Uppercase}/u.test(character))) continue;
    const normalized = normalizeWord(tail.join(''));
    if ([...normalized].length >= 2) add(normalizeDiacritics(normalized));
  }
  return [...tokens];
}

function windowEvidence(content, words, start, queryTokens) {
  const window = words.slice(start, start + queryTokens.length);
  const begin = Math.max(0, window[0].offset - 80);
  const end = Math.min(content.length, window.at(-1).end + 80);
  return {
    startPosition: start,
    words: window.map((word, index) => ({
      position: start + index,
      raw: word.raw.slice(0, 160),
      hebrewTokens: word.tokens.slice(0, 12).map(token => token.slice(0, 160)),
      hebrewTokenCount: word.tokens.length,
      expectedToken: queryTokens[index],
      matched: word.tokens.includes(queryTokens[index]),
    })),
    rawExcerpt: content.slice(begin, Math.min(end, begin + 500)),
  };
}

export function hebrewPhraseEvidence(value, phrase, { version = VERSION } = {}) {
  if (version !== VERSION) throw new Error(`Phrase oracle requires pinned Pagefind ${VERSION}; received ${version}`);
  const queryWords = String(phrase).match(WHITESPACE_WORDS) || [];
  const queryTokens = queryWords.map(primaryToken);
  if (!queryWords.length || queryWords.some((word, index) =>
    !/^[\p{Letter}\p{Mark}]+$/u.test(word) || !isHebrewWord(queryTokens[index]))) {
    throw new Error('Phrase oracle supports plain Hebrew query words only');
  }

  const content = String(value || '');
  const words = [];
  for (const match of content.matchAll(WHITESPACE_WORDS)) {
    const raw = match[0].replace(/\u200b/gu, '');
    if (!raw) continue;
    // Do not remove punctuation-only positions. A separate comma between two
    // words prevents a native exact phrase, even though its token list is empty.
    words.push({ raw, tokens: hebrewVariants(raw), offset: match.index, end: match.index + match[0].length });
  }

  let matchCount = 0;
  const matches = [];
  const nearby = [];
  for (let start = 0; start + queryTokens.length <= words.length; start++) {
    const matched = queryTokens.every((token, index) => words[start + index].tokens.includes(token));
    if (matched) {
      matchCount++;
      if (matches.length < 3) matches.push(windowEvidence(content, words, start, queryTokens));
    } else if (nearby.length < 3 && words[start].tokens.includes(queryTokens[0])) {
      nearby.push(windowEvidence(content, words, start, queryTokens));
    }
  }
  return {
    engine: 'pagefind', version: VERSION, language: 'he', queryTokens,
    matched: matchCount > 0, matchCount, wordPositions: words.length,
    matches,
    ...(matchCount ? {} : { nearby, rawExcerpt: content.slice(0, 240) }),
  };
}
