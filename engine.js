// ── BIS INTERHOUSE BADMINTON — RESULTS ENGINE ───────────────────────
// Pure logic, no DOM, no network. The SAME file runs in three places:
//   • the website (browser)            → global BADM
//   • the Google Apps Script backend   → global BADM (pasted into Code.gs)
//   • the local test suite (Node)      → module.exports
// so the site, the admin page and the server can never disagree about
// who plays whom, who won, or how many points a house has.
//
// Input `data` (all values are strings, exactly as the Sheet shows them):
//   config:     { key: value }
//   categories: [{ category, session, dispersal, status, note }]
//   players:    [{ category, name, house }]
//   matches:    [{ match_id, category, match_no, round, player_a, player_b,
//                  winner, outcome, winner_pts, loser_pts, updated_at }]

var BADM = (function () {
  'use strict';

  var HOUSES = ['Alpha', 'Beta', 'Gamma'];
  var ROUND_ORDER = { r1: 1, r2: 2, qf: 3, sf: 4, f: 5, '3p': 6, other: 7 };
  var ROUND_LABEL = { r1: 'Round 1', r2: 'Round 2', qf: 'Quarter-final', sf: 'Semi-final', f: 'Final', '3p': '3rd Place', other: 'Match' };

  // ── small helpers ──────────────────────────────────────────────────
  function str(v) { return v === null || v === undefined ? '' : String(v); }
  function norm(v) { return str(v).replace(/\s+/g, ' ').trim(); }
  function key(v) { return norm(v).toLowerCase(); }

  function normHouse(h) {
    var k = key(h);
    if (k === 'alpha') return 'Alpha';
    if (k === 'beta') return 'Beta';
    if (k === 'gamma') return 'Gamma';
    return '';
  }

  function yes(v) { return /^(y|yes|true|1|on)$/i.test(norm(v)); }

  function toInt(v) {
    var s = norm(v);
    if (s === '') return null;
    if (!/^\d+$/.test(s)) return NaN;
    return parseInt(s, 10);
  }

  function roundKey(r) {
    var k = key(r);
    if (/3rd|third|bronze/.test(k)) return '3p';
    if (/semi/.test(k)) return 'sf';
    if (/quarter/.test(k)) return 'qf';
    if (/final/.test(k)) return 'f';
    if (/round\s*2|^r2$/.test(k)) return 'r2';
    if (/round\s*1|^r1$|prelim/.test(k)) return 'r1';
    return 'other';
  }

  function outcomeKey(o) {
    var k = key(o);
    if (!k) return '';
    if (/double|both|neither/.test(k)) return 'double';
    if (/walk|^w\s*\/?\s*o$/.test(k)) return 'walkover';
    return 'unknown';
  }

  // "Winner of M5", "Loser of M8", "winner m5", "Winner of Match 5"
  function parseRef(s) {
    var m = norm(s).match(/^(winner|loser)\s+(?:of\s+)?(?:m(?:atch)?\s*)?#?\s*([a-z0-9]+)$/i);
    if (!m) return null;
    return { kind: m[1].toLowerCase() === 'winner' ? 'W' : 'L', no: m[2].toUpperCase() };
  }

  function matchLabel(no, rk) {
    if (rk === '3p') return '3rd Place';
    if (rk === 'f') return 'Final';
    return 'M' + no;
  }

  // Parse "U10 Boys" → { age: 10, gender: 'Boys' } (for sorting)
  function catSortKey(name) {
    var m = norm(name).match(/^u\s*(\d+)\s+(boys|girls)/i);
    if (!m) return [999, 9, key(name)];
    return [parseInt(m[1], 10), m[2].toLowerCase() === 'boys' ? 0 : 1, ''];
  }
  function cmpCat(a, b) {
    var ka = catSortKey(a), kb = catSortKey(b);
    return ka[0] - kb[0] || ka[1] - kb[1] || (ka[2] < kb[2] ? -1 : ka[2] > kb[2] ? 1 : 0);
  }

  // ── score rules (from the rules sheet) ─────────────────────────────
  // Prelims: 1 game to 11, no extension (next point at 10-10 wins).
  // Semis:   1 game to 15, no extension (next point at 14-14 wins).
  // Final:   1 game to 15, setting to 17 at 14-14.
  // 3rd place: not specified — accept either the 11 or the 15 format.
  // Returns { ok:false, error } for impossible input, or { ok:true, warn? }.
  function checkScore(rk, w, l) {
    var hasW = w !== null && w !== undefined && w !== '';
    var hasL = l !== null && l !== undefined && l !== '';
    if (!hasW && !hasL) return { ok: true, empty: true };
    if (!hasW || !hasL) return { ok: false, error: 'Enter both scores, or leave both empty.' };
    w = Number(w); l = Number(l);
    if (!isFinite(w) || !isFinite(l) || w % 1 !== 0 || l % 1 !== 0 || w < 0 || l < 0 || w > 30 || l > 30) {
      return { ok: false, error: 'Scores must be whole numbers between 0 and 30.' };
    }
    if (w <= l) return { ok: false, error: "The winner's score must be higher than the loser's." };
    var to11 = (w === 11 && l <= 10);
    var to15 = (w === 15 && l <= 14);
    var fin = (w === 15 && l <= 13) || (w === 17 && l >= 14 && l <= 16);
    var fine = rk === 'sf' ? to15 : rk === 'f' ? fin : rk === '3p' ? (to11 || to15) : rk === 'other' ? true : to11;
    if (fine) return { ok: true };
    var rule = rk === 'sf' ? 'Semi-finals are 1 game to 15 (no extension)'
             : rk === 'f' ? 'The final is 1 game to 15, setting to 17 at 14-14'
             : rk === '3p' ? 'The 3rd place match should be to 11 or to 15'
             : 'This round is 1 game to 11 (no extension)';
    return { ok: true, warn: rule + ', but you entered ' + w + '-' + l + '.' };
  }

  // ── the main build ─────────────────────────────────────────────────
  function build(data) {
    data = data || {};
    var cfgRaw = data.config || {};
    var issues = [];
    function issue(level, category, msg) { issues.push({ level: level, category: category || '', msg: msg }); }

    var pts = [toInt(cfgRaw.points_1st), toInt(cfgRaw.points_2nd), toInt(cfgRaw.points_3rd)];
    var defaults = [5, 3, 1];
    for (var pi = 0; pi < 3; pi++) {
      if (pts[pi] === null || isNaN(pts[pi])) {
        if (norm([cfgRaw.points_1st, cfgRaw.points_2nd, cfgRaw.points_3rd][pi]) !== '') {
          issue('error', '', 'Config points_' + ['1st', '2nd', '3rd'][pi] + ' is not a whole number; using ' + defaults[pi] + '.');
        }
        pts[pi] = defaults[pi];
      }
    }
    var config = {
      title: norm(cfgRaw.event_title) || 'BIS Interhouse Badminton Championship',
      date: norm(cfgRaw.event_date),
      venue: norm(cfgRaw.venue),
      notice: norm(cfgRaw.notice),
      points: pts,
      singleEntryPoints: norm(cfgRaw.single_entry_points) === '' ? true : yes(cfgRaw.single_entry_points)
    };

    // categories (sheet order = schedule order)
    var cats = [], byName = {};
    function getCat(name, fromSheet) {
      var k = key(name);
      if (byName[k]) return byName[k];
      var c = {
        name: norm(name), key: k, order: cats.length,
        session: '', dispersal: '', status: '', postponed: false, note: '',
        players: [], matches: [], playersByKey: {}, inSheet: !!fromSheet
      };
      byName[k] = c; cats.push(c);
      return c;
    }
    (data.categories || []).forEach(function (r) {
      if (!norm(r.category)) return;
      if (byName[key(r.category)]) { issue('warn', norm(r.category), 'Category listed twice in the Categories tab.'); return; }
      var c = getCat(r.category, true);
      c.session = norm(r.session);
      c.dispersal = norm(r.dispersal);
      c.status = norm(r.status).toUpperCase();
      c.postponed = /postpon/i.test(c.status);
      c.note = norm(r.note);
    });

    // players
    (data.players || []).forEach(function (r) {
      var name = norm(r.name);
      if (!name || !norm(r.category)) return;
      var c = getCat(r.category, false);
      if (!c.inSheet && !c.warned) { c.warned = true; issue('warn', c.name, 'Category "' + c.name + '" is not in the Categories tab.'); }
      var pk = key(name);
      if (c.playersByKey[pk]) { issue('error', c.name, name + ' is listed twice in Players.'); return; }
      var house = normHouse(r.house);
      if (norm(r.house) && !house) issue('error', c.name, name + ': house "' + norm(r.house) + '" is not Alpha, Beta or Gamma.');
      var p = { name: name, key: pk, house: house, inDraw: 0 };
      c.playersByKey[pk] = p;
      c.players.push(p);
    });

    // matches
    var matchById = {};
    (data.matches || []).forEach(function (r, idx) {
      if (!norm(r.category) || !norm(r.match_no)) return;
      var c = getCat(r.category, false);
      if (!c.inSheet && !c.warned) { c.warned = true; issue('warn', c.name, 'Category "' + c.name + '" is not in the Categories tab.'); }
      var no = norm(r.match_no).toUpperCase().replace(/^M/, '');
      var rk = roundKey(r.round);
      var id = norm(r.match_id) || (c.name.replace(/\s+/g, '') + '-' + no);
      if (matchById[id]) { issue('error', c.name, 'Duplicate match_id ' + id + '.'); return; }
      for (var i = 0; i < c.matches.length; i++) {
        if (c.matches[i].no === no) { issue('error', c.name, 'Match number ' + no + ' appears twice.'); return; }
      }
      var m = {
        id: id, no: no, category: c.name, round: norm(r.round) || ROUND_LABEL[rk], rk: rk,
        label: matchLabel(no, rk), srcA: norm(r.player_a), srcB: norm(r.player_b),
        stored: {
          winner: norm(r.winner), outcome: outcomeKey(r.outcome), outcomeRaw: norm(r.outcome),
          wPts: toInt(r.winner_pts), lPts: toInt(r.loser_pts), updatedAt: norm(r.updated_at)
        },
        seq: idx
      };
      m.hasStored = !!(m.stored.winner || m.stored.outcome);
      if (m.stored.outcome === 'unknown') issue('error', c.name, m.label + ': outcome "' + m.stored.outcomeRaw + '" not recognised (use blank, WALKOVER or DOUBLE WALKOVER).');
      c.matches.push(m);
      matchById[id] = m;
    });

    // resolve every bracket
    cats.forEach(function (c) {
      var byNo = {};
      c.matches.forEach(function (m) { byNo[m.no] = m; });
      var visiting = {};

      function side(src, m) {
        if (!src) return { type: 'none', why: 'bye', label: 'Bye' };
        var ref = parseRef(src);
        if (ref) {
          var tgt = byNo[ref.no];
          var lbl = (ref.kind === 'W' ? 'Winner of ' : 'Loser of ') + (tgt ? tgt.label : 'M' + ref.no);
          if (!tgt) {
            issue('error', c.name, m.label + ' refers to M' + ref.no + ', which does not exist.');
            return { type: 'pending', ref: ref, label: lbl, broken: true };
          }
          resolve(tgt);
          if (!tgt.decided) return { type: 'pending', ref: ref, label: lbl, from: tgt.id };
          var s = ref.kind === 'W' ? tgt.winner : tgt.loser;
          if (s && s.type === 'player') return { type: 'player', name: s.name, key: s.key, house: s.house, via: lbl };
          return { type: 'none', why: 'noplayer', label: 'No player', via: lbl };
        }
        var p = c.playersByKey[key(src)];
        if (!p) {
          issue('error', c.name, '"' + src + '" (' + m.label + ') is not in the Players tab for ' + c.name + '.');
          return { type: 'player', name: src, key: key(src), house: '', unknown: true };
        }
        p.inDraw++;
        return { type: 'player', name: p.name, key: p.key, house: p.house };
      }

      function resolve(m) {
        if (m.resolved) return;
        if (visiting[m.id]) {
          issue('error', c.name, m.label + ' is part of a circular reference.');
          m.a = m.a || { type: 'pending', label: '?' }; m.b = m.b || { type: 'pending', label: '?' };
          m.decided = false; m.status = 'waiting'; m.resolved = true;
          return;
        }
        visiting[m.id] = true;
        var a = side(m.srcA, m), b = side(m.srcB, m);
        m.a = a; m.b = b;
        m.decided = false; m.winner = null; m.loser = null; m.winSide = null; m.how = null;
        m.wPts = null; m.lPts = null; m.problem = '';
        var st = m.stored;
        var sidesKnown = a.type !== 'pending' && b.type !== 'pending';

        if (m.hasStored && !sidesKnown) {
          m.problem = 'Has a saved result but its players are not decided yet.';
          issue('error', c.name, m.label + ': ' + m.problem + ' Clear it, or enter the earlier result first.');
        } else if (st.outcome === 'double') {
          m.decided = true; m.how = 'double';
          m.winner = { type: 'none', why: 'noplayer', label: 'No player' };
          m.loser = { type: 'none', why: 'noplayer', label: 'No player' };
        } else if (st.winner) {
          var wk = key(st.winner);
          var side_ = (a.type === 'player' && a.key === wk) ? 'a' : (b.type === 'player' && b.key === wk) ? 'b' : null;
          if (!side_) {
            m.problem = 'Saved winner "' + st.winner + '" is not one of the two players.';
            issue('error', c.name, m.label + ': ' + m.problem);
          } else {
            m.decided = true; m.winSide = side_;
            m.winner = side_ === 'a' ? a : b; m.loser = side_ === 'a' ? b : a;
            m.how = (st.outcome === 'walkover') ? 'walkover' : (m.loser.type === 'none' ? 'auto' : 'played');
            if (m.how === 'played' && st.wPts !== null && st.lPts !== null && !isNaN(st.wPts) && !isNaN(st.lPts)) {
              m.wPts = st.wPts; m.lPts = st.lPts;
            }
          }
        } else if (st.outcome === 'walkover') {
          m.problem = 'Marked WALKOVER but no winner is filled in.';
          issue('error', c.name, m.label + ': ' + m.problem);
        }

        // Nothing usable stored: a bye / no-show on one side decides it automatically.
        if (!m.decided && !m.problem && sidesKnown) {
          if (a.type === 'player' && b.type === 'none') { m.decided = true; m.winSide = 'a'; m.winner = a; m.loser = b; m.how = 'auto'; }
          else if (b.type === 'player' && a.type === 'none') { m.decided = true; m.winSide = 'b'; m.winner = b; m.loser = a; m.how = 'auto'; }
          else if (a.type === 'none' && b.type === 'none') {
            m.decided = true; m.how = 'empty';
            m.winner = { type: 'none', why: 'noplayer', label: 'No player' };
            m.loser = { type: 'none', why: 'noplayer', label: 'No player' };
          }
        }

        m.status = m.decided ? 'done' : (sidesKnown ? 'ready' : 'waiting');
        m.updatedAt = m.decided && m.hasStored ? st.updatedAt : '';
        m.resolved = true;
        visiting[m.id] = false;
      }

      c.matches.forEach(resolve);
      c.matches.sort(function (x, y) {
        return (ROUND_ORDER[x.rk] - ROUND_ORDER[y.rk]) || (numOf(x.no) - numOf(y.no)) || (x.seq - y.seq);
      });
    });

    function numOf(no) { var n = parseInt(no, 10); return isNaN(n) ? 9999 : n; }

    // category state, podium, points
    var totals = {}, tally = {};
    HOUSES.forEach(function (h) { totals[h] = 0; tally[h] = { 1: 0, 2: 0, 3: 0 }; });
    var countable = 0, completed = 0;

    cats.forEach(function (c) {
      c.points = { Alpha: 0, Beta: 0, Gamma: 0 };
      c.podium = [];
      c.counted = false;
      c.total = c.matches.filter(function (m) { return m.how !== 'auto' && m.how !== 'empty'; }).length;
      c.played = c.matches.filter(function (m) { return m.hasStored && m.decided; }).length;

      if (c.matches.length === 0 && c.players.length === 0) { c.kind = 'empty'; c.state = 'empty'; return; }

      if (c.matches.length === 0) {
        c.kind = 'single';
        if (c.players.length > 1) issue('error', c.name, c.players.length + ' players but no matches in the Matches tab.');
        if (c.players.length === 1) {
          c.players[0].inDraw = 1;
          if (config.singleEntryPoints) c.podium = [{ pos: 1, player: c.players[0], pts: pts[0] }];
        }
        c.state = c.postponed ? 'postponed' : (c.players.length === 1 ? (config.singleEntryPoints ? 'complete' : 'single') : 'upcoming');
      } else {
        c.kind = 'bracket';
        var finals = c.matches.filter(function (m) { return m.rk === 'f'; });
        var thirds = c.matches.filter(function (m) { return m.rk === '3p'; });
        if (finals.length !== 1) issue('error', c.name, 'Needs exactly one match with round "Final" (found ' + finals.length + ').');
        if (thirds.length > 1) issue('error', c.name, 'More than one 3rd Place match.');
        var fin = finals[0], third = thirds[0];
        c.final = fin || null; c.third = third || null;
        var complete = !!fin && fin.decided && (!third || third.decided);
        if (complete) {
          if (fin.winner && fin.winner.type === 'player') c.podium.push({ pos: 1, player: fin.winner, pts: pts[0], how: fin.how });
          if (fin.loser && fin.loser.type === 'player') c.podium.push({ pos: 2, player: fin.loser, pts: pts[1], how: fin.how });
          if (third && third.winner && third.winner.type === 'player') c.podium.push({ pos: 3, player: third.winner, pts: pts[2], how: third.how });
        }
        var anyStored = c.matches.some(function (m) { return m.hasStored; });
        c.state = c.postponed ? 'postponed' : complete ? 'complete' : anyStored ? 'progress' : 'upcoming';

        c.players.forEach(function (p) {
          if (p.inDraw === 0) issue('warn', c.name, p.name + ' is in Players but not in the draw.');
          if (p.inDraw > 1) issue('error', c.name, p.name + ' appears ' + p.inDraw + ' times in the draw.');
        });
      }

      if (c.state === 'complete') {
        completed++;
        c.counted = true;
        c.podium.forEach(function (pl) {
          if (!pl.player.house) {
            pl.noHouse = true;
            issue('error', c.name, pl.player.name + ' (' + ['1st', '2nd', '3rd'][pl.pos - 1] + ') has no house, so ' + pl.pts + ' points are not counted.');
            return;
          }
          c.points[pl.player.house] += pl.pts;
          totals[pl.player.house] += pl.pts;
          tally[pl.player.house][pl.pos]++;
        });
      }
      if (c.state !== 'empty' && !c.postponed && !(c.kind === 'single' && !config.singleEntryPoints)) countable++;
    });

    cats.forEach(function (c) {
      c.players.forEach(function (p) {
        if (!p.house) issue('warn', c.name, p.name + ' has no house yet.');
      });
    });

    // house standings — shared position on equal points; a tie never skips the next place
    var order = HOUSES.slice().sort(function (x, y) { return totals[y] - totals[x] || HOUSES.indexOf(x) - HOUSES.indexOf(y); });
    var standings = [], pos = 0;
    order.forEach(function (h, i) {
      if (i === 0 || totals[h] !== totals[order[i - 1]]) pos++;
      standings.push({ house: h, pts: totals[h], pos: pos, gold: tally[h][1], silver: tally[h][2], bronze: tally[h][3] });
    });
    standings.forEach(function (s) {
      s.tied = standings.filter(function (t) { return t.pos === s.pos; }).length > 1;
    });

    // latest results (entered by a person, newest first)
    var latest = [];
    cats.forEach(function (c) {
      c.matches.forEach(function (m) { if (m.decided && m.hasStored) latest.push(m); });
    });
    latest.sort(function (x, y) { return (y.updatedAt > x.updatedAt ? 1 : y.updatedAt < x.updatedAt ? -1 : 0); });

    var visible = cats.filter(function (c) { return c.state !== 'empty'; });

    return {
      config: config,
      categories: visible,                                   // schedule (sheet) order
      byAge: visible.slice().sort(function (a, b) { return cmpCat(a.name, b.name); }),
      byName: byName,
      matchById: matchById,
      totals: totals,
      standings: standings,
      anyPoints: HOUSES.some(function (h) { return totals[h] > 0; }),
      completed: completed,
      countable: countable,
      latest: latest,
      issues: issues
    };
  }

  // Every later match that depends (directly or indirectly) on `matchId`,
  // i.e. would change if this match's result changed. Same category only.
  function dependents(model, matchId) {
    var m = model.matchById[matchId];
    if (!m) return [];
    var cat = model.byName[key(m.category)];
    var out = [], seen = {};
    (function walk(no) {
      cat.matches.forEach(function (x) {
        if (seen[x.id]) return;
        var ra = parseRef(x.srcA), rb = parseRef(x.srcB);
        if ((ra && ra.no === no) || (rb && rb.no === no)) {
          seen[x.id] = true;
          out.push(x);
          walk(x.no);
        }
      });
    })(m.no);
    return out;
  }

  // Signature of what is stored for a match — used to detect two phones
  // editing the same match at once.
  function storedSig(row) {
    return [key(row.winner), outcomeKey(row.outcome), norm(row.winner_pts), norm(row.loser_pts)].join('|');
  }

  return {
    HOUSES: HOUSES,
    ROUND_LABEL: ROUND_LABEL,
    build: build,
    dependents: dependents,
    checkScore: checkScore,
    storedSig: storedSig,
    parseRef: parseRef,
    roundKey: roundKey,
    outcomeKey: outcomeKey,
    normHouse: normHouse,
    norm: norm,
    key: key,
    cmpCat: cmpCat
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = BADM;
