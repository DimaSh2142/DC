// Pure, dependency-free answer checking. No external deps so it can run/be
// unit-tested without `npm install`.

/**
 * Normalize a string for forgiving comparison:
 * - lowercase
 * - trim + collapse internal whitespace
 * - strip punctuation/quotes/dashes
 * - normalize common UA/RU letter variants (ё->е, ' variants, apostrophes)
 */
function normalize(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .toLowerCase()
    .replace(/[ёЁ]/g, 'е')
    .replace(/['`´ʼ’‘"]/g, '')
    .replace(/[-_.,!?;:()«»–—/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Cheap Levenshtein distance, capped for performance on short quiz answers.
 */
function levenshtein(a, b) {
  if (a === b) return 0;
  const al = a.length, bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  let prev = new Array(bl + 1);
  let curr = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,      // deletion
        curr[j - 1] + 1,  // insertion
        prev[j - 1] + cost // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[bl];
}

/**
 * Allowed typo tolerance scales with answer length so short answers
 * (e.g. "CS") still require an exact/near-exact match.
 */
function toleranceFor(length) {
  if (length <= 3) return 0;
  if (length <= 6) return 1;
  return 2;
}

/**
 * Check free-text answer against a list of accepted variants.
 * Returns { correct: boolean, matchedVariant: string|null }
 */
function checkTextAnswer(userInput, acceptedAnswers) {
  const normInput = normalize(userInput);
  if (!normInput) return { correct: false, matchedVariant: null };

  let best = null;
  let bestDist = Infinity;
  for (const variant of acceptedAnswers || []) {
    const normVariant = normalize(variant);
    if (!normVariant) continue;
    if (normInput === normVariant) {
      return { correct: true, matchedVariant: variant };
    }
    const dist = levenshtein(normInput, normVariant);
    if (dist < bestDist) {
      bestDist = dist;
      best = variant;
    }
  }
  if (best !== null && bestDist <= toleranceFor(normalize(best).length)) {
    return { correct: true, matchedVariant: best };
  }
  return { correct: false, matchedVariant: null };
}

/**
 * Check a select/point-style answer (e.g. logo challenge): compare chosen
 * option id against the correct option id.
 */
function checkSelectAnswer(chosenId, correctId) {
  return { correct: String(chosenId) === String(correctId) };
}

module.exports = { normalize, levenshtein, checkTextAnswer, checkSelectAnswer };
