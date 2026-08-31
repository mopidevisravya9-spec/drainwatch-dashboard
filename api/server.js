import express from "express";
import cors from "cors";

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// Test API
app.get("/", (req, res) => {
  res.json({
    status: "success",
    message: "DrainWatch API is running"
  });
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok"
  });
});

// Receive data from ESP / Raspberry Pi
app.post("/api/data", (req, res) => {
  console.log("Received data:", req.body);

  res.json({
    status: "success",
    message: "Data received successfully",
    data: req.body
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`DrainWatch API running on port ${PORT}`);
});
