#!/usr/bin/env python3
DRAIN_MODEL = "/home/pi/yolo/drain_best.pt"
TRASH_MODEL = "/home/pi/yolo/trash_best.pt"
# ============================================================
# SMART DRAIN MONITORING SYSTEM
# Raspberry Pi + ESP8266 + A7670C GSM + PiCamera2 + YOLO
#
# MAIN PROJECT ALERTS
# 1. HEAVY WATER FLOW ALERT
# 2. MUD BLOCKAGE ALERT
#
# IMPORTANT:
# The A7670C only sends the SMS.
# The Raspberry Pi decides which alert is required.
# ============================================================

from picamera2 import Picamera2
from ultralytics import YOLO
import cv2
import time
import serial
import serial.tools.list_ports
import threading
import re
import requests
import os
from datetime import datetime, timezone


# ============================================================
# CONFIGURATION
# ============================================================

DATA_API = "http://10.45.119.45:8000/api/data"
ALERT_API = "http://10.45.119.45:8000/api/alerts"

# ESP8266 UART/USB serial
ESP_BAUD = 115200

# A7670C
# You previously confirmed your A7670C setup is working at 115200.
GSM_BAUD = 115200

# Add all mobile numbers that should receive alerts.
PHONE_NUMBERS = [
    "+919390547987",
    "+919177364716",
    "+919505651480"
]

# ============================================================
# TELEGRAM ALERT CONFIGURATION
# ============================================================
TELEGRAM_BOT_TOKEN = "8692003378:AAGNBmJSotjt9MCPhRaAYC6YqrXcr4UDL0A"
TELEGRAM_CHAT_ID = "-1004339935265"
TELEGRAM_API = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}"

SNAPSHOT_FOLDER = "incident_snapshots"
os.makedirs(SNAPSHOT_FOLDER, exist_ok=True)

# Set a fixed GSM port here if you know it.
# Examples:
#   "/dev/serial0"
#   "/dev/ttyUSB0"
#   "/dev/ttyUSB1"
#
# None = automatically try common ports.
GSM_PORT = "/dev/ttyAMA0"

# None = automatically find ESP8266 USB serial.
ESP_PORT = None

# Actual internal drain depth
DRAIN_HEIGHT_CM = 200.0

# High-water threshold
WATER_LEVEL_HIGH_CM = 20.0

# ------------------------------------------------------------
# HEAVY FLOW SETTING
# ------------------------------------------------------------
# YF-S201 flow value is expected from the ESP8266 as L/min.
#
# If water level is high AND flow >= this value AND there is
# no confirmed blockage -> HEAVY WATER FLOW ALERT.
#
# CALIBRATE THIS VALUE for your prototype.
HEAVY_FLOW_LPM = 10.0

# ------------------------------------------------------------
# VISUAL BLOCKAGE DETECTION
# ------------------------------------------------------------
YOLO_CONFIDENCE = 0.30

MUD_CLASS = "mud_buildup"

PLASTIC_CLASSES = {
    "plastic-bag",
    "plastic-garbage"
}

SAND_CLASSES = {
    "sand",
    "sand-buildup",
    "sand_buildup",
    "sand buildup"
}

# Number of consecutive camera frames required before
# treating mud/plastic as a confirmed blockage condition.
BLOCKAGE_CONFIRM_FRAMES = 5

# Number of consecutive readings required before treating
# the water level as a confirmed high-water event.
HIGH_WATER_CONFIRM_READINGS = 3

# Minimum time between SMS messages.
SMS_COOLDOWN = 60

# ============================================================
# RENDER DASHBOARD API
# ============================================================

DATA_API = "http://10.45.119.45:8000/api/data"
ALERT_API = "http://10.45.119.45:8000/api/alerts"

DEVICE_ID = "ESP8266-DRAIN-001"
DEVICE_NAME = "Drain 1"

DEVICE_LATITUDE = 17.44716
DEVICE_LONGITUDE = 78.4786

# Send live sensor data to dashboard every 5 seconds.
DATA_API_INTERVAL = 5
API_TIMEOUT = 8

last_data_api_time = 0


# ============================================================
# SHARED SENSOR DATA
# ============================================================

sensor_data = {
    "temperature": None,
    "mq135": None,
    "distance": None,
    "level": None,
    "flow": None
}

data_lock = threading.Lock()

esp_serial = None
gsm_serial = None


# ============================================================
# HELPER
# ============================================================

def extract_number(text):
    """
    Extract the first signed integer/decimal number from text.
    """
    match = re.search(r"-?\d+(?:\.\d+)?", text)

    if match:
        return float(match.group())

    return None



# ============================================================
# RENDER API FUNCTIONS
# ============================================================

def post_json_api(url, payload):
    """POST JSON to the Render dashboard API."""

    try:
        response = requests.post(
            url,
            json=payload,
            headers={"Content-Type": "application/json"},
            timeout=API_TIMEOUT
        )

        print(
            f"\nAPI POST: {url}"
        )
        print(
            f"API STATUS: {response.status_code}"
        )

        if response.text.strip():
            print(
                f"API RESPONSE: {response.text[:300]}"
            )

        return 200 <= response.status_code < 300

    except requests.exceptions.RequestException as e:
        print(
            f"\nAPI CONNECTION ERROR: {e}"
        )
        return False

    except Exception as e:
        print(
            f"\nAPI ERROR: {e}"
        )
        return False


def send_dashboard_data(
    level,
    flow,
    temperature,
    mq135,
    system_status
):
    """
    Send dashboard sensor JSON.

    velocity_mps is null until the velocity sensor is connected.
    humidity_pct is null because no humidity sensor is currently
    present in this code.
    gas_ppm is null because MQ-135 currently provides ADC,
    not calibrated PPM.
    """

    if level is not None:
        water_level_pct = (
            level / DRAIN_HEIGHT_CM
        ) * 100.0

        water_level_pct = max(
            0.0,
            min(100.0, water_level_pct)
        )
    else:
        water_level_pct = None

    payload = {
        "device_id": DEVICE_ID,
        "device_name": DEVICE_NAME,
        "latitude": DEVICE_LATITUDE,
        "longitude": DEVICE_LONGITUDE,
        "status": "online",
        "water_level_pct": (
            round(water_level_pct, 1)
            if water_level_pct is not None
            else None
        ),
        "velocity_mps": None,
        "temperature_c": (
            round(temperature, 1)
            if temperature is not None
            else None
        ),
        "humidity_pct": None,
        "gas_ppm": None,
        "timestamp": datetime.now(
            timezone.utc
        ).replace(
            microsecond=0
        ).isoformat()
    }

    return post_json_api(
        DATA_API,
        payload
    )


def send_dashboard_alert(
    alert_type,
    level,
    flow,
    mud_confidence,
    plastic_confidence
):
    """Send a detected alert event to the dashboard."""

    if alert_type == "HEAVY_FLOW":
        alert_name = "HEAVY WATER FLOW ALERT"

    elif alert_type == "MUD_BLOCKAGE":
        alert_name = "MUD BLOCKAGE ALERT"

    else:
        alert_name = str(alert_type)

    payload = {
        "device_id": DEVICE_ID,
        "device_name": DEVICE_NAME,
        "alert_type": alert_type,
        "alert": alert_name,
        "status": "alert",
        "water_level_cm": (
            round(level, 1)
            if level is not None
            else None
        ),
        "velocity_mps": None,
        "flow_lpm": (
            round(flow, 2)
            if flow is not None
            else None
        ),
        "mud_confidence": (
            round(mud_confidence, 3)
            if mud_confidence is not None
            else None
        ),
        "plastic_confidence": (
            round(plastic_confidence, 3)
            if plastic_confidence is not None
            else None
        ),
        "timestamp": datetime.now(
            timezone.utc
        ).replace(
            microsecond=0
        ).isoformat()
    }

    return post_json_api(
        ALERT_API,
        payload
    )


# ============================================================
# ESP8266 PORT DETECTION
# ============================================================

def find_esp_port():
    """
    Automatically find a likely ESP8266 USB serial port.

    If ESP_PORT is manually configured, that port is used instead.
    """

    if ESP_PORT:
        return ESP_PORT

    ports = list(serial.tools.list_ports.comports())

    if not ports:
        return None

    print()
    print("Available serial devices:")

    for port in ports:
        print(
            f"  {port.device} - "
            f"{port.description or 'No description'}"
        )

    preferred = []

    for port in ports:

        # Do not select the GSM port if it is already open.
        if (
            gsm_serial is not None
            and port.device == gsm_serial.port
        ):
            continue

        device = port.device.lower()

        description = (
            port.description or ""
        ).lower()

        manufacturer = (
            port.manufacturer or ""
        ).lower()

        text = (
            description
            + " "
            + manufacturer
        )

        if (
            "usb" in device
            or
            "cp210" in text
            or
            "ch340" in text
            or
            "ch341" in text
            or
            "silicon labs" in text
            or
            "esp" in text
        ):
            preferred.append(port.device)

    if preferred:
        return preferred[0]

    # Return the first non-GSM device.
    for port in ports:
        if (
            gsm_serial is None
            or port.device != gsm_serial.port
        ):
            return port.device

    return None


# ============================================================
# GSM PORT LIST
# ============================================================

def get_gsm_ports():

    if GSM_PORT:
        return [GSM_PORT]

    return [
        "/dev/ttyUSB0",
        "/dev/ttyUSB1",
        "/dev/ttyUSB2",
        "/dev/serial0",
        "/dev/ttyAMA0",
        "/dev/ttyAMA1"
    ]


# ============================================================
# CONNECT GSM / A7670C
# ============================================================

def gsm_command(command, wait=1.0):
    """
    Send an AT command and return the modem response.
    """

    global gsm_serial

    if gsm_serial is None:
        return ""

    try:
        gsm_serial.reset_input_buffer()
        gsm_serial.write((command + "\r").encode())
        gsm_serial.flush()

        time.sleep(wait)

        response = (
            gsm_serial.read_all()
            .decode(
                "utf-8",
                errors="ignore"
            )
        )

        print(
            f"\nGSM AT: {command}"
        )
        print(
            f"GSM RX: {response.strip()}"
        )

        return response

    except Exception as e:

        print(
            f"GSM command error ({command}): {e}"
        )

        return ""


def connect_gsm():

    global gsm_serial

    print()
    print("==============================================")
    print("             CONNECTING A7670C")
    print("==============================================")

    for port in get_gsm_ports():

        try:

            print(
                f"Trying GSM port: {port}"
            )

            candidate = serial.Serial(
                port=port,
                baudrate=GSM_BAUD,
                timeout=1,
                write_timeout=2
            )

            gsm_serial = candidate

            time.sleep(1)

            # Basic modem test
            response = gsm_command(
                "AT",
                wait=1
            )

            if "OK" not in response.upper():

                print(
                    f"A7670C did not answer on {port}"
                )

                candidate.close()
                gsm_serial = None
                continue

            # Disable command echo
            gsm_command(
                "ATE0",
                wait=0.5
            )

            # SMS text mode
            response = gsm_command(
                "AT+CMGF=1",
                wait=0.5
            )

            if "OK" not in response.upper():

                print(
                    "Warning: SMS text mode was not accepted."
                )

            # Check SIM
            gsm_command(
                "AT+CPIN?",
                wait=0.8
            )

            # Signal strength
            gsm_command(
                "AT+CSQ",
                wait=0.8
            )

            # LTE registration
            gsm_command(
                "AT+CEREG?",
                wait=0.8
            )

            # Operator information
            gsm_command(
                "AT+COPS?",
                wait=0.8
            )

            print()
            print(
                f"A7670C GSM: READY on {port}"
            )
            print(
                f"A7670C baud: {GSM_BAUD}"
            )

            return True

        except Exception as e:

            print(
                f"GSM port {port} failed: {e}"
            )

            gsm_serial = None

    print()
    print(
        "A7670C GSM: NOT CONNECTED"
    )

    print(
        "Check power, UART/USB connection, SIM and baud rate."
    )

    return False


# ============================================================
# SEND SMS
# ============================================================

def send_sms(message):
    """Send the same SMS alert to every number in PHONE_NUMBERS."""
    global gsm_serial

    if gsm_serial is None:
        print("\nGSM unavailable - SMS not sent.")
        return False

    overall_success = True

    for phone_number in PHONE_NUMBERS:
        phone_number = phone_number.strip()
        if not phone_number:
            continue

        try:
            print()
            print("==============================================")
            print("             SENDING SMS ALERT")
            print("==============================================")
            print(f"SMS number: {phone_number}")

            response = gsm_command("AT+CMGF=1", wait=0.5)

            if "OK" not in response.upper():
                print("SMS text mode failed.")
                overall_success = False
                continue

            gsm_serial.reset_input_buffer()
            gsm_serial.write(
                ('AT+CMGS="' + phone_number + '"\r').encode()
            )
            gsm_serial.flush()

            prompt = ""
            start_time = time.time()

            while time.time() - start_time < 8:
                if gsm_serial.in_waiting:
                    chunk = gsm_serial.read(
                        gsm_serial.in_waiting
                    ).decode("utf-8", errors="ignore")
                    prompt += chunk
                    print(f"GSM > {chunk}", end="")

                    if ">" in prompt:
                        break
                    if "ERROR" in prompt.upper():
                        break
                time.sleep(0.1)

            if ">" not in prompt:
                print("\nSMS prompt '>' not received.")
                overall_success = False
                continue

            gsm_serial.write(
                message.encode("utf-8", errors="ignore")
            )
            gsm_serial.write(bytes([26]))
            gsm_serial.flush()

            print()
            print("SMS message submitted. Waiting for modem...")

            response = ""
            start_time = time.time()

            while time.time() - start_time < 30:
                if gsm_serial.in_waiting:
                    chunk = gsm_serial.read(
                        gsm_serial.in_waiting
                    ).decode("utf-8", errors="ignore")
                    response += chunk
                    print(chunk, end="")

                    if (
                        "OK" in response.upper()
                        or "ERROR" in response.upper()
                    ):
                        break
                time.sleep(0.2)

            print()

            if "OK" in response.upper():
                print(
                    f"SMS SENT SUCCESSFULLY to {phone_number}"
                )
            else:
                print(
                    f"SMS sending failed to {phone_number}."
                )
                overall_success = False

        except Exception as e:
            print(
                f"\nSMS error for {phone_number}: {e}"
            )
            overall_success = False

        time.sleep(2)

    return overall_success


# ============================================================
# TELEGRAM ALERT FUNCTIONS
# ============================================================

def telegram_configured():
    return (
        TELEGRAM_BOT_TOKEN
        and TELEGRAM_BOT_TOKEN != "PASTE_YOUR_BOT_TOKEN_HERE"
        and TELEGRAM_CHAT_ID
        and TELEGRAM_CHAT_ID != "PASTE_YOUR_GROUP_CHAT_ID_HERE"
    )


def send_telegram_message(message):
    try:
        if not telegram_configured():
            print("\nTelegram is not configured yet.")
            return False

        response = requests.post(
            f"{TELEGRAM_API}/sendMessage",
            data={"chat_id": TELEGRAM_CHAT_ID, "text": message},
            timeout=20
        )

        print(f"\nTELEGRAM MESSAGE STATUS: {response.status_code}")
        print(f"TELEGRAM RESPONSE: {response.text[:500]}")

        if response.ok:
            print("Telegram alert sent successfully.")
            return True

        print("Telegram alert failed.")
        return False

    except Exception as e:
        print(f"\nTelegram message error: {e}")
        return False


def send_telegram_snapshot(snapshot_path, caption):
    try:
        if not telegram_configured():
            print("\nTelegram is not configured yet.")
            return False

        if not snapshot_path or not os.path.exists(snapshot_path):
            print(f"Telegram snapshot file not found: {snapshot_path}")
            return False

        with open(snapshot_path, "rb") as photo:
            response = requests.post(
                f"{TELEGRAM_API}/sendPhoto",
                data={"chat_id": TELEGRAM_CHAT_ID, "caption": caption},
                files={"photo": photo},
                timeout=30
            )

        print(f"\nTELEGRAM SNAPSHOT STATUS: {response.status_code}")
        print(f"TELEGRAM SNAPSHOT RESPONSE: {response.text[:500]}")

        if response.ok:
            print("Telegram snapshot sent successfully.")
            return True

        print("Telegram snapshot failed.")
        return False

    except Exception as e:
        print(f"\nTelegram snapshot error: {e}")
        return False


# ============================================================
# CONNECT ESP8266
# ============================================================

def connect_esp():

    global esp_serial

    print()
    print("==============================================")
    print("              CONNECTING ESP8266")
    print("==============================================")

    port = find_esp_port()

    if port is None:

        print(
            "ESP8266: NO SERIAL DEVICE FOUND"
        )

        return False

    try:

        esp_serial = serial.Serial(
            port=port,
            baudrate=ESP_BAUD,
            timeout=0.2,
            write_timeout=2
        )

        time.sleep(1)

        print(
            f"ESP8266: CONNECTED on {port}"
        )

        print(
            f"ESP8266 baud: {ESP_BAUD}"
        )

        return True

    except Exception as e:

        print(
            "ESP8266 connection failed:"
        )

        print(e)

        esp_serial = None

        return False


# ============================================================
# ESP8266 SENSOR READER
# ============================================================

def read_esp8266():

    print()
    print(
        "ESP8266 reader started."
    )

    while True:

        if esp_serial is None:

            time.sleep(1)
            continue

        try:

            line = (
                esp_serial
                .readline()
                .decode(
                    "utf-8",
                    errors="ignore"
                )
                .strip()
            )

            if not line:
                continue

            print(
                f"\nESP > {line}"
            )

            # ------------------------------------------------
            # TEMPERATURE
            # ------------------------------------------------

            if line.lower().startswith(
                "temperature"
            ):

                value = extract_number(line)

                if value is not None:

                    with data_lock:

                        sensor_data[
                            "temperature"
                        ] = value

            # ------------------------------------------------
            # MQ-135
            # ------------------------------------------------

            elif (
                "mq-135" in line.lower()
                or
                "mq135" in line.lower()
            ):

                value = extract_number(line)

                if value is not None:

                    with data_lock:

                        sensor_data[
                            "mq135"
                        ] = int(value)

            # ------------------------------------------------
            # A02YYUW WATER DISTANCE
            # ------------------------------------------------

            elif (
                "water distance"
                in line.lower()
                or
                "distance"
                in line.lower()
            ):

                value = extract_number(line)

                if value is not None:

                    level = (
                        DRAIN_HEIGHT_CM
                        -
                        value
                    )

                    level = max(
                        0,
                        min(
                            DRAIN_HEIGHT_CM,
                            level
                        )
                    )

                    with data_lock:

                        sensor_data[
                            "distance"
                        ] = value

                        sensor_data[
                            "level"
                        ] = level

            # ------------------------------------------------
            # YF-S201 WATER FLOW
            # ------------------------------------------------

            elif (
                "water flow"
                in line.lower()
                or
                "flow"
                in line.lower()
                or
                "l/min"
                in line.lower()
                or
                "lpm"
                in line.lower()
            ):

                value = extract_number(line)

                if value is not None:

                    with data_lock:

                        sensor_data[
                            "flow"
                        ] = value

        except Exception as e:

            print(
                "\nESP serial error:",
                e
            )

            time.sleep(1)


# ============================================================
# LOAD YOLO MODELS
# ============================================================

print()
print("==============================================")
print("       SMART DRAIN MONITORING SYSTEM")
print("==============================================")

print()
print(
    "Loading DRAIN YOLO..."
)

drain_model = YOLO(
    DRAIN_MODEL
)

print(
    "DRAIN:",
    drain_model.names
)

print()
print(
    "Loading TRASH YOLO..."
)

trash_model = YOLO(
    TRASH_MODEL
)

print(
    "TRASH:",
    trash_model.names
)


# ============================================================
# START CAMERA
# ============================================================

print()
print(
    "Starting camera..."
)

picam2 = Picamera2()

camera_config = (
    picam2.create_preview_configuration(
        main={
            "size": (640, 480),
            "format": "RGB888"
        }
    )
)

picam2.configure(
    camera_config
)

picam2.start()

time.sleep(2)

print(
    "CAMERA: READY"
)


# ============================================================
# START GSM FIRST
# This prevents ESP auto-detection from taking the GSM port.
# ============================================================

gsm_ready = connect_gsm()


# ============================================================
# START ESP8266
# ============================================================

esp_ready = connect_esp()

if esp_ready:

    esp_thread = threading.Thread(
        target=read_esp8266,
        daemon=True
    )

    esp_thread.start()


# ============================================================
# SYSTEM STATUS
# ============================================================

print()
print("==============================================")
print("              SYSTEM READY")
print("==============================================")

print(
    "DRAIN YOLO : READY"
)

print(
    "TRASH YOLO : READY"
)

print(
    "CAMERA     : READY"
)

print(
    "ESP8266    :",
    "READY" if esp_ready else "NOT CONNECTED"
)

print(
    "A7670C GSM :",
    "READY" if gsm_ready else "NOT CONNECTED"
)

print()
print("MAIN ALERTS:")
print("  1. HEAVY WATER FLOW ALERT")
print("  2. MUD BLOCKAGE ALERT")
print("  3. MUD / SAND / PLASTIC DETECTION ALERTS")
print("  4. TELEGRAM SNAPSHOT ALERT")

print()
print("SENSORS:")
print("  A02YYUW  -> Water level")
print("  DS18B20  -> Temperature")
print("  MQ-135   -> Gas")
print("  YF-S201  -> Water flow")
print("  PiCamera -> Mud / sand / plastic / blockage")

print()
print(
    f"High water threshold : {WATER_LEVEL_HIGH_CM:.1f} cm"
)

print(
    f"Heavy flow threshold : {HEAVY_FLOW_LPM:.1f} L/min"
)

print()
print(
    "Press Q to quit."
)

print(
    "=============================================="
)
print()


# ============================================================
# ALERT STATE
# ============================================================

high_water_count = 0
blockage_count = 0

last_alert_type = None
last_alert_time = 0

# True after the water returns below the high-water threshold.
# This allows a new event to generate a fresh SMS.
event_reset = True


# ============================================================
# ALERT DECISION FUNCTION
# ============================================================
def determine_alert(
    water_high,
    flow,
    mud_found,
    sand_found,
    plastic_found,
    confirmed_blockage
):
    if water_high and confirmed_blockage:
        return "MUD_BLOCKAGE"

    if water_high:
        return "HEAVY_FLOW"

    if confirmed_blockage:
        if mud_found and sand_found and plastic_found:
            return "MUD_SAND_PLASTIC"
        if mud_found and sand_found:
            return "MUD_SAND"
        if mud_found and plastic_found:
            return "MUD_PLASTIC"
        if sand_found and plastic_found:
            return "SAND_PLASTIC"
        if mud_found:
            return "MUD_DETECTED"
        if sand_found:
            return "SAND_DETECTED"
        if plastic_found:
            return "PLASTIC_DETECTED"

    return None


# ============================================================
# SMS MESSAGE CREATION
# ============================================================

def build_alert_message(
    alert_type,
    level,
    flow,
    mud_confidence,
    sand_confidence,
    plastic_confidence
):
    level_text = f"{level:.1f} cm" if level is not None else "N/A"
    flow_text = f"{flow:.2f} L/min" if flow is not None else "N/A"

    titles = {
        "HEAVY_FLOW": "HEAVY WATER FLOW",
        "MUD_BLOCKAGE": "MUD/BLOCKAGE",
        "MUD_DETECTED": "MUD DETECTED",
        "SAND_DETECTED": "SAND DETECTED",
        "PLASTIC_DETECTED": "PLASTIC DETECTED",
        "MUD_SAND": "MUD + SAND DETECTED",
        "MUD_PLASTIC": "MUD + PLASTIC DETECTED",
        "SAND_PLASTIC": "SAND + PLASTIC DETECTED",
        "MUD_SAND_PLASTIC": "MUD + SAND + PLASTIC DETECTED"
    }

    return (
        "DRAIN ALERT\n"
        f"{titles.get(alert_type, alert_type)}\n"
        f"Water Level: {level_text}\n"
        f"Water Flow: {flow_text}\n"
        f"Mud: {mud_confidence:.0%}\n"
        f"Sand: {sand_confidence:.0%}\n"
        f"Plastic: {plastic_confidence:.0%}\n"
        "Check/inspect drain."
    )


def build_telegram_alert_message(
    alert_type,
    level,
    flow,
    mud_confidence,
    sand_confidence,
    plastic_confidence
):
    level_text = f"{level:.1f} cm" if level is not None else "N/A"
    flow_text = f"{flow:.2f} L/min" if flow is not None else "N/A"

    titles = {
        "HEAVY_FLOW": "🚨 HEAVY WATER FLOW ALERT",
        "MUD_BLOCKAGE": "🚨 MUD BLOCKAGE ALERT",
        "MUD_DETECTED": "⚠️ MUD DETECTED",
        "SAND_DETECTED": "⚠️ SAND DETECTED",
        "PLASTIC_DETECTED": "⚠️ PLASTIC DETECTED",
        "MUD_SAND": "⚠️ MUD + SAND DETECTED",
        "MUD_PLASTIC": "⚠️ MUD + PLASTIC DETECTED",
        "SAND_PLASTIC": "⚠️ SAND + PLASTIC DETECTED",
        "MUD_SAND_PLASTIC": "🚨 MUD + SAND + PLASTIC ALERT"
    }

    return (
        f"{titles.get(alert_type, '🚨 ' + str(alert_type))}\n\n"
        f"Device: {DEVICE_NAME}\n"
        f"Device ID: {DEVICE_ID}\n\n"
        f"Water Level: {level_text}\n"
        f"Water Flow: {flow_text}\n\n"
        f"Mud Confidence: {mud_confidence:.1%}\n"
        f"Sand Confidence: {sand_confidence:.1%}\n"
        f"Plastic Confidence: {plastic_confidence:.1%}\n\n"
        f"Time: {datetime.now().strftime('%d-%m-%Y %H:%M:%S')}\n\n"
        "📸 Incident snapshot is attached."
    )


# ============================================================
# MAIN LOOP
# ============================================================

try:

    while True:

        # Current time is needed by the dashboard API timer
        # and the SMS alert timer.
        current_time = time.time()

        # ====================================================
        # CAMERA FRAME
        # ====================================================

        frame = picam2.capture_array()

        output = frame.copy()


        # ====================================================
        # SENSOR DATA
        # ====================================================

        with data_lock:

            temperature = (
                sensor_data[
                    "temperature"
                ]
            )

            mq135 = (
                sensor_data[
                    "mq135"
                ]
            )

            distance = (
                sensor_data[
                    "distance"
                ]
            )

            level = (
                sensor_data[
                    "level"
                ]
            )

            flow = (
                sensor_data[
                    "flow"
                ]
            )


        # ====================================================
        # HIGH WATER CONFIRMATION
        # ====================================================

        water_high_now = (
            level is not None
            and
            level >= WATER_LEVEL_HIGH_CM
        )

        if water_high_now:

            high_water_count += 1

        else:

            high_water_count = 0

            # Reset the event after water returns to normal.
            if event_reset is False:

                event_reset = True
                last_alert_type = None

                print()
                print(
                    "Water returned to normal."
                )
                print(
                    "Alert event RESET."
                )


        confirmed_high_water = (
            high_water_count
            >=
            HIGH_WATER_CONFIRM_READINGS
        )


        # ====================================================
        # DRAIN YOLO
        # ====================================================

        drain_result = drain_model.predict(
            source=frame,
            imgsz=416,
            conf=YOLO_CONFIDENCE,
            verbose=False
        )[0]


        # ====================================================
        # TRASH YOLO
        # ====================================================

        trash_result = trash_model.predict(
            source=frame,
            imgsz=416,
            conf=YOLO_CONFIDENCE,
            verbose=False
        )[0]


        # ====================================================
        # MUD DETECTION
        # ====================================================

        mud_found = False
        mud_confidence = 0.0

        for box in drain_result.boxes:

            cls = int(
                box.cls[0]
            )

            conf = float(
                box.conf[0]
            )

            name = str(
                drain_model.names[cls]
            )

            if (
                name.lower()
                !=
                MUD_CLASS.lower()
            ):
                continue

            mud_found = True

            mud_confidence = max(
                mud_confidence,
                conf
            )

            x1, y1, x2, y2 = map(
                int,
                box.xyxy[0]
            )

            cv2.rectangle(
                output,
                (x1, y1),
                (x2, y2),
                (255, 255, 255),
                2
            )

            cv2.putText(
                output,
                f"MUD BUILDUP {conf:.0%}",
                (
                    x1,
                    max(
                        y1 - 10,
                        20
                    )
                ),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.60,
                (255, 255, 255),
                2
            )


        # ====================================================
        # SAND DETECTION
        # ====================================================

        sand_found = False
        sand_confidence = 0.0

        accepted_sand_classes = {
            x.lower()
            for x in SAND_CLASSES
        }

        for box in drain_result.boxes:

            cls = int(box.cls[0])
            conf = float(box.conf[0])
            name = str(drain_model.names[cls])

            if name.lower() not in accepted_sand_classes:
                continue

            sand_found = True
            sand_confidence = max(sand_confidence, conf)

            x1, y1, x2, y2 = map(int, box.xyxy[0])

            cv2.rectangle(
                output,
                (x1, y1),
                (x2, y2),
                (255, 255, 255),
                2
            )

            cv2.putText(
                output,
                f"SAND {conf:.0%}",
                (x1, max(y1 - 10, 20)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.60,
                (255, 255, 255),
                2
            )


        # ====================================================
        # PLASTIC TRASH DETECTION
        # ====================================================

        plastic_found = False
        plastic_confidence = 0.0

        accepted_plastic_classes = {
            x.lower()
            for x in PLASTIC_CLASSES
        }

        for box in trash_result.boxes:

            cls = int(
                box.cls[0]
            )

            conf = float(
                box.conf[0]
            )

            name = str(
                trash_model.names[cls]
            )

            if (
                name.lower()
                not in
                accepted_plastic_classes
            ):
                continue

            plastic_found = True

            plastic_confidence = max(
                plastic_confidence,
                conf
            )

            x1, y1, x2, y2 = map(
                int,
                box.xyxy[0]
            )

            cv2.rectangle(
                output,
                (x1, y1),
                (x2, y2),
                (255, 255, 255),
                2
            )

            cv2.putText(
                output,
                f"PLASTIC TRASH {conf:.0%}",
                (
                    x1,
                    min(
                        y2 + 20,
                        470
                    )
                ),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.60,
                (255, 255, 255),
                2
            )


        # ====================================================
        # BLOCKAGE CONFIRMATION
        # ====================================================
        #
        # A single camera detection is not immediately treated
        # as a blockage alert. It must be present over several
        # consecutive frames.
        #
        # Mud is the primary blockage indication.
        # Plastic trash is also treated as physical obstruction
        # when water is high.
        # ====================================================

        visual_blockage_now = (
            mud_found
            or
            sand_found
            or
            plastic_found
        )

        if visual_blockage_now:

            blockage_count += 1

        else:

            blockage_count = 0

        confirmed_blockage = (
            blockage_count
            >=
            BLOCKAGE_CONFIRM_FRAMES
        )


        # ====================================================
        # DETECTION STATUS
        # ====================================================

        detected_items = []

        if mud_found:
            detected_items.append("MUD")

        if sand_found:
            detected_items.append("SAND")

        if plastic_found:
            detected_items.append("PLASTIC")

        if detected_items:
            detection_status = " + ".join(detected_items) + " DETECTED"
        else:
            detection_status = "NO TARGET DETECTED"


        # ====================================================
        # PROJECT ALERT DECISION
        # ====================================================

        alert_type = determine_alert(
            confirmed_high_water,
            flow,
            mud_found,
            sand_found,
            plastic_found,
            confirmed_blockage
        )


        # ====================================================
        # HUMAN-READABLE SYSTEM STATUS
        # ====================================================

        if not confirmed_high_water:

            system_status = (
                "NORMAL / MONITORING"
            )

        elif confirmed_blockage:

            system_status = (
                "MUD / BLOCKAGE CONDITION"
            )

        elif (
            flow is not None
            and
            flow >= HEAVY_FLOW_LPM
        ):

            system_status = (
                "HEAVY WATER FLOW"
            )

        else:

            system_status = (
                "HIGH WATER - CAUSE UNCERTAIN"
            )


        # ====================================================
        # DISPLAY TEXT
        # ====================================================

        level_text = (
            f"{level:.1f} cm"
            if level is not None
            else
            "NO DATA"
        )

        temp_text = (
            f"{temperature:.1f} C"
            if temperature is not None
            else
            "NO DATA"
        )

        mq_text = (
            str(mq135)
            if mq135 is not None
            else
            "NO DATA"
        )

        flow_text = (
            f"{flow:.2f} L/min"
            if flow is not None
            else
            "NO DATA"
        )


        # ====================================================
        # CAMERA OVERLAY
        # ====================================================

        cv2.putText(
            output,
            f"STATUS: {system_status}",
            (10, 40),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.60,
            (255, 255, 255),
            2
        )


        # ====================================================
        # TERMINAL STATUS
        # ====================================================

        mud_text = (
            f"MUD {mud_confidence:.0%}"
            if mud_found
            else
            "MUD None"
        )

        sand_text = (
            f"SAND {sand_confidence:.0%}"
            if sand_found
            else
            "SAND None"
        )

        plastic_text = (
            f"PLASTIC {plastic_confidence:.0%}"
            if plastic_found
            else
            "PLASTIC None"
        )

        alert_text = (
            alert_type
            if alert_type is not None
            else
            "NONE"
        )

        print(
            "\r"
            f"LEVEL={level_text} | "
            f"FLOW={flow_text} | "
            f"{mud_text} | "
            f"{sand_text} | "
            f"{plastic_text} | "
            f"STATUS={system_status} | "
            f"ALERT={alert_text}",
            end="",
            flush=True
        )


        # ====================================================
        # SEND LIVE DATA TO DASHBOARD
        # ====================================================

        if (
            current_time - last_data_api_time
            >= DATA_API_INTERVAL
        ):

            send_dashboard_data(
                level,
                flow,
                temperature,
                mq135,
                system_status
            )

            last_data_api_time = current_time


        # ====================================================
        # ALERT CONTROL: SMS + TELEGRAM + SNAPSHOT
        # ====================================================

        should_send = False

        if alert_type is not None:

            if event_reset:
                should_send = True

            elif (
                alert_type == last_alert_type
                and
                current_time - last_alert_time >= SMS_COOLDOWN
            ):
                should_send = True

            elif alert_type != last_alert_type:
                should_send = True

        if should_send:

            sms_message = build_alert_message(
                alert_type,
                level,
                flow,
                mud_confidence,
                sand_confidence,
                plastic_confidence
            )

            telegram_message = build_telegram_alert_message(
                alert_type,
                level,
                flow,
                mud_confidence,
                sand_confidence,
                plastic_confidence
            )

            print()
            print()
            print("******** ALERT DECISION ********")
            print(f"ALERT TYPE: {alert_type}")
            print("********************************")

            # 1. Save the current camera frame with YOLO labels.
            snapshot_timestamp = datetime.now().strftime(
                "%Y%m%d_%H%M%S"
            )

            snapshot_filename = (
                f"{snapshot_timestamp}_{alert_type}.jpg"
            )

            snapshot_path = os.path.join(
                SNAPSHOT_FOLDER,
                snapshot_filename
            )

            if cv2.imwrite(snapshot_path, output):
                print(f"📸 Snapshot saved: {snapshot_path}")
            else:
                print("❌ Snapshot could not be saved.")
                snapshot_path = None

            # 2. Send SMS through A7670C.
            sms_success = False

            if gsm_ready:
                sms_success = send_sms(sms_message)
            else:
                print("GSM unavailable - SMS not sent.")

            # 3. Send Telegram text.
            telegram_success = send_telegram_message(
                telegram_message
            )

            # 4. Send the snapshot to Telegram.
            telegram_snapshot_success = False

            if snapshot_path is not None:

                snapshot_level = (
                    f"{level:.1f} cm"
                    if level is not None
                    else "N/A"
                )

                snapshot_caption = (
                    f"📸 {alert_type}\n"
                    f"Device: {DEVICE_NAME}\n"
                    f"Water Level: {snapshot_level}\n"
                    f"Time: "
                    f"{datetime.now().strftime('%d-%m-%Y %H:%M:%S')}"
                )

                telegram_snapshot_success = send_telegram_snapshot(
                    snapshot_path,
                    snapshot_caption
                )

            # 5. Record the alert in the dashboard.
            dashboard_success = send_dashboard_alert(
                alert_type,
                level,
                flow,
                mud_confidence,
                plastic_confidence
            )

            print()
            print("ALERT DELIVERY RESULT")
            print(
                "SMS       :",
                "SUCCESS" if sms_success else "FAILED"
            )
            print(
                "Telegram  :",
                "SUCCESS" if telegram_success else "FAILED"
            )
            print(
                "Snapshot  :",
                "SUCCESS" if telegram_snapshot_success else "FAILED"
            )
            print(
                "Dashboard :",
                "SUCCESS" if dashboard_success else "FAILED"
            )

            # SMS and Telegram are independent.
            if sms_success or telegram_success:

                last_alert_type = alert_type
                last_alert_time = time.time()
                event_reset = False

                print("Alert recorded for this event.")

            else:
                print(
                    "SMS and Telegram both failed. "
                    "Alert will be retried."
                )


        # ============================================================
        # DISPLAY
        # ============================================================

        cv2.imshow(
            "SMART DRAIN MONITORING SYSTEM",
            output
        )


        # ====================================================
        # QUIT
        # ====================================================

        key = (
            cv2.waitKey(1)
            &
            0xFF
        )

        if key == ord("q"):

            break


except KeyboardInterrupt:

    print()
    print(
        "Keyboard interrupt received."
    )


finally:

    # ========================================================
    # CLEANUP
    # ========================================================

    print()
    print()
    print(
        "Stopping system..."
    )

    try:

        picam2.stop()

    except Exception:
        pass

    cv2.destroyAllWindows()

    if esp_serial is not None:

        try:

            esp_serial.close()

        except Exception:
            pass

    if gsm_serial is not None:

        try:

            gsm_serial.close()

        except Exception:
            pass

    print(
        "System stopped."
    )
