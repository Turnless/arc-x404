// JSON-RPC access with retries, endpoint rotation and eth_getLogs routing across the
// archive and recent endpoints (see RPC in config.mjs for the measured limits).
import { RPC } from "./config.mjs";

const RETRYABLE =
  /rate limit|too many|timeout|timed out|ECONNRESET|connection reset|connection error|connection closed|fetch failed|socket|Fork Error|Transport|429|502|503|504|-32005|internal error|header/i;
const RANGE = /range|exceeds|too large|not supported|limit/i;
const PRUNED = /pruned|missing trie|not available|unavailable/i;

export class RpcError extends Error {
  constructor(message, { retryable = false, code } = {}) {
    super(message);
    this.retryable = retryable;
    this.code = code;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// A pool of equivalent endpoints with a client-side throttle: at most `maxInFlight`
/// requests at once and at least `minGapMs` between request starts. Measured on Arc's
/// public archive endpoints (7 Oct): 3-4 requests in flight at about 6-10 per second are
/// served; heavier bursts earn a temporary "rate limit exceeded" penalty.
export class RpcPool {
  constructor(urls, { maxInFlight = 3, minGapMs = 150 } = {}) {
    if (!urls.length) throw new Error("RpcPool needs at least one URL");
    this.urls = urls;
    this.next = 0;
    this.maxInFlight = maxInFlight;
    this.minGapMs = minGapMs;
    this.inFlight = 0;
    this.waiting = [];
    this.lastStart = 0;
    this.downUntil = new Map(); // url -> time it may be used again after a network error
    this.stats = { calls: 0, retries: 0, byMethod: {} };
  }

  pickUrl() {
    const now = Date.now();
    for (let i = 0; i < this.urls.length; i++) {
      const url = this.urls[this.next++ % this.urls.length];
      if ((this.downUntil.get(url) ?? 0) <= now) return url;
    }
    return this.urls[this.next++ % this.urls.length]; // all marked down: try anyway
  }

  async acquire() {
    if (this.inFlight >= this.maxInFlight) await new Promise((r) => this.waiting.push(r));
    this.inFlight++;
    const wait = this.lastStart + this.minGapMs - Date.now();
    this.lastStart = Math.max(Date.now(), this.lastStart + this.minGapMs);
    if (wait > 0) await sleep(wait);
  }

  release() {
    this.inFlight--;
    const next = this.waiting.shift();
    if (next) next();
  }

  async request(method, params, { tries = 14 } = {}) {
    let lastErr;
    for (let attempt = 0; attempt < tries; attempt++) {
      const url = this.pickUrl();
      await this.acquire();
      this.stats.calls++;
      if (attempt > 0) this.stats.retries++;
      this.stats.byMethod[method] = (this.stats.byMethod[method] ?? 0) + 1;
      let backoff = 0;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(Number(process.env.RPC_TIMEOUT_MS ?? 25_000)),
        });
        const text = await res.text();
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          throw new RpcError(`HTTP ${res.status}: ${text.slice(0, 120)}`, { retryable: true });
        }
        if (body.error) {
          const msg = body.error.message || String(body.error.code);
          throw new RpcError(msg, {
            retryable: res.status === 429 || (RETRYABLE.test(msg) && !RANGE.test(msg) && !PRUNED.test(msg)),
            code: body.error.code,
          });
        }
        return body.result;
      } catch (e) {
        lastErr = e;
        const network = !(e instanceof RpcError);
        if (network && this.urls.length > 1) this.downUntil.set(url, Date.now() + 30_000);
        const retryable = network || e.retryable;
        if (!retryable) throw e;
        backoff = Math.min(10_000, 250 * 2 ** attempt) * (0.5 + Math.random());
      } finally {
        this.release();
      }
      // Back off after releasing the slot, so other requests keep moving.
      if (backoff) await sleep(backoff);
    }
    throw lastErr;
  }
}

export const archive = new RpcPool(RPC.archive, { maxInFlight: 3, minGapMs: 150 });
export const recent = RPC.recent.length ? new RpcPool(RPC.recent, { maxInFlight: 6, minGapMs: 50 }) : null;

let headCache = { at: 0, block: 0 };
export async function headBlock() {
  if (Date.now() - headCache.at > 1_500) {
    headCache = { at: Date.now(), block: Number(BigInt(await archive.request("eth_blockNumber", []))) };
  }
  return headCache.block;
}

const hex = (n) => "0x" + n.toString(16);

async function fetchChunk(pool, filter, from, to) {
  try {
    return await pool.request("eth_getLogs", [{ ...filter, fromBlock: hex(from), toBlock: hex(to) }]);
  } catch (e) {
    const msg = String(e.message);
    if (pool === recent && PRUNED.test(msg)) {
      // Older than the recent endpoint keeps: fetch from archive in archive-sized chunks.
      const out = [];
      for (let t = to; t >= from; t -= RPC.archiveLogRange) {
        out.push(...(await fetchChunk(archive, filter, Math.max(from, t - RPC.archiveLogRange + 1), t)));
      }
      return out;
    }
    if (RANGE.test(msg) && to - from >= 500) {
      const mid = Math.floor((from + to) / 2);
      return [...(await fetchChunk(pool, filter, mid + 1, to)), ...(await fetchChunk(pool, filter, from, mid))];
    }
    throw e;
  }
}

/// eth_getLogs over [fromBlock, toBlock], split into chunks the endpoints accept, newest
/// chunks first. `stop(logs)` is checked after each batch; returning true ends the scan
/// early (used when enough evidence has been found). Returns logs sorted oldest first.
export async function getLogs(filter, fromBlock, toBlock, { stop } = {}) {
  if (toBlock < fromBlock) return [];
  const head = await headBlock();
  const recentFloor = head - RPC.recentWindow;
  const chunks = [];
  let t = toBlock;
  while (t >= fromBlock) {
    const useRecent = t > recentFloor && RPC.recent.length > 0;
    const size = useRecent ? RPC.recentLogRange : RPC.archiveLogRange;
    const lowLimit = useRecent ? Math.max(fromBlock, recentFloor + 1) : fromBlock;
    const f = Math.max(lowLimit, t - size + 1);
    chunks.push({ pool: useRecent ? recent : archive, from: f, to: t });
    t = f - 1;
  }
  const logs = [];
  for (let i = 0; i < chunks.length; i += RPC.concurrency) {
    const batch = chunks.slice(i, i + RPC.concurrency);
    const results = await Promise.all(batch.map((c) => fetchChunk(c.pool, filter, c.from, c.to)));
    for (const r of results) logs.push(...r);
    if (stop && stop(logs)) break;
  }
  return logs.sort(
    (a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.logIndex) - BigInt(b.logIndex)),
  );
}
