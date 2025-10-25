import { redis } from "../config/redis";
import { db } from "../config/database";
import { logger } from "../utils/logger";
import { User } from "../types";

export class CacheService {
  private readonly USER_CACHE_TTL = 300; // 5 minutes
  private readonly VOUCHER_COUNT_TTL = 300;
  private readonly USER_CACHE_PREFIX = "user:";
  private readonly CLAIM_RESULT_PREFIX = "claim:result:";
  private cacheHits = 0;
  private cacheMisses = 0;

  /**
   * Get user's voucher count from cache
   */
  public async getUserVoucherCount(userId: number): Promise<number | null> {
    const key = `${this.USER_CACHE_PREFIX}${userId}:vouchers`;
    const cached = await redis.get(key);

    if (cached !== null) {
      this.cacheHits++;
      logger.debug("Cache hit", { key });
      return parseInt(cached, 10);
    }

    this.cacheMisses++;
    logger.debug("Cache miss", { key });
    return null;
  }

  /**
   * Set user's voucher count in cache
   */
  public async setUserVoucherCount(
    userId: number,
    count: number
  ): Promise<void> {
    const key = `${this.USER_CACHE_PREFIX}${userId}:vouchers`;
    await redis.set(key, count.toString(), this.VOUCHER_COUNT_TTL);
    logger.debug("Cache set", { key, count });
  }

  /**
   * Get complete user data from cache
   */
  public async getUser(userId: number): Promise<User | null> {
    const key = `${this.USER_CACHE_PREFIX}${userId}:data`;
    const cached = await redis.get(key);

    if (cached) {
      this.cacheHits++;
      return JSON.parse(cached);
    }

    this.cacheMisses++;
    return null;
  }

  /**
   * Cache complete user data
   */
  public async setUser(user: User): Promise<void> {
    const key = `${this.USER_CACHE_PREFIX}${user.id}:data`;
    await redis.set(key, JSON.stringify(user), this.USER_CACHE_TTL);
  }

  /**
   * Invalidate all user-related cache
   */
  public async invalidateUserCache(userId: number): Promise<void> {
    const pattern = `${this.USER_CACHE_PREFIX}${userId}:*`;
    const keys = await this.getKeysByPattern(pattern);

    if (keys.length > 0) {
      const pipeline = redis.getClient().pipeline();
      keys.forEach((key) => pipeline.del(key));
      await pipeline.exec();
      logger.debug("Cache invalidated", { userId, keysDeleted: keys.length });
    }
  }

  /**
   * Cache claim result for idempotency
   */
  public async cacheClaimResult(
    idempotencyKey: string,
    result: any
  ): Promise<void> {
    const key = `${this.CLAIM_RESULT_PREFIX}${idempotencyKey}`;
    await redis.set(key, JSON.stringify(result), 3600); // 1 hour
  }

  /**
   * Get cached claim result
   */
  public async getClaimResult(idempotencyKey: string): Promise<any | null> {
    const key = `${this.CLAIM_RESULT_PREFIX}${idempotencyKey}`;
    const cached = await redis.get(key);

    if (cached) {
      this.cacheHits++;
      return JSON.parse(cached);
    }

    this.cacheMisses++;
    return null;
  }

  /**
   * PRODUCTION: Warm cache with real user data from database
   */
  public async warmCache(userIds: number[]): Promise<void> {
    logger.info("Starting cache warming", { userCount: userIds.length });

    try {
      // Fetch users from database in batches
      const batchSize = 100;
      const batches = Math.ceil(userIds.length / batchSize);

      for (let i = 0; i < batches; i++) {
        const start = i * batchSize;
        const end = Math.min(start + batchSize, userIds.length);
        const batchIds = userIds.slice(start, end);

        // Fetch batch from database
        const result = await db.query(
          `SELECT id, email, vouchers_claimed, voucher_limit, is_premium, 
                  created_at, updated_at
           FROM users
           WHERE id = ANY($1)`,
          [batchIds]
        );

        // Cache each user
        const pipeline = redis.getClient().pipeline();

        result.rows.forEach((row) => {
          const user: User = {
            id: row.id,
            email: row.email,
            vouchersClaimеd: row.vouchers_claimed,
            voucherLimit: row.voucher_limit,
            isPremium: row.is_premium,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          };

          // Cache complete user data
          const userKey = `${this.USER_CACHE_PREFIX}${user.id}:data`;
          pipeline.setex(userKey, this.USER_CACHE_TTL, JSON.stringify(user));

          // Cache voucher count separately for quick access
          const countKey = `${this.USER_CACHE_PREFIX}${user.id}:vouchers`;
          pipeline.setex(
            countKey,
            this.VOUCHER_COUNT_TTL,
            user.vouchersClaimеd.toString()
          );
        });

        await pipeline.exec();

        logger.info("Cache batch warmed", {
          batch: i + 1,
          total: batches,
          count: result.rows.length,
        });
      }

      logger.info("Cache warming completed", {
        totalUsers: userIds.length,
      });
    } catch (error) {
      logger.error("Cache warming failed", { error });
      throw error;
    }
  }

  /**
   * Warm cache for active users (users who logged in recently)
   */
  public async warmActiveUsersCache(days: number = 7): Promise<void> {
    logger.info("Warming cache for active users", { days });

    try {
      // Get active user IDs
      const result = await db.query(
        `SELECT id FROM users 
         WHERE updated_at >= NOW() - INTERVAL '${days} days'
         ORDER BY updated_at DESC
         LIMIT 10000`,
        []
      );

      const userIds = result.rows.map((row) => row.id);
      await this.warmCache(userIds);
    } catch (error) {
      logger.error("Active users cache warming failed", { error });
      throw error;
    }
  }

  /**
   * Get keys by pattern (for cleanup)
   */
  private async getKeysByPattern(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = "0";

    do {
      const reply = await redis
        .getClient()
        .scan(cursor, "MATCH", pattern, "COUNT", "100");
      cursor = reply[0];
      keys.push(...reply[1]);
    } while (cursor !== "0");

    return keys;
  }

  /**
   * Clear all cache (use with caution)
   */
  public async clearAllCache(): Promise<void> {
    logger.warn("Clearing all cache");
    await redis.getClient().flushdb();
  }

  /**
   * Get cache statistics
   */
  public getCacheStats() {
    const total = this.cacheHits + this.cacheMisses;
    const hitRate = total > 0 ? (this.cacheHits / total) * 100 : 0;

    return {
      hits: this.cacheHits,
      misses: this.cacheMisses,
      total,
      hitRate: hitRate.toFixed(2) + "%",
    };
  }

  /**
   * Reset cache statistics
   */
  public resetStats(): void {
    this.cacheHits = 0;
    this.cacheMisses = 0;
  }
}

export const cacheService = new CacheService();
