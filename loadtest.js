const axios = require("axios");
const { performance } = require("perf_hooks");

const API_URL = "http://localhost:3000/api/vouchers/claim";
const CONCURRENT_USERS = 1000;
const REQUESTS_PER_USER = 10;

async function claimVoucher(userId) {
  const start = performance.now();
  try {
    const response = await axios.post(
      API_URL,
      {
        voucherCode: `VOUCHER${Math.random()
          .toString(36)
          .substring(7)
          .toUpperCase()}`,
      },
      {
        headers: {
          "x-user-id": userId.toString(),
          "Content-Type": "application/json",
        },
      }
    );
    const duration = performance.now() - start;
    return { success: true, duration, status: response.status };
  } catch (error) {
    const duration = performance.now() - start;
    return {
      success: false,
      duration,
      status: error.response?.status,
      error: error.message,
    };
  }
}

async function runLoadTest() {
  console.log(`Starting load test with ${CONCURRENT_USERS} users...`);
  console.log(`Each user will make ${REQUESTS_PER_USER} requests`);

  const startTime = performance.now();
  const promises = [];

  for (let userId = 1; userId <= CONCURRENT_USERS; userId++) {
    for (let req = 0; req < REQUESTS_PER_USER; req++) {
      promises.push(claimVoucher(userId));
    }
  }

  const results = await Promise.all(promises);
  const endTime = performance.now();

  // Analyze results
  const successful = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  const durations = results.map((r) => r.duration);
  const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
  const minDuration = Math.min(...durations);
  const maxDuration = Math.max(...durations);
  const totalTime = (endTime - startTime) / 1000;
  const rps = results.length / totalTime;

  console.log("\n=== Load Test Results ===");
  console.log(`Total requests: ${results.length}`);
  console.log(`Successful: ${successful}`);
  console.log(`Failed: ${failed}`);
  console.log(
    `Success rate: ${((successful / results.length) * 100).toFixed(2)}%`
  );
  console.log(`\nTotal time: ${totalTime.toFixed(2)}s`);
  console.log(`Requests per second: ${rps.toFixed(2)}`);
  console.log(`\nAverage response time: ${avgDuration.toFixed(2)}ms`);
  console.log(`Min response time: ${minDuration.toFixed(2)}ms`);
  console.log(`Max response time: ${maxDuration.toFixed(2)}ms`);
}

runLoadTest().catch(console.error);
