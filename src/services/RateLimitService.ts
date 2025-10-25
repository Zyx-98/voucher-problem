import { redis } from "../config/redis";
import { queueService } from "../config/queue";
import { RateLimitResult } from "../types";
import { logger } from "../utils/logger";
import { rateLimitHits } from "../utils/metrics";
import * as os from "os";

export class RateLimitService {
  private systemLoadCache: { value: number; timestamp: number } | null = null;
  private readonly LOAD_CACHE_TTL = 5000; // 5 seconds

  /**
   * Sliding window rate limiter
   */
  public async checkRateLimit(
    userId: number,
    maxRequests: number = 10,
    windowSeconds: number = 60
  ): Promise<RateLimitResult> {
    const key = `rate_limit:user:${userId}`;
    const now = Date.now();
    const windowStart = now - windowSeconds * 1000;

    const client = redis.getClient();

    // Use pipeline for atomic operations
    const pipeline = client.pipeline();

    // Remove old entries
    pipeline.zremrangebyscore(key, 0, windowStart);

    // Count requests in window
    pipeline.zcard(key);

    // Add current request
    pipeline.zadd(key, now, now.toString());

    // Set expiry
    pipeline.expire(key, windowSeconds);

    const results = await pipeline.exec();

    if (!results) {
      throw new Error("Pipeline execution failed");
    }

    const requestCount = results[1][1] as number;

    if (requestCount >= maxRequests) {
      rateLimitHits.inc({ endpoint: "voucher_claim" });
      logger.warn("Rate limit exceeded", { userId, requestCount, maxRequests });

      // Calculate reset time
      const oldestRequest = await client.zrange(key, 0, 0, "WITHSCORES");
      const resetTime =
        oldestRequest.length > 0
          ? parseInt(oldestRequest[1]) + windowSeconds * 1000
          : now + windowSeconds * 1000;

      return {
        allowed: false,
        remainingRequests: 0,
        resetTime,
      };
    }

    return {
      allowed: true,
      remainingRequests: maxRequests - requestCount - 1,
      resetTime: now + windowSeconds * 1000,
    };
  }

  /**
   * Token bucket rate limiter (allows bursts)
   */
  public async checkTokenBucket(
    userId: number,
    capacity: number = 10,
    refillRate: number = 1
  ): Promise<boolean> {
    const key = `token_bucket:user:${userId}`;
    const client = redis.getClient();

    const bucket = await client.hgetall(key);
    const now = Date.now() / 1000; // seconds

    let tokensAvailable: number;
    let lastRefill: number;

    if (Object.keys(bucket).length === 0) {
      tokensAvailable = capacity;
      lastRefill = now;
    } else {
      tokensAvailable = parseFloat(bucket.tokens);
      lastRefill = parseFloat(bucket.last_refill);
    }

    // Calculate tokens to add
    const timePassed = now - lastRefill;
    const tokensToAdd = timePassed * refillRate;

    // Refill bucket
    tokensAvailable = Math.min(capacity, tokensAvailable + tokensToAdd);

    // Try to consume 1 token
    if (tokensAvailable >= 1) {
      tokensAvailable -= 1;

      await client.hset(key, "tokens", tokensAvailable.toString());
      await client.hset(key, "last_refill", now.toString());
      await client.expire(key, 3600);

      return true;
    }

    logger.warn("Token bucket depleted", { userId, tokensAvailable });
    return false;
  }

  /**
   * Check IP-based rate limit
   */
  public async checkIPRateLimit(
    ipAddress: string,
    maxRequests: number = 100,
    windowSeconds: number = 60
  ): Promise<boolean> {
    const key = `rate_limit:ip:${ipAddress}`;
    const client = redis.getClient();

    const count = await client.incr(key);

    if (count === 1) {
      await client.expire(key, windowSeconds);
    }

    if (count > maxRequests) {
      logger.warn("IP rate limit exceeded", { ipAddress, count });
      return false;
    }

    return true;
  }

  /**
   * PRODUCTION: Adaptive rate limiting based on actual system load
   */
  public async getDynamicRateLimit(baseLimit: number = 10): Promise<number> {
    try {
      // Get current system metrics
      const cpuUsage = await this.getCPUUsage();
      const memoryUsage = this.getMemoryUsage();
      const queueDepth = await this.getQueueDepth();

      logger.debug("System metrics", { cpuUsage, memoryUsage, queueDepth });

      // Calculate adjustment factor based on multiple metrics
      let adjustmentFactor = 1.0;

      // CPU-based adjustment
      if (cpuUsage > 80) {
        adjustmentFactor *= 0.5; // Reduce by 50%
      } else if (cpuUsage > 60) {
        adjustmentFactor *= 0.75; // Reduce by 25%
      } else if (cpuUsage < 30) {
        adjustmentFactor *= 1.5; // Increase by 50%
      }

      // Memory-based adjustment
      if (memoryUsage > 80) {
        adjustmentFactor *= 0.7; // Reduce by 30%
      } else if (memoryUsage < 50) {
        adjustmentFactor *= 1.2; // Increase by 20%
      }

      // Queue-based adjustment
      if (queueDepth > 10000) {
        adjustmentFactor *= 0.5; // Reduce by 50%
      } else if (queueDepth > 5000) {
        adjustmentFactor *= 0.75; // Reduce by 25%
      } else if (queueDepth < 1000) {
        adjustmentFactor *= 1.3; // Increase by 30%
      }

      const dynamicLimit = Math.max(
        Math.floor(baseLimit * adjustmentFactor),
        1 // Minimum 1 request
      );

      logger.info("Dynamic rate limit calculated", {
        baseLimit,
        adjustmentFactor: adjustmentFactor.toFixed(2),
        dynamicLimit,
        cpuUsage,
        memoryUsage,
        queueDepth,
      });

      return dynamicLimit;
    } catch (error) {
      logger.error("Error calculating dynamic rate limit", { error });
      return baseLimit; // Fall back to base limit on error
    }
  }

  /**
   * PRODUCTION: Get actual CPU usage
   */
  private async getCPUUsage(): Promise<number> {
    // Check cache first
    if (
      this.systemLoadCache &&
      Date.now() - this.systemLoadCache.timestamp < this.LOAD_CACHE_TTL
    ) {
      return this.systemLoadCache.value;
    }

    return new Promise((resolve) => {
      const startUsage = process.cpuUsage();
      const startTime = Date.now();

      setTimeout(() => {
        const endUsage = process.cpuUsage(startUsage);
        const endTime = Date.now();

        const userUsage = endUsage.user / 1000; // Convert to milliseconds
        const systemUsage = endUsage.system / 1000;
        const totalUsage = userUsage + systemUsage;
        const elapsedTime = endTime - startTime;

        // Calculate percentage
        const cpuPercent = (totalUsage / elapsedTime) * 100;

        // Get system-wide CPU load
        const loadAverage = os.loadavg()[0]; // 1-minute load average
        const cpuCount = os.cpus().length;
        const systemLoad = (loadAverage / cpuCount) * 100;

        // Use the higher of process CPU or system load
        const finalUsage = Math.max(cpuPercent, systemLoad);

        // Cache the result
        this.systemLoadCache = {
          value: finalUsage,
          timestamp: Date.now(),
        };

        resolve(Math.min(finalUsage, 100)); // Cap at 100%
      }, 100); // Sample over 100ms
    });
  }

  /**
   * PRODUCTION: Get actual memory usage
   */
  private getMemoryUsage(): number {
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedMemory = totalMemory - freeMemory;

    return (usedMemory / totalMemory) * 100;
  }

  /**
   * PRODUCTION: Get actual queue depth
   */
  private async getQueueDepth(): Promise<number> {
    try {
      const metrics = await queueService.getQueueMetrics();
      return metrics.total; // waiting + active + delayed
    } catch (error) {
      logger.error("Error getting queue depth", { error });
      return 0;
    }
  }

  /**
   * Get rate limit statistics for monitoring
   */
  public async getRateLimitStats(userId: number): Promise<any> {
    const key = `rate_limit:user:${userId}`;
    const client = redis.getClient();

    const now = Date.now();
    const oneMinuteAgo = now - 60000;

    const requests = await client.zrangebyscore(key, oneMinuteAgo, now);

    return {
      userId,
      requestsInLastMinute: requests.length,
      requests: requests.map((r) => ({
        timestamp: parseInt(r),
        timeAgo: now - parseInt(r),
      })),
    };
  }

  /**
   * Clear rate limit for a user (admin function)
   */
  public async clearRateLimit(userId: number): Promise<void> {
    const keys = [`rate_limit:user:${userId}`, `token_bucket:user:${userId}`];

    const client = redis.getClient();
    await Promise.all(keys.map((key) => client.del(key)));

    logger.info("Rate limit cleared for user", { userId });
  }

  /**
   * Get global rate limit statistics
   */
  public async getGlobalRateLimitStats(): Promise<any> {
    const client = redis.getClient();

    // Get all rate limit keys
    const keys = await this.scanKeys("rate_limit:user:*");

    const stats = {
      totalUsers: keys.length,
      timestamp: new Date().toISOString(),
    };

    logger.info("Global rate limit stats", stats);
    return stats;
  }

  /**
   * Scan for keys matching a pattern
   */
  private async scanKeys(pattern: string): Promise<string[]> {
    const client = redis.getClient();
    const keys: string[] = [];
    let cursor = "0";

    do {
      const reply = await client.scan(cursor, "MATCH", pattern, "COUNT", "100");
      cursor = reply[0];
      keys.push(...reply[1]);
    } while (cursor !== "0");

    return keys;
  }
}

export const rateLimitService = new RateLimitService();
