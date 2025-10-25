export interface User {
  id: number;
  email: string;
  passwordHash?: string;
  vouchersClaimed: number;
  voucherLimit: number;
  isPremium: boolean;
  isAdmin: boolean;
  isActive: boolean;
  emailVerified: boolean;
  phone?: string;
  phoneVerified: boolean;
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
  lastLogin?: Date;
}

export interface VoucherCode {
  id: number;
  code: string;
  isActive: boolean;
  isUsed: boolean;
  usedBy?: number;
  usedAt?: Date;
  usageLimit: number;
  usageCount: number;
  validFrom: Date;
  expiresAt?: Date;
  discountType?: 'percentage' | 'fixed' | 'free_shipping';
  discountValue?: number;
  minPurchaseAmount?: number;
  maxDiscountAmount?: number;
  userSegment?: string;
  allowedUserIds?: number[];
  description?: string;
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: number;
}

export interface VoucherClaim {
  id: number;
  userId: number;
  voucherCode: string;
  voucherCodeId?: number;
  claimedAt: Date;
  ipAddress: string;
  userAgent: string;
  deviceId?: string;
  sessionId?: string;
  requestId?: string;
  status: 'pending' | 'success' | 'failed' | 'refunded';
  refundedAt?: Date;
  refundedBy?: number;
  refundReason?: string;
  metadata?: Record<string, any>;
}

export interface UserSession {
  id: number;
  userId: number;
  sessionToken: string;
  refreshToken?: string;
  ipAddress?: string;
  userAgent?: string;
  deviceId?: string;
  createdAt: Date;
  expiresAt: Date;
  lastActivity: Date;
  isActive: boolean;
}

export interface BlacklistedToken {
  id: number;
  tokenHash: string;
  userId?: number;
  blacklistedAt: Date;
  expiresAt: Date;
  reason?: string;
}

export interface VoucherAuditLog {
  id: number;
  userId?: number;
  action: 'CLAIM_SUCCESS' | 'CLAIM_DENIED' | 'LIMIT_REACHED' | 'REFUND' | 'CODE_CREATED' | 'CODE_DEACTIVATED' | 'SUSPICIOUS_ACTIVITY';
  voucherCode?: string;
  voucherCodeId?: number;
  claimId?: number;
  ipAddress?: string;
  userAgent?: string;
  deviceId?: string;
  sessionId?: string;
  metadata?: Record<string, any>;
  createdAt: Date;
}

export interface ClaimVoucherRequest {
  userId: number;
  voucherCode: string;
  ipAddress: string;
  userAgent: string;
  deviceId?: string;
  idempotencyKey: string;
}

export interface ClaimVoucherResponse {
  success: boolean;
  message: string;
  vouchersRemaining?: number;
  requestId?: string;
  status?: "pending" | "success" | "limit_reached";
}

export interface QueueJob {
  id: string;
  userId: number;
  voucherCode: string;
  ipAddress: string;
  userAgent: string;
  deviceId?: string;
  idempotencyKey: string;
  timestamp: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remainingRequests: number;
  resetTime: number;
}

export interface MetricsData {
  totalClaims: number;
  successfulClaims: number;
  failedClaims: number;
  averageResponseTime: number;
  queueDepth: number;
  activeConnections: number;
}

export class VoucherError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
    public code: string = "INTERNAL_ERROR"
  ) {
    super(message);
    this.name = "VoucherError";
  }
}

export class VoucherLimitExceeded extends VoucherError {
  constructor(message: string = "Voucher limit exceeded") {
    super(message, 403, "LIMIT_EXCEEDED");
    this.name = "VoucherLimitExceeded";
  }
}

export class RateLimitExceeded extends VoucherError {
  constructor(message: string = "Rate limit exceeded") {
    super(message, 429, "RATE_LIMIT_EXCEEDED");
    this.name = "RateLimitExceeded";
  }
}

export class InvalidVoucherCode extends VoucherError {
  constructor(message: string = "Invalid voucher code") {
    super(message, 400, "INVALID_VOUCHER");
    this.name = "InvalidVoucherCode";
  }
}
