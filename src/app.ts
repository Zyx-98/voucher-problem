import express, { Application } from "express";
import helmet from "helmet";
import compression from "compression";
import cors from "cors";
import dotenv from "dotenv";
import { register } from "./utils/metrics";
import { logger } from "./utils/logger";
import { db } from "./config/database";
import { redis } from "./config/redis";
import voucherRoutes from "./routes/voucher.routes";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { ipRateLimitMiddleware } from "./middleware/rateLimit";

// Load environment variables
dotenv.config();

class App {
  public app: Application;
  private port: number;

  constructor() {
    this.app = express();
    this.port = parseInt(process.env.PORT || "3000");

    this.initializeMiddlewares();
    this.initializeRoutes();
    this.initializeErrorHandling();
  }

  private initializeMiddlewares(): void {
    // Security
    this.app.use(helmet());

    // CORS
    this.app.use(
      cors({
        origin: process.env.CORS_ORIGIN || "*",
        credentials: true,
      })
    );

    // Compression
    this.app.use(compression());

    // Body parsing
    this.app.use(express.json({ limit: "10mb" }));
    this.app.use(express.urlencoded({ extended: true, limit: "10mb" }));

    // IP rate limiting
    this.app.use(ipRateLimitMiddleware(1000, 60));

    // Request logging
    this.app.use((req, res, next) => {
      logger.info("Incoming request", {
        method: req.method,
        path: req.path,
        ip: req.ip,
      });
      next();
    });
  }

  private initializeRoutes(): void {
    // Health check
    this.app.get("/health", async (req, res) => {
      const dbHealthy = await db.healthCheck();
      const redisHealthy = await redis.healthCheck();

      const healthy = dbHealthy && redisHealthy;

      res.status(healthy ? 200 : 503).json({
        success: healthy,
        status: healthy ? "healthy" : "unhealthy",
        checks: {
          database: dbHealthy ? "healthy" : "unhealthy",
          redis: redisHealthy ? "healthy" : "unhealthy",
        },
        timestamp: new Date().toISOString(),
      });
    });

    // Prometheus metrics endpoint
    this.app.get("/metrics", async (req, res) => {
      res.set("Content-Type", register.contentType);
      const metrics = await register.metrics();
      res.send(metrics);
    });

    // API routes
    this.app.use("/api/vouchers", voucherRoutes);

    // Root endpoint
    this.app.get("/", (req, res) => {
      res.json({
        success: true,
        message: "Voucher System API",
        version: "1.0.0",
        endpoints: {
          health: "/health",
          metrics: "/metrics",
          vouchers: "/api/vouchers",
        },
      });
    });
  }

  private initializeErrorHandling(): void {
    this.app.use(notFoundHandler);

    this.app.use(errorHandler);
  }

  public async start(): Promise<void> {
    try {
      const dbHealthy = await db.healthCheck();
      if (!dbHealthy) {
        throw new Error("Database connection failed");
      }

      const redisHealthy = await redis.healthCheck();
      if (!redisHealthy) {
        throw new Error("Redis connection failed");
      }

      this.app.listen(this.port, () => {
        logger.info(`Server started on port ${this.port}`);
        logger.info(`Health check: http://localhost:${this.port}/health`);
        logger.info(`Metrics: http://localhost:${this.port}/metrics`);
        logger.info(`API: http://localhost:${this.port}/api/vouchers`);
      });
    } catch (error) {
      logger.error("Failed to start server", { error });
      process.exit(1);
    }
  }

  public async close(): Promise<void> {
    logger.info("Shutting down gracefully...");
    await db.close();
    await redis.close();
    logger.info("Server shutdown complete");
  }
}

const app = new App();
app.start();

process.on("SIGTERM", async () => {
  logger.info("SIGTERM received");
  await app.close();
  process.exit(0);
});

process.on("SIGINT", async () => {
  logger.info("SIGINT received");
  await app.close();
  process.exit(0);
});

export default app;
