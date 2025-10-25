import { register, Counter, Histogram, Gauge } from "prom-client";

// Counters
export const voucherClaimTotal = new Counter({
  name: "voucher_claims_total",
  help: "Total number of voucher claim attempts",
  labelNames: ["status", "region"],
});

export const voucherLimitViolations = new Counter({
  name: "voucher_limit_violations_total",
  help: "Total number of limit violation attempts",
});

export const rateLimitHits = new Counter({
  name: "rate_limit_hits_total",
  help: "Total number of rate limit hits",
  labelNames: ["endpoint"],
});

// Histograms
export const voucherClaimDuration = new Histogram({
  name: "voucher_claim_duration_seconds",
  help: "Duration of voucher claim processing",
  buckets: [0.1, 0.5, 1, 2, 5, 10],
  labelNames: ["status"],
});

export const databaseQueryDuration = new Histogram({
  name: "database_query_duration_seconds",
  help: "Duration of database queries",
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2],
  labelNames: ["query_type"],
});

// Gauges
export const activeUsers = new Gauge({
  name: "active_users_total",
  help: "Number of active users attempting claims",
});

export const queueDepth = new Gauge({
  name: "voucher_queue_depth",
  help: "Number of pending claims in queue",
});

export const databaseConnections = new Gauge({
  name: "database_connections_active",
  help: "Number of active database connections",
});

export const cacheHitRate = new Gauge({
  name: "cache_hit_rate",
  help: "Cache hit rate percentage",
});

export { register };
