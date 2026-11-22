/**
 * Study History Analytics & Dashboard Renderer
 * Pure Vanilla ES Module — zero external dependencies.
 */

const SESSION_GAP_MS = 20 * 60 * 1000; // 20 minutes

/**
 * Escape untrusted strings before interpolating into HTML.
 * @param {string} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Format a timestamp into a local YYYY-MM-DD calendar day key.
 * @param {number} timestamp
 * @returns {string}
 */
function toLocalDateKey(timestamp) {
  const d = new Date(timestamp);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Format a duration in milliseconds into a compact human-readable string.
 * Examples: "0s", "4s", "1m 23s", "1h 5m".
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

/**
 * Compute summary KPIs, 14-day daily buckets, and grouped study sessions from reviewLogs.
 * @param {Array<object>} [reviewLogs=[]]
 * @param {Array<object>} [decks=[]]
 * @param {number} [now=Date.now()]
 * @returns {{
 *   reviewedToday: number,
 *   streakDays: number,
 *   totalReviews: number,
 *   overallAccuracy: number,
 *   last14Days: Array<{ dateKey: string, label: string, count: number, accuracy: number }>,
 *   sessions: Array<{ id: string, deckId: string, deckName: string, startTime: number, endTime: number, count: number, passCount: number, accuracy: number, totalDurationMs: number }>
 * }}
 */
export function computeAnalytics(reviewLogs = [], decks = [], now = Date.now()) {
  const logs = Array.isArray(reviewLogs) ? reviewLogs : [];
  const deckMap = new Map(
    (Array.isArray(decks) ? decks : []).map((d) => [d.id, d.name || 'Untitled Deck'])
  );

  // Aggregate logs per local calendar day
  const dailyMap = new Map();
  let totalPass = 0;

  for (const log of logs) {
    const ts = Number(log?.timestamp);
    if (!Number.isFinite(ts)) continue;
    const key = toLocalDateKey(ts);
    const passed = Number(log?.rating) >= 2;
    if (passed) totalPass += 1;

    let bucket = dailyMap.get(key);
    if (!bucket) {
      bucket = { count: 0, passCount: 0 };
      dailyMap.set(key, bucket);
    }
    bucket.count += 1;
    if (passed) bucket.passCount += 1;
  }

  const nowDate = new Date(now);
  const todayKey = toLocalDateKey(now);
  const reviewedToday = dailyMap.get(todayKey)?.count || 0;

  // Compute current streak in local days (count from today if studied today, otherwise from yesterday)
  let streakDays = 0;
  const startOffset = reviewedToday > 0 ? 0 : 1;
  for (let offset = startOffset; offset < 3650; offset += 1) {
    const dayNoon = new Date(
      nowDate.getFullYear(),
      nowDate.getMonth(),
      nowDate.getDate() - offset,
      12,
      0,
      0
    );
    const key = toLocalDateKey(dayNoon.getTime());
    if ((dailyMap.get(key)?.count || 0) > 0) {
      streakDays += 1;
    } else {
      break;
    }
  }

  const totalReviews = logs.length;
  const overallAccuracy =
    totalReviews > 0 ? Math.round((totalPass / totalReviews) * 100) : 0;

  // Build 14-day window from 13 days ago up to today (inclusive)
  const last14Days = [];
  for (let offset = 13; offset >= 0; offset -= 1) {
    const dayNoon = new Date(
      nowDate.getFullYear(),
      nowDate.getMonth(),
      nowDate.getDate() - offset,
      12,
      0,
      0
    );
    const dateKey = toLocalDateKey(dayNoon.getTime());
    const label = `${dayNoon.getMonth() + 1}/${dayNoon.getDate()}`;
    const bucket = dailyMap.get(dateKey);
    const count = bucket ? bucket.count : 0;
    const accuracy = count > 0 ? Math.round((bucket.passCount / count) * 100) : 0;

    last14Days.push({
      dateKey,
      label,
      count,
      accuracy,
    });
  }

  // Group sorted review logs into study sessions (same deck, <= 20m gap, same local day)
  const sortedLogs = [...logs]
    .filter((l) => Number.isFinite(Number(l?.timestamp)))
    .sort((a, b) => Number(a.timestamp) - Number(b.timestamp));

  const sessions = [];
  let current = null;

  for (const log of sortedLogs) {
    const ts = Number(log.timestamp);
    const dateKey = toLocalDateKey(ts);
    const deckId = String(log.deckId || '');
    const rating = Number(log.rating) || 1;
    const durationMs = Math.max(0, Number(log.durationMs) || 0);
    const passed = rating >= 2;

    const startsNewSession =
      !current ||
      current.deckId !== deckId ||
      current.dateKey !== dateKey ||
      ts - current.endTime > SESSION_GAP_MS;

    if (startsNewSession) {
      current = {
        id: `session-${sessions.length + 1}-${ts}`,
        deckId,
        deckName: deckMap.get(deckId) || 'Deleted Deck',
        dateKey,
        startTime: ts,
        endTime: ts,
        count: 0,
        passCount: 0,
        accuracy: 0,
        totalDurationMs: 0,
      };
      sessions.push(current);
    }

    current.endTime = ts;
    current.count += 1;
    if (passed) current.passCount += 1;
    current.totalDurationMs += durationMs;
    current.accuracy = Math.round((current.passCount / current.count) * 100);
  }

  // Strip internal dateKey helper and sort newest session first
  const formattedSessions = sessions
    .map(({ dateKey: _dateKey, ...session }) => session)
    .sort((a, b) => b.startTime - a.startTime);

  return {
    reviewedToday,
    streakDays,
    totalReviews,
    overallAccuracy,
    last14Days,
    sessions: formattedSessions,
  };
}

/**
 * Format a session start timestamp into a concise local date & time string.
 * @param {number} timestamp
 * @returns {string}
 */
function formatSessionDateTime(timestamp) {
  try {
    return new Date(timestamp).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return new Date(timestamp).toISOString();
  }
}

/**
 * Classify an accuracy percentage for semantic badge styling.
 * @param {number} accuracy
 * @returns {string}
 */
function accuracyTierClass(accuracy) {
  if (accuracy >= 85) return 'accuracy-high';
  if (accuracy >= 65) return 'accuracy-mid';
  return 'accuracy-low';
}

/**
 * Render the History Analytics Dashboard (KPI cards, 14-day chart, session table)
 * into the target container element.
 * @param {HTMLElement} containerEl
 * @param {Array<object>} [reviewLogs=[]]
 * @param {Array<object>} [decks=[]]
 */
export function renderHistoryDashboard(containerEl, reviewLogs = [], decks = []) {
  if (!containerEl) return;

  const analytics = computeAnalytics(reviewLogs, decks);
  const maxDayCount = Math.max(
    1,
    ...analytics.last14Days.map((day) => day.count)
  );
  const todayKey = toLocalDateKey(Date.now());

  const barsHtml = analytics.last14Days
    .map((day) => {
      const heightPct =
        day.count > 0 ? Math.max(8, Math.round((day.count / maxDayCount) * 100)) : 0;
      const isToday = day.dateKey === todayKey;
      const tooltip = escapeHtml(
        `${day.label}: ${day.count} review${day.count === 1 ? '' : 's'}${
          day.count > 0 ? ` (${day.accuracy}% accuracy)` : ''
        }`
      );

      return `
        <div class="bar-col${isToday ? ' bar-col--today' : ''}" title="${tooltip}">
          <span class="bar-value">${day.count > 0 ? day.count : ''}</span>
          <div class="bar-track" style="flex:1;width:100%;display:flex;align-items:flex-end;justify-content:center;min-height:120px;">
            <div class="bar-fill${day.count === 0 ? ' bar-fill--empty' : ''}" style="height:${heightPct}%;"></div>
          </div>
          <span class="bar-label">${escapeHtml(day.label)}</span>
        </div>
      `;
    })
    .join('');

  const sessionsHtml =
    analytics.sessions.length === 0
      ? `
        <div class="empty-state">
          <p>No study sessions recorded yet. Start studying any deck to track your daily progress and retention.</p>
        </div>
      `
      : `
        <div class="history-table-scroll">
          <table class="history-table">
            <thead>
              <tr>
                <th>Date &amp; Time</th>
                <th>Deck</th>
                <th>Cards Reviewed</th>
                <th>Accuracy %</th>
                <th>Time Spent</th>
              </tr>
            </thead>
            <tbody>
              ${analytics.sessions
                .map(
                  (session) => `
                  <tr>
                    <td>${escapeHtml(formatSessionDateTime(session.startTime))}</td>
                    <td class="history-deck-cell">${escapeHtml(session.deckName)}</td>
                    <td>${session.count}</td>
                    <td>
                      <span class="accuracy-badge ${accuracyTierClass(session.accuracy)}">
                        ${session.accuracy}%
                      </span>
                    </td>
                    <td>${escapeHtml(formatDuration(session.totalDurationMs))}</td>
                  </tr>
                `
                )
                .join('')}
            </tbody>
          </table>
        </div>
      `;

  containerEl.innerHTML = `
    <div class="kpi-grid">
      <div class="kpi-card">
        <span class="kpi-label">Reviewed Today</span>
        <strong class="kpi-value">${analytics.reviewedToday}</strong>
        <span class="kpi-sub">cards studied today</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">Current Streak</span>
        <strong class="kpi-value">${analytics.streakDays} ${
    analytics.streakDays === 1 ? 'day' : 'days'
  }</strong>
        <span class="kpi-sub">consecutive active days</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">Total Reviews</span>
        <strong class="kpi-value">${analytics.totalReviews}</strong>
        <span class="kpi-sub">all-time card reviews</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">Overall Accuracy</span>
        <strong class="kpi-value">${analytics.overallAccuracy}%</strong>
        <span class="kpi-sub">Hard, Good &amp; Easy pass rate</span>
      </div>
    </div>

    <section class="chart-card">
      <div class="chart-header">
        <h3>14-Day Review Activity</h3>
        <span class="chart-subtitle">Daily review volume &amp; retention tooltips</span>
      </div>
      <div class="bar-chart" role="img" aria-label="14-day review activity bar chart">
        ${barsHtml}
      </div>
    </section>

    <section class="history-table-wrap">
      <div class="history-table-header">
        <h3>Study Sessions History</h3>
        <span class="history-session-count">${analytics.sessions.length} session${
    analytics.sessions.length === 1 ? '' : 's'
  }</span>
      </div>
      ${sessionsHtml}
    </section>
  `;
}
