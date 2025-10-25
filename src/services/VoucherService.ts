import { db } from "../config/database";
import { cacheService } from "./CacheService";
import { rateLimitService } from "./RateLimitService";
import { queueService } from "../config/queue";
import { CircuitBreaker } from "../utils/circuitBreaker";
import { logger } from "../utils/logger";
import {
  ClaimVoucherRequest,
  ClaimVoucherResponse,
  User,
  VoucherCode,
  VoucherClaim,
  VoucherLimitExceeded,
  InvalidVoucherCode,
  RateLimitExceeded,
} from "../types";
import {
  voucherClaimTotal,
  voucherLimitViolations,
  voucherClaimDuration,
  activeUsers,
} from "../utils/metrics";

export class VoucherService {
  private dbCircuitBreaker: CircuitBreaker;

  constructor() {
    this.dbCircuitBreaker = new CircuitBreaker({
      failureThreshold: 5,
      successThreshold: 2,
      timeout: 5000,
      resetTimeout: 30000,
    });
  }

  /**
   * Main entry point for claiming vouchers
   */
  public async claimVoucher(
    request: ClaimVoucherRequest
  ): Promise<ClaimVoucherResponse> {
    const startTime = Date.now();
    activeUsers.inc();

    try {
      // Check for existing result (idempotency)
      const existingResult = await cacheService.getClaimResult(
        request.idempotencyKey
      );
      if (existingResult) {
        logger.info("Returning cached result", {
          userId: request.userId,
          idempotencyKey: request.idempotencyKey,
        });
        return existingResult;
      }

      // Rate limiting
      const rateLimit = await rateLimitService.checkRateLimit(
        request.userId,
        10,
        60
      );

      if (!rateLimit.allowed) {
        throw new RateLimitExceeded(
          `Rate limit exceeded. Try again in ${Math.ceil(
            (rateLimit.resetTime - Date.now()) / 1000
          )} seconds`
        );
      }

      // IP rate limiting
      const ipAllowed = await rateLimitService.checkIPRateLimit(
        request.ipAddress,
        100,
        60
      );

      if (!ipAllowed) {
        throw new RateLimitExceeded("Too many requests from this IP");
      }

      // Check cache first
      const cachedCount = await cacheService.getUserVoucherCount(
        request.userId
      );

      if (cachedCount !== null) {
        const user = await this.getUser(request.userId);

        if (cachedCount >= user.voucherLimit) {
          voucherLimitViolations.inc();
          throw new VoucherLimitExceeded();
        }
      }

      // Validate voucher code format
      if (!this.isValidVoucherCodeFormat(request.voucherCode)) {
        throw new InvalidVoucherCode("Invalid voucher code format");
      }

      // Check if voucher code exists and is valid
      const voucherCode = await this.getVoucherCode(request.voucherCode);
      if (!voucherCode) {
        throw new InvalidVoucherCode("Voucher code not found");
      }

      if (!this.isVoucherCodeValid(voucherCode, request.userId)) {
        throw new InvalidVoucherCode(
          "Voucher code is not valid or has expired"
        );
      }

      // Process immediately for premium users, queue for others
      const user = await this.getUser(request.userId);

      if (user.isPremium) {
        const result = await this.processClaimImmediate(request);
        await cacheService.cacheClaimResult(request.idempotencyKey, result);

        const duration = (Date.now() - startTime) / 1000;
        voucherClaimDuration.observe({ status: "success" }, duration);

        return result;
      } else {
        const jobId = await queueService.addClaimJob({
          id: request.idempotencyKey,
          userId: request.userId,
          voucherCode: request.voucherCode,
          ipAddress: request.ipAddress,
          userAgent: request.userAgent,
          deviceId: request.deviceId,
          idempotencyKey: request.idempotencyKey,
          timestamp: Date.now(),
        });

        return {
          success: true,
          message: "Claim request queued for processing",
          requestId: jobId,
          status: "pending",
        };
      }
    } catch (error) {
      const duration = (Date.now() - startTime) / 1000;
      voucherClaimDuration.observe({ status: "error" }, duration);

      if (
        error instanceof VoucherLimitExceeded ||
        error instanceof RateLimitExceeded ||
        error instanceof InvalidVoucherCode
      ) {
        throw error;
      }

      logger.error("Voucher claim error", { error, request });
      throw error;
    } finally {
      activeUsers.dec();
    }
  }

  /**
   * Process voucher claim immediately
   */
  private async processClaimImmediate(
    request: ClaimVoucherRequest
  ): Promise<ClaimVoucherResponse> {
    return await this.dbCircuitBreaker.execute(async () => {
      return await db.transaction(async (client) => {
        // Lock user row
        const userResult = await client.query(
          `SELECT id, email, vouchers_claimed, voucher_limit, is_premium, is_active
           FROM users
           WHERE id = $1 AND is_active = TRUE
           FOR UPDATE`,
          [request.userId]
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
          throw new VoucherLimitExceeded();
        }

        // Get and lock voucher code
        const voucherResult = await client.query(
          `SELECT id, code, is_active, is_used, usage_limit, usage_count, 
                  expires_at, discount_type, discount_value
           FROM voucher_codes
           WHERE code = $1
           FOR UPDATE`,
          [request.voucherCode]
        );

        if (voucherResult.rows.length === 0) {
          throw new InvalidVoucherCode("Voucher code not found");
        }

        const voucher = voucherResult.rows[0];

        // Validate voucher
        if (!voucher.is_active) {
          throw new InvalidVoucherCode("Voucher code is inactive");
        }

        if (voucher.expires_at && new Date(voucher.expires_at) < new Date()) {
          throw new InvalidVoucherCode("Voucher code has expired");
        }

        if (voucher.usage_count >= voucher.usage_limit) {
          throw new InvalidVoucherCode("Voucher code usage limit reached");
        }

        // Check if user already claimed this voucher
        const existingClaim = await client.query(
          `SELECT id FROM voucher_claims
           WHERE user_id = $1 AND voucher_code = $2 AND status = 'success'`,
          [request.userId, request.voucherCode]
        );

        if (existingClaim.rows.length > 0) {
          throw new InvalidVoucherCode("You have already claimed this voucher");
        }

        // Update user's voucher count
        await client.query(
          `UPDATE users
           SET vouchers_claimed = vouchers_claimed + 1,
               updated_at = NOW()
           WHERE id = $1`,
          [request.userId]
        );

        // NOTE: Voucher code usage is automatically updated by trigger
        // But we can also do it manually for explicitness
        await client.query(
          `UPDATE voucher_codes
           SET usage_count = usage_count + 1,
               is_used = CASE WHEN usage_count + 1 >= usage_limit THEN TRUE ELSE is_used END,
               used_by = CASE WHEN usage_limit = 1 THEN $1 ELSE used_by END,
               used_at = CASE WHEN usage_limit = 1 THEN NOW() ELSE used_at END,
               updated_at = NOW()
           WHERE id = $2`,
          [request.userId, voucher.id]
        );

        // Create voucher claim record
        const claimResult = await client.query(
          `INSERT INTO voucher_claims 
           (user_id, voucher_code, voucher_code_id, claimed_at, ip_address, 
            user_agent, device_id, status, request_id, metadata)
           VALUES ($1, $2, $3, NOW(), $4, $5, $6, 'success', $7, $8)
           RETURNING id`,
          [
            request.userId,
            request.voucherCode,
            voucher.id,
            request.ipAddress,
            request.userAgent,
            request.deviceId,
            request.idempotencyKey,
            JSON.stringify({
              discountType: voucher.discount_type,
              discountValue: voucher.discount_value,
            }),
          ]
        );

        // NOTE: Audit log is automatically created by trigger
        // But we can add additional context if needed

        // Invalidate cache
        await cacheService.invalidateUserCache(request.userId);

        // Update cache with new count
        await cacheService.setUserVoucherCount(
          request.userId,
          user.vouchers_claimed + 1
        );

        voucherClaimTotal.inc({ status: "success", region: "us-east" });

        logger.info("Voucher claimed successfully", {
          userId: request.userId,
          voucherCode: request.voucherCode,
          claimId: claimResult.rows[0].id,
          newCount: user.vouchers_claimed + 1,
        });

        return {
          success: true,
          message: "Voucher claimed successfully",
          vouchersRemaining: user.voucher_limit - (user.vouchers_claimed + 1),
          status: "success",
        };
      });
    });
  }

  /**
   * Get user by ID with caching
   */
  private async getUser(userId: number): Promise<User> {
    const cachedUser = await cacheService.getUser(userId);
    if (cachedUser) {
      return cachedUser;
    }

    const result = await db.query(
      `SELECT id, email, vouchers_claimed, voucher_limit, is_premium, is_admin,
              is_active, email_verified, phone, phone_verified, metadata,
              created_at, updated_at, last_login
       FROM users
       WHERE id = $1 AND is_active = TRUE`,
      [userId]
    );

    if (result.rows.length === 0) {
      throw new Error("User not found or inactive");
    }

    const user: User = {
      id: result.rows[0].id,
      email: result.rows[0].email,
      vouchersClaimed: result.rows[0].vouchers_claimed,
      voucherLimit: result.rows[0].voucher_limit,
      isPremium: result.rows[0].is_premium,
      isAdmin: result.rows[0].is_admin,
      isActive: result.rows[0].is_active,
      emailVerified: result.rows[0].email_verified,
      phone: result.rows[0].phone,
      phoneVerified: result.rows[0].phone_verified,
      metadata: result.rows[0].metadata,
      createdAt: result.rows[0].created_at,
      updatedAt: result.rows[0].updated_at,
      lastLogin: result.rows[0].last_login,
    };

    await cacheService.setUser(user);
    return user;
  }

  /**
   * Get voucher code from database
   */
  private async getVoucherCode(code: string): Promise<VoucherCode | null> {
    const result = await db.query(
      `SELECT id, code, is_active, is_used, used_by, used_at, usage_limit, 
              usage_count, valid_from, expires_at, discount_type, discount_value,
              min_purchase_amount, max_discount_amount, user_segment, 
              allowed_user_ids, description, metadata, created_at, updated_at, created_by
       FROM voucher_codes
       WHERE code = $1`,
      [code]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      id: row.id,
      code: row.code,
      isActive: row.is_active,
      isUsed: row.is_used,
      usedBy: row.used_by,
      usedAt: row.used_at,
      usageLimit: row.usage_limit,
      usageCount: row.usage_count,
      validFrom: row.valid_from,
      expiresAt: row.expires_at,
      discountType: row.discount_type,
      discountValue: row.discount_value
        ? parseFloat(row.discount_value)
        : undefined,
      minPurchaseAmount: row.min_purchase_amount
        ? parseFloat(row.min_purchase_amount)
        : undefined,
      maxDiscountAmount: row.max_discount_amount
        ? parseFloat(row.max_discount_amount)
        : undefined,
      userSegment: row.user_segment,
      allowedUserIds: row.allowed_user_ids,
      description: row.description,
      metadata: row.metadata,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      createdBy: row.created_by,
    };
  }

  /**
   * Validate voucher code format
   */
  private isValidVoucherCodeFormat(code: string): boolean {
    if (!code || typeof code !== "string") {
      return false;
    }

    if (code.length < 6 || code.length > 50) {
      return false;
    }

    const validPattern = /^[A-Z0-9-]+$/;
    return validPattern.test(code);
  }

  /**
   * Check if voucher code is valid for use
   */
  private isVoucherCodeValid(voucher: VoucherCode, userId: number): boolean {
    // Check if active
    if (!voucher.isActive) {
      logger.debug("Voucher code inactive", { code: voucher.code });
      return false;
    }

    // Check if already fully used
    if (voucher.usageCount >= voucher.usageLimit) {
      logger.debug("Voucher code usage limit reached", {
        code: voucher.code,
        usageCount: voucher.usageCount,
        usageLimit: voucher.usageLimit,
      });
      return false;
    }

    // Check validity period
    const now = new Date();
    if (voucher.validFrom && new Date(voucher.validFrom) > now) {
      logger.debug("Voucher code not yet valid", {
        code: voucher.code,
        validFrom: voucher.validFrom,
      });
      return false;
    }

    // Check expiration
    if (voucher.expiresAt && new Date(voucher.expiresAt) < now) {
      logger.debug("Voucher code expired", {
        code: voucher.code,
        expiresAt: voucher.expiresAt,
      });
      return false;
    }

    // Check user restrictions
    if (voucher.allowedUserIds && voucher.allowedUserIds.length > 0) {
      if (!voucher.allowedUserIds.includes(userId)) {
        logger.debug("User not in allowed list", {
          code: voucher.code,
          userId,
        });
        return false;
      }
    }

    return true;
  }

  /**
   * Get voucher claim status
   */
  public async getClaimStatus(requestId: string): Promise<any> {
    const cached = await cacheService.getClaimResult(requestId);
    if (cached) {
      return cached;
    }

    const jobStatus = await queueService.getJobStatus(requestId);
    return jobStatus || { status: "not_found" };
  }

  /**
   * Get user's voucher history
   */
  public async getUserVoucherHistory(
    userId: number,
    limit: number = 100,
    offset: number = 0
  ): Promise<VoucherClaim[]> {
    const result = await db.query(
      `SELECT vc.id, vc.user_id, vc.voucher_code, vc.voucher_code_id,
              vc.claimed_at, vc.ip_address, vc.user_agent, vc.device_id, 
              vc.session_id, vc.request_id, vc.status, vc.refunded_at, 
              vc.refunded_by, vc.refund_reason, vc.metadata,
              vcode.discount_type, vcode.discount_value
       FROM voucher_claims vc
       LEFT JOIN voucher_codes vcode ON vc.voucher_code_id = vcode.id
       WHERE vc.user_id = $1
       ORDER BY vc.claimed_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    return result.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      voucherCode: row.voucher_code,
      voucherCodeId: row.voucher_code_id,
      claimedAt: row.claimed_at,
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
      deviceId: row.device_id,
      sessionId: row.session_id,
      requestId: row.request_id,
      status: row.status,
      refundedAt: row.refunded_at,
      refundedBy: row.refunded_by,
      refundReason: row.refund_reason,
      metadata: {
        ...row.metadata,
        discountType: row.discount_type,
        discountValue: row.discount_value,
      },
    }));
  }

  /**
   * Refund a voucher
   */
  public async refundVoucher(
    claimId: number,
    reason: string,
    adminId?: number
  ): Promise<void> {
    await db.transaction(async (client) => {
      // Get claim
      const claimResult = await client.query(
        `SELECT id, user_id, voucher_code, voucher_code_id, status
         FROM voucher_claims
         WHERE id = $1
         FOR UPDATE`,
        [claimId]
      );

      if (claimResult.rows.length === 0) {
        throw new Error("Claim not found");
      }

      const claim = claimResult.rows[0];

      if (claim.status === "refunded") {
        throw new Error("Claim already refunded");
      }

      // Update claim status
      await client.query(
        `UPDATE voucher_claims
         SET status = 'refunded',
             refunded_at = NOW(),
             refunded_by = $1,
             refund_reason = $2
         WHERE id = $3`,
        [adminId, reason, claimId]
      );

      // Decrement user's voucher count
      await client.query(
        `UPDATE users
         SET vouchers_claimed = GREATEST(0, vouchers_claimed - 1),
             updated_at = NOW()
         WHERE id = $1`,
        [claim.user_id]
      );

      // Decrement voucher code usage count
      if (claim.voucher_code_id) {
        await client.query(
          `UPDATE voucher_codes
           SET usage_count = GREATEST(0, usage_count - 1),
               is_used = FALSE,
               updated_at = NOW()
           WHERE id = $1`,
          [claim.voucher_code_id]
        );
      }

      // Log to audit
      await client.query(
        `INSERT INTO voucher_audit_log
         (user_id, action, voucher_code, voucher_code_id, claim_id, metadata)
         VALUES ($1, 'REFUND', $2, $3, $4, $5)`,
        [
          claim.user_id,
          claim.voucher_code,
          claim.voucher_code_id,
          claimId,
          JSON.stringify({ reason, adminId }),
        ]
      );

      // Invalidate cache
      await cacheService.invalidateUserCache(claim.user_id);

      logger.info("Voucher refunded", {
        claimId,
        userId: claim.user_id,
        reason,
        adminId,
      });
    });
  }

  public async getVoucherStatistics(days: number = 7): Promise<any> {
    const result = await db.query(
      `SELECT 
         COUNT(*) as total_claims,
         COUNT(DISTINCT user_id) as unique_users,
         COUNT(*) FILTER (WHERE status = 'success') as successful_claims,
         COUNT(*) FILTER (WHERE status = 'failed') as failed_claims,
         COUNT(*) FILTER (WHERE status = 'refunded') as refunded_claims,
         COUNT(DISTINCT voucher_code) as unique_codes,
         COUNT(DISTINCT ip_address) as unique_ips,
         DATE_TRUNC('day', claimed_at) as claim_date
       FROM voucher_claims
       WHERE claimed_at >= NOW() - INTERVAL '${days} days'
       GROUP BY DATE_TRUNC('day', claimed_at)
       ORDER BY claim_date DESC`,
      []
    );

    return result.rows;
  }
}

export const voucherService = new VoucherService();
