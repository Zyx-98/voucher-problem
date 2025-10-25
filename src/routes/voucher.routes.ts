import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { voucherService } from "../services/VoucherService";
import { queueService } from "../config/queue";
import { authenticate, AuthRequest, blacklistToken } from "../middleware/auth";
import { rateLimitMiddleware } from "../middleware/rateLimit";
import { asyncHandler } from "../middleware/errorHandler";
import { db } from "../config/database";

const router = Router();

/**
 * Claim a voucher
 * POST /api/vouchers/claim
 */
router.post(
  "/claim",
  authenticate,
  rateLimitMiddleware(10, 60),
  asyncHandler(async (req: AuthRequest, res) => {
    const { voucherCode, deviceId } = req.body;

    if (!voucherCode) {
      res.status(400).json({
        success: false,
        error: "Bad request",
        message: "Voucher code is required",
      });
      return;
    }

    const ipAddress =
      (req.headers["x-forwarded-for"] as string)?.split(",")[0] ||
      (req.headers["x-real-ip"] as string) ||
      req.socket.remoteAddress ||
      "unknown";

    const userAgent = req.headers["user-agent"] || "unknown";

    // Generate idempotency key from header or create new
    const idempotencyKey =
      (req.headers["idempotency-key"] as string) || uuidv4();

    const result = await voucherService.claimVoucher({
      userId: req.userId!,
      voucherCode,
      ipAddress,
      userAgent,
      deviceId,
      idempotencyKey,
    });

    res.status(result.success ? 200 : 400).json(result);
  })
);

/**
 * Get claim status
 * GET /api/vouchers/claim/:requestId
 */
router.get(
  "/claim/:requestId",
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const { requestId } = req.params;

    const status = await voucherService.getClaimStatus(requestId);

    res.json({
      success: true,
      data: status,
    });
  })
);

/**
 * Get user's voucher history
 * GET /api/vouchers/history
 */
router.get(
  "/history",
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const history = await voucherService.getUserVoucherHistory(req.userId!);

    res.json({
      success: true,
      data: history,
    });
  })
);

/**
 * Refund a voucher (admin only)
 * POST /api/vouchers/refund
 */
router.post(
  "/refund",
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const { claimId, reason } = req.body;

    if (!claimId || !reason) {
      res.status(400).json({
        success: false,
        error: "Bad request",
        message: "Claim ID and reason are required",
      });
      return;
    }

    await voucherService.refundVoucher(claimId, reason);

    res.json({
      success: true,
      message: "Voucher refunded successfully",
    });
  })
);

/**
 * Get queue metrics
 * GET /api/vouchers/queue/metrics
 */
router.get(
  "/queue/metrics",
  asyncHandler(async (req, res) => {
    const metrics = await queueService.getQueueMetrics();

    res.json({
      success: true,
      data: metrics,
    });
  })
);

/**
 * Health check
 * GET /api/vouchers/health
 */
router.get("/health", (req, res) => {
  res.json({
    success: true,
    status: "healthy",
    timestamp: new Date().toISOString(),
  });
});


/**
 * Logout endpoint
 * POST /api/vouchers/logout
 */
router.post(
  '/logout',
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const token = req.headers['authorization']?.split(' ')[1];
    
    if (token) {
      await blacklistToken(token, req.userId!, 'user_logout');
    }

    res.json({
      success: true,
      message: 'Logged out successfully',
    });
  })
);

/**
 * Get user summary
 * GET /api/vouchers/user/summary
 */
router.get(
  '/user/summary',
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const result = await db.query(
      `SELECT * FROM user_voucher_summary WHERE id = $1`,
      [req.userId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({
        success: false,
        message: 'User not found',
      });
      return;
    }

    res.json({
      success: true,
      data: result.rows[0],
    });
  })
);

export default router;
