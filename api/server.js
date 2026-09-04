import express from "express";
import cors from "cors";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";

const app = express();

app.use(cors());
app.use(express.json({ limit: "12mb" }));

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
const MAX_FRAME_AGE_MS = 5000;

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
  console.log("Received sensor data:", req.body);

  const data = {
    ...req.body,
    received_at: new Date().toISOString()
  };

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
// ======================================

app.get("/api/alerts", (req, res) => {
  res.json({
    status: "success",
    data: alerts
  });
});

// ======================================
// CAMERA FRAME HELPER
// ======================================

function getFrame(deviceId) {
  const item = cameraFrames.get(deviceId);

  if (!item) {
    return null;
  }

  if (Date.now() - item.updatedAt > MAX_FRAME_AGE_MS) {
    return null;
  }

  return item;
}

// ======================================
// SNAPSHOT METADATA
// ======================================

function snapshotMeta(snapshot) {
  return {
    id: snapshot.id,
    device_id: snapshot.device_id,
    device_name: snapshot.device_name,
    filename: snapshot.filename,
    captured_at: snapshot.captured_at,
    url: `/api/snapshots/${snapshot.id}`
  };
}

// ======================================
// CAMERA STATUS
// ======================================

app.get("/api/camera/status", (req, res) => {
  const result = {};

  for (const [deviceId, item] of cameraFrames.entries()) {
    result[deviceId] = {
      online:
        Date.now() - item.updatedAt <= MAX_FRAME_AGE_MS,
      device_id: deviceId,
      device_name: item.device_name,
      last_frame_at:
        new Date(item.updatedAt).toISOString()
    };
  }

  res.json({
    status: "success",
    data: result
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
    data: list.map(snapshotMeta)
  });
});

// ======================================
// GET ONE SNAPSHOT
// ======================================

app.get("/api/snapshots/:id", (req, res) => {
  const id = Number(req.params.id);

  const snapshot = cameraSnapshots.get(id);

  if (!snapshot) {
    return res.status(404).json({
      status: "error",
      message: "Snapshot not found"
    });
  }

  res.setHeader(
    "Content-Type",
    snapshot.contentType || "image/jpeg"
  );

  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, max-age=0"
  );

  return res.send(snapshot.buffer);
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
        message:
          "device_id and image_base64 are required"
      });
    }

    const cleanBase64 =
      String(image_base64).replace(
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

    const safeFilename =
      filename || `snapshot_${id}.jpg`;

    const snapshot = {
      id,
      device_id: String(device_id),
      device_name: String(
        device_name || device_id
      ),
      filename: safeFilename,
      captured_at:
        captured_at ||
        new Date().toISOString(),
      contentType:
        content_type || "image/jpeg",
      buffer
    };

    cameraSnapshots.set(id, snapshot);

    while (
      cameraSnapshots.size > MAX_SNAPSHOTS
    ) {
      const oldestId =
        cameraSnapshots.keys().next().value;

      cameraSnapshots.delete(oldestId);
    }

    console.log(
      `Camera snapshot received: ${snapshot.device_id} #${snapshot.id}`
    );

    return res.json({
      status: "success",
      message:
        "Snapshot uploaded successfully",
      data: snapshotMeta(snapshot)
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

const cameraWss =
  new WebSocketServer({
    server,
    path: "/ws/camera"
  });

cameraWss.on(
  "connection",
  (ws, req) => {

    let deviceId = null;
    let deviceName = null;
    let role = "unknown";

    console.log(
      "Camera WebSocket connected:",
      req.socket.remoteAddress
    );

    ws.on(
      "message",
      (message, isBinary) => {

        try {

          // ====================================
          // TEXT MESSAGE
          // ====================================

          if (!isBinary) {

            const text =
              message.toString();

            const data =
              JSON.parse(text);

            // ------------------------------
            // PI REGISTRATION
            // ------------------------------

            if (data.type === "register") {

              deviceId =
                String(
                  data.device_id || ""
                );

              deviceName =
                String(
                  data.device_name ||
                  deviceId
                );

              role = "pi";

              if (!deviceId) {

                ws.close(
                  1008,
                  "device_id is required"
                );

                return;
              }

              ws.deviceId = deviceId;
              ws.deviceName = deviceName;
              ws.role = "pi";

              if (cameraFrames.has(deviceId)) {

                cameraFrames.get(
                  deviceId
                ).producer = ws;

              }

              ws.send(
                JSON.stringify({
                  type: "registered",
                  device_id: deviceId,
                  device_name: deviceName
                })
              );

              console.log(
                `Camera producer registered: ${deviceId}`
              );

              return;
            }

            // ------------------------------
            // BROWSER VIEWER
            // ------------------------------

            if (data.type === "viewer") {

              ws.role = "viewer";

              ws.deviceId =
                String(
                  data.device_id || ""
                );

              if (!ws.deviceId) {

                ws.close(
                  1008,
                  "device_id is required"
                );

                return;
              }

              ws.send(
                JSON.stringify({
                  type:
                    "viewer_registered",
                  device_id:
                    ws.deviceId
                })
              );

              const frame =
                getFrame(
                  ws.deviceId
                );

              if (
                frame &&
                ws.readyState ===
                  WebSocket.OPEN
              ) {

                ws.send(
                  frame.buffer,
                  { binary: true }
                );

              }

              console.log(
                `Camera viewer registered: ${ws.deviceId}`
              );

              return;
            }

            return;
          }

          // ====================================
          // BINARY MESSAGE = CAMERA FRAME
          // ====================================

          if (
            !deviceId ||
            role !== "pi"
          ) {
            return;
          }

          const buffer =
            Buffer.from(message);

          if (!buffer.length) {
            return;
          }

          cameraFrames.set(
            deviceId,
            {
              device_id:
                deviceId,

              device_name:
                deviceName ||
                deviceId,

              buffer:
                buffer,

              updatedAt:
                Date.now(),

              producer:
                ws
            }
          );

          // Send frame to viewers
          for (
            const client
            of cameraWss.clients
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
              client.role ===
                "viewer" &&
              client.deviceId ===
                deviceId
            ) {

              try {

                client.send(
                  buffer,
                  {
                    binary: true
                  }
                );

              } catch (
                error
              ) {

                console.error(
                  "Camera viewer send error:",
                  error.message
                );

              }

            }

          }

        } catch (error) {

          console.error(
            "Camera WebSocket message error:",
            error
          );

        }

      }
    );

    ws.on(
      "close",
      () => {

        console.log(
          `Camera WebSocket closed: ${
            deviceId || "unknown"
          } (${role})`
        );

        if (
          role === "pi" &&
          deviceId
        ) {

          const stored =
            cameraFrames.get(
              deviceId
            );

          if (
            stored &&
            stored.producer === ws
          ) {

            cameraFrames.delete(
              deviceId
            );

          }

        }

      }
    );

    ws.on(
      "error",
      (error) => {

        console.error(
          "Camera WebSocket error:",
          error.message
        );

      }
    );

  }
);

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
