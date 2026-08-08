import express from "express";
import dotenv from "dotenv";
import helmet from "helmet";
import compression from "compression";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Basic security
app.disable("x-powered-by");
app.use(helmet());
app.use(compression());
app.use(express.json({ limit: "100kb" }));

// Health check
app.get("/", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "Nova-AI",
    message: "Nova-AI server is running"
  });
});

app.listen(PORT, () => {
  console.log(`Nova-AI server running on port ${PORT}`);
});