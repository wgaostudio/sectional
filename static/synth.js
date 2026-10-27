/* The app's own sound engine. abcjs's built-in synth sets each note's loudness once, when the
   note starts, and can't change it while the note sounds, so crescendos and diminuendos on held
   notes were lost. Here every note has its own loudness curve, played from the bundled
   soundfonts and scheduled on the live audio clock (nothing to render ahead of time).

   A note: {pitch, instrument, start, dur (seconds), env: [[seconds from note start, gain], ...],
            legato (true: overlaps the next note slightly so they join)} */
(function (root) {
  "use strict";

  const NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
  const INSTRUMENTS = { 0: "acoustic_grand_piano", 19: "church_organ", 52: "choir_aahs", 53: "voice_oohs", 71: "clarinet", 115: "woodblock" };
  const RELEASE = { 0: 0.09, 115: 0.02 };    // how quickly a note is damped (seconds)
  const OVERLAP = 0.04;                      // slurred notes run this far into the next one
  const MASTER = 2.4;                        // overall level (ff at full volume ≈ the old player)
  const LEAD = 0.06;                         // scheduling headroom (seconds)
  const cache = new Map();

  const noteName = (p) => NAMES[p % 12] + (Math.floor(p / 12) - 1);

  function sample(ctx, url, instrument, pitch) {
    const key = instrument + ":" + pitch;
    if (!cache.has(key)) {
      const name = INSTRUMENTS[instrument] || INSTRUMENTS[0];
      const p = Math.max(21, Math.min(108, pitch));
      cache.set(key, fetch(`${url}${name}-mp3/${noteName(p)}.mp3`)
        .then((r) => { if (!r.ok) throw new Error("missing sound " + name + " " + noteName(p)); return r.arrayBuffer(); })
        .then((b) => ctx.decodeAudioData(b))
        .catch((e) => { cache.delete(key); throw e; }));
    }
    return cache.get(key);
  }

  /** Loudness of a note `dt` seconds after it starts, from its envelope points. */
  function gainAt(env, dt) {
    if (dt <= env[0][0]) return env[0][1];
    for (let i = 1; i < env.length; i++) {
      if (dt <= env[i][0]) {
        const [ta, ga] = env[i - 1], [tb, gb] = env[i];
        return tb > ta ? ga + (gb - ga) * (dt - ta) / (tb - ta) : gb;
      }
    }
    return env[env.length - 1][1];
  }

  class Synth {
    /** ctx: the live AudioContext; url: soundfont folder. */
    constructor(ctx, url) {
      this.ctx = ctx;
      this.url = url;
      this.notes = [];
      this.buffers = [];
      this.sources = [];
      this.out = null;
      this.zero = 0;          // audio-clock time of the pass's start
      this.offset = 0;        // where in the pass a pause happened (seconds)
      this.playing = false;
    }

    /** Load the sounds the notes need. */
    async load(notes) {
      this.notes = notes;
      this.buffers = await Promise.all(notes.map((n) => sample(this.ctx, this.url, n.instrument, n.pitch)));
      return this;
    }

    /** Play from `offset` seconds into the pass. */
    start(offset) {
      this.stop();
      const ctx = this.ctx;
      this.offset = offset || 0;
      this.zero = ctx.currentTime + LEAD - this.offset;
      // overall level, then a limiter so loud, busy passages never distort
      const master = ctx.createGain();
      master.gain.value = MASTER;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -4; comp.knee.value = 3; comp.ratio.value = 20;
      comp.attack.value = 0.002; comp.release.value = 0.15;
      master.connect(comp).connect(ctx.destination);
      this.out = { master, comp };
      this.notes.forEach((n, i) => {
        const buf = this.buffers[i];
        if (!buf) return;
        const rel = RELEASE[n.instrument] !== undefined ? RELEASE[n.instrument] : 0.05;
        const len = Math.max(0.03, n.dur) + (n.legato ? OVERLAP : 0);
        if (n.start + len + rel <= this.offset) return;               // already over
        const env = n.env && n.env.length ? n.env : [[0, 0.5]];
        const into = Math.max(0, this.offset - n.start);              // starting part-way through
        const at = this.zero + n.start + into;
        const end = this.zero + n.start + len;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, at);
        g.gain.linearRampToValueAtTime(gainAt(env, into), at + 0.006);
        for (const [dt, v] of env) if (dt > into + 0.006 && n.start + dt < n.start + len) g.gain.linearRampToValueAtTime(v, this.zero + n.start + dt);
        if (end > at + 0.006) g.gain.setValueAtTime(gainAt(env, len), end);
        g.gain.linearRampToValueAtTime(0, Math.max(end, at + 0.006) + rel);
        src.connect(g).connect(master);
        src.start(at, Math.min(into, buf.duration - 0.01));
        src.stop(Math.max(end, at + 0.006) + rel + 0.02);
        src.onended = () => { try { g.disconnect(); } catch (e) {} };
        this.sources.push(src);
      });
      this.playing = true;
    }

    pause() {
      if (!this.playing) return;
      const off = this.ctx.currentTime - this.zero;
      this.stop();
      this.offset = Math.max(0, off);
    }

    resume() { this.start(this.offset); }

    stop() {
      for (const s of this.sources) { try { s.stop(); } catch (e) {} }
      this.sources = [];
      if (this.out) { try { this.out.comp.disconnect(); } catch (e) {} this.out = null; }
      this.playing = false;
    }
  }

  root.Synth = Synth;
})(this);
