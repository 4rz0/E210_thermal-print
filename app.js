import { E210, buildJob, DOTS_PER_MM, HEAD_DOTS, transports } from "./printer.js";

const $ = (id) => document.getElementById(id);
const printer = new E210();
let mode = "text";
let image = null; // HTMLImageElement

// name, print width, label height, paper type, paper (roll / backing) width
const PRESETS = [
  ["Receipt roll 58 mm", 48, 0, "continuous", 58], ["Receipt roll 52 mm", 48, 0, "continuous", 52],
  ["Label 30 × 20", 30, 20, "gap", 34], ["Label 40 × 20", 40, 20, "gap", 44],
  ["Label 40 × 30", 40, 30, "gap", 44], ["Label 40 × 40", 40, 40, "gap", 44],
  ["Label 40 × 60", 40, 60, "gap", 44], ["Label 48 × 30", 48, 30, "gap", 52],
  ["Label 50 × 30 (prints 48)", 48, 30, "gap", 54], ["Custom", null, null, null, null],
];

// ---------- settings persistence ----------------------------------------------
const FIELDS = ["text", "textSize", "textAlign", "textFont", "textBold", "dither", "bright", "contrast", "imgFit",
  "qrText", "qrCaption", "bcText", "bcType", "bcShowText", "media", "preset", "pmm", "wmm", "hmm", "rotate", "density",
  "copies", "border", "invert", "feedmm"];
function save() {
  try {
    const s = { mode };
    for (const f of FIELDS) { const el = $(f); s[f] = el.type === "checkbox" ? el.checked : el.value; }
    localStorage.setItem("e210", JSON.stringify(s));
  } catch {}
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem("e210") || "null");
    if (!s) return false;
    for (const f of FIELDS) if (f in s) { const el = $(f); if (el.type === "checkbox") el.checked = s[f]; else el.value = s[f]; }
    if (s.mode) setMode(s.mode);
    return true;
  } catch { return false; }
}

// ---------- UI wiring ---------------------------------------------------------------
PRESETS.forEach(([n], i) => $("preset").append(new Option(n, i)));
document.querySelectorAll(".tabs button").forEach((b) => b.onclick = () => { setMode(b.dataset.mode); render(); save(); });
function setMode(m) {
  mode = m;
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.mode === m));
  document.querySelectorAll("[data-pane]").forEach((p) => p.hidden = p.dataset.pane !== m);
}
$("preset").onchange = () => {
  const p = PRESETS[+$("preset").value];
  if (p[1] != null) { $("wmm").value = p[1]; $("hmm").value = p[2] || 30; $("media").value = p[3]; $("pmm").value = p[4]; }
  syncMedia(); render(); save();
};
$("media").onchange = () => { syncMedia(); render(); save(); };
function syncMedia() { const c = $("media").value === "continuous"; $("hwrap").hidden = c; $("fwrap").hidden = !c; }
["wmm", "hmm", "pmm"].forEach((id) => $(id).addEventListener("input", () => { $("preset").value = PRESETS.length - 1; }));
document.querySelectorAll("input, select, textarea").forEach((el) => {
  if (el.type === "file") return;
  el.addEventListener("input", () => { $("densityVal").textContent = $("density").value; render(); save(); });
});

$("imgFile").onchange = (e) => e.target.files[0] && loadImage(e.target.files[0]);
window.addEventListener("paste", (e) => {
  const f = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith("image/"));
  if (f) { setMode("image"); loadImage(f); }
});
const drop = $("drop");
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault(); drop.classList.remove("over");
  const f = [...e.dataTransfer.files].find((f) => f.type.startsWith("image/"));
  if (f) { setMode("image"); loadImage(f); }
});
function loadImage(file) {
  const img = new Image();
  img.onload = () => { image = img; render(); };
  img.src = URL.createObjectURL(file);
}

// ---------- rendering -------------------------------------------------------------
// Draw the content on a canvas of the label size in dots, then turn it into 1-bit.
let bits = null, bw = 0, bh = 0;

function labelDots() {
  const w = Math.min(HEAD_DOTS, Math.max(8, Math.round(+$("wmm").value * DOTS_PER_MM)));
  const cont = $("media").value === "continuous";
  const h = cont ? null : Math.max(8, Math.round(+$("hmm").value * DOTS_PER_MM));
  return { w, h, cont };
}

function fontStr(px) {
  return `${$("textBold").checked ? "bold " : ""}${px}px ${$("textFont").value}`;
}

// Content is drawn in an "upright" box (cw x ch); rotation maps it onto the label.
function drawContent(ctx, cw, ch, cont) {
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cw, ch);
  ctx.fillStyle = "#000";
  const pad = 6;
  if (mode === "text") {
    const lines = $("text").value.split("\n");
    const align = $("textAlign").value;
    let px = $("textSize").value === "fit" ? fitText(ctx, lines, cw - 2 * pad, ch ? ch - 2 * pad : 1e9) : +$("textSize").value;
    ctx.font = fontStr(px);
    const lh = Math.round(px * 1.15);
    const wrapped = cont ? wrap(ctx, lines, cw - 2 * pad) : lines;
    const total = lh * wrapped.length;
    const H = ch ?? total + 2 * pad;
    if (ch == null) return { needH: H };
    ctx.textBaseline = "middle"; ctx.textAlign = align;
    const x = align === "left" ? pad : align === "right" ? cw - pad : cw / 2;
    let y = (ch - total) / 2 + lh / 2;
    for (const l of wrapped) { ctx.fillText(l, x, y); y += lh; }
  } else if (mode === "image") {
    if (!image) {
      if (ch == null) return { needH: 120 };
      ctx.fillStyle = "#999"; ctx.font = "20px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("Choose a picture", cw / 2, ch / 2); return;
    }
    if (ch == null) return { needH: Math.round(image.height * cw / image.width) };
    const s = $("imgFit").value === "cover" ? Math.max(cw / image.width, ch / image.height) : Math.min(cw / image.width, ch / image.height);
    const w = image.width * s, h = image.height * s;
    ctx.filter = `brightness(${100 + +$("bright").value}%) contrast(${100 + +$("contrast").value}%)`;
    ctx.drawImage(image, (cw - w) / 2, (ch - h) / 2, w, h);
    ctx.filter = "none";
  } else if (mode === "qr") {
    const q = qrcode(0, "M"); q.addData($("qrText").value || " "); q.make();
    const n = q.getModuleCount();
    const cap = $("qrCaption").value.trim();
    const side = ch == null ? Math.min(cw, 384) : Math.min(cw, ch);
    if (ch == null) return { needH: (cap ? Math.round(cw * 0.6) : side) };
    const capW = cap ? Math.round(cw * 0.45) : 0;
    const box = Math.min(cw - capW, ch) - 2 * pad;
    const m = Math.max(1, Math.floor(box / (n + 2)));
    const size = m * n;
    const ox = cap ? pad + m : Math.round((cw - size) / 2), oy = Math.round((ch - size) / 2);
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) ctx.fillRect(ox + c * m, oy + r * m, m, m);
    if (cap) {
      const lines = cap.split("\n");
      const avail = cw - (ox + size) - 2 * pad;
      const px = fitText(ctx, lines, avail, ch - 2 * pad);
      ctx.font = fontStr(px); ctx.textBaseline = "middle"; ctx.textAlign = "left";
      const lh = px * 1.15; let y = ch / 2 - (lh * (lines.length - 1)) / 2;
      for (const l of lines) { ctx.fillText(l, ox + size + pad * 2, y); y += lh; }
    }
  } else if (mode === "barcode") {
    if (ch == null) return { needH: 120 };
    const c = document.createElement("canvas");
    try {
      JsBarcode(c, $("bcText").value, { format: $("bcType").value, displayValue: $("bcShowText").checked,
        margin: 0, width: 2, height: 100, fontSize: 22, font: "sans-serif", fontOptions: "bold" });
    } catch {
      ctx.fillStyle = "#000"; ctx.font = "18px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("Invalid for " + $("bcType").value, cw / 2, ch / 2); return;
    }
    // scale bars by whole dots so they stay crisp
    const k = Math.max(1, Math.floor((cw - 2 * pad) / (c.width / 2)));
    const k2 = Math.min(k, Math.max(1, Math.floor((cw - 2 * pad) * 2 / c.width))) / 2;
    const w = c.width * k2, h = Math.min(ch - 2 * pad, c.height * Math.max(k2, (ch - 2 * pad) / c.height));
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(c, Math.round((cw - w) / 2), Math.round((ch - h) / 2), Math.round(w), Math.round(h));
  }
}

function fitText(ctx, lines, maxW, maxH) {
  for (let px = Math.min(200, maxH); px > 8; px -= 2) {
    ctx.font = fontStr(px);
    const wOk = lines.every((l) => ctx.measureText(l).width <= maxW);
    if (wOk && px * 1.15 * lines.length <= maxH) return px;
  }
  return 10;
}
function wrap(ctx, lines, maxW) {
  const out = [];
  for (const para of lines) {
    let line = "";
    for (const word of para.split(" ")) {
      const t = line ? line + " " + word : word;
      if (!line || ctx.measureText(t).width <= maxW) line = t; else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}

function render() {
  const { w, h, cont } = labelDots();
  const rot = +$("rotate").value;
  const sideways = rot === 90 || rot === 270;
  // upright content size
  let cw = sideways ? h : w, ch = sideways ? w : h;
  const tmp = document.createElement("canvas");
  let tctx = tmp.getContext("2d", { willReadFrequently: true });
  if (cont) {
    // continuous: the free dimension follows the content
    if (sideways) { ch = w; cw = 600; } // sideways text on a roll: fixed 75 mm long
    else { const r = drawContent(tctx, cw, null, true); ch = Math.max(16, Math.min(8000, r?.needH || 120)); }
  }
  tmp.width = cw; tmp.height = ch;
  tctx = tmp.getContext("2d", { willReadFrequently: true });
  drawContent(tctx, cw, ch, cont);

  // rotate onto label canvas
  const W = sideways ? ch : cw, H = sideways ? cw : ch;
  const cv = $("cv"); cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
  ctx.save(); ctx.translate(W / 2, H / 2); ctx.rotate(rot * Math.PI / 180); ctx.drawImage(tmp, -cw / 2, -ch / 2); ctx.restore();

  // 1-bit conversion
  const id = ctx.getImageData(0, 0, W, H);
  const g = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const a = id.data[i * 4 + 3] / 255;
    g[i] = (id.data[i * 4] * 0.299 + id.data[i * 4 + 1] * 0.587 + id.data[i * 4 + 2] * 0.114) * a + 255 * (1 - a);
  }
  const out = new Uint8Array(W * H);
  const dither = mode === "image" && $("dither").value === "fs";
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, v = g[i], b = v < 128 ? 1 : 0;
    out[i] = b;
    if (dither) {
      const e = v - (b ? 0 : 255);
      if (x + 1 < W) g[i + 1] += e * 7 / 16;
      if (y + 1 < H) { if (x) g[i + W - 1] += e * 3 / 16; g[i + W] += e * 5 / 16; if (x + 1 < W) g[i + W + 1] += e / 16; }
    }
  }
  if ($("invert").checked) for (let i = 0; i < out.length; i++) out[i] ^= 1;
  if ($("border").checked) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++)
    if (x < 3 || y < 3 || x >= W - 3 || y >= H - 3) out[y * W + x] = 1;
  for (let i = 0; i < W * H; i++) { const c = out[i] ? 0 : 255; id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = c; id.data[i * 4 + 3] = 255; }
  ctx.putImageData(id, 0, 0);
  bits = out; bw = W; bh = H;
  drawPreview(cv, W, H, cont);
  const pmm = +$("pmm").value || 58;
  $("dims").textContent = `Print ${(W / DOTS_PER_MM).toFixed(0)} × ${(H / DOTS_PER_MM).toFixed(0)} mm on ${pmm} mm paper` +
    (cont ? " · roll: length follows the content" : "");
}

// To-scale picture of the paper: roll or label backing, the 48 mm print head
// area centred on it, and the printed image where it will land.
const PREVIEW_PX_PER_MM = 6;
function drawPreview(src, W, H, cont) {
  const D = DOTS_PER_MM;
  const paper = Math.round(Math.max(10, +$("pmm").value || 58) * D);
  const CW = Math.max(paper, HEAD_DOTS) + 2 * D;            // 1 mm of air left and right
  const lead = 4 * D;                                       // paper shown above and below
  const CH = H + 2 * lead;
  const pv = $("pv"); pv.width = CW; pv.height = CH;
  pv.style.width = Math.round(CW / D * PREVIEW_PX_PER_MM) + "px";
  const g = pv.getContext("2d");
  const paperX = Math.round((CW - paper) / 2), headX = Math.round((CW - HEAD_DOTS) / 2);
  const css = getComputedStyle(document.documentElement);
  g.clearRect(0, 0, CW, CH);

  if (cont) {
    g.fillStyle = "#fff"; g.fillRect(paperX, 0, paper, CH);
  } else {
    // label backing, this label centred on it, and the ends of its neighbours
    const gap = 3 * D, lx = paperX + Math.round((paper - W) / 2);
    g.fillStyle = "#efe9dc"; g.fillRect(paperX, 0, paper, CH);
    g.fillStyle = "#fff";
    roundRect(g, lx, lead, W, H, D); g.fill();
    roundRect(g, lx, lead - gap - 4 * D, W, 4 * D, D); g.fill();
    roundRect(g, lx, lead + H + gap, W, 4 * D, D); g.fill();
  }
  // outside the print head: never printed
  g.fillStyle = "rgba(220, 38, 38, 0.10)";
  if (headX > paperX) { g.fillRect(paperX, 0, headX - paperX, CH); g.fillRect(headX + HEAD_DOTS, 0, paperX + paper - headX - HEAD_DOTS, CH); }

  // the printed image: black dots only
  const cx = paperX + Math.round((paper - W) / 2);  // the app centres every print on the head
  const img = src.getContext("2d").getImageData(0, 0, W, H);
  const tmp = g.getImageData(cx, lead, W, H);
  for (let i = 0; i < W * H; i++) if (img.data[i * 4] < 128) { tmp.data[i * 4] = tmp.data[i * 4 + 1] = tmp.data[i * 4 + 2] = 20; tmp.data[i * 4 + 3] = 255; }
  g.putImageData(tmp, cx, lead);

  // print area outline and mm ruler along the top edge of the paper
  g.strokeStyle = css.getPropertyValue("--accent").trim() || "#2563eb";
  g.lineWidth = 2; g.setLineDash([6, 4]); g.strokeRect(cx + 1, lead + 1, W - 2, H - 2); g.setLineDash([]);
  g.fillStyle = "#9aa4af";
  for (let mm = 0; mm * D <= paper; mm++) {
    const len = mm % 10 === 0 ? 3 * D / 2 : mm % 5 === 0 ? D : D / 2;
    g.fillRect(paperX + mm * D, 0, 1, len);
  }
}
function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

// ---------- printer actions -------------------------------------------------------------
function log(msg, cls = "") { const p = $("log"); p.textContent = msg; p.className = "log " + cls; }
function setConnected(name) {
  const on = !!name;
  $("state").textContent = on ? "Connected: " + name : "Not connected";
  $("state").className = "pill " + (on ? "on" : "off");
  ["btnPrint", "btnFeed", "btnStatus"].forEach((id) => $(id).disabled = !on);
  $("btnDisc").hidden = !on; $("btnBle").hidden = on; $("btnSerial").hidden = on || !transports.serial.available();
  $("stConn").textContent = on ? name + " (" + (connKind === "ble" ? "Bluetooth" : "COM port") + ")" : "Not connected";
  if (!on) { stopPolling(); for (const id of ["stState", "stPaper", "stLid", "stHead", "stRaw"]) setSt(id, "–"); }
}

// ---------- status panel ----------------------------------------------------------
let connKind = null, busy = false, pollTimer = null, lastPaperOut = null;
function setSt(id, text, cls = "") { const el = $(id); el.textContent = text; el.className = cls; }
async function refreshStatus() {
  if (!printer.connected || busy) return;
  busy = true;
  try {
    const s = await printer.status();
    if (!s.raw) { setSt("stState", "No answer from the printer", "bad"); return; }
    setSt("stState", s.paperOut ? "Not ready" : s.other ? "Busy" : "Ready", s.ok ? "good" : "bad");
    setSt("stPaper", s.paperOut ? "Out of paper (or lid open)" : "Loaded", s.paperOut ? "bad" : "good");
    setSt("stLid", "No lid sensor: an open lid shows up as \"out of paper\"");
    setSt("stRaw", s.raw + " (updates every 2 s)");
    if (s.paperOut && lastPaperOut === false) log("The printer reports no paper. Check the roll and close the lid.", "err");
    lastPaperOut = s.paperOut;
  } catch { /* ignore, next poll retries */ }
  finally { busy = false; }
}
function startPolling() { stopPolling(); refreshStatus(); pollTimer = setInterval(refreshStatus, 2000); }
function stopPolling() { clearInterval(pollTimer); pollTimer = null; lastPaperOut = null; }
async function whenIdle() { while (busy) await new Promise((r) => setTimeout(r, 50)); busy = true; }
async function connect(kind) {
  try {
    log("Connecting…");
    connKind = kind;
    const name = await printer.connect(kind, () => { setConnected(null); log("Printer disconnected.", "err"); });
    setConnected(name);
    const p = await printer.params();
    if (p) setSt("stHead", `${p.dpi} dpi, prints 48 mm (384 dots)`);
    const s = await printer.status();
    log(s.ok ? "Connected, printer is ready." : "Connected, printer status: " + s.text, s.ok ? "ok" : "err");
    startPolling();
  } catch (e) {
    setConnected(null);
    if (e.name !== "NotFoundError") log("Could not connect: " + e.message, "err"); else log("");
  }
}
$("btnBle").onclick = () => connect("ble");
$("btnSerial").onclick = () => connect("serial");
$("btnDisc").onclick = async () => { await printer.disconnect(); setConnected(null); log(""); };
$("btnStatus").onclick = async () => {
  await refreshStatus(); log("Status updated.", "ok");
};
$("btnFeed").onclick = async () => {
  await whenIdle();
  try { if ($("media").value === "continuous") await printer.feed(10); else await printer.nextLabel(); }
  finally { busy = false; }
};
$("btnPrint").onclick = async () => {
  render();
  const media = $("media").value;
  const job = buildJob(bits, bw, bh, {
    density: +$("density").value, media, copies: Math.max(1, Math.min(99, +$("copies").value || 1)),
    feedMM: Math.max(0, Math.min(100, +$("feedmm").value || 0)),
    labelW: +$("wmm").value, labelH: media === "continuous" ? bh / DOTS_PER_MM : +$("hmm").value,
  });
  await whenIdle();
  const st = await printer.status().catch(() => ({}));
  if (st.paperOut) { busy = false; refreshStatus(); log("Can't print: the printer reports no paper (or an open lid).", "err"); return; }
  const bar = $("progress"); bar.hidden = false;
  $("btnPrint").disabled = true;
  try {
    log("Printing…");
    await printer.send(job, (f) => bar.firstElementChild.style.width = (f * 100).toFixed(0) + "%");
    await new Promise((r) => setTimeout(r, 600));
    const errs = printer.errors();
    log(errs.length ? "Printer reported an error (code " + errs.map((e) => e.toString(16)).join(", ") + "). Check paper and lid." : "Sent to printer.", errs.length ? "err" : "ok");
  } catch (e) { log("Print failed: " + e.message, "err"); }
  finally { busy = false; $("btnPrint").disabled = !printer.connected; setTimeout(() => bar.hidden = true, 800); }
};

// ---------- start -----------------------------------------------------------------
if (!load()) { $("preset").value = 0; $("preset").onchange(); }
syncMedia();
$("densityVal").textContent = $("density").value;
setConnected(null);
const notes = [];
if (!window.isSecureContext) notes.push("Open this page over https:// or http://localhost, otherwise the browser blocks Bluetooth.");
else if (!transports.ble.available() && !transports.serial.available())
  notes.push("This browser has no Web Bluetooth. Use Chrome or Edge on Windows/Android/macOS. On iPhone, use the free \"Bluefy\" browser.");
if (notes.length) { $("support").textContent = notes.join(" "); $("support").hidden = false; }
if (!transports.ble.available()) $("btnBle").disabled = true;
document.fonts?.ready.then(render);
render();
if ("serviceWorker" in navigator && window.isSecureContext) navigator.serviceWorker.register("sw.js").catch(() => {});
