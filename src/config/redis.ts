import Redis, { Redis as RedisClient } from "ioredis";
import { logger } from "../utils/logger";

class RedisService {
  private client: RedisClient;
  private subscriber: RedisClient;
  private static instance: RedisService;

  private constructor() {
    const redisConfig = {
      host: process.env.REDIS_HOST || "localhost",
      port: parseInt(process.env.REDIS_PORT || "6379"),
      password: process.env.REDIS_PASSWORD || undefined,
      db: parseInt(process.env.REDIS_DB || "0"),
      retryStrategy: (times: number) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      maxRetriesPerRequest: 3,
    };

    this.client = new Redis(redisConfig);
    this.subscriber = new Redis(redisConfig);

    this.client.on("connect", () => {
      logger.info("Redis client connected");
    });

    this.client.on("error", (err) => {
      logger.error("Redis client error", err);
    });

    this.subscriber.on("connect", () => {
      logger.info("Redis subscriber connected");
    });
  }

  public static getInstance(): RedisService {
    if (!RedisService.instance) {
      RedisService.instance = new RedisService();
    }
    return RedisService.instance;
  }

  public getClient(): RedisClient {
    return this.client;
  }

  public getSubscriber(): RedisClient {
    return this.subscriber;
  }

  public async get(key: string): Promise<string | null> {
    try {
      return await this.client.get(key);
    } catch (error) {
      logger.error("Redis GET error", { key, error });
      return null;
    }
  }

  public async set(key: string, value: string, ttl?: number): Promise<boolean> {
    try {
      if (ttl) {
        await this.client.setex(key, ttl, value);
      } else {
        await this.client.set(key, value);
      }
      return true;
    } catch (error) {
      logger.error("Redis SET error", { key, error });
      return false;
    }
  }

  public async del(key: string): Promise<boolean> {
    try {
      await this.client.del(key);
      return true;
    } catch (error) {
      logger.error("Redis DEL error", { key, error });
      return false;
    }
  }

  public async incr(key: string): Promise<number> {
    return await this.client.incr(key);
  }

  public async expire(key: string, seconds: number): Promise<boolean> {
    const result = await this.client.expire(key, seconds);
    return result === 1;
  }

  public async hgetall(key: string): Promise<Record<string, string>> {
    return await this.client.hgetall(key);
  }

  public async hset(
    key: string,
    field: string,
    value: string
  ): Promise<number> {
    return await this.client.hset(key, field, value);
  }

  public async zadd(
    key: string,
    score: number,
    member: string
  ): Promise<number> {
    return await this.client.zadd(key, score, member);
  }

  public async zremrangebyscore(
    key: string,
    min: number,
    max: number
  ): Promise<number> {
    return await this.client.zremrangebyscore(key, min, max);
  }

  public async zcard(key: string): Promise<number> {
    return await this.client.zcard(key);
  }

  public async healthCheck(): Promise<boolean> {
    try {
      const result = await this.client.ping();
      return result === "PONG";
    } catch (error) {
      logger.error("Redis health check failed", error);
      return false;
    }
  }

  public async close(): Promise<void> {
    await this.client.quit();
    await this.subscriber.quit();
    logger.info("Redis connections closed");
  }
}

export const redis = RedisService.getInstance();
