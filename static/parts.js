/* Music logic for Sectional: the parts in a song, which one is yours, and the audio for
   each practice step. Pure functions (no DOM), so they can be tested outside the browser.
   Times are in whole notes, as abcjs uses them. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Parts = factory();
})(this, function () {
  "use strict";

  const SHARPS = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
  const FLATS = ["C", "D♭", "D", "E♭", "E", "F", "G♭", "G", "A♭", "A", "B♭", "B"];
  const pitchName = (p, flats = true) => (flats ? FLATS : SHARPS)[((p % 12) + 12) % 12] + (Math.floor(p / 12) - 1);

  /** Tidy the reading for abcjs: drop blank lines (they end a tune) and `$` line-break marks. */
  function sanitize(abc) {
    const lines = (abc || "")
      .replace(/\r/g, "")
      .split("\n")
      .filter((l) => l.trim() !== "" && !/^I:linebreak/.test(l));
    return lines
      .map((l) => (/^([A-Za-z]:|%)/.test(l) ? l : l.replace(/("[^"]*")|\$/g, (m, q) => q || "")))
      .join("\n") + "\n";
  }

  /** Header V: definitions and the %%score layout (which voices share a staff, which are piano). */
  function voiceDefs(abc) {
    const defs = {};
    const order = [];
    for (const line of abc.split("\n")) {
      const m = line.match(/^V:\s*(\S+)(.*)$/);
      if (m && m[2].trim() && !defs[m[1]]) {
        const rest = m[2];
        const clef = (rest.match(/(?:clef=)?\b(treble-8|treble|bass|alto|tenor|bass3|perc)\b/) || [])[1] || "";
        const nm = (rest.match(/\bnm="([^"]*)"/) || [])[1] || "";
        defs[m[1]] = { id: m[1], clef, name: nm.replace(/\\n/g, " ") };
        order.push(m[1]);
      }
    }
    const piano = new Set();
    const staffOf = {};
    const staffVoices = {};
    const score = (abc.match(/^%%(?:score|staves)\s+(.*)$/m) || [])[1] || "";
    // a { } brace inside [ ] brackets is a choir's brace; a top-level { } is a piano's
    let depth = 0, bracket = 0, inParen = false, staff = 0;
    const braceInBracket = [];
    for (const tok of score.match(/[{}()\[\]]|[^\s{}()\[\]|]+/g) || []) {
      if (tok === "[") bracket++;
      else if (tok === "]") bracket = Math.max(0, bracket - 1);
      else if (tok === "{") { braceInBracket.push(bracket > 0); if (bracket === 0) depth++; }
      else if (tok === "}") { if (braceInBracket.pop() === false) depth = Math.max(0, depth - 1); }
      else if (tok === "(") { inParen = true; staff++; }
      else if (tok === ")") inParen = false;
      else {
        if (!inParen) staff++;
        staffOf[tok] = staff;
        (staffVoices[staff] = staffVoices[staff] || []).push(tok);
        if (depth > 0) piano.add(tok);
      }
    }
    if (!score) order.forEach((id, i) => { staffOf[id] = i + 1; staffVoices[i + 1] = [id]; });
    return { defs, order, piano, staffOf, staffVoices };
  }

  /** Char offset in the ABC text → voice id. */
  function voiceLocator(abc) {
    const marks = [];
    const re = /^V:\s*(\S+)|\[V:\s*([^\]\s]+)[^\]]*\]/gm;
    let m;
    while ((m = re.exec(abc))) marks.push({ at: m.index, id: m[1] || m[2] });
    return function (offset) {
      let lo = 0, hi = marks.length - 1, found = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (marks[mid].at <= offset) { found = marks[mid].id; lo = mid + 1; } else hi = mid - 1;
      }
      return found || "1";
    };
  }

  function median(a) {
    return a.length ? a[Math.floor(a.length / 2)] : 60;
  }

  /** Notes of every voice (from visualObj.setUpAudio()) and a description of each part. */
  function analyze(abc, flattened) {
    const { defs, order, piano, staffOf, staffVoices } = voiceDefs(abc);
    const locate = voiceLocator(abc);
    const notesByVoice = {};
    let end = 0;
    flattened.tracks.forEach((track, ti) => {
      for (const ev of track) {
        if (ev.cmd !== "note" || ev.pitch === undefined || ev.style === "decoration") continue;
        const id = ev.startChar !== undefined ? locate(ev.startChar) : "t" + ti;
        ev.voice = id;
        ev.staff = staffOf[id] || 0;
        (notesByVoice[id] = notesByVoice[id] || []).push(ev);
        end = Math.max(end, ev.start + ev.duration);
      }
    });
    for (const id in notesByVoice) notesByVoice[id].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
    const ids = Object.keys(notesByVoice).sort((a, b) => {
      const ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.localeCompare(b, undefined, { numeric: true });
    });
    const parts = ids.map((id, i) => {
      const notes = notesByVoice[id];
      const pitches = notes.map((n) => n.pitch).sort((a, b) => a - b);
      const byStart = {};
      for (const n of notes) byStart[n.start.toFixed(5)] = (byStart[n.start.toFixed(5)] || 0) + 1;
      const counts = Object.values(byStart);
      const d = defs[id] || { id, clef: "", name: "" };
      return {
        id, index: i,
        clef: d.clef || (median(pitches) < 57 ? "bass" : "treble"),
        name: d.name,
        isPiano: piano.has(id) || /pian|pno|keyb|organ/i.test(d.name),
        staff: staffOf[id] || i + 1,
        voiceOnStaff: staffVoices[staffOf[id]] ? staffVoices[staffOf[id]].indexOf(id) : 0,
        low: pitches[0], high: pitches[pitches.length - 1], median: median(pitches),
        chordShare: counts.filter((c) => c >= 2).length / Math.max(1, counts.length),
        count: notes.length,
      };
    });
    if (parts.length && parts.every((p) => p.isPiano)) parts.forEach((p) => (p.isPiano = false));
    const roles = voiceRoles(abc, defs);
    const analysis = { parts, notesByVoice, end, roles };
    analysis.staffNames = namesByStaff(analysis);
    return analysis;
  }

  /**
   * Instruments a player can choose, the words that name their staff in a score, how far they
   * sound from what's written (semitones; a B♭ clarinet sounds a tone lower) and their usual
   * sounding range (MIDI), used to guess their staff when it isn't named.
   */
  const INSTRUMENTS = {
    "Flute":          { re: /\bflute|\bfl\.|piccolo/i, t: 0, range: [60, 96] },
    "Oboe":           { re: /\boboe|\bob\./i, t: 0, range: [58, 91] },
    "Clarinet in B♭": { re: /clarinet|\bcl\.|\bclar/i, t: -2, range: [50, 89] },
    "Bassoon":        { re: /bassoon|fagott|\bbsn/i, t: 0, range: [34, 72] },
    "Alto sax":       { re: /alto sax|a\.\s?sax|alto saxophone/i, t: -9, range: [49, 80] },
    "Tenor sax":      { re: /tenor sax|t\.\s?sax|tenor saxophone/i, t: -14, range: [44, 75] },
    "Trumpet in B♭":  { re: /trumpet|cornet|\btpt|\btrp/i, t: -2, range: [54, 82] },
    "Horn in F":      { re: /\bhorns?\b|\bhn\.|\bcor\b/i, t: -7, range: [41, 77] },
    "Trombone":       { re: /trombone|\btbn|\btrb/i, t: 0, range: [40, 72] },
    "Tuba":           { re: /\btuba|euphonium/i, t: 0, range: [28, 60] },
    "Violin":         { re: /violin|\bvln|\bvl\./i, t: 0, range: [55, 96] },
    "Viola":          { re: /\bviola|\bvla/i, t: 0, range: [48, 84] },
    "Cello":          { re: /cello|\bvc\.|\bvlc/i, t: 0, range: [36, 76] },
    "Double bass":    { re: /double bass|contrabass|string bass|\bcb\./i, t: -12, range: [28, 62] },
  };
  const isInstrument = (who) => Object.prototype.hasOwnProperty.call(INSTRUMENTS, who || "");
  /** The instrument a staff name names, if any ("Clarinet in B♭ 1" → "Clarinet in B♭"). */
  function instrumentOf(name) {
    for (const k in INSTRUMENTS) if (INSTRUMENTS[k].re.test(name || "")) return k;
    return null;
  }

  const ROLE_WORDS = ["soprano", "alto", "tenor", "baritone", "bass"];
  const PLURAL = { soprano: "Sopranos", alto: "Altos", tenor: "Tenors", baritone: "Baritones", bass: "Basses" };

  /** Part names the model read next to each voice ("TENORS & BARITONES." → tenor, baritone). */
  function voiceRoles(abc, defs) {
    const re = /^V:\s*(\S+)\s*$/gm;
    const starts = [];
    let m;
    while ((m = re.exec(abc))) starts.push({ id: m[1], at: m.index + m[0].length });
    const out = {};
    starts.forEach((v, i) => {
      const body = abc.slice(v.at, i + 1 < starts.length ? starts[i + 1].at : abc.length).slice(0, 400);
      const text = ((body.match(/"[\^_<>@]?[^"]*"/g) || []).join(" ") + " " + ((defs[v.id] && defs[v.id].name) || "")).toLowerCase();
      if (instrumentOf(text)) return;                   // "Alto sax", "Bass clarinet": not voices
      const found = [];
      for (const w of text.match(/sopran\w*|alto\w*|tenor\w*|bariton\w*|bass\w*/g) || []) {
        const role = ROLE_WORDS.find((r) => w.startsWith(r.slice(0, 5)));
        if (role && !found.includes(role)) found.push(role);
      }
      if (found.length) out[v.id] = found;
    });
    return out;
  }

  function namesByStaff(analysis) {
    const out = {};
    for (const p of analysis.parts) {
      const found = (analysis.roles || {})[p.id];
      if (!found) continue;
      out[p.staff] = (out[p.staff] || []).concat(found.filter((r) => !(out[p.staff] || []).includes(r)));
    }
    // A name has to suit its staff's clef: the reading sometimes writes a staff's heading
    // ("BASSES.") into the part above. Basses go on a bass-clef staff, sopranos and altos on a
    // treble one; a misplaced name moves to the next sung staff down that suits it, or is dropped.
    const clefs = analysis.pageClefs || [];
    const sung = new Set(analysis.parts.filter((p) => !p.isPiano).map((p) => p.staff));
    const suits = (role, staff) => {
      const c = clefKind(clefs[staff - 1]);
      return role === "bass" ? c === "bass" : (role === "soprano" || role === "alto") ? c === "treble" : true;
    };
    if (clefs.length) {
      for (const st of Object.keys(out).map(Number).sort((a, b) => a - b)) {
        for (const role of out[st].filter((r) => !suits(r, st))) {
          out[st] = out[st].filter((r) => r !== role);
          const to = [...sung].sort((a, b) => a - b).find((x) => x > st && suits(role, x) && !(out[x] || []).length);
          if (to) out[to] = [role];
        }
        if (!out[st].length) delete out[st];
      }
    }
    return out;     // {staffNumber: ["tenor", "baritone"]}
  }

  const clefKind = (c) => (/^bass/.test(c || "") ? "bass" : "treble");

  /**
   * Put each voice the model read on the printed staff it belongs to.
   * The model lists voices top to bottom, but its own staff layout can be wrong, so voices
   * are matched in order to the staves found on the page, by clef (treble/bass). Where
   * several staves in a row share a clef, the top staff gets as few voices as possible
   * (usually a solo or melody line). The staff of the first voice named "Piano" and every
   * staff below it are the piano.
   */
  // ------------------------------------------------------------------ expression
  // How loud (dynamics, hairpins, cresc./dim., accents) and how connected (slurs, staccato)
  // each note is, read from the marks in the music. Loudness is in dB, as a curve over time
  // per staff, so a crescendo keeps growing through a held note. A dynamic or hairpin printed
  // on a staff applies to every part on that staff (the reading often gives it to only one).

  const DB = { pppp: -26, ppp: -22, pp: -18, p: -13, mp: -9, mf: -6, f: -3, ff: 0, fff: 2, ffff: 3 };
  const HAIRPIN_DB = 7;        // a crescendo or diminuendo with no dynamic at its end changes this much
  const TEXT_PIN = [[/^\s*(poco a poco\s+)?(cresc|crescendo)\b/i, "<"], [/^\s*(poco a poco\s+)?(dim|dimin|diminuendo|decresc|decrescendo)\b/i, ">"]];
  const dbGain = (db) => Math.pow(10, db / 20);

  /** A level curve from dynamics [{t, db}] and hairpins [{t0, t1, dir}] (times in whole notes). */
  function levelCurve(dyns, pins) {
    const items = [...dyns.map((d) => ({ t: d.t, d })), ...pins.map((h) => ({ t: h.t0, h }))]
      .sort((a, b) => a.t - b.t || (a.d ? -1 : 1));
    const pts = [[0, DB.mf]];
    let cur = DB.mf, base = DB.mf, last = null;
    const cut = (t) => {                       // end whatever ramp is running at time t
      while (pts.length > 1 && pts[pts.length - 1][0] > t + 1e-9) {
        const [ta, va] = pts[pts.length - 2], [tb, vb] = pts[pts.length - 1];
        pts.pop();
        if (ta <= t) { const v = tb > ta ? va + (vb - va) * (t - ta) / (tb - ta) : vb; pts.push([t, v]); cur = v; break; }
      }
    };
    for (const it of items) {
      if (it.d) {
        cut(it.t);
        pts.push([it.t, cur]);
        cur = base = it.d.db;
        pts.push([it.t, cur]);
        continue;
      }
      const h = it.h;
      cut(h.t0);
      const t0 = Math.max(h.t0, pts[pts.length - 1][0]), t1 = h.t1;
      if (t1 <= t0 + 1e-6) continue;
      // a dynamic printed where the hairpin ends is where it's heading
      const m = dyns.find((d) => d.t >= t1 - 0.26 && d.t <= t1 + 0.5 && (h.dir === "<" ? d.db > cur : d.db < cur));
      let target = m ? m.db : cur + (h.dir === "<" ? HAIRPIN_DB : -HAIRPIN_DB);
      // the second half of a swell (< then >, or > then <) comes back to where the first began
      if (!m && last && last.dir !== h.dir && h.t0 <= last.t1 + 0.25 + 1e-6 && last.base === base) target = last.from;
      target = Math.max(base - 12, Math.min(base + 9, target));
      pts.push([t0, cur], [t1, target]);
      last = { dir: h.dir, from: cur, t1, base };
      cur = target;
    }
    return (t) => {
      let i = 0;
      while (i + 1 < pts.length && pts[i + 1][0] <= t + 1e-9) i++;
      if (i + 1 >= pts.length) return pts[i][1];
      const [ta, va] = pts[i], [tb, vb] = pts[i + 1];
      return tb > ta ? va + (vb - va) * (t - ta) / (tb - ta) : vb;
    };
  }

  /** lineStarts: when each line of music starts (an unclosed hairpin ends with its line). */
  function expression(analysis, abc, lineStarts) {
    if (analysis._expressed) return;
    analysis._expressed = true;
    analysis.lineStarts = lineStarts || [];
    const starts = (lineStarts || []).filter((x) => x !== null && x !== undefined).sort((a, b) => a - b);
    const lineEnd = (t) => { for (const s of starts) if (s > t + 1e-6) return s; return Infinity; };
    const blocks = [];
    const re = /^V:\s*(\S+)|\[V:\s*([^\]\s]+)[^\]]*\]/gm;
    let m;
    while ((m = re.exec(abc))) blocks.push(m.index + m[0].length);
    const blockStart = (at) => { let b = 0; for (const x of blocks) if (x <= at) b = x; return b; };

    const dynOn = {}, pinsOn = {};
    const add = (o, k, v) => (o[k] = o[k] || []).push(v);

    for (const id in analysis.notesByVoice) {
      const groups = new Map();                       // one entry per printed note or chord
      for (const n of analysis.notesByVoice[id]) {
        if (n.startChar === undefined) continue;
        if (!groups.has(n.startChar)) groups.set(n.startChar, []);
        groups.get(n.startChar).push(n);
      }
      const order = [...groups.keys()].sort((a, b) => a - b);
      let prevEnd = null, depth = 0, prev = null;
      const marks = [];                              // this part's expression marks, in order
      for (const at of order) {
        const g = groups.get(at);
        const n = g[0];
        const from = prevEnd === null ? blockStart(at) : prevEnd;
        const raw = abc.slice(from, Math.max(from, n.endChar));
        const decos = [...raw.matchAll(/!([^!\s]+)!/g)].map((x) => x[1]);
        const texts = [...raw.matchAll(/"[\^_<>@]?([^"]*)"/g)].map((x) => x[1]);
        const plain = raw.replace(/"[^"]*"/g, " ").replace(/![^!\s]*!/g, " ");
        // slurs: a note joins the one before if a slur stays open between them
        let min = depth;
        for (let i = 0; i < plain.length; i++) {
          const c = plain[i];
          if (c === "(" && !/\d/.test(plain[i + 1] || "")) depth = Math.min(2, depth + 1);
          else if (c === ")") depth = Math.max(0, depth - 1);
          else if (c === "|" && (plain[i + 1] === "]" || plain[i + 1] === "|")) depth = 0;
          min = Math.min(min, depth);
        }
        if (prev) for (const q of prev) q.legato = min > 0;
        const stacc = decos.includes("staccato") || /\.\s*[=^_]*[A-Ga-g\[][^.]*$/.test(plain.slice(-12));
        const accent = decos.some((d) => d === "accent" || d === ">" || d === "emphasis") ? 4 : decos.includes("sfz") ? 7 : 0;
        for (const q of g) { q.staccato = stacc; q.accentDb = accent; q.tenuto = decos.includes("tenuto"); q.legato = false; }
        for (const d of decos) {
          if (DB[d] !== undefined) marks.push({ t: n.start, dyn: DB[d] });
          if (d === "<(" || d === "crescendo(") marks.push({ t: n.start, open: "<" });
          if (d === ">(" || d === "diminuendo(") marks.push({ t: n.start, open: ">" });
          if (d === "<)" || d === "crescendo)") marks.push({ t: n.start, close: "<" });
          if (d === ">)" || d === "diminuendo)") marks.push({ t: n.start, close: ">" });
        }
        for (const tx of texts) for (const [rx, dir] of TEXT_PIN) if (rx.test(tx)) marks.push({ t: n.start, open: dir, text: true });
        prevEnd = n.endChar;
        prev = g;
      }
      // marks after the part's last note (a hairpin that ends at the end of the music)
      if (prev && prevEnd !== null) {
        const next = blocks.find((x) => x > prevEnd);
        const tail = abc.slice(prevEnd, next === undefined ? abc.length : abc.lastIndexOf("\n", next) + 1 || next);
        const end = Math.max(...prev.map((q) => q.start + q.duration));
        for (const x of tail.matchAll(/!([^!\s]+)!/g)) {
          const d = x[1];
          if (d === "<)" || d === "crescendo)") marks.push({ t: end, close: "<" });
          if (d === ">)" || d === "diminuendo)") marks.push({ t: end, close: ">" });
        }
      }
      if (!marks.length) continue;
      const staff = analysis.notesByVoice[id][0].staff;
      // pair hairpin starts with ends; one left open ends at the next mark, the end of its
      // line, or after two bars, whichever comes first
      const open = { "<": null, ">": null };
      const close = (dir, t) => {
        const o = open[dir];
        if (o === null) return;
        add(pinsOn, staff, { t0: o, t1: t, dir });
        open[dir] = null;
      };
      marks.forEach((mk, i) => {
        if (mk.dyn !== undefined) {
          add(dynOn, staff, { t: mk.t, db: mk.dyn });
          for (const dir of ["<", ">"]) if (open[dir] !== null && mk.t > open[dir] + 1e-6) close(dir, mk.t);
        }
        if (mk.close) close(mk.close, mk.t);
        if (mk.open) {
          const other = mk.open === "<" ? ">" : "<";
          if (open[other] !== null) close(other, mk.t);
          if (open[mk.open] !== null) close(mk.open, mk.t);
          if (mk.text) {                                   // "cresc." runs until the next dynamic
            const nextDyn = marks.slice(i + 1).find((x) => x.dyn !== undefined && x.t > mk.t);
            add(pinsOn, staff, { t0: mk.t, t1: Math.min(nextDyn ? nextDyn.t : Infinity, mk.t + 2), dir: mk.open });
          } else open[mk.open] = mk.t;
        }
      });
      for (const dir of ["<", ">"]) if (open[dir] !== null) {
        const t0 = open[dir];
        const later = marks.find((x) => x.t > t0 + 1e-6);
        close(dir, Math.min(later ? later.t : Infinity, lineEnd(t0), t0 + 2));
      }
    }
    // a staff's dynamics: drop repeats of the same mark at the same time from its other parts
    const curves = {};
    for (const p of analysis.parts) {
      const st = p.staff;
      if (curves[st]) continue;
      const seen = new Set();
      const dyns = (dynOn[st] || []).filter((d) => { const k = d.t.toFixed(4); if (seen.has(k)) return false; seen.add(k); return true; });
      const pseen = new Set();
      const pins = (pinsOn[st] || []).filter((h) => { const k = h.t0.toFixed(3) + h.dir; if (pseen.has(k)) return false; pseen.add(k); return true; });
      curves[st] = levelCurve(dyns, pins);
    }
    analysis.levelDb = (staff, t) => (curves[staff] ? curves[staff](t) : DB.mf);
  }

  /** How long a note actually sounds: slurred notes join the next, staccato ones are short,
   *  others keep their full length with just the tongue's break before the next note. */
  function sounded(n, d, beatLen) {
    if (n.staccato) return Math.min(d * 0.5, beatLen * 0.6);
    if (n.legato || n.tenuto) return d;
    return Math.max(d * 0.85, d - beatLen * 0.08);
  }

  function mapStaves(analysis, pageClefs) {
    const N = pageClefs.length;
    const voices = analysis.parts;
    const M = voices.length;
    if (!N || !M) return false;
    const INF = 1e9, SKIP = 20;
    const cost = (i, j) => {
      const w = Math.min(1, voices[i].count / 8);
      return (clefKind(voices[i].clef) === clefKind(pageClefs[j]) ? 0 : 10 * w) + 0.01 * (N - j);
    };
    const dp = Array.from({ length: M }, () => new Array(N).fill(INF));
    const from = Array.from({ length: M }, () => new Array(N).fill(-1));
    for (let j = 0; j < N; j++) dp[0][j] = SKIP * j + cost(0, j);
    for (let i = 1; i < M; i++) {
      for (let j = 0; j < N; j++) {
        for (let k = 0; k <= j; k++) {
          const c = dp[i - 1][k] + SKIP * Math.max(0, j - k - 1) + cost(i, j);
          if (c < dp[i][j]) { dp[i][j] = c; from[i][j] = k; }
        }
      }
    }
    let best = 0;
    for (let j = 0; j < N; j++) if (dp[M - 1][j] + SKIP * (N - 1 - j) < dp[M - 1][best] + SKIP * (N - 1 - best)) best = j;
    const staffOf = new Array(M);
    for (let i = M - 1, j = best; i >= 0; i--) { staffOf[i] = j; j = from[i][j]; }

    const pianoVoice = voices.findIndex((p) => /pian|pno/i.test(p.name || ""));
    const pianoFrom = pianoVoice >= 0 ? staffOf[pianoVoice] : N;
    voices.forEach((p, i) => {
      p.staff = staffOf[i] + 1;
      if (pianoVoice >= 0) p.isPiano = staffOf[i] >= pianoFrom;
      for (const n of analysis.notesByVoice[p.id]) n.staff = p.staff;
    });
    const onStaff = {};
    voices.forEach((p) => (onStaff[p.staff] = (onStaff[p.staff] || []).concat(p.id)));
    voices.forEach((p) => (p.voiceOnStaff = onStaff[p.staff].indexOf(p.id)));
    analysis.pageClefs = pageClefs.slice();
    analysis.staffNames = namesByStaff(analysis);
    analysis.pageStaves = N;
    return true;
  }

  function staffLabel(analysis, staff) {
    const inst = staffInstrument(analysis, staff);
    if (inst) return inst;
    const names = (analysis.staffNames || {})[staff];
    return names && names.length ? names.map((r) => PLURAL[r]).join(" & ") : "";
  }

  /** Real parts only: drop stray voices with a handful of notes (usually misreads). */
  function mainParts(analysis) {
    const most = Math.max(0, ...analysis.parts.map((p) => p.count));
    return analysis.parts.filter((p) => p.count >= Math.min(8, most) && p.count >= most * 0.08);
  }

  /** Every note printed on one staff, whichever voice the model put it in (no duplicates). */
  function staffNotes(analysis, staff) {
    const seen = new Set();
    const out = [];
    for (const p of analysis.parts) {
      if (p.staff !== staff) continue;
      for (const n of analysis.notesByVoice[p.id]) {
        const k = n.start.toFixed(4) + "|" + n.pitch;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(n);
      }
    }
    return out.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  }

  /** Pitches sounding on the staff when note n starts (n included). */
  function soundingAt(notes, n) {
    const t = n.start + 1e-6;
    const set = new Set();
    for (const o of notes) {
      if (o.start > t) break;
      if (o.start + o.duration > t) set.add(o.pitch);
    }
    set.add(n.pitch);
    return set;
  }

  /**
   * Two parts written on one staff. Where notes are stacked, the top one is the upper part
   * and the bottom one the lower part. A note on its own (the other part resting, or a note
   * the reading missed) goes to the part it's closest to in pitch, following each part's
   * line, so a part never jumps across to the other one. A unison belongs to both.
   */
  function assignParts(notes) {
    const upper = new Set(), lower = new Set();
    let lastU = null, lastL = null;
    const byStart = new Map();
    for (const n of notes) {
      const k = n.start.toFixed(5);
      if (!byStart.has(k)) byStart.set(k, []);
      byStart.get(k).push(n);
    }
    for (const group of byStart.values()) {
      const ps = [...soundingAt(notes, group[0])].concat(group.map((n) => n.pitch));
      const hi = Math.max(...ps), lo = Math.min(...ps);
      for (const n of group) {
        if (hi !== lo) {
          if (n.pitch === hi) { upper.add(n); lastU = n.pitch; continue; }
          if (n.pitch === lo) { lower.add(n); lastL = n.pitch; continue; }
        }
        // on its own (or in the middle of three): follow the nearer line
        const dU = lastU === null ? Infinity : Math.abs(n.pitch - lastU);
        const dL = lastL === null ? Infinity : Math.abs(n.pitch - lastL);
        if (lastU !== null && lastL !== null && lastU === lastL && dU === dL) { upper.add(n); lower.add(n); }
        else if (dU === Infinity && dL === Infinity) { upper.add(n); lower.add(n); lastU = lastL = n.pitch; }
        else if (dU <= dL) { upper.add(n); lastU = n.pitch; }
        else { lower.add(n); lastL = n.pitch; }
      }
    }
    return { upper, lower };
  }

  /**
   * One singer sings one note at a time: where a part still has two notes starting together
   * (a third note in a chord, or two voices on the staff with different rhythms), keep the
   * top one (bottom one for the lower part), and end each note when the next one starts.
   */
  function monophonic(notes, low) {
    const byStart = new Map();
    for (const n of notes) {
      const k = n.start.toFixed(5);
      const g = byStart.get(k);
      if (!g || (low ? n.pitch < g.pitch : n.pitch > g.pitch)) byStart.set(k, n);
    }
    const out = [...byStart.values()].sort((a, b) => a.start - b.start);
    return out.map((n, i) => {
      const next = out[i + 1];
      return next && n.start + n.duration > next.start + 1e-6 ? { ...n, duration: next.start - n.start } : n;
    });
  }

  function pickPart(notes, part) {
    if (!part || part === "all") return monophonic(notes, false);
    const a = assignParts(notes);
    const keep = part === "upper" ? a.upper : a.lower;
    return monophonic(notes.filter((n) => keep.has(n)), part === "lower");
  }

  /** Share of notes on a staff that have another note stacked with them. */
  function stacking(notes) {
    if (!notes.length) return 0;
    return notes.filter((n) => soundingAt(notes, n).size >= 2).length / notes.length;
  }

  /**
   * Singable lines, top to bottom: {staff, part: "upper"|"lower"|"all", label}. A staff with
   * two stacked parts gives two lines. With staffNum, only that staff (piano included).
   */
  function lines(analysis, staffNum) {
    let staves;
    if (staffNum !== undefined) {
      staves = [staffNum];
    } else {
      const vocal = mainParts(analysis).filter((p) => !p.isPiano);
      const pool = vocal.length ? vocal : mainParts(analysis);
      staves = [...new Set(pool.map((p) => p.staff))].sort((a, b) => a - b);
    }
    const out = [];
    for (const staff of staves) {
      const notes = staffNotes(analysis, staff);
      if (!notes.length) continue;
      const label = staffLabel(analysis, staff);
      if (stacking(notes) > 0.3) {
        out.push({ staff, part: "upper", label });
        out.push({ staff, part: "lower", label });
      } else {
        out.push({ staff, part: "all", label });
      }
    }
    return out;
  }

  const VOICE_RANK = { "Tenor 1": 0, "Tenor 2": 1 / 3, "Baritone": 2 / 3, "Bass": 1, "Soprano": 0, "Alto": 1 / 3, "Tenor": 2 / 3 };
  const MALE = new Set(["Tenor 1", "Tenor 2", "Baritone", "Bass", "Tenor"]);

  /**
   * Guess which line a singer of `voiceType` sings. First by the part names printed on the
   * staves ("TENORS & BARITONES": baritones are the lower notes); otherwise by rank among the
   * choir's four lines (a solo or melody staff above the choir is left out).
   */
  function guessLine(analysis, voiceType) {
    const all = lines(analysis);
    if (!all.length) return null;
    if (isInstrument(voiceType)) {
      // a staff named for the instrument; else the line whose notes sit best in its range
      const named = all.find((l) => staffInstrument(analysis, l.staff) === voiceType);
      if (named) return { ...named, why: "name" };
      const inst = INSTRUMENTS[voiceType];
      const mid = (inst.range[0] + inst.range[1]) / 2;
      let best = null, bestD = Infinity;
      for (const l of all) {
        const ns = pickPart(staffNotes(analysis, l.staff), l.part);
        if (!ns.length) continue;
        const ps = ns.map((n) => n.pitch).sort((a, b) => a - b);
        const shift = staffInstrument(analysis, l.staff) ? 0 : inst.t - writtenShift(analysis, l.staff);
        const d = Math.abs(ps[ps.length >> 1] + shift - mid);
        if (d < bestD) { bestD = d; best = l; }
      }
      return best ? { ...best, why: "range" } : null;
    }
    const role = (voiceType || "").toLowerCase().replace(/\s*\d$/, "");
    const named = [...new Set(all.map((l) => l.staff))].filter((st) => ((analysis.staffNames || {})[st] || []).includes(role));
    // names only count on a choir staff (two stacked parts); a solo line may carry them too
    const two = named.filter((st) => all.filter((l) => l.staff === st).length === 2 && (analysis.staffNames[st] || []).length >= 2);
    if (two.length) {
      const staff = two[0];
      const ls = all.filter((l) => l.staff === staff);
      const names = analysis.staffNames[staff];
      let part;
      if (names.length >= 2) part = names.indexOf(role) === 0 ? "upper" : "lower";
      else part = /1$/.test(voiceType) ? "upper" : "lower";
      return { ...ls.find((l) => l.part === part), why: "name" };
    }
    const choir = all.length > 4 ? all.slice(-4) : all;
    const rank = VOICE_RANK[voiceType] ?? 2 / 3;
    return { ...choir[Math.round(rank * (choir.length - 1))], why: "rank" };
  }

  /**
   * Men's choirs read treble-clef voice parts an octave lower. For a male singer, play such
   * staves (plain treble clef, sitting high) an octave down. Applied once per analysis.
   */
  /**
   * The reading sometimes puts a sung line in the wrong octave (a bass part written as if in
   * treble range). Line by line, bring each sung part into the range singers on its clef
   * actually sing. Applied once per analysis.
   */
  /** The instrument named on a staff (any of its parts), or null for voices and unnamed staves. */
  function staffInstrument(analysis, staff) {
    for (const p of analysis.parts) if (p.staff === staff && instrumentOf(p.name)) return instrumentOf(p.name);
    return null;
  }

  const restat = (p, notes) => {
    const all = notes.map((n) => n.pitch).sort((a, b) => a - b);
    if (all.length) { p.low = all[0]; p.high = all[all.length - 1]; p.median = all[all.length >> 1]; }
  };

  function fixOctaves(analysis, who) {
    if (analysis._octaves) return;
    analysis._octaves = true;
    const starts = (analysis.lineStarts || []).filter((x) => x !== null && x !== undefined).sort((a, b) => a - b);
    const lineOf = (t) => { let k = 0; starts.forEach((s, i) => { if (s <= t + 1e-6) k = i; }); return k; };
    for (const p of analysis.parts) {
      // only sung parts have a range this rule knows; for a player, only staves named as voices
      if (p.isPiano || staffInstrument(analysis, p.staff)) continue;
      if (isInstrument(who) && !((analysis.staffNames || {})[p.staff] || []).length) continue;
      const [lo, hi] = /^bass/.test(p.clef) ? [45, 64] : [57, 84];
      const byLine = {};
      for (const n of analysis.notesByVoice[p.id]) (byLine[lineOf(n.start)] = byLine[lineOf(n.start)] || []).push(n);
      for (const k in byLine) {
        const ps = byLine[k].map((n) => n.pitch).sort((a, b) => a - b);
        const med = ps[ps.length >> 1];
        let shift = 0;
        while (med + shift < lo) shift += 12;
        while (med + shift > hi) shift -= 12;
        if (shift) for (const n of byLine[k]) n.pitch += shift;
      }
      restat(p, analysis.notesByVoice[p.id]);
    }
  }

  /**
   * Men's choirs read treble-clef voice parts an octave lower. For a male singer, play such
   * staves (plain treble clef, sitting high) an octave down. Applied once per analysis.
   */
  function applyVoicing(analysis, who) {
    fixOctaves(analysis, who);
    if (analysis._voiced || !MALE.has(who)) return;
    analysis._voiced = true;
    for (const p of analysis.parts) {
      if (p.isPiano || p.clef !== "treble" || p.median < 64 || staffInstrument(analysis, p.staff)) continue;
      for (const n of analysis.notesByVoice[p.id]) n.pitch -= 12;
      p.low -= 12; p.high -= 12; p.median -= 12;
    }
  }

  /**
   * Transposing instruments: a B♭ clarinet's part is written a tone above how it sounds. Every
   * staff named for such an instrument is played at sounding pitch, and so is the player's own
   * staff when it isn't named at all (the page is then their own part, written for their
   * instrument; a staff named for singers is printed at sounding pitch).
   * Call again when the player or their staff changes; returns {staff: semitones applied}.
   */
  function applyTransposition(analysis, who, myStaff) {
    analysis._shift = analysis._shift || {};
    const staves = [...new Set(analysis.parts.map((p) => p.staff))];
    for (const st of staves) {
      const inst = staffInstrument(analysis, st);
      let t = inst ? INSTRUMENTS[inst].t : 0;
      // an unnamed staff you play is taken to be your own part, written for your instrument
      // (not a sung line you're playing along with: that's printed at sounding pitch)
      const sung = ((analysis.staffNames || {})[st] || []).length > 0;
      if (st === myStaff && !inst && !sung && isInstrument(who)) t = INSTRUMENTS[who].t;
      const d = t - (analysis._shift[st] || 0);
      if (!d) continue;
      for (const p of analysis.parts) {
        if (p.staff !== st) continue;
        for (const n of analysis.notesByVoice[p.id]) n.pitch += d;
        restat(p, analysis.notesByVoice[p.id]);
      }
      analysis._shift[st] = t;
    }
    return analysis._shift;
  }

  /** Semitones between what's printed on a staff and how it sounds (to name notes as written). */
  const writtenShift = (analysis, staff) => ((analysis && analysis._shift) || {})[staff] || 0;

  /** My notes, and everyone else's. */
  function divide(analysis, sel) {
    if (!sel || !sel.staff) return { mine: [], others: [].concat(...Object.values(analysis.notesByVoice)) };
    const mine = pickPart(staffNotes(analysis, sel.staff), sel.part);
    const mineKeys = new Set(mine.map((n) => n.start.toFixed(4) + "|" + n.pitch));
    const others = [];
    for (const id in analysis.notesByVoice) {
      for (const n of analysis.notesByVoice[id]) {
        if (n.staff === sel.staff && mineKeys.has(n.start.toFixed(4) + "|" + n.pitch)) continue;
        others.push(n);
      }
    }
    return { mine, others };
  }

  /** Beats for a one-bar count-in from the time signature. */
  function beatOf(meter) {
    const num = meter && meter.num ? meter.num : 4;
    const den = meter && meter.den ? meter.den : 4;
    if (den === 8 && num % 3 === 0 && num > 3) return { beats: num / 3, beatLen: 3 / 8 };
    return { beats: num, beatLen: 1 / den };
  }

  const FADE = [1, 0.7, 0.45, 0.25, 0];

  /**
   * One pass of a practice step over the range [a, b), starting at `from`.
   * opts: {analysis, sel, a, b, from, step (1–5), round, vol: {mine, others},
   *        inst: {mine, others}, beat: {beats, beatLen}, countIn, clicks, bars: [{start, dur, first}], phrasing}
   * Returns {notes, marks}: notes for the sound engine ({pitch, instrument, start, dur, env,
   * legato}, times in whole notes); marks gives (in whole notes from the start of the pass)
   * musicStart/musicEnd, gapStart/gapEnd (echo), checkStart, total, and the my-part volume used.
   */
  function buildPass(o) {
    const { mine, others } = divide(o.analysis, o.sel);
    const beatLen = o.beat.beatLen;
    const notes = [];
    const plain = (instrument, pitch, gain, start, dur) => {
      if (gain > 0.001) notes.push({ pitch, instrument, start, dur, env: [[0, gain]] });
    };
    const inRange = (n) => n.start >= o.from - 1e-6 && n.start < o.b - 1e-6;
    const levelDb = o.analysis.levelDb || (() => DB.mf);
    const PIANO = 0;
    const pianoIds = new Set(o.analysis.parts.filter((p) => p.isPiano).map((p) => p.id));

    // Where a note falls in its bar. Bars come as {start, dur, first (first bar of a line)}.
    // A short first bar is a pick-up: its notes are the end of a bar, so they count from the
    // bar's end (a one-beat pick-up in 4/4 is beat 4, not beat 1).
    const bars = (o.bars || (o.barStarts || []).map((s) => ({ start: s })))
      .slice().sort((x, y) => x.start - y.start);
    const full = o.beat.beats * beatLen;
    const barOf = (t) => { let b = null; for (const x of bars) { if (x.start <= t + 1e-6) b = x; else break; } return b; };
    const posInBar = (t) => {
      const b = barOf(t);
      if (!b) return t;
      if (b.dur !== undefined && b.first && b.dur < full - 1e-6) return full - (b.start + b.dur - t);
      return t - b.start;
    };

    // Natural phrasing: how players and singers shape music without it being written.
    // - Strong and weak beats: the first beat of a bar leans in, the middle of a 4/4 (or 6/8,
    //   12/8) bar a little, other beats are lighter, and notes between beats lighter still.
    // - Higher notes in a phrase come out a little more, lower ones a little less.
    // - A phrase (up to a rest or the end of the line) grows towards its middle and eases off
    //   at its end.
    const N = o.beat.beats;
    const metricDb = (t) => {
      const pos = posInBar(t);
      const k = pos / beatLen;
      const onBeat = Math.abs(k - Math.round(k)) < 1e-3;
      if (onBeat) {
        const beat = ((Math.round(k) % N) + N) % N;
        if (beat === 0) return 3;
        if (N >= 4 && N % 2 === 0 && beat === N / 2) return 1;
        return -1;
      }
      const half = pos / (beatLen / 2);
      return Math.abs(half - Math.round(half)) < 1e-3 ? -3.5 : -4.5;
    };

    // Split my part into phrases, for the arch and the high/low shaping.
    const minePlayed = mine.filter(inRange);
    const lineStarts = bars.filter((b) => b.first).map((b) => b.start);
    const phraseOf = new Map();
    {
      let cur = [];
      const flush = () => {
        if (!cur.length) return;
        const a = cur[0].start, z = cur[cur.length - 1].start + cur[cur.length - 1].duration;
        const ps = cur.map((n) => n.pitch).sort((x, y) => x - y);
        const median = ps[Math.floor(ps.length / 2)];
        cur.forEach((n, i) => phraseOf.set(n, { a, z, median, last: i === cur.length - 1 }));
        cur = [];
      };
      minePlayed.forEach((n, i) => {
        const prev = minePlayed[i - 1];
        const newLine = prev && lineStarts.some((s) => s > prev.start + 1e-6 && s <= n.start + 1e-6);
        if (prev && (n.start - (prev.start + prev.duration) >= beatLen / 2 - 1e-6 || newLine)) flush();
        cur.push(n);
      });
      flush();
    }

    // A music note with its loudness curve: the staff's dynamics over time (so hairpins carry
    // on through held notes), any accent (strongest at the start), and natural phrasing.
    const music = (instrument, n, vol, start, d) => {
      if (vol <= 0.001) return;
      const len = sounded(n, d, beatLen);
      const settle = Math.min(len * 0.5, beatLen * 0.5);
      const shape = o.phrasing ? metricDb(n.start) : 0;
      const ph = o.phrasing ? phraseOf.get(n) : null;
      let lift = 0;
      if (ph) lift = Math.max(-3, Math.min(3, (n.pitch - ph.median) * 0.4));
      const arch = (t) => {
        if (!ph || ph.z - ph.a < beatLen * 2) return 0;
        const x = Math.max(0, Math.min(1, (t - ph.a) / (ph.z - ph.a)));
        return 3 * Math.sin(Math.PI * x) - 1.5;
      };
      const times = new Set([0, settle, len * 0.5, len]);
      for (let dt = 0.125; dt < len; dt += 0.125) times.add(dt);
      const env = [...times].sort((x, y) => x - y).map((dt) => {
        const t = n.start + Math.min(dt, len - 1e-4);
        let db = levelDb(n.staff, t) + shape + lift + arch(t);
        if (dt < settle) db += (n.accentDb || 0) * (1 - dt / settle);
        if (ph && ph.last && dt > len * 0.5) db -= 2 * (dt - len * 0.5) / (len * 0.5);
        return [dt, vol * dbGain(db)];
      });
      notes.push({ pitch: n.pitch, instrument, start, dur: len, env, legato: !!n.legato && !n.staccato });
    };
    let t0 = 0;

    // Step 5: the starting notes, the way a rehearsal pianist gives them: each part's first
    // note in turn, from the lowest part up (piano parts left out).
    if (o.step === 5) {
      const firstOf = (ns) => {
        const at = ns.filter((n) => n.start <= o.a + 1e-6 && n.start + n.duration > o.a + 1e-6);
        if (at.length) return at;
        const after = ns.filter((n) => n.start >= o.a - 1e-6 && n.start < o.b);
        if (!after.length) return [];
        const s = after[0].start;
        return after.filter((n) => Math.abs(n.start - s) < 1e-6);
      };
      const given = new Map();                                  // pitch -> is it mine
      for (const n of firstOf(mine)) given.set(n.pitch, true);
      const vocalStaves = new Set(o.analysis.parts.filter((p) => !p.isPiano).map((p) => p.staff));
      for (const st of vocalStaves) {
        for (const n of firstOf(others.filter((x) => x.staff === st && !pianoIds.has(x.voice)))) {
          if (!given.has(n.pitch)) given.set(n.pitch, false);
        }
      }
      const order = [...given.keys()].sort((x, y) => x - y);
      order.forEach((p, i) => plain(PIANO, p, given.get(p) ? 0.55 : 0.4, i * beatLen, beatLen * 1.5));
      t0 = (order.length + 1) * beatLen;
    }
    // count-in clicks
    if (o.countIn || o.step === 5 || o.step === 1) {
      for (let i = 0; i < o.beat.beats; i++) plain(115, i === 0 ? 76 : 77, 0.5, t0 + i * beatLen, beatLen / 2);
      t0 += o.beat.beats * beatLen;
    }
    const musicStart = t0;
    const shift = musicStart - o.from;
    const musicEnd = musicStart + (o.b - o.from);

    let mineVol = o.vol.mine;
    if (o.step === 3) mineVol = o.vol.mine * FADE[Math.min(o.round || 0, FADE.length - 1)];
    if (o.step === 4 || o.step === 5) mineVol = 0;   // you carry your line yourself
    const othersVol = o.step === 5 ? 0 : o.vol.others;

    for (const n of minePlayed) music(o.inst.mine, n, mineVol, n.start + shift, Math.min(n.duration, o.b - n.start));
    // the other singers in their sound; the piano part on the piano, a little under them
    for (const n of others) {
      if (!inRange(n)) continue;
      const piano = pianoIds.has(n.voice);
      music(piano ? PIANO : o.inst.others, n, othersVol * (piano ? 0.8 : 1), n.start + shift, Math.min(n.duration, o.b - n.start));
    }

    const marks = { musicStart, musicEnd, total: musicEnd, mineVol };
    // beat clicks, with the first beat of each bar louder and higher
    const isDownbeat = (t) => Math.abs(posInBar(t)) < 1e-4;
    const clicksBetween = (from, to, offset) => {
      for (let t = from; t < to - 1e-6; t += beatLen) {
        const one = isDownbeat(t - offset);
        plain(115, one ? 76 : 77, one ? 0.4 : 0.2, t, beatLen / 2);
      }
    };
    if (o.step === 5 || o.clicks) clicksBetween(musicStart, musicEnd, shift);

    if (o.step === 1) {
      // your turn: the same length of silence (with quiet beats if asked)
      marks.gapStart = musicEnd;
      marks.gapEnd = musicEnd + (o.b - o.a);
      if (o.clicks) clicksBetween(marks.gapStart, marks.gapEnd, marks.gapStart - o.a);
      marks.total = marks.gapEnd;
    }
    if (o.step === 4 || o.step === 5) {
      // check note: your last note of the range, after a beat's pause
      const last = mine.filter((n) => n.start >= o.a - 1e-6 && n.start < o.b - 1e-6).pop();
      if (last) {
        marks.checkStart = musicEnd + beatLen;
        marks.checkPitch = last.pitch;
        plain(o.inst.mine, last.pitch, 0.55, marks.checkStart, beatLen * 2.5);
        marks.total = marks.checkStart + beatLen * 2.5;
      }
    }
    return { notes, marks };
  }

  /** Your first note at or after `from`. */
  function firstNote(analysis, sel, from) {
    const { mine } = divide(analysis, sel);
    return mine.find((n) => n.start >= (from || 0) - 1e-6) || null;
  }

  return { sanitize, voiceDefs, voiceLocator, analyze, mainParts, lines, guessLine, divide,
           staffNotes, pickPart, assignParts, expression, applyTransposition, writtenShift, staffInstrument, instrumentOf, isInstrument, INSTRUMENTS, sounded, staffLabel, applyVoicing, mapStaves, beatOf, buildPass, firstNote, pitchName, FADE, VOICE_RANK, MALE };
});
