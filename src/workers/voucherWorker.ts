import { Worker, Job } from "bullmq";
import { db } from "../config/database";
import { cacheService } from "../services/CacheService";
import { logger } from "../utils/logger";
import { QueueJob, ClaimVoucherResponse } from "../types";
import { voucherClaimTotal, voucherLimitViolations } from "../utils/metrics";

class VoucherWorker {
  private worker: Worker<QueueJob>;

  constructor() {
    const connection = {
      host: process.env.QUEUE_REDIS_HOST || "localhost",
      port: parseInt(process.env.QUEUE_REDIS_PORT || "6379"),
    };

    this.worker = new Worker<QueueJob>(
      "voucher-claims",
      async (job: Job<QueueJob>) => {
        return await this.processJob(job);
      },
      {
        connection,
        concurrency: parseInt(process.env.QUEUE_CONCURRENCY || "50"),
        limiter: {
          max: 100,
          duration: 1000, // 100 jobs per second
        },
      }
    );

    this.worker.on("completed", (job) => {
      logger.info("Worker completed job", { jobId: job.id });
    });

    this.worker.on("failed", (job, err) => {
      logger.error("Worker failed job", {
        jobId: job?.id,
        error: err.message,
      });
    });

    this.worker.on("error", (err) => {
      logger.error("Worker error", { error: err });
    });

    logger.info("Voucher worker started", {
      concurrency: this.worker.opts.concurrency,
    });
  }

  private async processJob(job: Job<QueueJob>): Promise<ClaimVoucherResponse> {
    const {
      userId,
      voucherCode,
      ipAddress,
      userAgent,
      deviceId,
      idempotencyKey,
    } = job.data;

    logger.info("Processing voucher claim", { jobId: job.id, userId });

    try {
      const result = await db.transaction(async (client) => {
        // Lock user row
        const userResult = await client.query(
          `SELECT id, email, vouchers_claimed, voucher_limit, is_premium, is_active
         FROM users
         WHERE id = $1 AND is_active = TRUE
         FOR UPDATE`,
          [userId]
        );

        if (userResult.rows.length === 0) {
          throw new Error("User not found or inactive");
        }

        const user = userResult.rows[0];

        // Check limit
        if (user.vouchers_claimed >= user.voucher_limit) {
          voucherLimitViolations.inc();
          voucherClaimTotal.inc({
            status: "limit_exceeded",
            region: "us-east",
          });

          return {
            success: false,
            message: "Voucher limit exceeded",
            status: "limit_reached" as const,
          };
        }

        // Get and validate voucher code
        const voucherResult = await client.query(
          `SELECT id, code, is_active, usage_limit, usage_count, expires_at
         FROM voucher_codes
         WHERE code = $1
         FOR UPDATE`,
          [voucherCode]
        );

        if (voucherResult.rows.length === 0) {
          throw new Error("Voucher code not found");
        }

        const voucher = voucherResult.rows[0];

        // Validate voucher
        if (
          !voucher.is_active ||
          (voucher.expires_at && new Date(voucher.expires_at) < new Date()) ||
          voucher.usage_count >= voucher.usage_limit
        ) {
          throw new Error("Voucher code is not valid");
        }

        // Update user's voucher count
        await client.query(
          `UPDATE users
         SET vouchers_claimed = vouchers_claimed + 1,
             updated_at = NOW()
         WHERE id = $1`,
          [userId]
        );

        // Update voucher code usage
        await client.query(
          `UPDATE voucher_codes
         SET usage_count = usage_count + 1,
             is_used = CASE WHEN usage_count + 1 >= usage_limit THEN TRUE ELSE is_used END,
             updated_at = NOW()
         WHERE id = $1`,
          [voucher.id]
        );

        // Create voucher claim record
        await client.query(
          `INSERT INTO voucher_claims 
         (user_id, voucher_code, voucher_code_id, claimed_at, ip_address, 
          user_agent, device_id, status, request_id)
         VALUES ($1, $2, $3, NOW(), $4, $5, $6, 'success', $7)`,
          [
            userId,
            voucherCode,
            voucher.id,
            ipAddress,
            userAgent,
            deviceId,
            idempotencyKey,
          ]
        );

        // Cache operations
        await cacheService.invalidateUserCache(userId);
        await cacheService.setUserVoucherCount(
          userId,
          user.vouchers_claimed + 1
        );

        voucherClaimTotal.inc({ status: "success", region: "us-east" });

        return {
          success: true,
          message: "Voucher claimed successfully",
          vouchersRemaining: user.voucher_limit - (user.vouchers_claimed + 1),
          status: "success" as const,
        };
      });

      // Cache the result
      await cacheService.cacheClaimResult(idempotencyKey, result);

      return result;
    } catch (error) {
      logger.error("Error processing voucher claim", {
        jobId: job.id,
        userId,
        error,
      });
      throw error;
    }
  }

  public async close(): Promise<void> {
    await this.worker.close();
    logger.info("Voucher worker closed");
  }
}

const worker = new VoucherWorker();

process.on("SIGTERM", async () => {
  logger.info("SIGTERM received, shutting down gracefully");
  await worker.close();
  process.exit(0);
});

process.on("SIGINT", async () => {
  logger.info("SIGINT received, shutting down gracefully");
  await worker.close();
  process.exit(0);
});

export default worker;
