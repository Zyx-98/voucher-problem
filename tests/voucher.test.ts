import request from "supertest";
import app from "../src/app";
import { db } from "../src/config/database";
import { redis } from "../src/config/redis";

describe("Voucher API", () => {
  beforeAll(async () => {
    await db.query("DELETE FROM voucher_claims");
    await db.query("UPDATE users SET vouchers_claimed = 0");
  });

  afterAll(async () => {
    await db.close();
    await redis.close();
  });

  describe("POST /api/vouchers/claim", () => {
    it("should claim a voucher successfully", async () => {
      const response = await request(app as any)
        .post("/api/vouchers/claim")
        .set("x-user-id", "1")
        .send({
          voucherCode: "TESTCODE123",
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toContain("successfully");
    });

    it("should reject claim when limit exceeded", async () => {
      await db.query(
        "UPDATE users SET vouchers_claimed = voucher_limit WHERE id = 1"
      );

      const response = await request(app as any)
        .post("/api/vouchers/claim")
        .set("x-user-id", "1")
        .send({
          voucherCode: "TESTCODE123",
        });

      expect(response.status).toBe(403);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain("limit");
    });

    it("should reject invalid voucher code", async () => {
      const response = await request(app as any)
        .post("/api/vouchers/claim")
        .set("x-user-id", "1")
        .send({
          voucherCode: "ABC",
        });

      expect(response.status).toBe(400);
    });
  });

  describe("GET /api/vouchers/history", () => {
    it("should return user voucher history", async () => {
      const response = await request(app as any)
        .get("/api/vouchers/history")
        .set("x-user-id", "1");

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data)).toBe(true);
    });
  });

  describe("GET /health", () => {
    it("should return healthy status", async () => {
      const response = await request(app as any).get("/health");

      expect(response.status).toBe(200);
      expect(response.body.status).toBe("healthy");
    });
  });
});
