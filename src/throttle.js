// 按站点限速：同一站点的请求排队、控制并发和间隔；被限流后整站一起冷却，而不是各自继续撞墙。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class HostGate {
  constructor({ concurrency, minGapMs }) {
    this.concurrency = concurrency;
    this.minGapMs = minGapMs;
    this.active = 0;
    this.waiters = [];
    this.nextStart = 0;     // 下一个请求最早的发出时间
    this.cooldownUntil = 0; // 被限流后，整站暂停到这个时间
  }

  async acquire() {
    while (this.active >= this.concurrency) await new Promise((r) => this.waiters.push(r));
    this.active++;
    // 冷却可能在等待期间被别的请求延长，所以循环到真正可以发出为止
    for (;;) {
      const now = Date.now();
      const at = Math.max(this.nextStart, this.cooldownUntil, now);
      if (at <= now) break;
      await sleep(at - now);
    }
    this.nextStart = Date.now() + this.minGapMs;
  }

  release() {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }

  cooldown(ms) {
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + ms);
  }
}

// 维基百科各语言站共用一套限流；arXiv 要求两次请求间隔 3 秒
const gates = {
  wikipedia: new HostGate({ concurrency: 2, minGapMs: 150 }),
  arxiv: new HostGate({ concurrency: 1, minGapMs: 3000 }),
  other: new HostGate({ concurrency: 2, minGapMs: 200 }),
};

function gateFor(hostname) {
  if (hostname.endsWith('wikipedia.org')) return gates.wikipedia;
  if (hostname.endsWith('arxiv.org')) return gates.arxiv;
  return gates.other;
}

module.exports = { gateFor, sleep };
