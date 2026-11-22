/* Pagefind 1.6 expands prefixes in ordinary search, including shard-local
 * fallbacks. Launch search uses complete words; quoted input uses its native
 * positional phrase mode. Keep this policy shared by both static clients. */
export function normalizeSearchQuery(value) {
  const normalized = String(value ?? '').normalize('NFKD')
    .replace(/[\u0591-\u05bd\u05bf-\u05c7]/g, '').replace(/\s+/g, ' ').trim();
  const phrase = /^".+"$/.test(normalized);
  const body = (phrase ? normalized.slice(1, -1) : normalized).replace(/[׳״'"“”‘’]/g, '');
  // Native Hebrew compounds occupy one word position. Turning a maqaf into
  // whitespace inside a copied phrase would change its positional meaning.
  const words = (phrase ? body : body.replace(/[\u05be–-]/g, ' ')).replace(/\s+/g, ' ').trim();
  if (!/[\p{L}\p{N}]/u.test(words)) return '';
  return phrase ? `"${words}"` : words;
}

export async function searchWholeWords(api, query, options = {}, isCurrent = () => true, bundlePath = '') {
  if (!isCurrent()) return null;
  if (/^".+"$/.test(query)) {
    const exact = await api.search(query, options);
    if (!isCurrent()) return null;
    if (!exact.results.length) return { results: [] };
    // Native phrase results all score 1. Obtain relevance scores separately,
    // after phrase search has loaded the required chunks. Keep the original
    // phrase handles: broad-query locations include non-adjacent occurrences.
    const ranked = await api.search(query.slice(1, -1), options);
    if (!isCurrent()) return null;
    const scores = new Map(ranked.results.map(result => [result.id, result.score]));
    const missing = exact.results.filter(result => !Number.isFinite(scores.get(result.id)));
    if (missing.length) throw new Error(`Search engine omitted an exact-phrase rank in ${bundlePath}: ${missing.slice(0, 5).map(result => result.id).join(', ')}`);
    return { results: exact.results.map(result => ({ ...result, score: scores.get(result.id) })) };
  }
  const words = [...new Set(query.split(/\s+/).filter(word => /[\p{L}\p{N}]/u.test(word)))];
  let matching;
  for (const word of words) {
    if (!isCurrent()) return null;
    const response = await api.search(`"${word}"`, options);
    const ids = new Set(response.results.map(result => result.id));
    matching = matching ? new Set([...matching].filter(id => ids.has(id))) : ids;
    if (!matching.size) return { results: [] };
  }
  if (!isCurrent()) return null;
  if (!matching?.size) return { results: [] };
  // Warm every exact token before asking for native ranking and highlight
  // handles. This function must run within ONE index: short fragment IDs are
  // unique only there, not across Pagefind's merged-index response.
  const response = await api.search(query, options);
  const results = response.results.filter(result => matching.has(result.id));
  if (results.length !== matching.size) {
    const returned = new Set(results.map(result => result.id));
    const missing = [...matching].filter(id => !returned.has(id)).slice(0, 5);
    throw new Error(`Search engine omitted a whole-word match in ${bundlePath}: ${missing.join(', ')}`);
  }
  // Prefix-query facet counts and timings do not describe this intersection.
  // Callers display results.length and manifest scopes, so omit those fields.
  return { results };
}
