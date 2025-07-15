/**
 * rewards.js – match-result → MMR update logic
 * -------------------------------------------------
 *  ✦ Elo-style adjustment using team-average MMR.
 *  ✦ Underdogs gain more, favourites gain less (or lose more).
 *  ✦ Per-user win/lose record, live streak & last-10 buffer.
 *
 *  Public API:
 *    • processMatch({ team1Ids, team2Ids, winner, chalked })
 *    • adjustMMR(winningIds, losingIds)
 *    • adjustMMRForTie(allIds)
 *    • getLeaderboardLines(limit = 10)     // “1. @user — 123 MMR (24-10)”
 */

const admin = require('firebase-admin'); // already initialised in index.js
const db    = admin.firestore();

const DEFAULT_MMR = 100;  // new users start here (was 1000)
const BASE_K      = 32;   // Elo “K-factor”

/* ────────────────────────── low-level helpers ────────────────────────── */

async function getUser(uid) {
  const snap = await db.collection('users').doc(uid).get();
  return snap.exists
    ? snap.data()
    : { mmr: DEFAULT_MMR, wins: 0, losses: 0, streak: 0, last10: [] };
}

function expectedScore(mmrA, mmrB) {
  return 1 / (1 + Math.pow(10, (mmrB - mmrA) / 400));
}

function clamp(num, lo, hi) {
  return Math.max(lo, Math.min(hi, num));
}

/* ─────────────────────────── main entry point ────────────────────────── */

/**
 * @param {Object}   opts
 * @param {string[]} opts.team1Ids – Discord user IDs for team 1
 * @param {string[]} opts.team2Ids – Discord user IDs for team 2
 * @param {1|2|null} opts.winner   – 1 or 2 for winner; null for tie
 * @param {boolean}  opts.chalked  – true → no MMR updates
 */
async function processMatch({ team1Ids, team2Ids, winner, chalked = false }) {
  if (chalked || !winner) return;

  const t1 = [...new Set(team1Ids)];
  const t2 = [...new Set(team2Ids)];

  const users = {};
  await Promise.all(
    [...t1, ...t2].map(async uid => {
      users[uid] = await getUser(uid);
    })
  );

  const avg1 = t1.reduce((sum, id) => sum + users[id].mmr, 0) / t1.length;
  const avg2 = t2.reduce((sum, id) => sum + users[id].mmr, 0) / t2.length;
  const exp1 = expectedScore(avg1, avg2);
  const exp2 = 1 - exp1;

  const delta1 = winner === 1
    ? BASE_K * (1 - exp1)
    : -BASE_K * exp1;
  const delta2 = winner === 2
    ? BASE_K * (1 - exp2)
    : -BASE_K * exp2;

  const batch = db.batch();

  function writeResult(uid, won, deltaMMR) {
    const ref = db.collection('users').doc(uid);
    const u   = users[uid];

    const newStreak = won
      ? (u.streak > 0 ? u.streak + 1 : 1)
      : (u.streak < 0 ? u.streak - 1 : -1);

    const last10 = [won ? 'W' : 'L', ...u.last10].slice(0, 10);

    batch.set(ref, {
      mmr   : Math.round(u.mmr + deltaMMR),
      wins  : u.wins   + (won ? 1 : 0),
      losses: u.losses + (won ? 0 : 1),
      streak: newStreak,
      last10
    }, { merge: true });
  }

  t1.forEach(uid => writeResult(uid, winner === 1, delta1));
  t2.forEach(uid => writeResult(uid, winner === 2, delta2));

  await batch.commit();
}

/* ────────────────────── convenience wrappers ────────────────────── */

async function adjustMMR(winningIds, losingIds) {
  await processMatch({
    team1Ids: winningIds,
    team2Ids: losingIds,
    winner:   1,
    chalked:  false
  });
}

async function adjustMMRForTie(allIds) {
  await processMatch({
    team1Ids: allIds,
    team2Ids: [],
    winner:   null,
    chalked:  false
  });
}

async function getLeaderboardLines(limit = 10) {
  const ss = await db
    .collection('users')
    .orderBy('mmr', 'desc')
    .limit(limit)
    .get();

  return ss.docs.map((d, i) => {
    const { wins = 0, losses = 0, mmr = DEFAULT_MMR } = d.data();
    const rec = `${wins}-${losses}`;
    return `\`${String(i + 1).padStart(2)}.\` <@${d.id}> — **${mmr} MMR**  (${rec})`;
  });
}

module.exports = {
  processMatch,
  adjustMMR,
  adjustMMRForTie,
  getLeaderboardLines
};
