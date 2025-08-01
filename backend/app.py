import os
import re
from datetime import datetime
from flask import Flask, request, jsonify
from flask_cors import CORS
from pymongo import MongoClient
from pymongo.errors import PyMongoError, ConfigurationError
from dotenv import load_dotenv

# -----------------------------------------------------------------------------
# Initialization
# -----------------------------------------------------------------------------
load_dotenv()
app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": "*"}})

MONGO_URI = os.environ.get("MONGO_URI")
if not MONGO_URI:
    raise RuntimeError("FATAL ERROR: MONGO_URI environment variable is not set.")

try:
    client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
    # Use the most direct way to select the database
    db = client.minyue_db
    
    # Verify the connection with a ping
    client.admin.command("ping")
    print("✅ MongoDB connection successful.")
except Exception as e:
    print(f"❌ MongoDB connection failed: {e}")
    raise e

services_col = db.services
bookings_col = db.bookings
users_col = db.users

# -----------------------------------------------------------------------------
# Routes
# -----------------------------------------------------------------------------
@app.route("/")
def index():
    return "茗月髮型設計 - API 伺服器已啟動！"

@app.route("/api/services", methods=["GET"])
def get_services():
    try:
        cursor = services_col.find(
            {"is_active": True},
            {"name": 1, "price": 1, "display_order": 1}
        ).sort("display_order", 1)
        services = [
            {"_id": str(s["_id"]), "name": s["name"], "price": s.get("price", 0)}
            for s in cursor
        ]
        return jsonify(services), 200
    except PyMongoError as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/bookings", methods=["POST"])
def create_booking():
    try:
        payload = request.get_json(force=True)
    except Exception:
        return jsonify({"error": "無效的 JSON"}), 400

    err_msg = _validate_booking_payload(payload)
    if err_msg:
        return jsonify({"error": err_msg}), 400

    user_profile = payload.get("userProfile", {})
    user_id = user_profile.get("userId")
    
    if user_id:
        users_col.update_one(
            {"userId": user_id},
            {"$setOnInsert": {
                "displayName": user_profile.get("displayName"),
                "pictureUrl": user_profile.get("pictureUrl"),
                "createdAt": datetime.utcnow()
            }},
            upsert=True
        )

    try:
        doc = {
            "userId": user_id,
            "date": payload["date"],
            "time": payload["time"],
            "serviceIds": payload["serviceIds"],
            "status": "pending",
            "createdAt": datetime.utcnow(),
        }
        result = bookings_col.insert_one(doc)
        return jsonify({"_id": str(result.inserted_id), "status": "pending"}), 201
    except PyMongoError as e:
        return jsonify({"error": str(e)}), 500

# -----------------------------------------------------------------------------
# Helper
# -----------------------------------------------------------------------------
def _validate_booking_payload(payload: dict) -> str | None:
    if not payload: return "Request body is empty"
    if "userProfile" not in payload or "userId" not in payload["userProfile"]: return "缺少 userProfile.userId"
    if "date" not in payload: return "缺少 date"
    if "time" not in payload: return "缺少 time"
    if "serviceIds" not in payload or not isinstance(payload["serviceIds"], list) or not payload["serviceIds"]:
        return "serviceIds 必須為非空陣列"
    return None

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5001))
    app.run(host="0.0.0.0", port=port)