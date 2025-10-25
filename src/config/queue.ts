import { Queue, QueueEvents } from "bullmq";
import { logger } from "../utils/logger";
import { QueueJob } from "../types";

class QueueService {
  private voucherQueue: Queue<QueueJob>;
  private queueEvents: QueueEvents;
  private static instance: QueueService;

  private constructor() {
    const connection = {
      host: process.env.QUEUE_REDIS_HOST || "localhost",
      port: parseInt(process.env.QUEUE_REDIS_PORT || "6379"),
    };

    this.voucherQueue = new Queue<QueueJob>("voucher-claims", {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 1000,
        },
        removeOnComplete: {
          count: 1000,
          age: 24 * 3600, // 24 hours
        },
        removeOnFail: {
          count: 5000,
          age: 7 * 24 * 3600, // 7 days
        },
      },
    });

    this.queueEvents = new QueueEvents("voucher-claims", { connection });

    this.queueEvents.on("completed", ({ jobId }) => {
      logger.info("Job completed", { jobId });
    });

    this.queueEvents.on("failed", ({ jobId, failedReason }) => {
      logger.error("Job failed", { jobId, failedReason });
    });
  }

  public static getInstance(): QueueService {
    if (!QueueService.instance) {
      QueueService.instance = new QueueService();
    }
    return QueueService.instance;
  }

  public async addClaimJob(data: QueueJob, priority?: number): Promise<string> {
    const job = await this.voucherQueue.add("claim-voucher", data, {
      priority: priority || 5,
      jobId: data.idempotencyKey, // Use idempotency key as job ID
    });

    logger.info("Job added to queue", { jobId: job.id, userId: data.userId });
    return job.id!;
  }

  public async getJobStatus(jobId: string): Promise<any> {
    const job = await this.voucherQueue.getJob(jobId);
    if (!job) {
      return null;
    }

    return {
      id: job.id,
      status: await job.getState(),
      progress: job.progress,
      data: job.data,
      returnvalue: job.returnvalue,
      failedReason: job.failedReason,
    };
  }

  public async getQueueMetrics() {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      this.voucherQueue.getWaitingCount(),
      this.voucherQueue.getActiveCount(),
      this.voucherQueue.getCompletedCount(),
      this.voucherQueue.getFailedCount(),
      this.voucherQueue.getDelayedCount(),
    ]);

    return {
      waiting,
      active,
      completed,
      failed,
      delayed,
      total: waiting + active + delayed,
    };
  }

  public getQueue(): Queue<QueueJob> {
    return this.voucherQueue;
  }

  public async close(): Promise<void> {
    await this.voucherQueue.close();
    await this.queueEvents.close();
    logger.info("Queue connections closed");
  }
}

export const queueService = QueueService.getInstance();
