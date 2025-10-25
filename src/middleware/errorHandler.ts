import { Request, Response, NextFunction } from "express";
import {
  VoucherError,
  VoucherLimitExceeded,
  RateLimitExceeded,
  InvalidVoucherCode,
} from "../types";
import { logger } from "../utils/logger";

export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  logger.error("Error handler caught error", {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  if (err instanceof VoucherLimitExceeded) {
    res.status(403).json({
      success: false,
      error: "Voucher limit exceeded",
      message: err.message,
      code: "LIMIT_EXCEEDED",
    });
    return;
  }

  if (err instanceof RateLimitExceeded) {
    res.status(429).json({
      success: false,
      error: "Rate limit exceeded",
      message: err.message,
      code: "RATE_LIMIT_EXCEEDED",
    });
    return;
  }

  if (err instanceof InvalidVoucherCode) {
    res.status(400).json({
      success: false,
      error: "Invalid voucher code",
      message: err.message,
      code: "INVALID_VOUCHER",
    });
    return;
  }

  if (err instanceof VoucherError) {
    res.status(err.statusCode).json({
      success: false,
      error: err.message,
      code: err.code,
    });
    return;
  }

  res.status(500).json({
    success: false,
    error: "Internal server error",
    message:
      process.env.NODE_ENV === "production"
        ? "An unexpected error occurred"
        : err.message,
  });
};

export const notFoundHandler = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  res.status(404).json({
    success: false,
    error: "Not found",
    message: `Route ${req.method} ${req.path} not found`,
  });
};

export const asyncHandler = (
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any>
) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
