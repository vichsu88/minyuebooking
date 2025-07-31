import os
import re
from datetime import datetime

from flask import Flask, request, jsonify
from flask_cors import CORS
from pymongo import MongoClient
from pymongo.errors import PyMongoError
from dotenv import load_dotenv

# ----------------------------------------------------------------------------- 
# 初始化
# ----------------------------------------------------------------------------- 
load_dotenv()

app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": "*"}})

# 取得 MongoDB 連線字串
MONGO_URI = os.environ.get("MONGO_URI", "mongodb://localhost:27017/minyue_db")
client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
try:
    db = client.get_default_database() or client.minyue_db
    client.admin.command("ping")
    print("✅ MongoDB connection successful.")
except Exception as e:
    print(f"❌ MongoDB connection failed: {e}")
    db = client.minyue_db  # 保底指向一個 DB，避免 None

services_col = db.services
bookings_col = db.bookings

# ----------------------------------------------------------------------------- 
# Routes
# ----------------------------------------------------------------------------- 

@app.route("/")
def index():
    return "茗月髮型設計 - API 伺服器已啟動！"


@app.route("/health")
def health():
    """簡易健康檢查：DB ping"""
    try:
        client.admin.command("ping")
        return jsonify({"status": "ok"}), 200
    except Exception as e:
        return jsonify({"status": "error", "msg": str(e)}), 500


@app.route("/api/services", methods=["GET"])
def get_services():
    try:
        cursor = services_col.find(
            {"is_active": True},
            {"name": 1, "price": 1}  # 加入 price
        ).sort("display_order", 1)
        services = [
            {"_id": str(s["_id"]), "name": s["name"], "price": s.get("price", 0)}  # 返回服務名稱和價格
            for s in cursor
        ]
        return jsonify(services), 200
    except PyMongoError as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/bookings", methods=["POST"])
def create_booking():
    # 1) 解析 JSON
    try:
        payload = request.get_json(force=True)
    except Exception:
        return jsonify({"error": "無效的 JSON"}), 400

    # 2) 驗證
    err = _validate_booking(payload)
    if err:
        return jsonify({"error": err}), 400

    # 3) 寫入 DB
    try:
        doc = {
            "date": payload["date"],
            "time": payload["time"],
            "services": payload["services"],  # e.g. [{id, name}, ...]
            "status": "pending",  # 後續可改為 confirmed/cancelled 等狀態
            "created_at": datetime.utcnow(),
        }
        result = bookings_col.insert_one(doc)
        return (
            jsonify({"_id": str(result.inserted_id), "status": "pending"}),
            201,
        )
    except PyMongoError as e:
        return jsonify({"error": str(e)}), 500


# ----------------------------------------------------------------------------- 
# Main – 啟動伺服器
# ----------------------------------------------------------------------------- 

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5001))
    debug_mode = os.environ.get("FLASK_DEBUG", "0") == "1"
    app.run(host="0.0.0.0", port=port, debug=debug_mode)
