import { Request, Response, NextFunction } from "express";
import { rateLimitService } from "../services/RateLimitService";
import { logger } from "../utils/logger";
import { AuthRequest } from "./auth";

export const rateLimitMiddleware = (
  maxRequests: number = 10,
  windowSeconds: number = 60
) => {
  return async (
    req: AuthRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const userId = req.userId;

      if (!userId) {
        res.status(401).json({
          success: false,
          error: "Unauthorized",
          message: "Authentication required for rate limiting",
        });
        return;
      }

      const result = await rateLimitService.checkRateLimit(
        userId,
        maxRequests,
        windowSeconds
      );

      res.setHeader("X-RateLimit-Limit", maxRequests);
      res.setHeader("X-RateLimit-Remaining", result.remainingRequests);
      res.setHeader("X-RateLimit-Reset", result.resetTime);

      if (!result.allowed) {
        const retryAfter = Math.ceil((result.resetTime - Date.now()) / 1000);
        res.setHeader("Retry-After", retryAfter);

        res.status(429).json({
          success: false,
          error: "Rate limit exceeded",
          message: `Too many requests. Please try again in ${retryAfter} seconds`,
          retryAfter,
        });
        return;
      }

      next();
    } catch (error) {
      logger.error("Rate limit middleware error", { error });
      next(error);
    }
  };
};

/**
 * IP-based rate limiting middleware
 */
export const ipRateLimitMiddleware = (
  maxRequests: number = 100,
  windowSeconds: number = 60
) => {
  return async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const ipAddress = getClientIp(req);

      const allowed = await rateLimitService.checkIPRateLimit(
        ipAddress,
        maxRequests,
        windowSeconds
      );

      if (!allowed) {
        res.status(429).json({
          success: false,
          error: "Rate limit exceeded",
          message: "Too many requests from this IP address",
        });
        return;
      }

      next();
    } catch (error) {
      logger.error("IP rate limit middleware error", { error });
      next(error);
    }
  };
};

/**
 * Get client IP address
 */
function getClientIp(req: Request): string {
  return (
    (req.headers["x-forwarded-for"] as string)?.split(",")[0] ||
    (req.headers["x-real-ip"] as string) ||
    req.socket.remoteAddress ||
    "unknown"
  );
}
