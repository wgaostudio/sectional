/* Audio player for practice passes: plays one pass after another (looping), keeps track of
   where it is, and gets the next pass ready while the current one plays so loops don't stall. */
(function (root) {
  "use strict";

  class Player {
    constructor({ soundFontUrl, onTick, onPass, onStop, onError }) {
      this.soundFontUrl = soundFontUrl;
      this.onTick = onTick;     // ({pass, t}) every frame while playing; t = whole notes into the pass
      this.onPass = onPass;     // (pass) when a pass starts
      this.onStop = onStop;     // () when playback stops
      this.onError = onError;
      this.ctx = null;
      this.current = null;      // {synth, pass, startedAt, secPerWhole}
      this.next = null;         // Promise of a prepared {synth, pass}
      this.state = "stopped";   // stopped | loading | playing | paused
      this.makePass = null;     // (round) => pass {sequence, marks, ...}; null result = stop
      this.round = 0;
      this.secPerWhole = 3;
      this.raf = 0;
      this.token = 0;
    }

    audio() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AC();
      }
      if (this.ctx.state === "suspended") this.ctx.resume();
      return this.ctx;
    }

    /** Render a pass (times in whole notes) at the given tempo. */
    async prepare(pass, secPerWhole) {
      const s = secPerWhole;
      const notes = pass.notes.map((n) => ({
        pitch: n.pitch, instrument: n.instrument, legato: n.legato,
        start: n.start * s, dur: n.dur * s,
        env: (n.env || []).map(([dt, g]) => [dt * s, g]),
      }));
      const synth = await new Synth(this.audio(), this.soundFontUrl).load(notes);
      return { synth, pass };
    }

    /** Start looping passes. makePass(round) builds each pass; secPerWhole sets the tempo. */
    async play(makePass, secPerWhole) {
      this.stop(true);
      const token = ++this.token;
      this.makePass = makePass;
      this.secPerWhole = secPerWhole;
      this.round = 0;
      this.state = "loading";
      try {
        const first = await this.prepare(makePass(0), secPerWhole);
        if (token !== this.token) return;
        this.start(first, token);
      } catch (e) {
        if (token !== this.token) return;
        this.state = "stopped";
        this.onError && this.onError(e);
        this.onStop && this.onStop();
      }
    }

    start(prepared, token) {
      const ctx = this.audio();
      prepared.synth.start(0);
      this.current = { ...prepared, startedAt: prepared.synth.zero, pausedAt: null };
      this.state = "playing";
      this.onPass && this.onPass(prepared.pass, this.round);
      this.queueNext(token);
      this.loop(token);
    }

    queueNext(token) {
      const round = this.round + 1;
      const pass = this.makePass ? this.makePass(round) : null;
      this.next = pass ? this.prepare(pass, this.secPerWhole).catch(() => null) : Promise.resolve(null);
    }

    loop(token) {
      cancelAnimationFrame(this.raf);
      const step = async () => {
        if (token !== this.token || this.state !== "playing") return;
        const cur = this.current;
        const t = (this.ctx.currentTime - cur.startedAt) / this.secPerWhole;
        if (t >= cur.pass.marks.total + 0.02) {
          const nxt = await this.next;
          if (token !== this.token || this.state !== "playing") return;
          try { cur.synth.stop(); } catch (e) {}
          if (!nxt) { this.stop(); return; }
          this.round += 1;
          this.start(nxt, token);
          return;
        }
        this.onTick && this.onTick({ pass: cur.pass, t, round: this.round });
        this.raf = requestAnimationFrame(step);
      };
      this.raf = requestAnimationFrame(step);
    }

    /** Settings changed: rebuild the pass that plays next (the current one finishes as is). */
    refreshNext() {
      if (this.state === "playing" || this.state === "paused") {
        if (this.next) this.next.then((n) => { if (n) try { n.synth.stop(); } catch (e) {} });
        this.queueNext(this.token);
      }
    }

    pause() {
      if (this.state !== "playing") return;
      this.current.synth.pause();
      this.current.pausedAt = this.ctx.currentTime;
      this.state = "paused";
      cancelAnimationFrame(this.raf);
    }

    resume() {
      if (this.state !== "paused") return;
      this.audio();
      this.current.pausedAt = null;
      this.current.synth.resume();
      this.current.startedAt = this.current.synth.zero;
      this.state = "playing";
      this.loop(this.token);
    }

    stop(silent) {
      this.token++;
      cancelAnimationFrame(this.raf);
      if (this.current) { try { this.current.synth.stop(); } catch (e) {} }
      if (this.next) this.next.then((n) => { if (n) try { n.synth.stop(); } catch (e) {} });
      this.current = null;
      this.next = null;
      const was = this.state;
      this.state = "stopped";
      if (!silent && was !== "stopped") this.onStop && this.onStop();
    }

    /** Play a few notes once (e.g. "My note"), without disturbing anything else. */
    async blip(notes, secPerWhole, instrument) {
      let end = 0;
      const ns = notes.map((n) => {
        end = Math.max(end, n.start + n.duration);
        return { pitch: n.pitch, instrument, start: n.start, dur: n.duration, env: [[0, n.gain || 0.6]] };
      });
      const { synth } = await this.prepare({ notes: ns, marks: { total: end } }, secPerWhole);
      synth.start(0);
      return synth;
    }
  }

  root.Player = Player;
})(this);
