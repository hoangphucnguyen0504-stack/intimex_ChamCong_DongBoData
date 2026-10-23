import {createHash} from 'node:crypto';

// Runtime request logging for monitoring and audit: no tokens, passwords or sensitive payloads.
export function createRequestLogger({pool, maxEntries = 500} = {}) {
  const memoryLogs = [];
  const stats = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    totalDurationMs: 0,
    lastRequestAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    recentErrors: [],
  };

  const clientStats = new Map();

  function getClientStat(client) {
    let cs = clientStats.get(client);
    if (!cs) {
      cs = {
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        totalDurationMs: 0,
        lastRequestAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        recentErrors: [],
        minuteHits: new Map(),
      };
      clientStats.set(client, cs);
    }
    return cs;
  }

  function record(entry) {
    const at = entry.at || new Date().toISOString();
    const normalized = {
      id: entry.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      at,
      client: String(entry.client || 'unknown'),
      fingerprint: String(entry.fingerprint || 'unknown').slice(0, 16),
      method: String(entry.method || 'GET').toUpperCase(),
      path: String(entry.path || '').split('?')[0].slice(0, 200),
      status: Number(entry.status) || 0,
      durationMs: Math.max(0, Number(entry.durationMs) || 0),
      recordsCount: Math.max(0, Number(entry.recordsCount) || 0),
      errorCode: entry.errorCode ? String(entry.errorCode).slice(0, 64) : null,
    };

    memoryLogs.unshift(normalized);
    while (memoryLogs.length > maxEntries) memoryLogs.pop();

    stats.totalRequests++;
    stats.totalDurationMs += normalized.durationMs;
    stats.lastRequestAt = at;

    const cs = getClientStat(normalized.client);
    cs.totalRequests++;
    cs.totalDurationMs += normalized.durationMs;
    cs.lastRequestAt = at;

    const nowMinute = Math.floor(Date.now() / 60000);
    cs.minuteHits.set(nowMinute, (cs.minuteHits.get(nowMinute) || 0) + 1);
    for (const [minute] of cs.minuteHits) {
      if (nowMinute - minute > 10) cs.minuteHits.delete(minute);
    }

    if (normalized.status >= 200 && normalized.status < 400) {
      stats.successfulRequests++;
      stats.lastSuccessAt = at;
      cs.successfulRequests++;
      cs.lastSuccessAt = at;
    } else if (normalized.status >= 400) {
      stats.failedRequests++;
      stats.lastFailureAt = at;
      cs.failedRequests++;
      cs.lastFailureAt = at;

      const errEntry = { at, status: normalized.status, path: normalized.path, code: normalized.errorCode };
      stats.recentErrors.unshift(errEntry);
      if (stats.recentErrors.length > 20) stats.recentErrors.pop();

      cs.recentErrors.unshift(errEntry);
      if (cs.recentErrors.length > 20) cs.recentErrors.pop();
    }

    // Persist to MySQL table if pool is available (fire-and-forget, never breaks request)
    if (pool?.execute) {
      pool.execute({
        sql: `INSERT INTO client_request_logs (client, fingerprint, method, path, status, duration_ms, records_count, error_code, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        timeout: 2000
      }, [
        normalized.client,
        normalized.fingerprint,
        normalized.method,
        normalized.path,
        normalized.status,
        normalized.durationMs,
        normalized.recordsCount,
        normalized.errorCode,
        new Date()
      ]).catch(() => {});
    }
  }

  function middleware(clientName) {
    return (req, res, next) => {
      const start = Date.now();
      const peer = String(req.socket?.remoteAddress || req.ip || 'unknown');
      const fingerprint = createHash('sha256').update(peer).digest('hex').slice(0, 12);
      const client = clientName || (req.headers?.['x-datadongbo-client'] ? String(req.headers['x-datadongbo-client']).slice(0, 64) : 'api');

      let recorded = false;
      const complete = status => {
        if (recorded) return;
        recorded = true;
        const durationMs = Date.now() - start;
        const recordsCount = res.locals?.recordsCount || res.locals?.chatboxRows || 0;
        const errorCode = res.locals?.errorCode || (status >= 400 ? `HTTP_${status}` : null);
        record({
          client,
          fingerprint,
          method: req.method,
          path: req.baseUrl ? req.baseUrl + req.path : req.path,
          status,
          durationMs,
          recordsCount,
          errorCode
        });
      };

      res.once('finish', () => complete(res.statusCode));
      res.once('close', () => complete(res.statusCode || 499));
      next();
    };
  }

  function getStats(client = 'kinhdoanh-read-only') {
    const cs = getClientStat(client);
    const nowMinute = Math.floor(Date.now() / 60000);
    const currentHits = cs.minuteHits.get(nowMinute) || 0;
    const avgLatency = cs.totalRequests > 0 ? Math.round(cs.totalDurationMs / cs.totalRequests) : 0;

    return {
      client,
      totalRequests: cs.totalRequests,
      successfulRequests: cs.successfulRequests,
      failedRequests: cs.failedRequests,
      successRate: cs.totalRequests > 0 ? ((cs.successfulRequests / cs.totalRequests) * 100).toFixed(1) + '%' : '100%',
      currentRequestsPerMinute: currentHits,
      avgLatencyMs: avgLatency,
      lastRequestAt: cs.lastRequestAt,
      lastSuccessAt: cs.lastSuccessAt,
      lastFailureAt: cs.lastFailureAt,
      recentErrors: cs.recentErrors.slice(0, 10),
    };
  }

  function getLogs({ client, status, limit = 50, afterId } = {}) {
    let result = memoryLogs;
    if (client) result = result.filter(r => r.client === client);
    if (status) {
      const code = Number(status);
      if (Number.isInteger(code)) result = result.filter(r => r.status === code);
      else if (status === 'success') result = result.filter(r => r.status >= 200 && r.status < 400);
      else if (status === 'error') result = result.filter(r => r.status >= 400);
    }
    if (afterId) {
      const idx = result.findIndex(r => r.id === afterId);
      if (idx >= 0) result = result.slice(idx + 1);
    }
    return result.slice(0, Math.min(100, Math.max(1, Number(limit) || 50)));
  }

  return { record, middleware, getStats, getLogs };
}
