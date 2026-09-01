import express from "express";
import cors from "cors";

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// ======================================
// Temporary in-memory storage
// ======================================

let sensorData = [];
let detections = [];
let alerts = [];


// ======================================
// Test API
// ======================================

app.get("/", (req, res) => {
  res.json({
    status: "success",
    message: "DrainWatch API is running"
  });
});


// ======================================
// Health check
// ======================================

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok"
  });
});


// ======================================
// RECEIVE SENSOR DATA
// ESP32 / Raspberry Pi → Render
// ======================================

app.post("/api/data", (req, res) => {

  console.log("Received sensor data:", req.body);

  const data = {
    ...req.body,
    received_at: new Date().toISOString()
  };

  sensorData.push(data);

  // Keep latest 1000 readings
  if (sensorData.length > 1000) {
    sensorData.shift();
  }

  res.json({
    status: "success",
    message: "Data received successfully",
    data: data
  });
});


// ======================================
// GET SENSOR DATA
// Render → Bolt Dashboard
// ======================================

app.get("/api/data", (req, res) => {

  res.json({
    status: "success",
    data: sensorData
  });

});


// ======================================
// GET DEVICE HISTORY
// Example:
// /api/data/DRAIN-001
// ======================================

app.get("/api/data/:device_id", (req, res) => {

  const deviceId = req.params.device_id;

  const deviceData = sensorData.filter(
    (item) => item.device_id === deviceId
  );

  res.json({
    status: "success",
    device_id: deviceId,
    data: deviceData
  });

});


// ======================================
// RECEIVE CAMERA DETECTIONS
// Raspberry Pi → Render
// ======================================

app.post("/api/detections", (req, res) => {

  console.log("Received detection:", req.body);

  const detection = {
    ...req.body,
    received_at: new Date().toISOString()
  };

  detections.push(detection);

  if (detections.length > 1000) {
    detections.shift();
  }

  res.json({
    status: "success",
    message: "Detection received successfully",
    data: detection
  });

});


// ======================================
// GET CAMERA DETECTIONS
// Render → Bolt Dashboard
// ======================================

app.get("/api/detections", (req, res) => {

  res.json({
    status: "success",
    data: detections
  });

});


// ======================================
// RECEIVE ALERT
// ======================================

app.post("/api/alerts", (req, res) => {

  console.log("Received alert:", req.body);

  const alert = {
    ...req.body,
    received_at: new Date().toISOString()
  };

  alerts.push(alert);

  if (alerts.length > 1000) {
    alerts.shift();
  }

  res.json({
    status: "success",
    message: "Alert received successfully",
    data: alert
  });

});


// ======================================
// GET ALERTS
// Render → Bolt Dashboard
// ======================================

app.get("/api/alerts", (req, res) => {

  res.json({
    status: "success",
    data: alerts
  });

});


// ======================================
// START SERVER
// ======================================

app.listen(PORT, "0.0.0.0", () => {

  console.log(
    `DrainWatch API running on port ${PORT}`
  );

});
