// Run with: node --test tests/*.test.js
const test = require("node:test");
const assert = require("node:assert");
const ABCJS = require("../static/vendor/abcjs-basic-min.js");
const P = require("../static/parts.js");

function load(abc) {
  const text = P.sanitize(abc);
  const vo = ABCJS.parseOnly(text)[0];
  const an = P.analyze(text, vo.setUpAudio({}));
  return { an, text, vo };
}

const SONG = `X:1
L:1/8
M:4/4
K:C
V:1 treble nm="Tenor & Baritone"
V:2 bass nm="Bass"
V:3 treble nm="Piano"
V:1
!p! [ce]2 [Bd]2 [Ac]2 !<(! [GB]2 | [Ac]2 [Bd]2 [ce]2 [df]2!<)! |$
V:2
!p! C,4 G,,4 | A,,4 G,,4 |$
V:3
[CEG]8 | [DFA]8 |$
`;

test("a part on a shared staff is one note at a time", () => {
  const { an } = load(SONG);
  P.mapStaves(an, ["treble", "bass", "treble"]);
  const upper = P.divide(an, { staff: 1, part: "upper" }).mine;
  const lower = P.divide(an, { staff: 1, part: "lower" }).mine;
  assert.deepStrictEqual(upper.map((n) => n.pitch), [76, 74, 72, 71, 72, 74, 76, 77]);
  assert.deepStrictEqual(lower.map((n) => n.pitch), [72, 71, 69, 67, 69, 71, 72, 74]);
  for (const part of [upper, lower]) {
    for (let i = 1; i < part.length; i++) assert.ok(part[i - 1].start + part[i - 1].duration <= part[i].start + 1e-9);
  }
});

test("a crescendo makes the staff louder over time", () => {
  const { an, text } = load(SONG);
  P.mapStaves(an, ["treble", "bass", "treble"]);
  P.expression(an, text, [0]);
  const at = (t) => an.levelDb(1, t);
  assert.ok(at(0.75) < at(1.5));
  assert.ok(at(1.5) - at(0.75) > 3);
});

test("step 5 gives each sung part's first note, lowest first, without the piano", () => {
  const { an, text, vo } = load(SONG);
  P.mapStaves(an, ["treble", "bass", "treble"]);
  P.expression(an, text, [0]);
  const beat = P.beatOf(vo.getMeterFraction());
  const pass = P.buildPass({ analysis: an, sel: { staff: 1, part: "lower" }, a: 0, b: 2, from: 0, step: 5, round: 0,
    vol: { mine: 0.9, others: 0.5 }, inst: { mine: 71, others: 52 }, beat, countIn: false, clicks: false,
    bars: [{ start: 0, dur: 1, first: true }, { start: 1, dur: 1 }], phrasing: true });
  const given = pass.notes.filter((n) => n.start < pass.marks.musicStart - beat.beats * beat.beatLen);
  assert.deepStrictEqual(given.map((n) => n.pitch), [48, 72, 76]);
  assert.ok(given.every((n) => n.instrument === 0));
});

test("natural phrasing leans on the first beat of the bar", () => {
  const { an, text, vo } = load(SONG);
  P.mapStaves(an, ["treble", "bass", "treble"]);
  P.expression(an, text, [0]);
  const pass = P.buildPass({ analysis: an, sel: { staff: 2, part: "all" }, a: 0, b: 2, from: 0, step: 2, round: 0,
    vol: { mine: 0.9, others: 0 }, inst: { mine: 71, others: 52 }, beat: P.beatOf(vo.getMeterFraction()),
    countIn: false, clicks: false, bars: [{ start: 0, dur: 1, first: true }, { start: 1, dur: 1 }], phrasing: true });
  const mine = pass.notes.filter((n) => n.instrument === 71);
  assert.ok(mine[0].env[0][1] > mine[1].env[0][1]);       // beat 1 louder than beat 3
});

const BAND = `X:1
L:1/4
M:4/4
K:C
V:1 treble nm="Clarinet in Bb"
V:2 treble nm="Alto Sax."
V:3 bass nm="Trombone"
V:1
c d e f |$
V:2
G A B c |$
V:3
C, D, E, F, |$
`;

test("staff names say which instrument plays it, and voices aren't confused with saxes", () => {
  assert.strictEqual(P.instrumentOf("Clarinet in B♭ 1"), "Clarinet in B♭");
  assert.strictEqual(P.instrumentOf("Bass Clarinet"), "Clarinet in B♭");
  assert.strictEqual(P.instrumentOf("Alto Sax."), "Alto sax");
  assert.strictEqual(P.instrumentOf("Basses"), null);
  const { an } = load(BAND);
  P.mapStaves(an, ["treble", "treble", "bass"]);
  assert.deepStrictEqual(an.staffNames, {});
  assert.strictEqual(P.staffLabel(an, 2), "Alto sax");
});

test("transposing instruments play at sounding pitch, and follow the player's staff", () => {
  const { an } = load(BAND);
  P.mapStaves(an, ["treble", "treble", "bass"]);
  P.applyVoicing(an, "Clarinet in B♭");
  P.applyTransposition(an, "Clarinet in B♭", 1);
  assert.deepStrictEqual(P.staffNotes(an, 1).map((n) => n.pitch), [70, 72, 74, 75]);   // written C D E F
  assert.deepStrictEqual(P.staffNotes(an, 2).map((n) => n.pitch), [58, 60, 62, 63]);   // alto sax: a sixth lower
  assert.deepStrictEqual(P.staffNotes(an, 3).map((n) => n.pitch), [48, 50, 52, 53]);   // trombone: as written
  assert.strictEqual(P.writtenShift(an, 1), -2);
  const g = P.guessLine(an, "Trombone");
  assert.strictEqual(g.staff, 3);
});

test("an unnamed staff is read as the player's own part", () => {
  const { an } = load("X:1\nL:1/4\nK:C\nV:1 treble\nd e f g |$\n");
  P.mapStaves(an, ["treble"]);
  P.applyTransposition(an, "Trumpet in B♭", 1);
  assert.deepStrictEqual(P.staffNotes(an, 1).map((n) => n.pitch), [72, 74, 75, 77]);
  P.applyTransposition(an, "Soprano", 1);                                              // a singer now
  assert.deepStrictEqual(P.staffNotes(an, 1).map((n) => n.pitch), [74, 76, 77, 79]);
});

// ---------------------------------------------------------------- three or more parts on a staff
const pitches = (ns) => ns.map((n) => n.pitch);

test("three parts on one staff give three lines, top to bottom", () => {
  const { an } = load(`X:1\nL:1/4\nM:4/4\nK:C\nV:1 treble nm="Tenors, Baritones & Basses"\n[V:1] [ceg] [dfa] [egb] [fac'] |$\n`);
  P.mapStaves(an, ["treble"]);
  const ls = P.lines(an);
  assert.deepStrictEqual(ls.map((l) => l.part), ["1/3", "2/3", "3/3"]);
  assert.deepStrictEqual(pitches(P.divide(an, { staff: 1, part: "1/3" }).mine), [79, 81, 83, 84]);
  assert.deepStrictEqual(pitches(P.divide(an, { staff: 1, part: "2/3" }).mine), [76, 77, 79, 81]);
  assert.deepStrictEqual(pitches(P.divide(an, { staff: 1, part: "3/3" }).mine), [72, 74, 76, 77]);
  // a selection saved when the staff was taken for two parts: upper is the top, lower the bottom
  assert.deepStrictEqual(pitches(P.divide(an, { staff: 1, part: "upper" }).mine), [79, 81, 83, 84]);
  assert.deepStrictEqual(pitches(P.divide(an, { staff: 1, part: "lower" }).mine), [72, 74, 76, 77]);
  // names printed on the staff pick the line
  assert.strictEqual(P.guessLine(an, "Baritone").part, "2/3");
  assert.strictEqual(P.guessLine(an, "Bass").part, "3/3");
});

test("the number of parts on a staff can change: two, a divisi into three, unison, two", () => {
  const { an } = load(`X:1\nL:1/4\nM:4/4\nK:C\nV:1 treble\n[V:1] [ec] [fd] [ge] [fd] | [gec] [afc] [bgd] [c'ge] | c d e f | [ec] [fd] [ge]2 |$\n`);
  P.mapStaves(an, ["treble"]);
  assert.deepStrictEqual(P.lines(an).map((l) => l.part), ["1/3", "2/3", "3/3"]);
  const top = pitches(P.divide(an, { staff: 1, part: "1/3" }).mine);
  const mid = pitches(P.divide(an, { staff: 1, part: "2/3" }).mine);
  const bot = pitches(P.divide(an, { staff: 1, part: "3/3" }).mine);
  // two parts: the middle part sings with the top one; three: each its own; unison: all three
  assert.deepStrictEqual(top, [76, 77, 79, 77, 79, 81, 83, 84, 72, 74, 76, 77, 76, 77, 79]);
  assert.deepStrictEqual(mid, [76, 77, 79, 77, 76, 77, 79, 79, 72, 74, 76, 77, 76, 77, 79]);
  assert.deepStrictEqual(bot, [72, 74, 76, 74, 72, 72, 74, 76, 72, 74, 76, 77, 72, 74, 76]);
});

test("a part that rests in the reading rests, instead of singing another part's note", () => {
  const { an } = load(`X:1\nL:1/4\nM:4/4\nK:C\nV:1 treble nm="Sopranos"\nV:2 treble nm="Altos"\n%%score (1 2)\n[V:1] e f g a | g4 |\n[V:2] c d z z | c4 |\n`);
  P.mapStaves(an, ["treble"]);
  assert.deepStrictEqual(pitches(P.divide(an, { staff: 1, part: "upper" }).mine), [76, 77, 79, 81, 79]);
  assert.deepStrictEqual(pitches(P.divide(an, { staff: 1, part: "lower" }).mine), [72, 74, 72]);
});

test("a held note stays with its part while the others move", () => {
  const { an } = load(`X:1\nL:1/4\nM:4/4\nK:C\nV:1 treble\nV:2 treble\nV:3 treble\n%%score (1 2 3)\n[V:1] g4 |\n[V:2] e d e f |\n[V:3] c B, C D |\n`);
  P.mapStaves(an, ["treble"]);
  assert.deepStrictEqual(pitches(P.divide(an, { staff: 1, part: "1/3" }).mine), [79]);
  assert.deepStrictEqual(pitches(P.divide(an, { staff: 1, part: "2/3" }).mine), [76, 74, 76, 77]);
  assert.deepStrictEqual(pitches(P.divide(an, { staff: 1, part: "3/3" }).mine), [72, 59, 60, 62]);
});

test("a stray chord here and there doesn't make another part", () => {
  const { an } = load(`X:1\nL:1/4\nM:4/4\nK:C\nV:1 treble\n[V:1] c d e f | g a b c' | [c'e] b a g | f e d c |$\n`);
  P.mapStaves(an, ["treble"]);
  assert.deepStrictEqual(P.lines(an).map((l) => l.part), ["all"]);
});

// ---------------------------------------------------------------- a change of time signature
test("count-in, clicks and strong beats follow each bar's time signature", () => {
  const { an, text } = load(`X:1\nL:1/4\nM:2/4\nK:C\nV:1 treble\n[V:1] c d | [M:4/4] e f g a |$\n`);
  P.mapStaves(an, ["treble"]);
  P.expression(an, text, [0]);
  const bars = [{ start: 0, dur: 0.5, first: true, ...P.beatOf({ num: 2, den: 4 }) },
                { start: 0.5, dur: 1, ...P.beatOf({ num: 4, den: 4 }) }];
  const pass = P.buildPass({ analysis: an, sel: { staff: 1, part: "all" }, a: 0, b: 1.5, from: 0, step: 2, round: 0,
    vol: { mine: 0.9, others: 0 }, inst: { mine: 71, others: 52 }, beat: P.beatOf({ num: 4, den: 4 }),
    countIn: true, clicks: true, bars, phrasing: true });
  const clicks = pass.notes.filter((n) => n.instrument === 115);
  const m = pass.marks;
  // a count-in of two beats: the pass starts in 2/4
  assert.strictEqual(m.musicStart - m.countStart, 0.5);
  // beats in the music: 2 in the 2/4 bar, then 4; the first of each bar is the high click
  const inMusic = clicks.filter((c) => c.start >= m.musicStart - 1e-9).map((c) => [+(c.start - m.musicStart).toFixed(3), c.pitch]);
  assert.deepStrictEqual(inMusic, [[0, 76], [0.25, 77], [0.5, 76], [0.75, 77], [1, 77], [1.25, 77]]);
  // the first beat of the 4/4 bar leans in more than its second beat
  const mine = pass.notes.filter((n) => n.instrument === 71);
  assert.ok(mine[2].env[0][1] > mine[3].env[0][1]);
});

// ---------------------------------------------------------------- percussion, the whole choir on one staff, tempo
const TTB_PERC = `X:1\nL:1/4\nM:4/4\nK:C\nV:1 treble-8 nm="Tenor 1"\nV:2 treble-8 nm="Tenor 2"\nV:3 bass nm="Bass"\nV:4 perc nm="B. P."\n%%score [1 2 3] 4\n` +
  `[V:1] e f g a |\n[V:2] c d e f |\n[V:3] C, D, E, F, |\n[V:4] B B G B |\n`;

test("a percussion staff is nobody's part, and plays on the woodblock", () => {
  const { an, text } = load(TTB_PERC);
  P.mapStaves(an, ["treble", "treble", "bass"]);
  P.expression(an, text, [0]);
  assert.deepStrictEqual(P.lines(an).map((l) => l.staff), [1, 2, 3]);
  assert.strictEqual(P.guessLine(an, "Bass").staff, 3);
  const pass = P.buildPass({ analysis: an, sel: { staff: 3, part: "all" }, a: 0, b: 1, from: 0, step: 2, round: 0,
    vol: { mine: 0.9, others: 0.5 }, inst: { mine: 71, others: 52 }, beat: P.beatOf({ num: 4, den: 4 }),
    countIn: false, clicks: false, bars: [{ start: 0, dur: 1, first: true }], phrasing: false });
  const wood = pass.notes.filter((n) => n.instrument === 115);
  assert.strictEqual(wood.length, 4);
  assert.ok(pass.notes.filter((n) => n.instrument === 52).every((n) => n.pitch !== 71 || n.start > 0));
});

test("where one staff carries the whole choir, everyone's part is on it", () => {
  const { an, text } = load(`X:1\nL:1/4\nM:4/4\nK:C\nV:1 treble-8 nm="T.T."\nV:2 bass nm="B.B."\n%%score 1 2\n` +
    `[V:1] [ec] [fd] [ge] [fd] | "^All voices""^unison" c d e f | "^div. 3 parts" [gec] [afc] [bgd] [c'ge] | [ec] [fd] [ge] [fd] |\n` +
    `[V:2] [G,C,] [A,D,] [B,E,] [A,D,] | z4 | z4 | [G,C,] [A,D,] [B,E,] [A,D,] |\n`);
  P.mapStaves(an, ["treble", "bass"]);
  P.expression(an, text, [0, 1, 2, 3]);
  const shared = P.findShared(an, [0, 1, 2, 3].map((t) => ({ start: t, end: t + 1 })));
  assert.deepStrictEqual(shared.map((x) => [x.staff, x.start, x.end, x.unison]), [[1, 1, 2, true], [1, 2, 3, false]]);
  // the tenors' staff still has its two parts; the whole-choir bars don't count
  assert.deepStrictEqual(P.lines(an).map((l) => l.staff + ":" + l.part), ["1:upper", "1:lower", "2:upper", "2:lower"]);
  const bars = (sel, a, b) => P.divide(an, sel).mine.filter((n) => n.start >= a - 1e-9 && n.start < b - 1e-9).map((n) => n.pitch);
  // the basses sing the unison, then the bottom of three
  assert.deepStrictEqual(bars({ staff: 2, part: "lower" }, 1, 2), [60, 62, 64, 65]);
  assert.deepStrictEqual(bars({ staff: 2, part: "lower" }, 2, 3), [60, 60, 62, 64]);
  assert.deepStrictEqual(bars({ staff: 1, part: "upper" }, 2, 3), [67, 69, 71, 72]);
});

test("the music is played at the tempo marked along the way", () => {
  const { an, text } = load(`X:1\nL:1/4\nM:4/4\nQ:1/4=100\nK:C\nV:1\n[V:1] c d e f | "^rit." g a b c' | "^a tempo" c d e !fermata!f | [Q:1/4=50] g a b c' |\n`);
  P.mapStaves(an, ["treble"]);
  P.expression(an, text, [0]);
  // abcjs isn't left to stretch the notes after the tempo change: they stay in step with the bars
  assert.deepStrictEqual(an.notesByVoice["1"].slice(-4).map((n) => n.start), [3, 3.25, 3.5, 3.75]);
  assert.ok(an.rate(1.9) < 0.85 && an.rate(2) === 1 && an.rate(2.8) === 0.5 && an.rate(3.5) === 0.5);
  const pass = P.buildPass({ analysis: an, sel: { staff: 1, part: "all" }, a: 0, b: 4, from: 0, step: 2, round: 0,
    vol: { mine: 0.9, others: 0 }, inst: { mine: 71, others: 52 }, beat: P.beatOf({ num: 4, den: 4 }),
    countIn: false, clicks: false, bars: [0, 1, 2, 3].map((t) => ({ start: t, dur: 1, first: t === 0 })), phrasing: false });
  const starts = pass.notes.map((n) => +n.start.toFixed(3));
  assert.deepStrictEqual(starts.slice(0, 5), [0, 0.25, 0.5, 0.75, 1]);       // the opening tempo
  assert.ok(starts[7] - starts[6] > 0.27);                                  // slowing down
  assert.ok(Math.abs(starts[12] - starts[11] - 0.5) < 1e-3);                 // the fermata, held twice as long
  assert.ok(Math.abs(starts[13] - starts[12] - 0.5) < 1e-3);                 // half the tempo
  assert.ok(Math.abs(pass.marks.musicPos(starts[13]) - 3.25) < 1e-3);        // and the screen follows
});
