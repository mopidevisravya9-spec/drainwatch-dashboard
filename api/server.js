import express from "express";
import cors from "cors";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";

const app = express();

app.use(cors());
app.use(express.json({ limit: "15mb" }));

const PORT = process.env.PORT || 10000;

// ======================================
// TEMPORARY IN-MEMORY STORAGE
// ======================================

let sensorData = [];
let detections = [];
let alerts = [];

// ======================================
// CAMERA STORAGE
// ======================================

const cameraFrames = new Map();
const cameraSnapshots = new Map();

let nextSnapshotId = 1;

const MAX_SNAPSHOTS = 100;
const CAMERA_FRAME_TIMEOUT_MS = 5000;

// ======================================
// TEST API
// ======================================

app.get("/", (req, res) => {
  res.json({
    status: "success",
    message: "DrainWatch API is running"
  });
});

// ======================================
// HEALTH CHECK
// ======================================

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    camera_devices: cameraFrames.size
  });
});

// ======================================
// RECEIVE SENSOR DATA
// ======================================

app.post("/api/data", (req, res) => {
  const data = {
    ...req.body,
    received_at: new Date().toISOString()
  };

  console.log("Received sensor data:", data);

  sensorData.push(data);

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
// ======================================

app.get("/api/data", (req, res) => {
  res.json({
    status: "success",
    data: sensorData
  });
});

// ======================================
// DEVICE HISTORY
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
// ======================================

app.post("/api/detections", (req, res) => {
  const detection = {
    ...req.body,
    received_at: new Date().toISOString()
  };

  console.log("Received detection:", detection);

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
// ======================================

app.get("/api/detections", (req, res) => {
  res.json({
    status: "success",
    data: detections
  });
});

// ======================================
// RECEIVE ALERTS
// ======================================

app.post("/api/alerts", (req, res) => {
  const alert = {
    ...req.body,
    received_at: new Date().toISOString()
  };

  console.log("Received alert:", alert);

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
// ======================================

app.get("/api/alerts", (req, res) => {
  res.json({
    status: "success",
    data: alerts
  });
});

// ======================================
// GET FRESH CAMERA FRAME
// ======================================

function getFreshFrame(deviceId) {
  const item = cameraFrames.get(deviceId);

  if (!item) {
    return null;
  }

  const age = Date.now() - item.updatedAt;

  if (age > CAMERA_FRAME_TIMEOUT_MS) {
    cameraFrames.delete(deviceId);
    return null;
  }

  return item;
}

// ======================================
// CAMERA STATUS
// ======================================

app.get("/api/camera/status", (req, res) => {
  const data = {};

  for (const [deviceId, item] of cameraFrames.entries()) {
    const age = Date.now() - item.updatedAt;

    if (age <= CAMERA_FRAME_TIMEOUT_MS) {
      data[deviceId] = {
        online: true,
        device_id: deviceId,
        device_name: item.deviceName,
        last_frame_at: new Date(item.updatedAt).toISOString()
      };
    } else {
      cameraFrames.delete(deviceId);
    }
  }

  res.json({
    status: "success",
    data: data
  });
});

// ======================================
// GET SNAPSHOT LIST
// ======================================

app.get("/api/snapshots", (req, res) => {
  const deviceId = req.query.device_id;

  let list = Array.from(cameraSnapshots.values());

  if (deviceId) {
    list = list.filter(
      (item) => item.device_id === deviceId
    );
  }

  list.sort((a, b) => b.id - a.id);

  res.json({
    status: "success",
    data: list.map((item) => ({
      id: item.id,
      device_id: item.device_id,
      device_name: item.device_name,
      filename: item.filename,
      captured_at: item.captured_at,
      url: `/api/snapshots/${item.id}`
    }))
  });
});

// ======================================
// GET ONE SNAPSHOT
// ======================================

app.get("/api/snapshots/:id", (req, res) => {
  const id = Number(req.params.id);

  const item = cameraSnapshots.get(id);

  if (!item) {
    return res.status(404).json({
      status: "error",
      message: "Snapshot not found"
    });
  }

  res.setHeader(
    "Content-Type",
    item.contentType || "image/jpeg"
  );

  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, max-age=0"
  );

  return res.send(item.buffer);
});

// ======================================
// RECEIVE SNAPSHOT FROM RASPBERRY PI
// ======================================

app.post("/api/snapshots/upload", (req, res) => {
  try {
    const {
      device_id,
      device_name,
      filename,
      captured_at,
      content_type,
      image_base64
    } = req.body || {};

    if (!device_id || !image_base64) {
      return res.status(400).json({
        status: "error",
        message: "device_id and image_base64 are required"
      });
    }

    const cleanBase64 = String(image_base64).replace(
      /^data:image\/[^;]+;base64,/i,
      ""
    );

    const buffer = Buffer.from(
      cleanBase64,
      "base64"
    );

    if (!buffer.length) {
      return res.status(400).json({
        status: "error",
        message: "Invalid image data"
      });
    }

    const id = nextSnapshotId++;

    const item = {
      id: id,
      device_id: String(device_id),
      device_name: String(
        device_name || device_id
      ),
      filename: String(
        filename || `snapshot_${id}.jpg`
      ),
      captured_at:
        captured_at || new Date().toISOString(),
      contentType:
        content_type || "image/jpeg",
      buffer: buffer
    };

    cameraSnapshots.set(id, item);

    while (
      cameraSnapshots.size > MAX_SNAPSHOTS
    ) {
      const oldestId =
        cameraSnapshots.keys().next().value;

      cameraSnapshots.delete(oldestId);
    }

    console.log(
      `Snapshot received: ${item.device_id} #${item.id}`
    );

    return res.json({
      status: "success",
      message: "Snapshot uploaded successfully",
      data: {
        id: item.id,
        device_id: item.device_id,
        device_name: item.device_name,
        filename: item.filename,
        captured_at: item.captured_at,
        url: `/api/snapshots/${item.id}`
      }
    });

  } catch (error) {
    console.error(
      "Snapshot upload error:",
      error
    );

    return res.status(500).json({
      status: "error",
      message: "Snapshot upload failed"
    });
  }
});

// ======================================
// CREATE HTTP SERVER
// ======================================

const server = http.createServer(app);

// ======================================
// CAMERA WEBSOCKET SERVER
// ======================================

const cameraWss = new WebSocketServer({
  server: server,
  path: "/ws/camera"
});

// ======================================
// WEBSOCKET CONNECTION
// ======================================

cameraWss.on("connection", (ws) => {

  ws.role = null;
  ws.deviceId = null;
  ws.deviceName = null;

  console.log(
    "Camera WebSocket connected"
  );

  // ====================================
  // RECEIVE MESSAGE
  // ====================================

  ws.on("message", (message, isBinary) => {

    try {

      // ==================================
      // TEXT MESSAGE
      // Registration from Pi or browser
      // ==================================

      if (!isBinary) {

        const data = JSON.parse(
          message.toString()
        );

        // -------------------------------
        // RASPBERRY PI REGISTRATION
        // -------------------------------

        if (data.type === "register") {

          const deviceId = String(
            data.device_id || ""
          );

          const deviceName = String(
            data.device_name || deviceId
          );

          if (!deviceId) {

            ws.close(
              1008,
              "device_id is required"
            );

            return;
          }

          ws.role = "pi";
          ws.deviceId = deviceId;
          ws.deviceName = deviceName;

          ws.send(
            JSON.stringify({
              type: "registered",
              device_id: deviceId,
              device_name: deviceName
            })
          );

          console.log(
            `Camera PI registered: ${deviceId}`
          );

          return;
        }

        // -------------------------------
        // FLORA BROWSER REGISTRATION
        // -------------------------------

        if (data.type === "viewer") {

          const deviceId = String(
            data.device_id || ""
          );

          if (!deviceId) {

            ws.close(
              1008,
              "device_id is required"
            );

            return;
          }

          ws.role = "viewer";
          ws.deviceId = deviceId;

          ws.send(
            JSON.stringify({
              type: "viewer_registered",
              device_id: deviceId
            })
          );

          console.log(
            `Camera viewer registered: ${deviceId}`
          );

          // Send latest frame immediately
          const frame =
            getFreshFrame(deviceId);

          if (
            frame &&
            ws.readyState ===
              WebSocket.OPEN
          ) {

            ws.send(
              frame.buffer,
              {
                binary: true
              }
            );
          }

          return;
        }

        return;
      }

      // ==================================
      // BINARY MESSAGE = CAMERA FRAME
      // ==================================

      if (
        ws.role !== "pi" ||
        !ws.deviceId
      ) {
        return;
      }

      const buffer = Buffer.from(
        message
      );

      if (!buffer.length) {
        return;
      }

      // Store latest frame
      cameraFrames.set(
        ws.deviceId,
        {
          deviceId:
            ws.deviceId,

          deviceName:
            ws.deviceName ||
            ws.deviceId,

          buffer:
            buffer,

          updatedAt:
            Date.now(),

          producer:
            ws
        }
      );

      // ==================================
      // SEND FRAME TO FLORA VIEWERS
      // ==================================

      for (
        const client of cameraWss.clients
      ) {

        if (client === ws) {
          continue;
        }

        if (
          client.readyState !==
          WebSocket.OPEN
        ) {
          continue;
        }

        if (
          client.role !== "viewer"
        ) {
          continue;
        }

        if (
          client.deviceId !==
          ws.deviceId
        ) {
          continue;
        }

        try {

          client.send(
            buffer,
            {
              binary: true
            }
          );

        } catch (error) {

          console.error(
            "Viewer send error:",
            error.message
          );

        }
      }

    } catch (error) {

      console.error(
        "Camera WebSocket message error:",
        error.message
      );

    }

  });

  // ====================================
  // WEBSOCKET CLOSED
  // ====================================

  ws.on("close", () => {

    console.log(
      `Camera WebSocket closed: ${
        ws.deviceId || "unknown"
      } (${ws.role || "unknown"})`
    );

    if (
      ws.role === "pi" &&
      ws.deviceId
    ) {

      const stored =
        cameraFrames.get(
          ws.deviceId
        );

      if (
        stored &&
        stored.producer === ws
      ) {

        cameraFrames.delete(
          ws.deviceId
        );

      }
    }

  });

  // ====================================
  // WEBSOCKET ERROR
  // ====================================

  ws.on("error", (error) => {

    console.error(
      "Camera WebSocket error:",
      error.message
    );

  });

});

// ======================================
// START SERVER
// ======================================

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `DrainWatch API running on port ${PORT}`
    );

    console.log(
      "Camera WebSocket: /ws/camera"
    );

  }
);
