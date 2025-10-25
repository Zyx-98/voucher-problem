import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { StringValue } from "ms";
import { db } from "../config/database";
import crypto from "crypto";
import { logger } from "../utils/logger";
import { User } from "../types";

export interface AuthRequest extends Request {
  userId?: number;
  user?: {
    id: number;
    email: string;
    isPremium: boolean;
  };
}

interface JWTPayload {
  userId: number;
  email: string;
  isPremium: boolean;
  iat: number;
  exp: number;
}

export const authenticate = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers["authorization"];

    if (!authHeader) {
      res.status(401).json({
        success: false,
        error: "Unauthorized",
        message: "Authorization header required",
      });
      return;
    }

    const parts = authHeader.split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer") {
      res.status(401).json({
        success: false,
        error: "Unauthorized",
        message: "Invalid authorization format",
      });
      return;
    }

    const token = parts[1];

    // Check if token is blacklisted
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const blacklistCheck = await db.query(
      `SELECT id FROM blacklisted_tokens WHERE token_hash = $1 AND expires_at > NOW()`,
      [tokenHash]
    );

    if (blacklistCheck.rows.length > 0) {
      res.status(401).json({
        success: false,
        error: "Unauthorized",
        message: "Token has been revoked",
      });
      return;
    }

    // Verify JWT token
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || "your-secret-key"
    ) as JWTPayload;

    // Fetch user
    const result = await db.query(
      `SELECT id, email, is_premium, is_admin, is_active, email_verified
       FROM users
       WHERE id = $1 AND is_active = TRUE`,
      [decoded.userId]
    );

    if (result.rows.length === 0) {
      res.status(401).json({
        success: false,
        error: "Unauthorized",
        message: "User not found or inactive",
      });
      return;
    }

    const user = result.rows[0];

    // Update last activity
    await db.query(`UPDATE users SET last_login = NOW() WHERE id = $1`, [
      user.id,
    ]);

    req.userId = user.id;
    req.user = {
      id: user.id,
      email: user.email,
      isPremium: user.is_premium,
    };

    next();
  } catch (error) {
    logger.error("Authentication error", { error });
    res.status(401).json({
      success: false,
      error: "Unauthorized",
      message: "Authentication failed",
    });
  }
};

export async function blacklistToken(
  token: string,
  userId: number,
  reason: string
): Promise<void> {
  try {
    const decoded = jwt.decode(token) as JWTPayload;
    if (!decoded || !decoded.exp) {
      return;
    }

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(decoded.exp * 1000);

    await db.query(
      `INSERT INTO blacklisted_tokens (token_hash, user_id, expires_at, reason)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (token_hash) DO NOTHING`,
      [tokenHash, userId, expiresAt, reason]
    );

    logger.info("Token blacklisted", { userId, reason });
  } catch (error) {
    logger.error("Error blacklisting token", { error });
  }
}

export const optionalAuth = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers["authorization"];

    if (!authHeader) {
      next();
      return;
    }

    const parts = authHeader.split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer") {
      next();
      return;
    }

    const token = parts[1];

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || "your-secret-key"
    ) as JWTPayload;

    req.userId = decoded.userId;
    req.user = {
      id: decoded.userId,
      email: decoded.email,
      isPremium: decoded.isPremium,
    };

    next();
  } catch (error) {
    next();
  }
};

export const requireAdmin = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  if (!req.userId) {
    res.status(401).json({
      success: false,
      error: "Unauthorized",
      message: "Authentication required",
    });
    return;
  }

  try {
    const result = await db.query(`SELECT is_admin FROM users WHERE id = $1`, [
      req.userId,
    ]);

    if (result.rows.length === 0 || !result.rows[0].is_admin) {
      res.status(403).json({
        success: false,
        error: "Forbidden",
        message: "Admin access required",
      });
      return;
    }

    next();
  } catch (error) {
    logger.error("Admin check error", { error });
    res.status(500).json({
      success: false,
      error: "Internal server error",
      message: "Authorization check failed",
    });
  }
};

export function generateToken(user: User): string {
  const payload: Omit<JWTPayload, "iat" | "exp"> = {
    userId: user.id,
    email: user.email,
    isPremium: user.isPremium,
  };

  return jwt.sign(payload, process.env.JWT_SECRET || "your-secret-key", {
    expiresIn: (process.env.JWT_EXPIRY || "24h") as StringValue,
  });
}

export function generateRefreshToken(user: User): string {
  const payload = {
    userId: user.id,
    type: "refresh",
  };

  return jwt.sign(
    payload,
    process.env.JWT_REFRESH_SECRET || "your-refresh-secret",
    {
      expiresIn: "7d",
    }
  );
}

export async function refreshAccessToken(
  refreshToken: string
): Promise<string> {
  try {
    const decoded = jwt.verify(
      refreshToken,
      process.env.JWT_REFRESH_SECRET || "your-refresh-secret"
    ) as any;

    if (decoded.type !== "refresh") {
      throw new Error("Invalid token type");
    }

    const result = await db.query(
      `SELECT id, email, is_premium, is_admin, is_active, email_verified, phone_verified
      FROM users WHERE id = $1`,
      [decoded.userId]
    );

    if (result.rows.length === 0) {
      throw new Error("User not found");
    }

    const user = result.rows[0];

    return generateToken({
      id: user.id,
      email: user.email,
      isActive: user.is_active,
      emailVerified: user.email_verified,
      isAdmin: user.is_admin,
      phoneVerified: user.phone_verified,
      vouchersClaimеd: 0,
      voucherLimit: 0,
      isPremium: user.is_premium,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  } catch (error) {
    logger.error("Error refreshing token", { error });
    throw new Error("Invalid refresh token");
  }
}
