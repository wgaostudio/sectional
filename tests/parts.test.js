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
