// E210 (YICHIP YC3121, QLabel) printer driver for the browser.
// Transports: Web Bluetooth (BLE) and Web Serial (Bluetooth COM port or USB).
// Protocol reference: github.com/InverseCubeSquared/yc3121-e210-label-printer-reversing

export const DOTS_PER_MM = 8;
export const HEAD_DOTS = 384;
export const MEDIA = { continuous: 0, holes: 1, gap: 2, blackmark: 3 };

const SVC = 0xff00, CH_WRITE = 0xff02, CH_REPLY = 0xff01, CH_FLOW = 0xff03;

// ---------- job building ----------------------------------------------------

// bits: Uint8Array of w*h, 1 = black. Returns the full command stream.
// The printer aligns images narrower than the head to the RIGHT edge (tested),
// so every image is padded to the full 384 dots with the content centred.
export function centerOnHead(bits, w, h) {
  if (w >= HEAD_DOTS) return { bits, w };
  const out = new Uint8Array(HEAD_DOTS * h), off = Math.floor((HEAD_DOTS - w) / 2);
  for (let y = 0; y < h; y++) out.set(bits.subarray(y * w, y * w + w), y * HEAD_DOTS + off);
  return { bits: out, w: HEAD_DOTS };
}

export function buildJob(bits, w, h, { density = 6, media = "gap", labelW, labelH, copies = 1, feedMM = 0 } = {}) {
  ({ bits, w } = centerOnHead(bits, w, h));
  labelW = w / DOTS_PER_MM;
  const nb = Math.ceil(w / 8);
  const out = [];
  const push = (...b) => { for (const x of b) out.push(x & 0xff); };
  const wmm10 = Math.round((labelW ?? w / DOTS_PER_MM) * 10);
  const hmm10 = Math.round((labelH ?? h / DOTS_PER_MM) * 10);
  for (let c = 0; c < copies; c++) {
    push(0x1c, 0x21, density);
    push(0x1b, 0x35, 0, 0);
    push(0x1b, 0x34, 0, 0);
    push(0x1c, 0x25, MEDIA[media] ?? 2);
    push(0x1b, 0x33);
    const r = h + 1;
    push(0x1b, 0x29, r, r >> 8, wmm10, wmm10 >> 8, hmm10, hmm10 >> 8, 0);
    const row = new Uint8Array(nb);
    for (let y = 0; y < h; y++) {
      row.fill(0);
      for (let x = 0; x < w; x++) if (bits[y * w + x]) row[x >> 3] |= 0x80 >> (x & 7);
      let s = 0; while (s < nb && row[s] === 0) s++;
      let e = nb; while (e > s && row[e - 1] === 0) e--;
      if (s === nb) { push(0x1b, 0x19, 0x01, 0x01, nb); continue; }
      push(0x1b, 0x19, 0x01, e - s + 1, s);
      for (let i = s; i < e; i++) out.push(row[i]);
    }
    push(0x1b, 0x4a, 0x00);
    if (media === "continuous") {
      // extra feed after the print (1B 4A takes at most 255 dots, so split it)
      let dots = Math.round(Math.max(0, feedMM) * DOTS_PER_MM);
      while (dots > 0) { const n = Math.min(255, dots); push(0x1b, 0x4a, n); dots -= n; }
    } else push(0x1b, 0x69);
  }
  return new Uint8Array(out);
}

// ---------- transports ------------------------------------------------------

class BleTransport {
  static available() { return !!navigator.bluetooth; }
  async open() {
    this.dev = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: "E2" }, { services: [SVC] }],
      optionalServices: [SVC],
    });
    this.dev.addEventListener("gattserverdisconnected", () => this.ondisconnect?.());
    const gatt = await this.dev.gatt.connect();
    const svc = await gatt.getPrimaryService(SVC);
    this.wr = await svc.getCharacteristic(CH_WRITE);
    this.credits = 0; this.mtu = 180; this.waiters = [];
    const flow = await svc.getCharacteristic(CH_FLOW);
    flow.addEventListener("characteristicvaluechanged", (e) => {
      const d = new Uint8Array(e.target.value.buffer);
      if (d[0] === 1) { this.credits += d[1]; this.wake(); }
      else if (d[0] === 2) this.mtu = Math.max(20, (d[1] | (d[2] << 8)) - 2);
    });
    await flow.startNotifications();
    const rep = await svc.getCharacteristic(CH_REPLY);
    rep.addEventListener("characteristicvaluechanged", (e) => this.onData(new Uint8Array(e.target.value.buffer)));
    await rep.startNotifications();
    await sleep(400);
    this.pace = 20;
    this.name = this.dev.name;
  }
  wake() {}
  // The ff03 "credits" are announced once but never replenished, so they are
  // not a usable flow control. Pace the writes instead (tested: 180 B / 20 ms).
  async write(data, progress) {
    for (let i = 0; i < data.length; i += this.mtu) {
      const chunk = data.slice(i, i + this.mtu);
      try { await this.wr.writeValueWithoutResponse(chunk); }
      catch { await sleep(50); await this.wr.writeValueWithoutResponse(chunk); }
      await sleep(this.pace);
      progress?.(Math.min(1, (i + this.mtu) / data.length));
    }
  }
  async close() { try { this.dev?.gatt.disconnect(); } catch {} }
}

class SerialTransport {
  static available() { return !!navigator.serial; }
  async open() {
    this.port = await navigator.serial.requestPort();
    await this.port.open({ baudRate: 115200, bufferSize: 65536 });
    this.writer = this.port.writable.getWriter();
    this.name = "Serial port";
    this.reading = (async () => {
      while (this.port.readable) {
        this.reader = this.port.readable.getReader();
        try {
          for (;;) { const { value, done } = await this.reader.read(); if (done) break; this.onData(value); }
        } catch { /* port closed */ } finally { this.reader.releaseLock(); }
        if (this.closing) break;
      }
      this.ondisconnect?.();
    })();
  }
  async write(data, progress) {
    const n = 512;
    for (let i = 0; i < data.length; i += n) {
      await this.writer.write(data.slice(i, i + n));
      progress?.(Math.min(1, (i + n) / data.length));
    }
  }
  async close() {
    this.closing = true;
    try { await this.reader?.cancel(); } catch {}
    try { this.writer?.releaseLock(); } catch {}
    try { await this.port?.close(); } catch {}
  }
}

export const transports = { ble: BleTransport, serial: SerialTransport };

// ---------- printer -----------------------------------------------------------

export class E210 {
  constructor() { this.t = null; this.buf = []; this.listeners = new Set(); }
  get connected() { return !!this.t; }
  async connect(kind, ondisconnect) {
    const T = transports[kind];
    const t = new T();
    t.onData = (d) => { for (const b of d) this.buf.push(b); this.listeners.forEach((f) => f()); };
    t.ondisconnect = () => { this.t = null; ondisconnect?.(); };
    await t.open();
    this.t = t;
    return t.name;
  }
  async disconnect() { const t = this.t; this.t = null; await t?.close(); }
  async query(cmd, replyLen, timeout = 1500) {
    this.buf = [];
    await this.t.write(new Uint8Array(cmd));
    const t0 = Date.now();
    while (this.buf.length < replyLen && Date.now() - t0 < timeout) await sleep(30);
    return this.buf.slice();
  }
  async status() {
    const r = await this.query([0x1b, 0x06], 4);
    if (r.length < 4) return { ok: false, text: "no reply" };
    // Byte 0 bit 0 = no paper (tested: set while the roll is out; an open lid
    // also reads as "no paper"). Byte 1 is 04 when idle; other bits unknown.
    const s0 = r[2], s1 = r[3];
    const paperOut = !!(s0 & 1);
    const other = (s0 & ~1) || s1 !== 0x04;
    return { ok: !paperOut && !other, paperOut, other,
      raw: [s0, s1].map((b) => b.toString(16).padStart(2, "0")).join(" "),
      text: paperOut ? "out of paper or lid open" : other ? "busy / unknown state" : "ready" };
  }
  // 1B 17 -> CB 00 (203 dpi), E0 01 (480), ...
  async params() {
    const r = await this.query([0x1b, 0x17], 9);
    if (r.length < 9) return null;
    return { dpi: r[2] | (r[3] << 8), dots: r[4] | (r[5] << 8) };
  }
  async send(bytes, progress) { this.buf = []; await this.t.write(bytes, progress); }
  async feed(mm) { await this.send(new Uint8Array([0x1b, 0x4a, Math.min(255, Math.round(mm * DOTS_PER_MM))])); }
  async nextLabel() { await this.send(new Uint8Array([0x1b, 0x69])); }
  // Error bytes E1..E8 the printer may send after a job
  errors() { return this.buf.filter((b) => b >= 0xe1 && b <= 0xe8); }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
