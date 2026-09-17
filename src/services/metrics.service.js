import client from "prom-client";

export const register = new client.Registry();

client.collectDefaultMetrics({ register });

export const httpRequestsTotal = new client.Counter({
  name: "nova_ai_http_requests_total",
  help: "Total number of HTTP requests handled",
  labelNames: ["method", "route", "status"],
  registers: [register],
});

export const httpRequestDurationSeconds = new client.Histogram({
  name: "nova_ai_http_request_duration_seconds",
  help: "Histogram of HTTP request latency in seconds",
  labelNames: ["method", "route", "status"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

export const messagesProcessedTotal = new client.Counter({
  name: "nova_ai_messages_processed_total",
  help: "Total WhatsApp messages processed",
  labelNames: ["tenant_id", "status"],
  registers: [register],
});

export const queueJobsTotal = new client.Counter({
  name: "nova_ai_queue_jobs_total",
  help: "Total queue jobs processed",
  labelNames: ["status"],
  registers: [register],
});

export const geminiDurationSeconds = new client.Histogram({
  name: "nova_ai_gemini_duration_seconds",
  help: "Latency of Gemini API generation calls in seconds",
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30],
  registers: [register],
});

export function metricsMiddleware(req, res, next) {
  const start = process.hrtime();

  res.on("finish", () => {
    const diff = process.hrtime(start);
    const durationInSeconds = diff[0] + diff[1] / 1e9;
    const route = req.route?.path || req.path || "unknown";
    const labels = {
      method: req.method,
      route,
      status: res.statusCode,
    };

    httpRequestsTotal.inc(labels);
    httpRequestDurationSeconds.observe(labels, durationInSeconds);
  });

  next();
}

export async function metricsEndpoint(req, res) {
  try {
    res.set("Content-Type", register.contentType);
    res.end(await register.metrics());
  } catch (error) {
    res.status(500).end(error.message);
  }
}
