/* Sectional — screens and interaction. */
(() => {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const api = async (path, opts = {}) => {
    const r = await fetch(path, opts);
    if (!r.ok) {
      let msg = r.statusText;
      try { msg = (await r.json()).detail || msg; } catch (e) {}
      throw new Error(msg);
    }
    return r.json();
  };
  const putJSON = (path, body) => api(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const postJSON = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const EPS = 1e-6;

  let toastTimer;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3200);
  }

  function show(id) {
    for (const s of $$(".screen")) s.hidden = s.id !== id;
    window.scrollTo(0, 0);
  }

  const VOICES = ["Soprano", "Alto", "Tenor", "Bass", "Tenor 1", "Tenor 2", "Baritone"];
  const PLAYS = Object.keys(Parts.INSTRUMENTS);

  // Singers sing and players play: the app's wording follows what you chose.
  const playing = () => Parts.isInstrument(S.settings && S.settings.voiceType);
  const words = (t) => (playing() ? t.replace(/\bsinging\b/g, "playing").replace(/\bSinging\b/g, "Playing")
    .replace(/\bsing\b/g, "play").replace(/\bSing\b/g, "Play") : t);

  /** Play the chosen staff at sounding pitch (transposing instruments); call after the part changes. */
  function syncTransposition() {
    if (S.analysis) Parts.applyTransposition(S.analysis, S.settings.voiceType, S.prefs && S.prefs.sel ? S.prefs.sel.staff : null);
  }

  /** A note of your part as printed on your page (a B♭ clarinet's written D sounds C). */
  function myNoteName(p) {
    const shift = S.prefs && S.prefs.sel ? Parts.writtenShift(S.analysis, S.prefs.sel.staff) : 0;
    return shift ? `${noteName(p - shift)} (sounds ${noteName(p)})` : noteName(p);
  }
  const STEPS = [
    { n: 1, name: "Listen, then echo", d: "Hear your part, then sing it back from memory in the silence.", mine: 0.9, others: 0 },
    { n: 2, name: "Sing along", d: "Your part plays; sing with it.", mine: 0.9, others: 0 },
    { n: 3, name: "Fade yourself out", d: "The others join, and your part gets quieter each time round.", mine: 0.9, others: 0.5 },
    { n: 4, name: "Without your part", d: "The others play; you carry your line. Your last note plays at the end to check.", mine: 0, others: 0.6, lockMine: true },
    { n: 5, name: "Starting notes only", d: "Hear each part’s first note, lowest first, then sing alone. Your last note plays at the end to check.", mine: 0, others: 0, lockMine: true, lockOthers: true },
  ];

  const S = {
    settings: {},          // global: {voiceType}
    song: null,
    analysis: null,
    vo: null,
    lines: [],             // meta.lines
    bars: [],              // [{n, line, k, start, dur}]
    total: 0,
    prefs: null,           // per song: {sel, range, step, speed, ...}
    from: 0,
    pos: null,             // current playing position (whole notes) or null
    phase: "",
    picking: false,
    pollId: 0,
    saveId: 0,
    userScrollAt: 0,
  };

  // The published demo runs without a server (see demo.js there); it can say where files are.
  const DEMO = window.SECTIONAL_DEMO || null;
  const pageUrl = (id, file) => (DEMO && DEMO.pageUrl ? DEMO.pageUrl(id, file) : `/api/songs/${id}/images/${file}`);

  const player = new Player({
    soundFontUrl: new URL("static/soundfonts/", location.href).href,
    onTick: tick,
    onPass: (pass, round) => { S.round = round; S.lastPass = pass; updateRound(); },
    onStop: () => { showTurn(false); setPlayState("stopped"); S.pos = null; drawDynamic(); updateNow(); },
    onError: (e) => toast("Couldn't start the sound: " + (e && e.message ? e.message : e)),
  });

  // =====================================================================
  // LIBRARY
  // =====================================================================
  async function openLibrary() {
    stopPlaying();
    clearInterval(S.pollId);
    S.song = null;
    history.replaceState(null, "", location.pathname + location.search);
    show("library");
    await renderLibrary();
    S.pollId = setInterval(renderLibrary, 3000);
  }

  async function renderLibrary() {
    let songs = [];
    try { songs = await api("/api/songs"); } catch (e) { return; }
    const box = $("#songs");
    box.innerHTML = "";
    const first = songs.length === 0;
    $("#welcome").hidden = !first;
    $("#shelf").hidden = first;
    $("#add-btn").hidden = first;
    for (const s of songs) {
      const b = document.createElement("button");
      b.className = "song-card";
      const busy = s.status === "queued" || s.status === "working";
      let state = s.pages === 1 ? "1 page" : `${s.pages} pages`;
      if (busy) state = s.message || "Reading…";
      if (s.status === "error") state = "Couldn't read it. Open it to try again.";
      b.innerHTML = `
        <div class="thumb">${s.thumb ? `<img src="${s.thumb}" alt="">` : ""}
          ${busy ? `<div class="bar-progress"><span style="width:${Math.round((s.progress || 0) * 100)}%"></span></div>` : ""}</div>
        <div class="name">${esc(s.title || "Untitled")}</div>
        <div class="state">${esc(state)}</div>`;
      b.onclick = () => openSong(s.id);
      box.append(b);
    }
  }

  $("#add-btn").onclick = () => openAdd();
  $("#add-first").onclick = () => openAdd();
  $("#demo-btn").onclick = async () => {
    try {
      const s = await postJSON("/api/demo", {});
      openSong(s.id);
    } catch (e) { toast("Couldn't open the sample: " + e.message); }
  };

  // =====================================================================
  // ADD A SONG
  // =====================================================================
  let upload = null;   // {upload, pages:[{n, thumb, music}]}
  let chosen = new Set();
  let pendingFiles = [];

  function openAdd() {
    clearInterval(S.pollId);
    upload = null;
    chosen = new Set();
    pendingFiles = [];
    $("#drop").hidden = false;
    $("#checking").hidden = true;
    $("#pick-pages").hidden = true;
    $("#title-input").value = "";
    show("add");
  }
  $$("[data-close-add]").forEach((b) => (b.onclick = openLibrary));

  $("#file-input").addEventListener("change", (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    if (files.length) addFiles(files);
  });
  const drop = $("#drop");
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    const files = [...e.dataTransfer.files];
    if (files.length) addFiles(files);
  });
  $("#add-more").onclick = () => $("#file-input").click();

  async function addFiles(files) {
    pendingFiles = pendingFiles.concat(files);
    $("#drop").hidden = true;
    $("#pick-pages").hidden = true;
    $("#checking").hidden = false;
    const fd = new FormData();
    pendingFiles.forEach((f) => fd.append("files", f, f.name || "page.jpg"));
    try {
      upload = await api("/api/uploads", { method: "POST", body: fd });
    } catch (e) {
      toast("Couldn't open those files: " + e.message);
      $("#checking").hidden = true;
      $("#drop").hidden = false;
      pendingFiles = [];
      return;
    }
    chosen = new Set(upload.pages.filter((p) => p.music).map((p) => p.n));
    if (!chosen.size) chosen = new Set(upload.pages.map((p) => p.n));
    if (!$("#title-input").value && files[0]) {
      const guess = files[0].name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").replace(/\s+\d+$/, "").trim();
      if (/[A-Za-z]{3}/.test(guess) && !/^(img|image|scan|photo|dsc)\b/i.test(guess)) $("#title-input").value = guess;
    }
    renderPicks();
    $("#checking").hidden = true;
    $("#pick-pages").hidden = false;
  }

  function renderPicks() {
    const box = $("#page-picks");
    box.innerHTML = "";
    for (const p of upload.pages) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pick" + (chosen.has(p.n) ? " on" : "");
      b.setAttribute("aria-pressed", chosen.has(p.n));
      b.innerHTML = `<img src="${p.thumb}" alt="Page ${p.n + 1}"><span class="tick">${chosen.has(p.n) ? "✓" : ""}</span>
        <span class="cap">Page ${p.n + 1}${p.music ? "" : " · no music found"}</span>`;
      b.onclick = () => { chosen.has(p.n) ? chosen.delete(p.n) : chosen.add(p.n); renderPicks(); };
      box.append(b);
    }
    $("#read-btn").disabled = chosen.size === 0;
  }

  $("#read-btn").onclick = async () => {
    const btn = $("#read-btn");
    btn.disabled = true;
    try {
      const song = await postJSON("/api/songs", {
        upload: upload.upload, title: $("#title-input").value, pages: [...chosen].sort((a, b) => a - b),
      });
      openSong(song.id);
    } catch (e) {
      toast(e.message);
      btn.disabled = false;
    }
  };

  // =====================================================================
  // SONG
  // =====================================================================
  async function openSong(id) {
    clearInterval(S.pollId);
    stopPlaying();
    let song;
    try { song = await api(`/api/songs/${id}`); } catch (e) { return openLibrary(); }
    S.song = song;
    history.replaceState(null, "", `${location.pathname}${location.search}#${id}`);
    show("song");
    $("#song-title").textContent = song.title;
    closeMenu();
    if (song.status !== "ready") return showReading(song);
    setupSong();
  }

  function showReading(song) {
    S.analysis = null;
    S.lines = [];
    $("#panel").hidden = true;
    $(".transport").hidden = true;
    $("#part-chip").hidden = true;
    renderPages();
    const banner = $("#banner");
    const update = (s) => {
      banner.hidden = false;
      banner.className = "banner";
      if (s.status === "error") {
        banner.innerHTML = `<p>Couldn't read this music: ${esc(s.message)}</p><button class="pill solid" id="b-retry">Try again</button>`;
      } else {
        const pct = Math.round((s.progress || 0) * 100);
        banner.innerHTML = `<p><strong>${s.job === "repair" ? "Checking the reading…" : "Reading the music…"}</strong> ${esc(s.message || "")} <span class="muted" style="color:rgba(255,255,255,.7)">${pct}%</span></p>
          <p class="small" style="color:rgba(255,255,255,.7)">You can leave this page; reading carries on.</p>`;
      }
      const r = $("#b-retry");
      if (r) r.onclick = rereadSong;
    };
    update(song);
    if (song.status === "queued" || song.status === "working") {
      S.pollId = setInterval(async () => {
        const s = await api(`/api/songs/${song.id}`).catch(() => null);
        if (!s || !S.song || S.song.id !== s.id) return;
        if (s.status === "ready") { clearInterval(S.pollId); openSong(s.id); return; }
        update(s);
      }, 2000);
    }
  }

  async function rereadSong() {
    if (!S.song) return;
    await api(`/api/songs/${S.song.id}/retry`, { method: "POST" });
    openSong(S.song.id);
  }

  function setupSong() {
    const song = S.song;
    $("#panel").hidden = false;
    $(".transport").hidden = false;
    S.lines = song.lines || [];
    const abc = Parts.sanitize(song.abc || "");
    try {
      S.vo = ABCJS.parseOnly(abc)[0];
      S.analysis = Parts.analyze(abc, S.vo.setUpAudio({}));
    } catch (e) {
      S.analysis = null;
    }
    if (!S.analysis || !S.analysis.parts.length) {
      renderPages();
      const banner = $("#banner");
      banner.hidden = false;
      banner.className = "banner";
      banner.innerHTML = `<p>No notes could be read from these pages. Try clearer, straighter photos.</p><button class="pill solid" id="b-retry">Read again</button>`;
      $("#b-retry").onclick = rereadSong;
      $("#panel").hidden = true;
      $(".transport").hidden = true;
      return;
    }
    S.abc = abc;
    // match the reading's voices to the staves printed on the page (by order and clef)
    const ref = (S.lines || []).find((L) => L.staves && L.staves.length && L.staves.every((st) => st.clef));
    if (ref) Parts.mapStaves(S.analysis, ref.staves.map((st) => st.clef));
    Parts.expression(S.analysis, abc, (S.lines || []).map((L) => L.start));
    buildBars();
    S.prefs = Object.assign({ step: 1, speed: 100, countIn: true, clicks: false, inst: { mine: 71, others: playing() ? 19 : 52 } }, song.settings || {});
    // Piano used to be the default for your part, but a piano note dies away, so you can't
    // hear how long it lasts. Move songs still on that old default to a sound that holds.
    if (!S.prefs.instHolds) {
      if (S.prefs.inst && +S.prefs.inst.mine === 0) S.prefs.inst = { ...S.prefs.inst, mine: 71 };
      S.prefs.instHolds = true;
    }
    if (!S.prefs.range || S.prefs.range.b > S.total + EPS) S.prefs.range = lineRange(firstPlayableLine());
    S.from = S.prefs.range.a;
    applyStep(S.prefs.step, false);
    syncSoundControls();
    renderPages();
    renderSteps();
    renderTimeline();
    updateRangeText();
    updateNow();
    if (!S.settings.voiceType) askVoice(() => afterVoice());
    else afterVoice();
  }

  function afterVoice() {
    Parts.applyVoicing(S.analysis, S.settings.voiceType);
    const maxStaff = Math.max(0, ...S.analysis.parts.map((p) => p.staff));
    if (S.prefs.sel && (!S.prefs.sel.part || S.prefs.sel.staff > maxStaff || S.prefs.sel.mapped !== true)) S.prefs.sel = null;   // older format
    if (!S.prefs.sel) {
      const guess = Parts.guessLine(S.analysis, S.settings.voiceType);
      if (guess) S.prefs.sel = { staff: guess.staff, part: guess.part, confirmed: false, mapped: true };
    }
    syncTransposition();
    updatePartChip();
    drawStatic();
    if (S.prefs.sel && !S.prefs.sel.confirmed) confirmBanner();
    else showNotice();
    savePrefs();
  }

  function showNotice() {
    const banner = $("#banner");
    if (S.song.notice) {
      banner.hidden = false;
      banner.className = "banner light";
      banner.innerHTML = `<p>${esc(S.song.notice)} Lines that couldn't be read are shaded on the page.</p><button class="pill small" id="b-ok">OK</button>`;
      $("#b-ok").onclick = () => { banner.hidden = true; S.song.notice = ""; };
    } else banner.hidden = true;
  }

  // ---------------------------------------------------------------- bars & time
  function buildBars() {
    S.bars = [];
    let n = 0;
    S.lines.forEach((L, li) => {
      if (L.start === null || L.start === undefined || !L.bars || !L.bars.length) return;
      let t = L.start;
      L.bars.forEach((d, k) => {
        S.bars.push({ n: ++n, line: li, k, start: t, dur: d });
        t += d;
      });
    });
    const last = S.bars[S.bars.length - 1];
    S.total = last ? last.start + last.dur : S.analysis.end;
  }
  const playable = (li) => S.lines[li] && S.lines[li].start !== null && S.lines[li].start !== undefined && S.lines[li].bars.length > 0;
  const firstPlayableLine = () => Math.max(0, S.lines.findIndex((L, i) => playable(i)));
  const lineDur = (li) => S.lines[li].bars.reduce((a, b) => a + b, 0);
  const lineRange = (li) => (playable(li) ? { a: S.lines[li].start, b: S.lines[li].start + lineDur(li) } : { a: 0, b: S.total });
  const barAt = (t) => {
    let found = S.bars[0];
    for (const b of S.bars) if (b.start <= t + EPS) found = b; else break;
    return found;
  };
  const lineAt = (t) => { const b = barAt(t); return b ? b.line : 0; };
  const lastBar = (r) => barAt(r.b - 1e-4);
  const snapToBar = (t) => { const b = barAt(t); return b ? b.start : 0; };

  function timeToX(li, t) {
    const L = S.lines[li];
    const X = L.bounds || [];
    const n = L.bars.length, p = X.length - 1, dur = lineDur(li) || 1;
    const f = Math.max(0, Math.min(1, (t - L.start) / dur));
    if (p < 1) return L.box[0] + f * (L.box[2] - L.box[0]);
    if (p === n) {
      let s = L.start;
      for (let k = 0; k < n; k++) {
        const d = L.bars[k];
        if (t < s + d - EPS || k === n - 1) {
          const g = Math.max(0, Math.min(1, (t - s) / (d || 1)));
          return X[k] + g * (X[k + 1] - X[k]);
        }
        s += d;
      }
    }
    const fp = f * p, j = Math.min(p - 1, Math.floor(fp));
    return X[j] + (fp - j) * (X[j + 1] - X[j]);
  }

  /** The printed bar (x0, x1) on the page that contains time t. */
  function printedBar(li, t) {
    const L = S.lines[li];
    const X = L.bounds || [];
    if (X.length < 2) return [L.box[0], L.box[2]];
    const x = timeToX(li, t);
    for (let j = 0; j < X.length - 1; j++) if (x < X[j + 1] - 0.5 || j === X.length - 2) return [X[j], X[j + 1]];
    return [X[0], X[X.length - 1]];
  }

  function xToTime(li, x) {
    const L = S.lines[li];
    const X = L.bounds || [];
    const n = L.bars.length, p = X.length - 1;
    if (p === n && n) {
      let s = L.start;
      for (let k = 0; k < n; k++) {
        if (x < X[k + 1] || k === n - 1) return s;
        s += L.bars[k];
      }
    }
    if (p >= 1) {
      let j = 0;
      while (j < p - 1 && x >= X[j + 1]) j++;
      return snapToBar(L.start + (j / p) * lineDur(li) + EPS);
    }
    return L.start;
  }

  // ---------------------------------------------------------------- pages & overlay
  function renderPages() {
    const box = $("#pages");
    box.innerHTML = "";
    const pages = (S.song && S.song.pages) || [];
    pages.forEach((p, pi) => {
      const div = document.createElement("div");
      div.className = "page";
      div.dataset.page = pi;
      div.innerHTML = `<img src="${pageUrl(S.song.id, p.file)}" alt="Page ${pi + 1}" width="${p.w}" height="${p.h}">
        <svg viewBox="0 0 ${p.w} ${p.h}" preserveAspectRatio="none">
          <defs><pattern id="hatch" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="14" height="14" fill="rgba(255,255,255,0.55)"/><line x1="0" y1="0" x2="0" y2="14" stroke="rgba(0,0,0,0.18)" stroke-width="5"/></pattern></defs>
          <g class="g-static"></g><g class="g-dyn"><rect class="ol-bar" width="0" height="0"/><rect class="ol-head" width="0" height="0"/></g><g class="g-pick"></g>
        </svg>`;
      box.append(div);
      const svg = $("svg", div);
      svg.addEventListener("click", (e) => onPageClick(e, pi, svg));
    });
    drawStatic();
  }

  function svgPoint(svg, e) {
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  }

  /** Which page staff (index) holds my part on line li. */
  function myStaffOn(li) {
    const sel = S.prefs && S.prefs.sel;
    if (!sel) return -1;
    const L = S.lines[li];
    const idx = (sel.staff || 1) - 1;          // staves are numbered top to bottom, as printed
    return idx < L.staves.length ? idx : -1;
  }

  function drawStatic() {
    if (!S.song) return;
    const range = S.prefs && S.prefs.range;
    for (const div of $$("#pages .page")) {
      const pi = +div.dataset.page;
      const g = $(".g-static", div);
      const gp = $(".g-pick", div);
      let html = "", pick = "";
      S.lines.forEach((L, li) => {
        if (L.page !== pi) return;
        const top = L.musicTop, h = L.musicBottom - L.musicTop;
        const x0 = L.box[0], w = L.box[2] - L.box[0];
        if (!playable(li)) {
          html += `<rect class="ol-failed" x="${x0}" y="${top}" width="${w}" height="${h}"/>`;
          html += `<text class="ol-failed-label" x="${(L.left || x0) + 8}" y="${top + 30}">Not read</text>`;
          return;
        }
        if (S.analysis) {
          if (range) {
            const a = Math.max(range.a, L.start), b = Math.min(range.b, L.start + lineDur(li));
            if (b > a + EPS) {
              const xa = a <= L.start + EPS ? (L.left || x0) : timeToX(li, a);
              const xb = b >= L.start + lineDur(li) - EPS ? (L.right || x0 + w) : timeToX(li, b);
              html += `<rect class="ol-range" x="${xa}" y="${top}" width="${Math.max(0, xb - xa)}" height="${h}"/>`;
            }
          }
          const ms = myStaffOn(li);
          if (ms >= 0) {
            // your part, shaded like a highlighter on your copy
            const st = L.staves[ms];
            const pad = (st.bottom - st.top) * 0.45;
            const xl = L.left || x0, xr = L.right || x0 + w;
            html += `<rect class="ol-mystaff" x="${xl}" y="${st.top - pad}" width="${xr - xl}" height="${st.bottom - st.top + 2 * pad}" rx="6"/>`;
          }
          html += `<rect class="ol-line" data-line="${li}" x="${x0}" y="${top}" width="${w}" height="${h}"/>`;
        }
        if (S.picking) {
          L.staves.forEach((st, si) => {
            pick += `<rect class="ol-staff" data-line="${li}" data-staff="${si}" x="${x0 + 6}" y="${st.y0}" width="${w - 12}" height="${st.y1 - st.y0}" rx="10"/>`;
          });
        }
      });
      g.innerHTML = html;
      gp.innerHTML = pick;
    }
    $("#pages").classList.toggle("picking", S.picking);
  }

  function drawDynamic() {
    for (const div of $$("#pages .page")) {
      const bar = $(".ol-bar", div), head = $(".ol-head", div);
      bar.setAttribute("width", 0);
      head.setAttribute("width", 0);
    }
    if (S.pos === null || !S.bars.length) return;
    const li = lineAt(S.pos);
    const L = S.lines[li];
    const div = $(`#pages .page[data-page="${L.page}"]`);
    if (!div) return;
    const x = timeToX(li, S.pos);
    const head = $(".ol-head", div);
    head.setAttribute("x", x - 2); head.setAttribute("y", L.musicTop);
    head.setAttribute("width", 4); head.setAttribute("height", L.musicBottom - L.musicTop);
    const ms = myStaffOn(li);
    const [bx0, bx1] = printedBar(li, S.pos);
    const bar = $(".ol-bar", div);
    if (ms >= 0) {
      const st = L.staves[ms];
      bar.setAttribute("x", bx0); bar.setAttribute("y", st.y0);
      bar.setAttribute("width", Math.max(0, bx1 - bx0)); bar.setAttribute("height", st.y1 - st.y0);
    }
    followLine(li);
  }

  /** Where a line of music is in the scrolling pages column (px). */
  function lineSpan(li) {
    const L = S.lines[li];
    const div = $(`#pages .page[data-page="${L.page}"]`);
    const img = div && $("img", div);
    if (!img) return null;
    const scale = img.clientWidth / (S.song.pages[L.page].w || 1);
    return [div.offsetTop + L.musicTop * scale, div.offsetTop + L.musicBottom * scale];
  }

  /**
   * Keep the line being played in view. In its last bar, also bring the line that comes
   * next into view (when both fit), so your eyes can move on before the music does.
   */
  function followLine(li) {
    if (Date.now() - S.userScrollAt < 2500) return;
    const col = $(".pages-col");
    const here = lineSpan(li);
    if (!here) return;
    let [yTop, yBot] = here;
    const L = S.lines[li];
    const r = S.prefs.range || { a: 0, b: S.total };
    const lastBarStart = L.start + lineDur(li) - L.bars[L.bars.length - 1];
    if (S.pos >= lastBarStart - EPS) {
      const end = L.start + lineDur(li);
      const next = end < r.b - EPS ? lineAt(end + EPS) : lineAt(r.a);
      const there = next !== li && playable(next) ? lineSpan(next) : null;
      if (there) {
        const top = Math.min(yTop, there[0]), bot = Math.max(yBot, there[1]);
        if (bot - top < col.clientHeight - 80) { yTop = top; yBot = bot; }
      }
    }
    const viewTop = col.scrollTop, viewBot = col.scrollTop + col.clientHeight;
    if (yTop < viewTop + 20 || yBot > viewBot - 20) {
      let top = yTop - col.clientHeight * 0.15;
      if (yBot > top + col.clientHeight - 30) top = Math.min(yTop - 20, yBot - col.clientHeight + 30);
      top = Math.round(Math.max(0, top));
      if (S.scrollTarget === top && Date.now() - S.autoScrolling < 1000) return;   // already on its way
      S.autoScrolling = Date.now();
      S.scrollTarget = top;
      col.scrollTo({ top, behavior: "smooth" });
    }
  }
  $(".pages-col").addEventListener("scroll", () => {
    if (!S.autoScrolling || Date.now() - S.autoScrolling > 1200) S.userScrollAt = Date.now();
  }, { passive: true });

  function onPageClick(e, pi, svg) {
    const target = e.target;
    if (S.picking && target.classList.contains("ol-staff")) {
      choosePart(+target.dataset.line, +target.dataset.staff, e);
      return;
    }
    if (!S.analysis) return;
    const li = target.dataset && target.dataset.line !== undefined ? +target.dataset.line : -1;
    if (li < 0 || !playable(li)) return;
    const pt = svgPoint(svg, e);
    const t = xToTime(li, pt.x);
    const r = S.prefs.range;
    if (e.shiftKey && r) {
      // extend the range to include this line
      const lr = lineRange(li);
      setRange({ a: Math.min(r.a, lr.a), b: Math.max(r.b, lr.b) }, t);
    } else if (r && t >= r.a - EPS && t < r.b - EPS && r.b - r.a > lineDur(li) - EPS) {
      seek(t);                            // inside a longer range: just move there
    } else {
      setRange(lineRange(li), t);
    }
  }

  /** Note name spelled for the key: D♭ rather than C♯ in a flat key. */
  const aOrAn = (w) => (/^[aeiou]/i.test(w) ? "an " : "a ") + w;

  function noteName(p) {
    let flats = false;
    try {
      const ks = S.vo.getKeySignature();
      flats = !!(ks && ks.accidentals && ks.accidentals.some((a) => a.acc === "flat"));
    } catch (e) {}
    return Parts.pitchName(p, flats);
  }

  // ---------------------------------------------------------------- your part
  function partLabel(sel) {
    if (!sel) return "Choose your part";
    const pos = sel.part === "upper" ? "upper notes" : sel.part === "lower" ? "lower notes" : "";
    return `Your part: staff ${sel.staff || 1}${pos ? ", " + pos : ""}`;
  }
  function updatePartChip() {
    const chip = $("#part-chip");
    chip.hidden = !S.analysis;
    chip.textContent = partLabel(S.prefs && S.prefs.sel);
  }
  $("#part-chip").onclick = () => startPicking();

  const ordinal = (n) => n + (n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th");

  /** "the 2nd staff from the top, lower notes" */
  function partWords(sel) {
    const label = Parts.staffLabel(S.analysis, sel.staff);
    const staff = `the ${ordinal(sel.staff || 1)} staff from the top${label ? ` (“${label}”)` : ""}`;
    if (sel.part === "upper") return `the upper notes on ${staff}`;
    if (sel.part === "lower") return `the lower notes on ${staff}`;
    return staff;
  }

  function confirmBanner() {
    const sel = S.prefs.sel;
    S.picking = true;                      // staves are tappable straight away
    drawStatic();
    const banner = $("#banner");
    banner.hidden = false;
    banner.className = "banner";
    banner.innerHTML = `<p><strong>Is the yellow staff your part?</strong> As ${esc(aOrAn(S.settings.voiceType || "singer"))}, we guessed ${esc(partWords(sel))}. If it's a different one, tap your staff on the page.</p>
      <button class="pill" id="b-hear">Hear it</button><button class="pill solid" id="b-yes">Yes, that's mine</button>`;
    $("#b-yes").onclick = () => { sel.confirmed = true; S.picking = false; closePopover(); drawStatic(); savePrefs(); showNotice(); };
    $("#b-hear").onclick = () => hearSel(sel);
    scrollToLine(firstPlayableLine());
  }

  function startPicking() {
    stopPlaying();
    S.picking = true;
    drawStatic();
    const banner = $("#banner");
    banner.hidden = false;
    banner.className = "banner";
    banner.innerHTML = `<p><strong>${words("Tap the staff you sing")}</strong> on the page. Your part now is shaded yellow.</p><button class="pill" id="b-cancel">Cancel</button>`;
    $("#b-cancel").onclick = () => { S.picking = false; drawStatic(); closePopover(); S.prefs.sel && S.prefs.sel.confirmed ? showNotice() : confirmBanner(); };
  }

  let popover = null;
  function closePopover() { if (popover) { popover.remove(); popover = null; } }

  function choosePart(li, si, e) {
    closePopover();
    const staffNum = si + 1;
    const opts = Parts.lines(S.analysis, staffNum);
    if (!opts.length) { toast("No notes were read on that staff. Try another line or staff."); return; }
    const pick = (o) => {
      S.prefs.sel = { staff: staffNum, part: o.part, confirmed: true, mapped: true };
      syncTransposition();
      S.picking = false;
      closePopover();
      drawStatic();
      updatePartChip();
      savePrefs();
      showNotice();
      toast(partLabel(S.prefs.sel));
    };
    if (opts.length === 1) return pick(opts[0]);
    popover = document.createElement("div");
    popover.className = "popover";
    popover.innerHTML = `<p>Two parts share this staff. Which is yours?</p>` + opts.map((o, i) => `
      <div class="row"><button class="pill small" data-hear="${i}">▶ Hear</button><button class="pill small solid" data-pick="${i}">${o.part === "upper" ? "Upper notes" : "Lower notes"}</button></div>`).join("");
    document.body.append(popover);
    const x = Math.min(window.innerWidth - 270, e.clientX + 12), y = Math.min(window.innerHeight - 200, e.clientY + 12);
    popover.style.left = x + "px";
    popover.style.top = y + "px";
    $$("[data-pick]", popover).forEach((b) => (b.onclick = () => pick(opts[+b.dataset.pick])));
    $$("[data-hear]", popover).forEach((b) => (b.onclick = () => hearSel({ staff: staffNum, part: opts[+b.dataset.hear].part }, li)));
  }

  /** Play a few bars of a part on its own. */
  async function hearSel(sel, li) {
    stopPlaying();
    const line = li !== undefined && playable(li) ? li : firstPlayableLine();
    const { mine } = Parts.divide(S.analysis, sel);
    // Start right on the part's first note from this line on (a line often opens with rests or a
    // piano introduction, which would mean seconds of silence), and play about 8 seconds of it.
    const a = S.lines[line].start;
    const first = mine.filter((n) => n.start >= a - EPS).reduce((m, n) => (!m || n.start < m.start ? n : m), null);
    if (!first) return toast("That part has no notes from here on.");
    const span = 8 / secPerWhole();
    const notes = mine.filter((n) => n.start >= first.start - EPS && n.start < first.start + span)
      .map((n) => ({ pitch: n.pitch, start: n.start - first.start, duration: n.duration }));
    try { await player.blip(notes, secPerWhole(), +S.prefs.inst.mine); } catch (e) { toast("Couldn't play: " + e.message); }
  }

  function askVoice(done) {
    const dlg = $("#voice-dlg");
    const box = $("#voice-opts");
    box.innerHTML = "";
    for (const [title, list] of [["Voices", VOICES], ["Instruments", PLAYS]]) {
      const h = document.createElement("div");
      h.className = "opts-title";
      h.textContent = title;
      box.append(h);
      for (const v of list) {
        const b = document.createElement("button");
        b.className = "pill" + (S.settings.voiceType === v ? " solid" : "");
        b.textContent = v;
        b.onclick = async () => {
          S.settings = await putJSON("/api/settings", { voiceType: v });
          dlg.close();
          renderSteps();
          done && done();
        };
        box.append(b);
      }
    }
    dlg.showModal();
  }

  // ---------------------------------------------------------------- range
  /** After a change: restart if playing; if paused, drop the paused pass. */
  function replay() {
    if (player.state === "playing" || player.state === "loading") { play(true); return true; }
    if (player.state === "paused") { stopPlaying(); }
    return false;
  }

  function setRange(r, from) {
    S.prefs.range = { a: r.a, b: r.b };
    S.from = from !== undefined && from >= r.a - EPS && from < r.b - EPS ? from : r.a;
    drawStatic();
    renderTimeline();
    updateRangeText();
    savePrefs();
    if (!replay()) { S.pos = null; drawDynamic(); updateNow(); }
  }

  function seek(t) {
    S.from = snapToBar(t);
    if (!replay()) { S.pos = null; drawDynamic(); updateNow(); renderTimeline(); }
  }

  function describeRange(r) {
    const b0 = barAt(r.a), b1 = lastBar(r);
    if (!b0 || !b1) return { main: "—", sub: "" };
    const L0 = S.lines[b0.line], L1 = S.lines[b1.line];
    const lineNo = (li) => S.lines.filter((L, i) => L.page === S.lines[li].page && i <= li).length;
    const whole = Math.abs(r.a - S.bars[0].start) < EPS && Math.abs(r.b - S.total) < EPS;
    const main = whole ? "Whole piece" : b0.n === b1.n ? `Bar ${b0.n}` : `Bars ${b0.n}–${b1.n}`;
    let sub = b0.line === b1.line ? `Page ${L0.page + 1}, line ${lineNo(b0.line)}` :
      `Page ${L0.page + 1} line ${lineNo(b0.line)} to page ${L1.page + 1} line ${lineNo(b1.line)}`;
    if (whole) sub = `Bars 1–${S.bars.length}`;
    return { main, sub };
  }

  function updateRangeText() {
    const r = S.prefs.range;
    const d = describeRange(r);
    $("#range-text").innerHTML = `${esc(d.main)}<span class="muted">${esc(d.sub)}</span>`;
    const li = lineAt(r.a);
    const isLine = playable(li) && Math.abs(r.a - S.lines[li].start) < EPS && Math.abs(r.b - (S.lines[li].start + lineDur(li))) < EPS;
    const isSong = Math.abs(r.a - (S.bars[0] ? S.bars[0].start : 0)) < EPS && Math.abs(r.b - S.total) < EPS;
    $("#range-line").classList.toggle("active", isLine);
    $("#range-song").classList.toggle("active", isSong && !isLine);
  }

  $("#range-line").onclick = () => setRange(lineRange(lineAt(S.pos !== null ? S.pos : S.from)));
  $("#range-song").onclick = () => setRange({ a: S.bars[0].start, b: S.total });
  $("#range-bars").onclick = () => {
    const f = $("#bars-form");
    f.hidden = !f.hidden;
    if (!f.hidden) {
      const r = S.prefs.range;
      $("#bar-from").value = barAt(r.a).n;
      $("#bar-to").value = lastBar(r).n;
      $("#bar-from").max = $("#bar-to").max = S.bars.length;
      $("#bar-from").focus();
    }
  };
  $("#bars-form").addEventListener("submit", (e) => {
    e.preventDefault();
    let f = Math.max(1, Math.min(S.bars.length, +$("#bar-from").value || 1));
    let t = Math.max(1, Math.min(S.bars.length, +$("#bar-to").value || f));
    if (t < f) [f, t] = [t, f];
    const b0 = S.bars[f - 1], b1 = S.bars[t - 1];
    setRange({ a: b0.start, b: b1.start + b1.dur });
    $("#bars-form").hidden = true;
    scrollToLine(b0.line);
  });
  function moveLine(dir) {
    const cur = lineAt(S.prefs.range.a);
    let li = cur + dir;
    while (li >= 0 && li < S.lines.length && !playable(li)) li += dir;
    if (li < 0 || li >= S.lines.length) return;
    setRange(lineRange(li));
    scrollToLine(li);
  }
  $("#prev-line").onclick = () => moveLine(-1);
  $("#next-line").onclick = () => moveLine(1);

  function scrollToLine(li) {
    const L = S.lines[li];
    if (!L) return;
    const div = $(`#pages .page[data-page="${L.page}"]`);
    if (!div) return;
    const img = $("img", div);
    const go = () => {
      const scale = img.clientWidth / (S.song.pages[L.page].w || 1);
      S.autoScrolling = Date.now();
      $(".pages-col").scrollTo({ top: Math.max(0, div.offsetTop + L.musicTop * scale - 90) });
    };
    img.complete ? go() : img.addEventListener("load", go, { once: true });
  }

  // ---------------------------------------------------------------- timeline
  function renderTimeline() {
    const tl = $("#timeline");
    if (!S.bars.length) { tl.innerHTML = ""; return; }
    const pct = (t) => (100 * (t - S.bars[0].start)) / (S.total - S.bars[0].start || 1);
    let html = `<div class="tl-track"></div>`;
    const r = S.prefs.range;
    html += `<div class="tl-range" style="left:${pct(r.a)}%;width:${pct(r.b) - pct(r.a)}%"></div>`;
    let lastPage = -1;
    const every = S.bars.length > 80 ? 8 : S.bars.length > 40 ? 4 : 2;
    for (const b of S.bars) {
      html += `<div class="tl-tick" style="left:${pct(b.start)}%"></div>`;
      const page = S.lines[b.line].page;
      if (page !== lastPage) { html += `<div class="tl-page" style="left:${pct(b.start)}%">p.${page + 1}</div>`; lastPage = page; }
      if (b.n === 1 || b.n % every === 0) html += `<div class="tl-bar" style="left:${pct(b.start)}%">${b.n}</div>`;
    }
    html += `<div class="tl-handle" data-h="a" style="left:${pct(r.a)}%"></div><div class="tl-handle" data-h="b" style="left:${pct(r.b)}%"></div>`;
    html += `<div class="tl-head" id="tl-head" style="left:${pct(S.pos !== null ? S.pos : S.from)}%"></div>`;
    tl.innerHTML = html;
  }

  (function timelineInput() {
    const tl = $("#timeline");
    let drag = null;
    const timeAt = (e) => {
      const rect = tl.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      return S.bars[0].start + f * (S.total - S.bars[0].start);
    };
    const nearestBoundary = (t) => {
      let best = S.bars[0].start, bd = Infinity;
      for (const b of S.bars) for (const x of [b.start, b.start + b.dur]) if (Math.abs(x - t) < bd) { bd = Math.abs(x - t); best = x; }
      return best;
    };
    tl.addEventListener("pointerdown", (e) => {
      if (!S.bars.length) return;
      const h = e.target.dataset && e.target.dataset.h;
      if (h) { drag = h; tl.setPointerCapture(e.pointerId); e.preventDefault(); return; }
      const t = timeAt(e);
      const r = S.prefs.range;
      if (t >= r.a - EPS && t < r.b - EPS) seek(t);
      else setRange(lineRange(lineAt(t)), snapToBar(t));
      scrollToLine(lineAt(t));
    });
    tl.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const t = nearestBoundary(timeAt(e));
      const r = { ...S.prefs.range };
      if (drag === "a") r.a = Math.min(t, r.b - (lastBar(r) ? lastBar(r).dur : 0.25));
      else r.b = Math.max(t, r.a + (barAt(r.a) ? barAt(r.a).dur : 0.25));
      S.prefs.range = r;
      renderTimeline();
      updateRangeText();
    });
    const end = () => {
      if (!drag) return;
      drag = null;
      setRange(S.prefs.range);
    };
    tl.addEventListener("pointerup", end);
    tl.addEventListener("pointercancel", end);
  })();

  function moveHead() {
    const head = $("#tl-head");
    if (!head || !S.bars.length) return;
    const t = S.pos !== null ? S.pos : S.from;
    head.style.left = (100 * (t - S.bars[0].start)) / (S.total - S.bars[0].start || 1) + "%";
  }

  // ---------------------------------------------------------------- steps & sound
  function renderSteps() {
    const ol = $("#steps");
    ol.innerHTML = "";
    for (const st of STEPS) {
      const li = document.createElement("li");
      li.innerHTML = `<button class="step" aria-pressed="${S.prefs.step === st.n}"><span class="num">${st.n}</span>
        <span><strong>${words(st.name)}</strong><span class="d">${words(st.d)}</span></span></button>`;
      $("button", li).onclick = () => { applyStep(st.n, true); };
      ol.append(li);
    }
    updateStepHint();
  }

  function applyStep(n, user) {
    const st = STEPS[n - 1];
    S.prefs.step = n;
    S.prefs.vol = { mine: st.mine, others: st.others };
    syncSoundControls();
    if (user) {
      renderSteps();
      savePrefs();
      if (!replay()) updateNow();
    }
  }

  function updateStepHint() {
    const n = S.prefs.step;
    const hints = {
      1: "Listen once, then sing the same notes back while it's quiet. Repeat until you can sing it without hesitating.",
      2: "Sing with your part until it feels easy, then move on.",
      3: "By round 5 your part is silent. If you drift, go back a round by pressing play again.",
      4: "Listen to the last note: if it matches what you're singing, you held your line.",
      5: "This is rehearsal: you get your note, then you're on your own.",
    };
    $("#step-hint").innerHTML = esc(words(hints[n])) + (n < 5 ? ` <button class="pill small" id="next-step" style="margin-top:8px">Next step</button>` : "");
    const nb = $("#next-step");
    if (nb) nb.onclick = () => applyStep(n + 1, true);
  }

  function syncSoundControls() {
    const st = STEPS[S.prefs.step - 1];
    const vm = $("#vol-mine"), vo = $("#vol-others");
    vm.value = Math.round(S.prefs.vol.mine * 100);
    vo.value = Math.round(S.prefs.vol.others * 100);
    vm.disabled = !!st.lockMine;
    vo.disabled = !!st.lockOthers;
    $("#vol-mine-out").textContent = st.lockMine ? "off" : vm.value + "%";
    $("#vol-others-out").textContent = st.lockOthers ? "off" : vo.value + "%";
    $$("#speed button").forEach((b) => b.setAttribute("aria-pressed", +b.dataset.speed === S.prefs.speed));
    $("#count-in").checked = S.prefs.countIn;
    $("#phrasing").checked = S.prefs.phrasing !== false;
    $("#clicks").checked = S.prefs.clicks;
    $("#inst-mine").value = S.prefs.inst.mine;
    $("#inst-others").value = S.prefs.inst.others;
    $("#bpm").value = baseBpm();
  }

  const changed = () => { savePrefs(); player.refreshNext(); };
  $("#vol-mine").addEventListener("input", (e) => { S.prefs.vol.mine = e.target.value / 100; $("#vol-mine-out").textContent = e.target.value + "%"; });
  $("#vol-others").addEventListener("input", (e) => { S.prefs.vol.others = e.target.value / 100; $("#vol-others-out").textContent = e.target.value + "%"; });
  $("#vol-mine").addEventListener("change", changed);
  $("#vol-others").addEventListener("change", changed);
  $$("#speed button").forEach((b) => (b.onclick = () => {
    S.prefs.speed = +b.dataset.speed;
    syncSoundControls();
    savePrefs();
    if (!replay()) updateNow();
  }));
  $("#count-in").onchange = (e) => { S.prefs.countIn = e.target.checked; changed(); };
  $("#phrasing").onchange = (e) => { S.prefs.phrasing = e.target.checked; changed(); };
  $("#clicks").onchange = (e) => { S.prefs.clicks = e.target.checked; changed(); };
  $("#inst-mine").onchange = (e) => { S.prefs.inst.mine = +e.target.value; changed(); };
  $("#inst-others").onchange = (e) => { S.prefs.inst.others = +e.target.value; changed(); };
  $("#bpm").onchange = (e) => {
    const v = Math.max(30, Math.min(240, +e.target.value || 80));
    S.prefs.bpm = v;
    e.target.value = v;
    savePrefs();
    replay();
  };

  function baseBpm() {
    if (S.prefs && S.prefs.bpm) return S.prefs.bpm;
    const t = S.vo && S.vo.metaText && S.vo.metaText.tempo;
    if (t && t.bpm) {
      const beat = t.duration && t.duration.length ? t.duration.reduce((a, b) => a + b, 0) : 0.25;
      return Math.round(t.bpm * beat * 4);
    }
    return 80;
  }
  /** Seconds per whole note at the chosen speed (bpm counts quarter notes). */
  const secPerWhole = () => (4 * 60) / (baseBpm() * (S.prefs ? S.prefs.speed : 100) / 100);

  function savePrefs() {
    clearTimeout(S.saveId);
    const id = S.song && S.song.id;
    S.saveId = setTimeout(() => {
      if (!id || !S.prefs) return;
      putJSON(`/api/songs/${id}`, { settings: S.prefs }).catch(() => {});
    }, 400);
  }

  // ---------------------------------------------------------------- playing
  function makePass(round) {
    syncTransposition();
    const r = S.prefs.range;
    const from = round === 0 ? S.from : r.a;
    const meter = S.vo && S.vo.getMeterFraction ? S.vo.getMeterFraction() : { num: 4, den: 4 };
    const pass = Parts.buildPass({
      analysis: S.analysis, sel: S.prefs.sel, a: r.a, b: r.b, from, step: S.prefs.step, round,
      vol: S.prefs.vol, inst: { mine: +S.prefs.inst.mine, others: +S.prefs.inst.others },
      beat: Parts.beatOf(meter), countIn: S.prefs.countIn, clicks: S.prefs.clicks,
      bars: S.bars.map((x) => ({ start: x.start, dur: x.dur, first: x.k === 0 })),
      phrasing: S.prefs.phrasing !== false,
    });
    pass.from = from;
    return pass;
  }

  function play(restart) {
    if (!S.analysis || !S.prefs.sel) { startPicking(); return; }
    if (!restart && player.state === "paused") { player.resume(); setPlayState("playing"); return; }
    setPlayState("loading");
    player.play(makePass, secPerWhole()).then(() => {
      if (player.state === "playing") setPlayState("playing");
    });
  }
  function stopPlaying() { player.stop(true); setPlayState("stopped"); S.pos = null; showTurn(false); }

  function setPlayState(s) {
    const b = $("#play");
    b.classList.toggle("on", s === "playing" || s === "loading");
    b.classList.toggle("loading", s === "loading");
    b.setAttribute("aria-label", s === "playing" ? "Pause" : "Play");
  }

  $("#play").onclick = () => {
    if (player.state === "playing") { player.pause(); setPlayState("paused"); }
    else play(false);
  };

  function tick({ pass, t, round }) {
    const m = pass.marks;
    let phase, pos = null;
    if (t < m.musicStart) { phase = S.prefs.step === 5 && t < m.musicStart - Parts.beatOf(S.vo.getMeterFraction()).beats * Parts.beatOf(S.vo.getMeterFraction()).beatLen ? "chord" : "count"; pos = pass.from; }
    else if (t < m.musicEnd) { phase = "music"; pos = pass.from + (t - m.musicStart); }
    else if (m.gapStart !== undefined && t < m.gapEnd) { phase = "echo"; pos = S.prefs.range.a + (t - m.gapStart); }
    else if (m.checkStart !== undefined) { phase = "check"; pos = null; }
    else { phase = "end"; pos = null; }
    S.phase = phase;
    S.round = round;
    S.pos = pos;
    showTurn(phase === "echo");
    S.lastPass = pass;
    drawDynamic();
    moveHead();
    updateNow();
  }

  /** A clear sign while the music is silent for you to sing back. */
  function showTurn(on) {
    document.body.classList.toggle("echo", on);
    const el = $("#turn");
    if (!on) { el.hidden = true; return; }
    const r = S.prefs.range, b0 = barAt(r.a), b1 = lastBar(r);
    const bars = b0 && b1 ? (b0.n === b1.n ? `bar ${b0.n}` : `bars ${b0.n}–${b1.n}`) : "";
    const now = S.pos !== null ? barAt(S.pos) : null;
    el.innerHTML = `${words("Your turn: sing it back")}<small>${bars}${now ? ` · now bar ${now.n}` : ""}</small>`;
    el.hidden = false;
  }

  function updateNow() {
    const now = $("#now-text");
    const st = S.prefs ? S.prefs.step : 1;
    if (player.state === "stopped" || S.pos === null && !["check", "chord", "count"].includes(S.phase)) {
      const b = S.bars.length ? barAt(S.from) : null;
      now.textContent = player.state === "stopped" ? (b ? `Ready · starts at bar ${b.n}` : "Ready") : now.textContent;
      if (player.state === "stopped") $("#round-text").textContent = "";
      return;
    }
    const b = S.pos !== null ? barAt(S.pos) : null;
    const texts = {
      chord: "Starting notes, lowest part first — find yours",
      count: "Count-in…",
      music: st === 1 ? `Listen · bar ${b && b.n}` : st === 5 ? `${words("Sing")} · bar ${b && b.n}` : `Bar ${b && b.n}`,
      echo: `${words("Your turn: sing it back")} (silent) · bar ${b && b.n}`,
      check: S.lastPass && S.lastPass.marks.checkPitch ? `Check: your last note was ${myNoteName(S.lastPass.marks.checkPitch)}` : "Check note",
      end: "",
    };
    now.textContent = texts[S.phase] || "";
  }

  function updateRound() {
    const st = S.prefs.step;
    let t = S.lastPass && S.lastPass.label ? S.lastPass.label : `Round ${S.round + 1}`;
    if (st === 3) {
      const pct = Math.round(Parts.FADE[Math.min(S.round, Parts.FADE.length - 1)] * 100);
      t += pct ? ` · your part at ${pct}%` : " · your part is off";
    }
    $("#round-text").textContent = t;
  }

  $("#my-note").onclick = async () => {
    if (!S.analysis || !S.prefs.sel) return startPicking();
    const n = Parts.firstNote(S.analysis, S.prefs.sel, S.pos !== null ? S.pos : S.from);
    if (!n) return toast("Your part has no notes from here.");
    try {
      await player.blip([{ pitch: n.pitch, start: 0, duration: 0.5 }], 3, +S.prefs.inst.mine);
      toast(`Your note: ${myNoteName(n.pitch)}`);
    } catch (e) { toast("Couldn't play the note: " + e.message); }
  };

  // ---------------------------------------------------------------- header: title, menu
  $("#back").onclick = openLibrary;
  $("#song-title").addEventListener("blur", async (e) => {
    const t = e.target.textContent.trim();
    if (S.song && t && t !== S.song.title) {
      S.song.title = t;
      await putJSON(`/api/songs/${S.song.id}`, { title: t });
    }
  });
  $("#song-title").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } });

  function closeMenu() { $("#menu").hidden = true; $("#menu-btn").setAttribute("aria-expanded", "false"); }
  $("#menu-btn").onclick = (e) => {
    e.stopPropagation();
    const m = $("#menu");
    m.hidden = !m.hidden;
    $("#menu-btn").setAttribute("aria-expanded", String(!m.hidden));
  };
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".menu-wrap")) closeMenu();
    if (popover && !e.target.closest(".popover") && !e.target.classList.contains("ol-staff")) closePopover();
  });
  $$("#menu [data-action]").forEach((b) => (b.onclick = async () => {
    closeMenu();
    const a = b.dataset.action;
    if (a === "notes") openNotes();
    if (a === "missed") {
      try { await api(`/api/songs/${S.song.id}/repair`, { method: "POST" }); openSong(S.song.id); }
      catch (e) { toast("Couldn't start: " + e.message); }
    }
    if (a === "reread") {
      if (confirm("Read the music again? This replaces the current reading, including any notes you edited.")) rereadSong();
    }
    if (a === "voice") askVoice(() => {
      if (!S.analysis) return;
      const g = Parts.guessLine(S.analysis, S.settings.voiceType);
      Parts.applyVoicing(S.analysis, S.settings.voiceType);
      if (g) S.prefs.sel = { staff: g.staff, part: g.part, confirmed: false, mapped: true };
      syncTransposition();
      updatePartChip(); drawStatic(); savePrefs(); confirmBanner();
    });
    if (a === "delete") {
      if (!confirm(`Delete “${S.song.title}” and its pages?`)) return;
      await api(`/api/songs/${S.song.id}`, { method: "DELETE" });
      openLibrary();
    }
  }));

  // ---------------------------------------------------------------- check the notes
  function openNotes() {
    if (!S.analysis) return;
    const dlg = $("#notes-dlg");
    dlg.showModal();
    const sel = S.prefs.sel;
    // grey out everything except my part
    const locate = Parts.voiceLocator(S.abc);
    const tunes = ABCJS.renderAbc("notes-score", S.abc, { add_classes: true, responsive: "resize", staffwidth: Math.min(940, window.innerWidth - 80) });
    const vo = tunes[0];
    for (const line of vo.lines || []) for (const st of line.staff || []) for (const v of st.voices || []) for (const el of v) {
      if (!el.abselem || el.startChar === undefined || (el.el_type !== "note" && el.el_type !== "rest")) continue;
      const part = S.analysis.parts.find((p) => p.id === locate(el.startChar));
      const mine = sel && part && part.staff === sel.staff;
      for (const g of el.abselem.elemset || []) g.classList.toggle("gray", !mine);
    }
    $("#abc-edit").value = S.song.abc;
    $("#abc-msg").textContent = "";
  }
  $$("#notes-dlg [data-close]").forEach((b) => (b.onclick = () => $("#notes-dlg").close()));
  $("#abc-save").onclick = async () => {
    const abc = $("#abc-edit").value;
    S.song = await putJSON(`/api/songs/${S.song.id}`, { abc });
    $("#abc-msg").textContent = "Saved.";
    $("#notes-dlg").close();
    setupSong();
  };

  // ---------------------------------------------------------------- keyboard
  document.addEventListener("keydown", (e) => {
    if ($("#song").hidden || e.target.closest("input,textarea,select,[contenteditable],dialog")) return;
    if (e.code === "Space") { e.preventDefault(); $("#play").click(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); moveLine(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); moveLine(1); }
    else if (/^[1-5]$/.test(e.key)) applyStep(+e.key, true);
    else if (e.key === "Escape" && S.picking) $("#b-cancel") && $("#b-cancel").click();
  });

  window.addEventListener("resize", () => { if (S.song) drawDynamic(); });

  // ---------------------------------------------------------------- boot
  (async () => {
    try { S.settings = await api("/api/settings"); } catch (e) { S.settings = {}; }
    const id = location.hash.slice(1) || (DEMO && DEMO.openSong) || "";
    if (DEMO) document.body.classList.add("demo");
    if (id) openSong(id); else openLibrary();
  })();
})();
