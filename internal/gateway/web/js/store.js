// Live dashboard state fed by the admin SSE stream.
//
// Subscribers receive {type, state} where type is one of:
//   'frame'  a new 1s frame arrived (state.frame, state.points updated)
//   'config' the active config was (re)fetched (state.config, state.revision)
//   'events' new activity events were appended (state.events)
//   'conn'   the connection state changed, or history was reseeded on connect
// state.conn is 'connecting' | 'live' | 'reconnecting' | 'offline'.

import { getConfig } from './api.js';

const MAX_POINTS = 300;
const MAX_EVENTS = 500;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];
// After this many consecutive failed attempts the pill reads OFFLINE; the store
// keeps retrying at the slowest backoff step.
const OFFLINE_AFTER = 3;
// A healthy stream sends a frame every second; silence this long means the
// connection is stuck even if the socket has not errored yet.
const STALL_MS = 5000;

export class Store {
  constructor(url = '/admin/v1/stream') {
    this.url = url;
    this.state = { conn: 'connecting', frame: null, points: [], events: [], config: null, revision: null };
    this.subs = new Set();
    this.es = null;
    this.failures = 0;
    this.retryTimer = 0;
    this.stallTimer = 0;
    this.configSeq = 0;
    this.lastEventSeq = 0;
  }

  subscribe(fn) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  getState() {
    return this.state;
  }

  emit(type) {
    for (const fn of this.subs) {
      try {
        fn({ type, state: this.state });
      } catch (e) {
        console.error('store subscriber failed', e);
      }
    }
  }

  setConn(conn) {
    if (this.state.conn === conn) return;
    this.state.conn = conn;
    this.emit('conn');
  }

  start() {
    this.refreshConfig();
    this.connect();
    document.addEventListener('visibilitychange', () => {
      // Reconnect at once when the tab comes back instead of waiting out a backoff.
      if (!document.hidden && !this.es && this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = 0;
        this.connect();
      }
    });
    return this;
  }

  connect() {
    this.retryTimer = 0;
    const es = new EventSource(this.url);
    this.es = es;
    es.addEventListener('hello', (e) => this.onHello(e));
    es.addEventListener('frame', (e) => this.onFrame(e));
    es.onerror = () => this.fail();
    this.armStall();
  }

  armStall() {
    clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(() => this.fail(), STALL_MS);
  }

  fail() {
    clearTimeout(this.stallTimer);
    if (this.es) {
      this.es.close();
      this.es = null;
    }
    if (this.retryTimer) return;
    this.failures++;
    this.setConn(this.failures >= OFFLINE_AFTER ? 'offline' : 'reconnecting');
    const delay = BACKOFF_MS[Math.min(this.failures - 1, BACKOFF_MS.length - 1)];
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  parse(e) {
    try {
      return JSON.parse(e.data);
    } catch {
      return null;
    }
  }

  onHello(e) {
    const msg = this.parse(e);
    if (!msg) return;
    this.failures = 0;
    this.armStall();
    this.mergePoints(Array.isArray(msg.series) ? msg.series : []);
    const evs = Array.isArray(msg.events) ? msg.events : [];
    const newest = evs.length ? evs[evs.length - 1].seq : 0;
    if (newest < this.lastEventSeq) {
      // Sequence went backwards: the gateway restarted with a fresh event log.
      this.state.events = [];
      this.lastEventSeq = 0;
    }
    const added = this.appendEvents(evs);
    // A reconnect may have missed config changes.
    this.refreshConfig();
    this.state.conn = 'live';
    this.emit('conn');
    if (added) this.emit('events');
  }

  onFrame(e) {
    const f = this.parse(e);
    if (!f) return;
    this.failures = 0;
    this.armStall();
    this.state.frame = f;
    if (f.point && f.point.ts) this.mergePoints([f.point]);
    if (f.revision != null && f.revision !== this.state.revision) {
      this.state.revision = f.revision;
      this.refreshConfig();
    }
    if (this.state.conn !== 'live') this.setConn('live');
    this.emit('frame');
    if (this.appendEvents(Array.isArray(f.events) ? f.events : [])) this.emit('events');
  }

  // mergePoints inserts points by ts (replacing equal ts), keeps them ordered
  // and bounded to the newest MAX_POINTS seconds.
  mergePoints(incoming) {
    if (!incoming.length) return;
    const pts = this.state.points;
    const last = pts.length ? pts[pts.length - 1].ts : -Infinity;
    if (incoming.length === 1 && incoming[0].ts > last) {
      pts.push(incoming[0]);
    } else {
      const byTs = new Map(pts.map((p) => [p.ts, p]));
      for (const p of incoming) byTs.set(p.ts, p);
      this.state.points = [...byTs.values()].sort((a, b) => a.ts - b.ts);
    }
    if (this.state.points.length > MAX_POINTS) this.state.points.splice(0, this.state.points.length - MAX_POINTS);
  }

  appendEvents(evs) {
    let added = 0;
    for (const ev of evs) {
      if (!ev || typeof ev.seq !== 'number' || ev.seq <= this.lastEventSeq) continue;
      this.state.events.push(ev);
      this.lastEventSeq = ev.seq;
      added++;
    }
    if (this.state.events.length > MAX_EVENTS) this.state.events.splice(0, this.state.events.length - MAX_EVENTS);
    return added;
  }

  // refreshConfig fetches the active config; only the newest request's answer
  // is applied when several overlap.
  async refreshConfig() {
    const seq = ++this.configSeq;
    try {
      const { revision, config } = await getConfig();
      if (seq !== this.configSeq) return this.state.config;
      this.state.config = config;
      if (this.state.revision == null || revision >= this.state.revision) this.state.revision = revision;
      this.emit('config');
      return config;
    } catch (e) {
      if (seq === this.configSeq) console.warn('config fetch failed', e.message);
      return this.state.config;
    }
  }
}

export function createStore(url) {
  return new Store(url);
}
