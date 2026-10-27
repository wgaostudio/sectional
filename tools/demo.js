/* Runs the Sectional app without its server, for the published demo: answers the app's
   /api/ requests from a song that was read ahead of time (songs/<id>/meta.json), and keeps
   what the visitor changes (their part, the steps, sound settings) in this browser only. */
(function () {
  "use strict";
  const SONG = "__SONG_ID__";
  const base = new URL("songs/", location.href).href;
  const KEY = "sectional-demo:";
  const store = {
    get(k, d) { try { const v = localStorage.getItem(KEY + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(KEY + k, JSON.stringify(v)); } catch (e) {} },
  };
  const realFetch = window.fetch.bind(window);
  let meta = null;
  async function song() {
    if (!meta) meta = await (await realFetch(base + SONG + "/meta.json")).json();
    return { ...meta, ...store.get("edits:" + SONG, {}), settings: store.get("song:" + SONG, {}) };
  }
  const reply = (body, status) => new Response(JSON.stringify(body), { status: status || 200, headers: { "Content-Type": "application/json" } });

  window.SECTIONAL_DEMO = { openSong: SONG, pageUrl: (id, file) => base + id + "/" + file };

  window.fetch = async (input, init) => {
    init = init || {};
    const u = new URL(typeof input === "string" ? input : input.url, location.href);
    const at = u.pathname.indexOf("/api/");
    if (at < 0) return realFetch(input, init);
    const path = u.pathname.slice(at);
    const method = (init.method || "GET").toUpperCase();
    const body = () => { try { return JSON.parse(init.body || "{}"); } catch (e) { return {}; } };
    if (path === "/api/status") return reply({ engine: { ready: true }, queue: 0 });
    if (path === "/api/settings") {
      if (method === "PUT") store.set("settings", { ...store.get("settings", {}), ...body() });
      return reply(store.get("settings", {}));
    }
    if (path === "/api/songs" && method === "GET") {
      const m = await song();
      return reply([{ id: m.id, title: m.title, status: "ready", progress: 1, pages: m.pages.length, thumb: base + SONG + "/thumb.jpg" }]);
    }
    if (path === "/api/songs/" + SONG) {
      if (method === "PUT") {
        const b = body();
        if (b.settings) store.set("song:" + SONG, b.settings);
        const edits = store.get("edits:" + SONG, {});
        if (b.title) edits.title = b.title;
        if (b.abc) edits.abc = b.abc;
        store.set("edits:" + SONG, edits);
      }
      return reply(await song());
    }
    return reply({ detail: "This demo plays music that was read ahead of time. To read your own, run Sectional on your computer." }, 400);
  };
})();
