/* Voice Party — custom level generation
 * Route (human drawn centre line) + difficulty + seed  ->  obstacles (machine made)
 * Solvability is validated so a generated level is always clearable.
 */
(function (global) {
  'use strict';

  var W = 360, H = 640;
  var BIRD_R = 13;
  var MIN_GAP = 60;          // bird diameter + margin
  var MAX_SLOPE = 1.20;      // vertical per horizontal the bird can track
  var MAX_ANGLE = 58 * Math.PI / 180;

  var DIFF = {
    easy:   { spacing: 205, gap: 214, zig: 0,  jitter: 10, saw: 0, stagger: 0 },
    normal: { spacing: 168, gap: 170, zig: 16, jitter: 16, saw: 3, stagger: 0 },
    hard:   { spacing: 140, gap: 132, zig: 30, jitter: 22, saw: 2, stagger: 4 }
  };

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /* ---- route: dense resample + smoothing -------------------------- */
  function buildPath(points) {
    if (!points || points.length < 2) return null;
    var pts = points.slice().sort(function (a, b) { return a.x - b.x; });
    /* drop duplicates */
    var clean = [pts[0]];
    for (var i = 1; i < pts.length; i++) {
      var d = Math.abs(pts[i].x - clean[clean.length - 1].x);
      if (d >= 4) clean.push(pts[i]);
    }
    if (clean.length < 2) return null;

    var dense = [], dx = 8, x = clean[0].x, lastX = clean[clean.length - 1].x;
    var seg = 0;
    while (x <= lastX) {
      while (seg < clean.length - 2 && clean[seg + 1].x < x) seg++;
      var a = clean[seg], b = clean[seg + 1] || clean[seg];
      var t = (b.x === a.x) ? 0 : (x - a.x) / (b.x - a.x);
      dense.push({ x: x, y: a.y + (b.y - a.y) * clamp(t, 0, 1) });
      x += dx;
    }
    /* moving average smoothing (window 9) */
    var win = 4, sm = [];
    for (var j = 0; j < dense.length; j++) {
      var sum = 0, n = 0;
      for (var k = j - win; k <= j + win; k++) {
        if (k >= 0 && k < dense.length) { sum += dense[k].y; n++; }
      }
      sm.push({ x: dense[j].x, y: sum / n });
    }
    /* keep the channel inside the play area */
    for (var q = 0; q < sm.length; q++) sm[q].y = clamp(sm[q].y, 74, H - 74);
    return sm;
  }

  function yAt(path, x) {
    if (!path || !path.length) return H / 2;
    if (x <= path[0].x) return path[0].y;
    if (x >= path[path.length - 1].x) return path[path.length - 1].y;
    var lo = 0, hi = path.length - 1;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (path[mid].x <= x) lo = mid; else hi = mid; }
    var a = path[lo], b = path[hi];
    var t = (b.x === a.x) ? 0 : (x - a.x) / (b.x - a.x);
    return a.y + (b.y - a.y) * t;
  }

  /* ---- obstacle generation ---------------------------------------- */
  function generate(points, difficulty, seed) {
    var D = DIFF[difficulty] || DIFF.normal;
    var rnd = mulberry32((seed >>> 0) || 1);
    var path = buildPath(points);
    if (!path) return null;

    var obstacles = [], relaxed = false;
    var spacing = D.spacing;
    var zig = D.zig, gapBase = D.gap, extra = 0;

    for (var attempt = 0; attempt < 5; attempt++) {
      obstacles = [];
      var x = 320 + rnd() * 30;
      var sign = rnd() < 0.5 ? -1 : 1;
      var idx = 0;
      while (x < 2600) {
        var cy = yAt(path, x) + sign * zig * (0.4 + 0.6 * rnd());
        var slope = Math.abs(yAt(path, x + spacing) - cy) / spacing;
        var widen = clamp(slope * 320, 0, 40);
        var gap = clamp(gapBase + extra + widen, MIN_GAP, 300);
        var type = 'pipe';
        if (D.saw && idx % D.saw === 0) type = 'saw';
        if (D.stagger && idx % D.stagger === 0) type = 'stagger';
        obstacles.push({
          x: Math.round(x),
          gapY: Math.round(cy),
          gapH: Math.round(gap),
          type: type,
          saw: type === 'saw'
        });
        sign = -sign;
        idx++;
        x += spacing + (rnd() - 0.5) * D.jitter * 2;
      }

      /* solvability pass: trackability + gap size */
      var bad = false;
      for (var i = 0; i < obstacles.length - 1; i++) {
        var dx = obstacles[i + 1].x - obstacles[i].x;
        var dy = Math.abs(obstacles[i + 1].gapY - obstacles[i].gapY);
        if (dy / dx > MAX_SLOPE) { bad = true; break; }
      }
      for (var m = 0; m < obstacles.length; m++) {
        if (obstacles[m].gapH < MIN_GAP + 6) { bad = true; break; }
        if (obstacles[m].gapY - obstacles[m].gapH / 2 < 46 ||
            obstacles[m].gapY + obstacles[m].gapH / 2 > H - 46) { bad = true; break; }
      }
      if (!bad) break;

      /* fix locally first, then globally */
      var fixed = false;
      for (var p = 0; p < obstacles.length - 1; p++) {
        var ddx = obstacles[p + 1].x - obstacles[p].x;
        var ddy = Math.abs(obstacles[p + 1].gapY - obstacles[p].gapY);
        if (ddy / ddx > MAX_SLOPE) {
          obstacles[p].gapH = Math.min(300, obstacles[p].gapH + 46);
          obstacles[p + 1].gapH = Math.min(300, obstacles[p + 1].gapH + 46);
          fixed = true;
        }
      }
      if (!fixed) {
        spacing += 14; gapBase += 10; zig = Math.max(0, zig - 6);
        relaxed = true;
      }
    }

    var avgGap = obstacles.length
      ? Math.round(obstacles.reduce(function (s, o) { return s + o.gapH; }, 0) / obstacles.length)
      : 0;

    return {
      obstacles: obstacles,
      path: path,
      count: obstacles.length,
      gap: avgGap,
      relaxed: relaxed,
      difficulty: difficulty,
      seed: seed,
      width: W, height: H
    };
  }

  global.LevelGen = {
    W: W, H: H, BIRD_R: BIRD_R, MIN_GAP: MIN_GAP,
    DIFF: DIFF,
    mulberry32: mulberry32,
    buildPath: buildPath,
    yAt: yAt,
    generate: generate,
    randomSeed: function () { return (Math.random() * 0xffffffff) >>> 0; }
  };
})(window);
