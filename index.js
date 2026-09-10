const express = require("express");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = parseInt(process.env.PORT) || 7001;
const BASE_PATH = process.env.BASE_PATH || "";
const PUBLIC_URL = process.env.PUBLIC_URL || `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") return res.end();
  next();
});

function parseConfig(encoded) {
  try {
    return JSON.parse(decodeURIComponent(encoded));
  } catch {
    return {};
  }
}

function getListEntries(config) {
  if (!config.userId) return [];
  const data = loadData(config.userId);

  if (data._lists && data._lists.length > 0) return data._lists;

  const entries = [];
  for (let i = 1; i <= 10; i++) {
    const name = config[`list${i}`];
    if (name && name.trim()) entries.push({ key: `list${i}`, name: name.trim() });
  }

  if (entries.length > 0) {
    data._lists = entries;
    saveData(config.userId, data);
  }
  return entries;
}

function nextListKey(lists) {
  let max = 0;
  for (const l of lists) {
    const m = l.key.match(/^list(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1]));
  }
  return `list${max + 1}`;
}

function getDataPath(userId) {
  return path.join(DATA_DIR, userId.replace(/[^a-zA-Z0-9_-]/g, "_") + ".json");
}

function loadData(userId) {
  try {
    return JSON.parse(fs.readFileSync(getDataPath(userId), "utf8"));
  } catch {
    return {};
  }
}

function saveData(userId, data) {
  fs.writeFileSync(getDataPath(userId), JSON.stringify(data, null, 2));
}

const metaCache = new Map();

function baseId(id) {
  if (id.startsWith("tt") && id.includes(":")) return id.split(":")[0];
  return id;
}

async function fetchMeta(type, id) {
  const bid = baseId(id);
  const ck = `${type}:${bid}`;
  const hit = metaCache.get(ck);
  if (hit && Date.now() - hit.ts < 3600000) return hit.data;

  let meta = { id: bid, type, name: bid };

  if (bid.startsWith("tt")) {
    try {
      const res = await fetch(
        `https://v3-cinemeta.strem.io/meta/${type}/${bid}.json`
      );
      const d = await res.json();
      if (d.meta)
        meta = {
          id: d.meta.id,
          type: d.meta.type,
          name: d.meta.name,
          poster: d.meta.poster,
        };
    } catch {}
  } else if (id.startsWith("scaryo:")) {
    const slug = id.replace("scaryo:", "");
    meta.name = slug
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  metaCache.set(ck, { data: meta, ts: Date.now() });
  return meta;
}

function buildManifest(config) {
  const lists = getListEntries(config);
  return {
    id: "community.watchlists" + (config.userId ? "." + config.userId.replace(/[^a-zA-Z0-9]/g, "") : ""),
    version: "1.0.0",
    name: "Watchlists",
    description:
      "Create and manage multiple named watchlists inside Stremio.",
    resources: ["catalog", "stream"],
    types: ["movie", "series"],
    catalogs: [
      ...lists.map((l) => ({
        id: `wl-${l.key}`,
        type: "movie",
        name: l.name,
        extra: [{ name: "skip", isRequired: false }],
      })),
      ...lists.map((l) => ({
        id: `wl-${l.key}`,
        type: "series",
        name: l.name,
        extra: [{ name: "skip", isRequired: false }],
      })),
    ],
    idPrefixes: ["tt", "scaryo:"],
    behaviorHints: {
      configurable: true,
      configurationRequired: !(config.userId && lists.length > 0),
    },
    config: [
      {
        key: "userId",
        type: "text",
        title: "Username (identifies your lists)",
        required: true,
      },
      ...Array.from({ length: 10 }, (_, i) => ({
        key: `list${i + 1}`,
        type: "text",
        title: `Watchlist ${i + 1}`,
        required: i === 0,
      })),
    ],
  };
}

app.get("/:config/manifest.json", (req, res) => {
  res.json(buildManifest(parseConfig(req.params.config)));
});

function handleCatalog(req, res) {
  const config = parseConfig(req.params.config);
  if (!config.userId) return res.json({ metas: [] });
  const type = req.params.type;
  const listKey = req.params.id.replace("wl-", "");
  const data = loadData(config.userId);
  const items = (data[listKey] || []).filter((i) => i.type === type);

  let skip = 0;
  if (req.params.extra) {
    const m = req.params.extra.match(/skip=(\d+)/);
    if (m) skip = parseInt(m[1]);
  }

  res.json({
    metas: items.slice(skip, skip + 50).map((item) => ({
      id: item.id,
      type: item.type,
      name: item.name,
      poster: item.poster || undefined,
    })),
  });
}

app.get("/:config/catalog/:type/:id.json", handleCatalog);
app.get("/:config/catalog/:type/:id/:extra.json", handleCatalog);

app.get("/:config/stream/:type/:id.json", (req, res) => {
  const config = parseConfig(req.params.config);
  if (!config.userId) return res.json({ streams: [] });
  const type = req.params.type;
  const bid = baseId(req.params.id);
  const lists = getListEntries(config);
  const data = loadData(config.userId);

  const streams = [];
  for (const l of lists) {
    const items = data[l.key] || [];
    const inList = items.some((i) => i.id === bid);
    const action = inList ? "remove" : "add";
    const icon = inList ? "−" : "+";
    const label = inList ? `Remove from ${l.name}` : `Add to ${l.name}`;

    streams.push({
      externalUrl: `${PUBLIC_URL}/${action}/${encodeURIComponent(config.userId)}/${l.key}/${type}/${encodeURIComponent(bid)}?ln=${encodeURIComponent(l.name)}`,
      name: `[${icon}] ${l.name} (${config.userId})`,
      description: label,
    });
  }

  streams.push({
    externalUrl: `${PUBLIC_URL}/settings/${encodeURIComponent(config.userId)}`,
    name: `Manage Lists (${config.userId})`,
    description: "Add, rename or delete watchlists",
  });

  res.json({ streams });
});

app.get("/manage/:configEnc/:type/:id", async (req, res) => {
  let conf;
  try {
    conf = JSON.parse(decodeURIComponent(req.params.configEnc));
  } catch {
    return res.status(400).send("Invalid config");
  }
  const { userId, lists } = conf;
  const type = req.params.type;
  const id = decodeURIComponent(req.params.id);

  const meta = await fetchMeta(type, id);
  const data = loadData(userId);

  const listButtons = lists
    .map((l) => {
      const items = data[l.key] || [];
      const inList = items.some((i) => i.id === id);
      const action = inList ? "remove" : "add";
      const icon = inList ? "−" : "+";
      const label = inList ? `Remove from ${esc(l.name)}` : `Add to ${esc(l.name)}`;
      const url = `${PUBLIC_URL}/${action}/${encodeURIComponent(userId)}/${l.key}/${type}/${encodeURIComponent(id)}?ln=${encodeURIComponent(l.name)}`;
      const cls = inList ? "btn remove" : "btn add";
      return `<a href="${esc(url)}" class="${cls}"><span class="icon">${icon}</span> ${label}</a>`;
    })
    .join("\n");

  res.setHeader("Content-Type", "text/html");
  res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Watchlists</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#1a1a2e;color:#e0e0e0;font-family:system-ui,sans-serif;
display:flex;align-items:center;justify-content:center;min-height:100vh;padding:1rem}
.card{background:#16213e;border-radius:12px;padding:2rem;text-align:center;
max-width:400px;width:100%;box-shadow:0 4px 20px rgba(0,0,0,.4)}
.poster{width:140px;border-radius:8px;margin-bottom:1rem;box-shadow:0 2px 12px rgba(0,0,0,.5)}
h1{font-size:1.3rem;margin-bottom:.3rem;color:#a78bfa}
.type{font-size:.85rem;opacity:.5;margin-bottom:1.2rem;text-transform:capitalize}
.btn{display:block;padding:.8rem 1.2rem;margin:.5rem 0;border-radius:8px;
text-decoration:none;font-size:1rem;font-weight:600;transition:opacity .15s}
.btn:hover{opacity:.85}
.btn.add{background:#2d6a4f;color:#fff}
.btn.remove{background:#6b2d3e;color:#fff}
.icon{font-size:1.2rem;vertical-align:middle;margin-right:.3rem}
.note{font-size:.8rem;opacity:.5;margin-top:1.2rem}
</style></head><body>
<div class="card">
${meta.poster ? `<img class="poster" src="${esc(meta.poster)}" alt="">` : ""}
<h1>${esc(meta.name)}</h1>
<div class="type">${esc(type)} &middot; ${esc(userId)}</div>
${listButtons}
<p class="note">Pick a list, then close this tab.</p>
</div>
</body></html>`);
});

app.get("/add/:userId/:listKey/:type/:id", async (req, res) => {
  const userId = decodeURIComponent(req.params.userId);
  const { listKey, type } = req.params;
  const id = decodeURIComponent(req.params.id);
  const listName = req.query.ln || listKey;

  const meta = await fetchMeta(type, id);
  const data = loadData(userId);
  if (!data[listKey]) data[listKey] = [];

  if (!data[listKey].some((i) => i.id === id)) {
    data[listKey].push({
      id: meta.id,
      type: meta.type || type,
      name: meta.name,
      poster: meta.poster || "",
      addedAt: Date.now(),
    });
    saveData(userId, data);
  }

  res.setHeader("Content-Type", "text/html");
  res.end(confirmPage(`Added "${esc(meta.name)}" to ${esc(listName)}`));
});

app.get("/remove/:userId/:listKey/:type/:id", (req, res) => {
  const userId = decodeURIComponent(req.params.userId);
  const { listKey } = req.params;
  const id = decodeURIComponent(req.params.id);
  const listName = req.query.ln || listKey;

  const data = loadData(userId);
  const items = data[listKey] || [];
  const item = items.find((i) => i.id === id);
  data[listKey] = items.filter((i) => i.id !== id);
  saveData(userId, data);

  res.setHeader("Content-Type", "text/html");
  res.end(
    confirmPage(`Removed "${esc(item?.name || id)}" from ${esc(listName)}`)
  );
});

function esc(s) {
  return String(s).replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function confirmPage(msg) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Watchlists</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#1a1a2e;color:#e0e0e0;font-family:system-ui,sans-serif;
display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#16213e;border-radius:12px;padding:2rem 3rem;text-align:center;
max-width:90%;box-shadow:0 4px 20px rgba(0,0,0,.4)}
h1{font-size:1.4rem;margin-bottom:.5rem;color:#a78bfa}
p{font-size:1rem;opacity:.7}
</style></head><body>
<div class="card"><h1>${msg}</h1><p>You can close this tab and return to Stremio.</p></div>
</body></html>`;
}

app.get("/api/:userId/lists", (req, res) => {
  const userId = decodeURIComponent(req.params.userId);
  const data = loadData(userId);
  const lists = data._lists || [];
  res.json(lists.map((l) => ({
    key: l.key,
    name: l.name,
    count: (data[l.key] || []).length,
  })));
});

app.get("/api/:userId/lists/add", (req, res) => {
  const userId = decodeURIComponent(req.params.userId);
  const name = (req.query.name || "").trim();
  if (!name) return res.status(400).json({ error: "Name required" });
  const data = loadData(userId);
  if (!data._lists) data._lists = [];
  const key = nextListKey(data._lists);
  data._lists.push({ key, name });
  if (!data[key]) data[key] = [];
  saveData(userId, data);
  res.json({ ok: true, key, name });
});

app.get("/api/:userId/lists/rename/:listKey", (req, res) => {
  const userId = decodeURIComponent(req.params.userId);
  const { listKey } = req.params;
  const name = (req.query.name || "").trim();
  if (!name) return res.status(400).json({ error: "Name required" });
  const data = loadData(userId);
  if (!data._lists) return res.status(404).json({ error: "No lists" });
  const entry = data._lists.find((l) => l.key === listKey);
  if (!entry) return res.status(404).json({ error: "List not found" });
  entry.name = name;
  saveData(userId, data);
  res.json({ ok: true, key: listKey, name });
});

app.get("/api/:userId/lists/delete/:listKey", (req, res) => {
  const userId = decodeURIComponent(req.params.userId);
  const { listKey } = req.params;
  const data = loadData(userId);
  if (!data._lists) return res.status(404).json({ error: "No lists" });
  const idx = data._lists.findIndex((l) => l.key === listKey);
  if (idx === -1) return res.status(404).json({ error: "List not found" });
  const removed = data._lists.splice(idx, 1)[0];
  delete data[listKey];
  saveData(userId, data);
  res.json({ ok: true, removed: removed.name });
});

app.get("/settings/:userId", (req, res) => {
  const userId = decodeURIComponent(req.params.userId);
  res.setHeader("Content-Type", "text/html");
  res.end(settingsPage(userId));
});

function settingsPage(userId) {
  const apiBase = `${PUBLIC_URL}/api/${encodeURIComponent(userId)}/lists`;
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Watchlists - ${esc(userId)}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#1a1a2e;color:#e0e0e0;font-family:system-ui,sans-serif;
display:flex;justify-content:center;padding:2rem 1rem;min-height:100vh}
.card{background:#16213e;border-radius:12px;padding:2rem;
max-width:460px;width:100%;box-shadow:0 4px 20px rgba(0,0,0,.4);align-self:flex-start}
h1{font-size:1.5rem;color:#a78bfa;margin-bottom:.3rem}
.sub{opacity:.6;margin-bottom:1.5rem;font-size:.9rem}
.list-item{display:flex;align-items:center;gap:.5rem;padding:.6rem .8rem;
background:#1a1a2e;border-radius:8px;margin-bottom:.5rem}
.list-item .name{flex:1;font-size:1rem;font-weight:600}
.list-item .count{font-size:.8rem;opacity:.5;margin-right:.5rem}
.list-item button{background:none;border:none;color:#e0e0e0;cursor:pointer;
font-size:.9rem;padding:.3rem .5rem;border-radius:4px;opacity:.7;transition:all .15s}
.list-item button:hover{opacity:1}
.list-item .rename:hover{background:#2d6a4f}
.list-item .delete:hover{background:#6b2d3e}
.add-row{display:flex;gap:.5rem;margin-top:1rem}
.add-row input{flex:1;padding:.6rem;font-size:1rem;background:#1a1a2e;border:1px solid #333;
color:#fff;border-radius:6px}
.add-row input:focus{outline:none;border-color:#a78bfa}
.add-row button{padding:.6rem 1rem;background:#a78bfa;color:#fff;border:none;
border-radius:6px;font-weight:600;cursor:pointer;white-space:nowrap}
.add-row button:hover{background:#8b5cf6}
.empty{text-align:center;opacity:.5;padding:1.5rem 0}
.toast{position:fixed;bottom:1.5rem;left:50%;transform:translateX(-50%);
background:#2d6a4f;color:#fff;padding:.6rem 1.5rem;border-radius:8px;
font-weight:600;opacity:0;transition:opacity .3s;pointer-events:none}
.toast.show{opacity:1}
.note{font-size:.8rem;opacity:.4;margin-top:1.2rem;text-align:center}
</style></head><body>
<div class="card">
<h1>Manage Lists</h1>
<div class="sub">${esc(userId)}</div>
<div id="lists"></div>
<div class="add-row">
<input id="newName" placeholder="New list name...">
<button onclick="addList()">Add</button>
</div>
<p class="note">Changes take effect immediately in Stremio. New catalogs appear after restarting Stremio.</p>
</div>
<div class="toast" id="toast"></div>
<script>
const API=${JSON.stringify(apiBase)};
function toast(msg){const t=document.getElementById("toast");t.textContent=msg;t.classList.add("show");setTimeout(()=>t.classList.remove("show"),2000)}
async function load(){
  const r=await fetch(API);const lists=await r.json();
  const el=document.getElementById("lists");
  if(!lists.length){el.innerHTML='<div class="empty">No lists yet. Add one below.</div>';return}
  el.innerHTML=lists.map(l=>\`<div class="list-item" data-key="\${l.key}">
    <span class="name">\${esc(l.name)}</span>
    <span class="count">\${l.count} items</span>
    <button class="rename" onclick="renameList('\${l.key}','\${esc(l.name).replace(/'/g,"\\\\'")}')">Rename</button>
    <button class="delete" onclick="deleteList('\${l.key}','\${esc(l.name).replace(/'/g,"\\\\'")}')">Delete</button>
  </div>\`).join("");
}
function esc(s){const d=document.createElement("span");d.textContent=s;return d.innerHTML}
async function addList(){
  const inp=document.getElementById("newName");
  const name=inp.value.trim();if(!name)return;
  await fetch(API+"/add?name="+encodeURIComponent(name));
  inp.value="";toast("Added "+name);load();
}
async function renameList(key,oldName){
  const name=prompt("Rename list:",oldName);if(!name||!name.trim())return;
  await fetch(API+"/rename/"+key+"?name="+encodeURIComponent(name.trim()));
  toast("Renamed to "+name.trim());load();
}
async function deleteList(key,name){
  if(!confirm("Delete \\""+name+"\\" and all its items?"))return;
  await fetch(API+"/delete/"+key);
  toast("Deleted "+name);load();
}
document.getElementById("newName").addEventListener("keydown",e=>{if(e.key==="Enter")addList()});
load();
</script></body></html>`;
}

app.get("/configure", (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Watchlists - Stremio Addon</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#1a1a2e;color:#e0e0e0;font-family:system-ui,sans-serif;padding:2rem;display:flex;justify-content:center}
.c{max-width:420px;width:100%}
h1{font-size:2rem;color:#a78bfa;margin-bottom:.3rem}
.sub{opacity:.7;margin-bottom:2rem;line-height:1.4}
label{display:block;margin-bottom:.3rem;font-size:.9rem;opacity:.8}
input{width:100%;padding:.6rem;font-size:1rem;background:#16213e;border:1px solid #333;
color:#fff;border-radius:6px;margin-bottom:1rem}
input:focus{outline:none;border-color:#a78bfa}
button{width:100%;padding:.8rem;font-size:1.1rem;background:#a78bfa;color:#fff;border:none;
border-radius:8px;cursor:pointer;font-weight:600;margin-top:.5rem}
button:hover{background:#8b5cf6}
.note{font-size:.8rem;opacity:.5;margin-top:1rem;text-align:center}
</style></head><body>
<div class="c">
<h1>Watchlists</h1>
<p class="sub">Create named watchlists inside Stremio. Add or remove movies from any movie&#39;s stream page.</p>
<form id="f">
<label>Username *</label>
<input name="userId" required placeholder="Pick a username">
<label>Watchlist 1 *</label>
<input name="list1" required placeholder="e.g. Horror Queue">
<label>Watchlist 2</label>
<input name="list2" placeholder="e.g. Weekend Picks">
<label>Watchlist 3</label>
<input name="list3" placeholder="e.g. Classics">
<label>Watchlist 4</label>
<input name="list4">
<label>Watchlist 5</label>
<input name="list5">
</form>
<a id="lnk" href="#"><button>INSTALL IN STREMIO</button></a>
<p class="note">Add more lists later by reconfiguring the addon.</p>
</div>
<script>
const f=document.getElementById("f"),a=document.getElementById("lnk");
function u(){
  const d=Object.fromEntries(new FormData(f));
  Object.keys(d).forEach(k=>{if(!d[k])delete d[k]});
  a.href="stremio://"+location.host+"${BASE_PATH}/"+encodeURIComponent(JSON.stringify(d))+"/manifest.json";
}
f.addEventListener("input",u);u();
a.onclick=()=>f.reportValidity();
</script></body></html>`);
});

app.listen(PORT, () => {
  console.log(`Watchlists addon running on port ${PORT}`);
  console.log(`Configure: ${PUBLIC_URL}/configure`);
});
