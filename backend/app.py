"""app.py – 茗月髮型設計後端伺服器（Flask + MongoDB）
================================================================
• 依環境變數 MONGO_URI 連線至 MongoDB
• 提供：
    /                -> 偵測 API 是否啟動
    /health          -> 簡易健康檢查 (DB ping)
    /api/services    -> 讀取啟用的服務清單 (GET)
    /api/bookings    -> 建立預約 (POST)
• 啟用 CORS，僅允許前端網域可再細部調整
• 可直接部署於 Render / Heroku / Railway 等雲端平台
"""

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
# 允許所有來源，正式環境建議改為固定網域
CORS(app, resources={r"/api/*": {"origins": "*"}})

# 取得 MongoDB 連線字串
MONGO_URI = os.environ.get("MONGO_URI", "mongodb://localhost:27017/minyue_db")
client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
# 若連線字串本身已含資料庫，get_default_database() 會自動擷取
# 若無，預設使用 minyue_db
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
# Helper – 資料驗證
# -----------------------------------------------------------------------------

def _validate_booking(payload: dict) -> str | None:
    """驗證預約資料，返回錯誤訊息或 None (驗證通過)"""
    required = ["date", "time", "services"]
    for field in required:
        if field not in payload:
            return f"缺少欄位：{field}"

    # YYYY-MM-DD
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", payload["date"]):
        return "日期格式錯誤，須為 YYYY-MM-DD"

    # HH:MM 24hr
    if not re.fullmatch(r"\d{2}:\d{2}", payload["time"]):
        return "時間格式錯誤，須為 HH:MM (24 小時制)"

    if not isinstance(payload["services"], list) or len(payload["services"]) == 0:
        return "services 必須為非空陣列"

    return None

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
        cursor = (
            services_col.find({"is_active": True}, {"name": 1})
            .sort("display_order", 1)
        )
        services = [{"_id": str(s["_id"]), "name": s["name"]} for s in cursor]
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
    # 在雲端服務 (Render 等) 通常會注入 PORT 環境變數
    port = int(os.environ.get("PORT", 5001))
    debug_mode = os.environ.get("FLASK_DEBUG", "0") == "1"
    app.run(host="0.0.0.0", port=port, debug=debug_mode)
