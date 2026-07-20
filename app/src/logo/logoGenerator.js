// Procedural "find the correct logo" challenge generator.
// Fallback used because no AI image-generation tool is available in this
// environment (documented in PROGRESS.md). Produces 1 canonical logo + 3
// decoys with deliberately small, controlled deltas, using only the site's
// 4-color palette (white / turquoise / crimson / orange) so generated
// content stays inside the brand constraint.
//
// Zero external dependencies -> unit-testable without `npm install`.

const PALETTE = {
  turquoise: '#17B8A6',
  crimson: '#D7263D',
  orange: '#F2994A',
  white: '#FFFFFF',
  ink: '#123A36' // dark turquoise shade used only for outlines/text, not a 5th hue
};

const SHAPES = ['hex', 'star', 'ring', 'triangleStack', 'chevron'];

// Small deterministic PRNG (mulberry32) seeded from a string, so the same
// seed always reproduces the same logo set (useful for tests + for baking
// content into the theme bank once, rather than regenerating on every load).
function seedToInt(seed) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

// Invented wordmark syllables -- avoids recreating any real trademarked
// brand name/logo (copyright/trademark safety), while still "feeling" like
// a plausible brand for the guessing game.
const SYLLABLES = ['NO', 'VA', 'PEX', 'LUM', 'ZEN', 'ORB', 'KAI', 'TRO', 'FIN', 'RIX', 'MELO', 'VOX', 'ARGO', 'NEX', 'PIKO'];

function inventBrandName(rng) {
  const parts = 2 + (rng() < 0.3 ? 1 : 0);
  let name = '';
  for (let i = 0; i < parts; i++) name += pick(rng, SYLLABLES);
  return name.slice(0, 10);
}

function buildIconPath(shape, cx, cy, r, points, rotationDeg, strokeWidth) {
  const rot = (rotationDeg * Math.PI) / 180;
  switch (shape) {
    case 'star': {
      const spikes = points;
      const inner = r * 0.5;
      let d = '';
      for (let i = 0; i < spikes * 2; i++) {
        const rad = i % 2 === 0 ? r : inner;
        const ang = rot + (i * Math.PI) / spikes;
        const x = cx + rad * Math.sin(ang);
        const y = cy - rad * Math.cos(ang);
        d += (i === 0 ? 'M' : 'L') + x.toFixed(2) + ',' + y.toFixed(2) + ' ';
      }
      return `<path d="${d}Z" fill="none" stroke="${'{{COLOR_A}}'}" stroke-width="${strokeWidth}" stroke-linejoin="round"/>`;
    }
    case 'hex':
    case 'triangleStack': {
      const sides = shape === 'hex' ? points : 3;
      let d = '';
      for (let i = 0; i < sides; i++) {
        const ang = rot + (i * 2 * Math.PI) / sides;
        const x = cx + r * Math.sin(ang);
        const y = cy - r * Math.cos(ang);
        d += (i === 0 ? 'M' : 'L') + x.toFixed(2) + ',' + y.toFixed(2) + ' ';
      }
      return `<path d="${d}Z" fill="none" stroke="{{COLOR_A}}" stroke-width="${strokeWidth}" stroke-linejoin="round"/>`;
    }
    case 'ring': {
      return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="{{COLOR_A}}" stroke-width="${strokeWidth}"/>` +
        `<circle cx="${cx + r * 0.15}" cy="${cy}" r="${r * 0.45}" fill="none" stroke="{{COLOR_B}}" stroke-width="${strokeWidth * 0.7}" transform="rotate(${rotationDeg} ${cx} ${cy})"/>`;
    }
    case 'chevron':
    default: {
      let d = '';
      const step = r / Math.max(2, points);
      for (let i = 0; i < points; i++) {
        const yy = cy - r + i * step * 2;
        d += `M${cx - r * 0.6},${(yy + step).toFixed(2)} L${cx},${(yy).toFixed(2)} L${cx + r * 0.6},${(yy + step).toFixed(2)} `;
      }
      return `<g transform="rotate(${rotationDeg} ${cx} ${cy})" fill="none" stroke="{{COLOR_A}}" stroke-width="${strokeWidth}" stroke-linecap="round">${d.split('M').filter(Boolean).map(seg => `<path d="M${seg}"/>`).join('')}</g>`;
    }
  }
}

function renderLogoSvg(spec) {
  const { shape, colorA, colorB, rotation, strokeWidth, points, brand, textColor } = spec;
  const icon = buildIconPath(shape, 60, 52, 34, points, rotation, strokeWidth)
    .replace(/\{\{COLOR_A\}\}/g, colorA)
    .replace(/\{\{COLOR_B\}\}/g, colorB);
  return `<svg viewBox="0 0 120 100" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="logo">` +
    `<rect x="0" y="0" width="120" height="100" fill="#FFFFFF"/>` +
    icon +
    `<text x="60" y="92" text-anchor="middle" font-family="Arial, sans-serif" font-weight="700" font-size="13" letter-spacing="1" fill="${textColor}">${brand}</text>` +
    `</svg>`;
}

/**
 * Generate one "find the correct logo" question: 1 correct + 3 decoys with
 * minimal, single-parameter differences from the correct one. `difficulty`
 * 1-5 controls how subtle the decoy deltas are (1 = obvious, 5 = razor-thin).
 *
 * @param {string} seed - deterministic seed (e.g. theme id + question index)
 * @param {number} difficulty - 1 (easy/obvious decoys) .. 5 (hard/subtle)
 */
function generateLogoChallenge(seed, difficulty = 3) {
  const rng = mulberry32(seedToInt(seed));
  const shape = pick(rng, SHAPES);
  const colorKeys = ['turquoise', 'crimson', 'orange'];
  const colorAKey = pick(rng, colorKeys);
  let colorBKey = pick(rng, colorKeys);
  if (colorBKey === colorAKey) colorBKey = colorKeys[(colorKeys.indexOf(colorAKey) + 1) % 3];

  const base = {
    shape,
    colorA: PALETTE[colorAKey],
    colorB: PALETTE[colorBKey],
    rotation: Math.floor(rng() * 40) - 20,
    strokeWidth: 5 + Math.floor(rng() * 3),
    points: shape === 'star' ? 5 + Math.floor(rng() * 2) : 6,
    brand: inventBrandName(rng),
    textColor: PALETTE.ink
  };

  // difficulty 1 -> big obvious deltas; difficulty 5 -> tiny deltas
  const deltaScale = { 1: 1.0, 2: 0.7, 3: 0.5, 4: 0.3, 5: 0.15 }[difficulty] || 0.5;

  const rotationDelta = Math.max(2, Math.round(18 * deltaScale));
  const strokeDelta = Math.max(0.4, +(2 * deltaScale).toFixed(1));
  const spacingDelta = Math.max(1, Math.round(6 * deltaScale)); // used via viewBox nudge

  const decoyRotation = { ...base, rotation: base.rotation + rotationDelta };
  const decoyStroke = { ...base, strokeWidth: +(base.strokeWidth + strokeDelta).toFixed(1) };
  // 'points' only has a rendered effect for hex/star/chevron (they use it as
  // side/spike/bar count). For 'ring' and 'triangleStack' the icon path
  // ignores `points` entirely, so nudging it would silently render an exact
  // duplicate of another variant -- use a secondary rotation nudge instead
  // for those two shapes so all 4 options always stay visually distinct.
  const usesPointsVisually = base.shape === 'hex' || base.shape === 'star' || base.shape === 'chevron';
  // rotationDelta is always >= 2 (see Math.max above), so this secondary
  // nudge is always >= 1 and therefore always non-zero / distinct from base.
  const secondaryRotationNudge = Math.round(rotationDelta / 2);
  const decoyPoints = usesPointsVisually
    ? { ...base, points: Math.max(3, base.points + (deltaScale > 0.5 ? 1 : (rng() < 0.5 ? 1 : -1))) }
    : { ...base, rotation: base.rotation + secondaryRotationNudge };

  const variants = [
    { id: 'correct', spec: base },
    { id: 'decoy_rotation', spec: decoyRotation },
    { id: 'decoy_stroke', spec: decoyStroke },
    { id: 'decoy_points', spec: decoyPoints }
  ];

  // shuffle display order deterministically from the same rng stream
  for (let i = variants.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [variants[i], variants[j]] = [variants[j], variants[i]];
  }

  const options = variants.map((v, idx) => ({
    optionId: 'opt' + idx,
    svg: renderLogoSvg(v.spec),
    isCorrect: v.id === 'correct'
  }));
  const correctOption = options.find(o => o.isCorrect);

  return {
    brand: base.brand,
    options: options.map(({ optionId, svg }) => ({ optionId, svg })),
    correctOptionId: correctOption.optionId
  };
}

module.exports = { generateLogoChallenge, PALETTE, renderLogoSvg };
