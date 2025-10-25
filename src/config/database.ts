import { Pool, PoolClient } from "pg";
import { logger } from "../utils/logger";

class Database {
  private pool: Pool;
  private static instance: Database;

  private constructor() {
    this.pool = new Pool({
      host: process.env.DB_HOST || "localhost",
      port: parseInt(process.env.DB_PORT || "5432"),
      database: process.env.DB_NAME || "voucher_system",
      user: process.env.DB_USER || "postgres",
      password: process.env.DB_PASSWORD || "postgres",
      min: parseInt(process.env.DB_POOL_MIN || "10"),
      max: parseInt(process.env.DB_POOL_MAX || "100"),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
      statement_timeout: 10000, // 10 seconds
    });

    this.pool.on("connect", () => {
      logger.info("Database connection established");
    });

    this.pool.on("error", (err) => {
      logger.error("Unexpected database error", err);
    });
  }

  public static getInstance(): Database {
    if (!Database.instance) {
      Database.instance = new Database();
    }
    return Database.instance;
  }

  public getPool(): Pool {
    return this.pool;
  }

  public async query(text: string, params?: any[]) {
    const start = Date.now();
    try {
      const result = await this.pool.query(text, params);
      const duration = Date.now() - start;
      logger.debug("Executed query", { text, duration, rows: result.rowCount });
      return result;
    } catch (error) {
      logger.error("Database query error", { text, error });
      throw error;
    }
  }

  public async getClient(): Promise<PoolClient> {
    return await this.pool.connect();
  }

  public async transaction<T>(
    callback: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await this.getClient();
    try {
      await client.query("BEGIN");
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async healthCheck(): Promise<boolean> {
    try {
      await this.query("SELECT 1");
      return true;
    } catch (error) {
      logger.error("Database health check failed", error);
      return false;
    }
  }

  public async close(): Promise<void> {
    await this.pool.end();
    logger.info("Database connection pool closed");
  }
}

export const db = Database.getInstance();
