/**
 * FSRS v4/v5 Spaced Repetition Scheduler
 * Pure Vanilla ES Module — zero dependencies.
 */

export const RATINGS = Object.freeze({
  AGAIN: 1,
  HARD: 2,
  GOOD: 3,
  EASY: 4,
});

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Standard FSRS v4/v5 17-parameter weight vector.
 */
const W = Object.freeze([
  0.4,  // w[0]: initial stability for Again
  0.6,  // w[1]: initial stability for Hard
  2.4,  // w[2]: initial stability for Good
  5.8,  // w[3]: initial stability for Easy
  4.93, // w[4]: initial difficulty baseline
  0.94, // w[5]: initial difficulty grade scaling
  0.86, // w[6]: difficulty update step
  0.01, // w[7]: difficulty mean reversion weight
  1.49, // w[8]: recall stability factor
  0.14, // w[9]: recall stability decay on S
  0.94, // w[10]: recall stability gain on (1 - R)
  2.18, // w[11]: lapse stability base
  0.05, // w[12]: lapse stability D exponent
  0.34, // w[13]: lapse stability S exponent
  1.26, // w[14]: lapse stability (1 - R) gain
  0.29, // w[15]: hard penalty
  2.61, // w[16]: easy bonus
]);

const RATING_NAMES = Object.freeze({
  [RATINGS.AGAIN]: 'Again',
  [RATINGS.HARD]: 'Hard',
  [RATINGS.GOOD]: 'Good',
  [RATINGS.EASY]: 'Easy',
});

/**
 * Clamp a numeric value to [min, max].
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Compute initial stability S0(G) for a given rating (1..4).
 * @param {number} rating
 * @returns {number}
 */
function initialStability(rating) {
  const index = clamp(Math.round(rating) - 1, 0, 3);
  return W[index];
}

/**
 * Compute initial difficulty D0(G) clamped to [1, 10].
 * @param {number} rating
 * @returns {number}
 */
function initialDifficulty(rating) {
  const raw = W[4] - Math.exp(W[5] * (rating - 1)) + 1;
  return clamp(raw, 1, 10);
}

/**
 * Compute updated difficulty with mean reversion toward D0(4).
 * @param {number} difficulty
 * @param {number} rating
 * @returns {number}
 */
function nextDifficulty(difficulty, rating) {
  const target = initialDifficulty(RATINGS.EASY);
  const delta = difficulty - W[6] * (rating - 3);
  const reverted = W[7] * target + (1 - W[7]) * delta;
  return clamp(reverted, 1, 10);
}

/**
 * Compute FSRS power-law retrievability R in (0, 1].
 * @param {number} elapsedDays
 * @param {number} stability
 * @returns {number}
 */
function computeRetrievability(elapsedDays, stability) {
  if (stability <= 0 || elapsedDays <= 0) return 1;
  return Math.pow(1 + (19 / 81) * (elapsedDays / stability), -0.5);
}

/**
 * Compute post-recall stability for Hard / Good / Easy.
 * @param {number} difficulty
 * @param {number} stability
 * @param {number} retrievability
 * @param {number} rating
 * @returns {number}
 */
function nextRecallStability(difficulty, stability, retrievability, rating) {
  const hardPenalty = rating === RATINGS.HARD ? W[15] : 1;
  const easyBonus = rating === RATINGS.EASY ? W[16] : 1;
  const growth =
    Math.exp(W[8]) *
    (11 - difficulty) *
    Math.pow(Math.max(0.1, stability), -W[9]) *
    (Math.exp(W[10] * (1 - retrievability)) - 1) *
    hardPenalty *
    easyBonus;
  return Math.max(0.1, stability * (growth + 1));
}

/**
 * Compute post-lapse stability when rating === AGAIN on a reviewed card.
 * @param {number} difficulty
 * @param {number} stability
 * @param {number} retrievability
 * @returns {number}
 */
function nextForgetStability(difficulty, stability, retrievability) {
  const raw =
    W[11] *
    Math.pow(clamp(difficulty, 1, 10), -W[12]) *
    (Math.pow(Math.max(0.1, stability) + 1, W[13]) - 1) *
    Math.exp(W[14] * (1 - retrievability));
  return clamp(raw, 0.1, Math.max(0.1, stability));
}

/**
 * Create the initial FSRS metadata object for a brand-new card.
 * @param {number} [now=Date.now()]
 * @returns {{ stability: number, difficulty: number, reps: number, lapses: number, state: string, dueDate: number, lastReview: number|null }}
 */
export function createInitialFSRS(now = Date.now()) {
  return {
    stability: 0,
    difficulty: 0,
    reps: 0,
    lapses: 0,
    state: 'new',
    dueDate: now,
    lastReview: null,
  };
}

/**
 * Format an interval expressed in days into a compact human-readable label.
 * @param {number} days
 * @returns {string}
 */
export function formatInterval(days) {
  if (!Number.isFinite(days) || days <= 0) return '1m';
  if (days < 1 / 24) {
    const minutes = Math.max(1, Math.round(days * 24 * 60));
    if (minutes < 60) return `${minutes}m`;
    return '1h';
  }
  if (days < 1) {
    const hours = Math.max(1, Math.round(days * 24));
    if (hours < 24) return `${hours}h`;
    return '1d';
  }
  if (days < 30) {
    const roundedDays = Math.max(1, Math.round(days));
    if (roundedDays < 30) return `${roundedDays}d`;
    return '1mo';
  }
  if (days < 365) {
    const months = Number((days / 30).toFixed(1));
    return `${months}mo`;
  }
  const years = Number((days / 365).toFixed(1));
  return `${years}y`;
}

/**
 * Check whether a card is currently due for study.
 * @param {object} card
 * @param {number} [now=Date.now()]
 * @returns {boolean}
 */
export function isCardDue(card, now = Date.now()) {
  return !card?.fsrs?.dueDate || card.fsrs.dueDate <= now;
}

/**
 * Ensure progressive day intervals for Hard < Good < Easy so button labels stay distinct.
 * @param {number} baseDays
 * @param {number} minDays
 * @returns {number}
 */
function ensureDistinctIntervalDays(baseDays, minDays) {
  let candidate = Math.max(minDays, Math.round(baseDays));
  const minLabel = formatInterval(minDays);
  // Step forward if rounding produced the same display label as the lower rating.
  let guard = 0;
  while (formatInterval(candidate) === minLabel && guard < 40) {
    const step = candidate < 30 ? 1 : candidate < 365 ? 3 : 37;
    candidate += step;
    guard += 1;
  }
  return candidate;
}

/**
 * Schedule the next FSRS state for a card given a rating (1..4).
 * @param {object} fsrsState
 * @param {number} rating
 * @param {number} [now=Date.now()]
 * @returns {{ nextFsrs: object, intervalDays: number, intervalLabel: string }}
 */
export function scheduleCard(fsrsState, rating, now = Date.now()) {
  const prev = fsrsState ? { ...createInitialFSRS(now), ...fsrsState } : createInitialFSRS(now);
  const validRating = clamp(Math.round(Number(rating) || RATINGS.GOOD), 1, 4);
  const prevState = prev.state || 'new';
  const prevReps = Number(prev.reps || 0);
  const prevLapses = Number(prev.lapses || 0);

  let stability;
  let difficulty;
  let nextState;
  let intervalDays;
  let lapses = prevLapses;

  if (prevState === 'new' || prevReps === 0 || !prev.stability) {
    stability = initialStability(validRating);
    difficulty = initialDifficulty(validRating);

    if (validRating === RATINGS.AGAIN) {
      nextState = 'learning';
      intervalDays = 1 / 1440; // 1 minute
    } else if (validRating === RATINGS.HARD) {
      nextState = 'learning';
      intervalDays = 10 / 1440; // 10 minutes
    } else if (validRating === RATINGS.GOOD) {
      nextState = 'review';
      intervalDays = Math.max(1, Math.round(W[2])); // ~2d
    } else {
      nextState = 'review';
      intervalDays = Math.max(4, Math.round(W[3])); // ~6d
    }
  } else if (prevState === 'learning' || prevState === 'relearning') {
    const elapsedDays = prev.lastReview ? Math.max(0, (now - prev.lastReview) / MS_PER_DAY) : 0;
    const prevD = prev.difficulty > 0 ? prev.difficulty : initialDifficulty(RATINGS.GOOD);
    const prevS = Math.max(0.1, prev.stability);
    const retrievability = computeRetrievability(elapsedDays, prevS);

    difficulty = nextDifficulty(prevD, validRating);

    if (validRating === RATINGS.AGAIN) {
      stability = Math.max(0.1, Math.min(prevS, W[0]));
      nextState = prevState;
      intervalDays = prevState === 'relearning' ? 10 / 1440 : 5 / 1440;
    } else if (validRating === RATINGS.HARD) {
      stability = Math.max(0.4, nextRecallStability(difficulty, prevS, retrievability, RATINGS.HARD));
      nextState = prevState;
      intervalDays = 0.5; // 12 hours
    } else if (validRating === RATINGS.GOOD) {
      const sGood = nextRecallStability(difficulty, prevS, retrievability, RATINGS.GOOD);
      stability = Math.max(1, sGood);
      nextState = 'review';
      intervalDays = Math.max(1, Math.round(stability));
    } else {
      const sGood = Math.max(1, nextRecallStability(difficulty, prevS, retrievability, RATINGS.GOOD));
      const sEasy = nextRecallStability(difficulty, prevS, retrievability, RATINGS.EASY);
      stability = Math.max(W[3], sEasy);
      nextState = 'review';
      const goodDays = Math.max(1, Math.round(sGood));
      intervalDays = ensureDistinctIntervalDays(Math.max(stability, goodDays + 2), goodDays);
    }
  } else {
    // 'review' state
    const elapsedDays = prev.lastReview ? Math.max(0, (now - prev.lastReview) / MS_PER_DAY) : prev.stability;
    const prevD = prev.difficulty > 0 ? prev.difficulty : initialDifficulty(RATINGS.GOOD);
    const prevS = Math.max(0.1, prev.stability);
    const retrievability = computeRetrievability(elapsedDays, prevS);

    difficulty = nextDifficulty(prevD, validRating);

    if (validRating === RATINGS.AGAIN) {
      lapses += 1;
      stability = nextForgetStability(difficulty, prevS, retrievability);
      nextState = 'relearning';
      intervalDays = 10 / 1440; // 10 minutes
    } else {
      nextState = 'review';
      const sHard = nextRecallStability(difficulty, prevS, retrievability, RATINGS.HARD);
      const sGood = nextRecallStability(difficulty, prevS, retrievability, RATINGS.GOOD);
      const sEasy = nextRecallStability(difficulty, prevS, retrievability, RATINGS.EASY);

      const hardDays = Math.max(1, Math.round(sHard));
      const goodDays = ensureDistinctIntervalDays(sGood, hardDays);
      const easyDays = ensureDistinctIntervalDays(sEasy, goodDays);

      if (validRating === RATINGS.HARD) {
        stability = sHard;
        intervalDays = hardDays;
      } else if (validRating === RATINGS.GOOD) {
        stability = sGood;
        intervalDays = goodDays;
      } else {
        stability = sEasy;
        intervalDays = easyDays;
      }
    }
  }

  const nextFsrs = {
    stability: Number(stability.toFixed(4)),
    difficulty: Number(difficulty.toFixed(4)),
    reps: prevReps + 1,
    lapses,
    state: nextState,
    dueDate: now + Math.round(intervalDays * MS_PER_DAY),
    lastReview: now,
  };

  return {
    nextFsrs,
    intervalDays,
    intervalLabel: formatInterval(intervalDays),
  };
}

/**
 * Preview scheduling outcomes across all 4 FSRS ratings for study UI buttons.
 * @param {object} fsrsState
 * @param {number} [now=Date.now()]
 * @returns {Record<number, { rating: number, name: string, label: string, nextFsrs: object }>}
 */
export function previewAllRatings(fsrsState, now = Date.now()) {
  const preview = {};
  for (const rating of [RATINGS.AGAIN, RATINGS.HARD, RATINGS.GOOD, RATINGS.EASY]) {
    const { nextFsrs, intervalLabel } = scheduleCard(fsrsState, rating, now);
    preview[rating] = {
      rating,
      name: RATING_NAMES[rating],
      label: intervalLabel,
      nextFsrs,
    };
  }
  return preview;
}
