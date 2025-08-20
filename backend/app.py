# backend/app.py

import os
import re
from datetime import datetime
from functools import wraps
from typing import Optional  # <<< 修改
from flask import Flask, request, jsonify
from flask_cors import CORS
from pymongo import MongoClient
from pymongo.errors import PyMongoError
from bson import ObjectId  # <<< 新增
from zoneinfo import ZoneInfo  # <<< 新增
from dotenv import load_dotenv

# -----------------------------------------------------------------------------
# Initialization
# -----------------------------------------------------------------------------
load_dotenv()
app = Flask(__name__)

# --- 建議：用環境變數設定白名單（多個以逗號分隔），沒設則允許 *（開發時） ---
ALLOWED_ORIGINS = os.environ.get("ALLOWED_ORIGINS", "*")
origins = [o.strip() for o in ALLOWED_ORIGINS.split(",")] if ALLOWED_ORIGINS != "*" else "*"
CORS(app, resources={r"/api/*": {"origins": origins}})

MONGO_URI = os.environ.get("MONGO_URI")
if not MONGO_URI:
    raise RuntimeError("FATAL ERROR: MONGO_URI environment variable is not set.")

try:
    client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
    db = client.minyue_db
    client.admin.command("ping")
    print("✅ MongoDB connection successful.")
except Exception as e:
    print(f"❌ MongoDB connection failed: {e}")
    raise e

services_col = db.services
bookings_col = db.bookings
users_col = db.users
TAIPEI = ZoneInfo("Asia/Taipei")  # 統一時區

# --- 建議：索引（可重複呼叫、idempotent）---
try:
    users_col.create_index("userId", unique=True)
    services_col.create_index([("is_active", 1), ("display_order", 1)])
    bookings_col.create_index([("userId", 1), ("startAt", 1)])
    print("✅ Database indexes ensured.")
except Exception as e:
    print(f"⚠️  Index creation warning: {e}")
    pass


# -----------------------------------------------------------------------------
# Helpers & Decorators
# -----------------------------------------------------------------------------
def _is_valid_object_id(s: str) -> bool:
    return bool(re.fullmatch(r"[0-9a-fA-F]{24}", s))

def _validate_booking_payload(payload: dict) -> Optional[str]:
    if not payload: return "Request body is empty"
    up = payload.get("userProfile") or {}
    if not up.get("userId"): return "缺少 userProfile.userId"

    date = payload.get("date")
    time = payload.get("time")
    svc_ids = payload.get("serviceIds")

    if not date or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date): return "缺少或不合法的 date（YYYY-MM-DD）"
    if not time or not re.fullmatch(r"\d{2}:\d{2}", time): return "缺少或不合法的 time（HH:MM）"
    if not isinstance(svc_ids, list) or not svc_ids: return "serviceIds 必須為非空陣列"
    if len(svc_ids) != len(set(svc_ids)): return "serviceIds 不可重複"
    if not all(isinstance(x, str) and _is_valid_object_id(x) for x in svc_ids): return "serviceIds 需為合法的 24 hex ObjectId 字串"

    try:
        y, m, d = map(int, date.split("-"))
        hh, mm = map(int, time.split(":"))
        start_at = datetime(y, m, d, hh, mm, tzinfo=TAIPEI)
        if start_at < datetime.now(tz=TAIPEI): return "預約時間不可早於現在"
    except ValueError:
        return "不合法的日期或時間"
    return None

ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN")

def require_admin(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not ADMIN_TOKEN:
            return jsonify({"error": "後台未設定 Admin Token"}), 500
        token = request.headers.get("X-Admin-Token")
        if token != ADMIN_TOKEN:
            return jsonify({"error": "未授權"}), 401
        return fn(*args, **kwargs)
    return wrapper


# -----------------------------------------------------------------------------
# Public Routes
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
        services = [{"_id": str(s["_id"]), "name": s["name"], "price": s.get("price", 0)} for s in cursor]
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

    up = payload["userProfile"]
    user_id = up["userId"]
    date = payload["date"]
    time = payload["time"]
    svc_ids = list(dict.fromkeys(payload["serviceIds"]))

    users_col.update_one(
        {"userId": user_id},
        {
            "$set": {
                "displayName": up.get("displayName"),
                "pictureUrl": up.get("pictureUrl"),
                "updatedAt": datetime.utcnow(),
            },
            "$setOnInsert": {"createdAt": datetime.utcnow()},
        },
        upsert=True,
    )

    svc_oids = [ObjectId(s) for s in svc_ids]
    found = list(services_col.find({"_id": {"$in": svc_oids}, "is_active": True}, {"_id": 1}))
    if len(found) != len(svc_oids):
        return jsonify({"error": "包含不存在或未啟用的服務項目"}), 400

    y, m, d = map(int, date.split("-"))
    hh, mm = map(int, time.split(":"))
    start_at = datetime(y, m, d, hh, mm, tzinfo=TAIPEI)

    dup = bookings_col.find_one({
        "userId": user_id,
        "startAt": start_at,
        "status": {"$in": ["pending", "confirmed"]},
    })
    if dup:
        return jsonify({"error": "同一時段已有未完成的預約"}), 409

    try:
        doc = {
            "userId": user_id,
            "date": date,
            "time": time,
            "startAt": start_at,
            "serviceIds": svc_oids,
            "status": "pending",
            "createdAt": datetime.utcnow(),
            "updatedAt": datetime.utcnow(),
        }
        result = bookings_col.insert_one(doc)
        return jsonify({"_id": str(result.inserted_id), "status": "pending"}), 201
    except PyMongoError as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/users/check", methods=["GET"])
def check_user():
    user_id = request.args.get("userId")
    if not user_id:
        return jsonify({"error": "缺少 userId"}), 400
    user = users_col.find_one({"userId": user_id}, {"_id": 0})
    registered = bool(user and user.get("phone") and user.get("birthday"))
    return jsonify({"registered": registered, "user": user}), 200

@app.route("/api/users", methods=["PUT"])
def upsert_user():
    data = request.get_json(force=True)
    user_id = (data or {}).get("userId")
    if not user_id:
        return jsonify({"error": "缺少 userId"}), 400

    phone = data.get("phone")
    birthday = data.get("birthday")
    if not phone or not re.fullmatch(r"09\d{8}", phone):
        return jsonify({"error": "不合法的手機號碼（需 09 開頭共 10 碼）"}), 400
    if not birthday or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", birthday):
        return jsonify({"error": "不合法的生日（YYYY-MM-DD）"}), 400

    update = {
        "displayName": data.get("displayName"),
        "pictureUrl": data.get("pictureUrl"),
        "phone": phone,
        "birthday": birthday,
        "updatedAt": datetime.utcnow()
    }
    users_col.update_one(
        {"userId": user_id},
        {"$set": update, "$setOnInsert": {"createdAt": datetime.utcnow()}},
        upsert=True
    )
    user = users_col.find_one({"userId": user_id}, {"_id": 0})
    return jsonify(user), 200

# -----------------------------------------------------------------------------
# Admin Routes
# -----------------------------------------------------------------------------
@app.route("/api/admin/bookings", methods=["GET"])
@require_admin
def admin_list_bookings():
    q = {}
    if status := request.args.get("status"):
        q["status"] = status
    
    date_from = request.args.get("date_from")
    date_to = request.args.get("date_to")

    if date_from or date_to:
        cond = {}
        if date_from:
            y, m, d = map(int, date_from.split("-"))
            cond["$gte"] = datetime(y, m, d, tzinfo=TAIPEI)
        if date_to:
            y, m, d = map(int, date_to.split("-"))
            cond["$lt"] = datetime(y, m, d, 23, 59, 59, tzinfo=TAIPEI)
        q["startAt"] = cond

    cursor = bookings_col.find(q).sort("startAt", 1)
    data = [
        {
            "_id": str(b["_id"]),
            "userId": b["userId"],
            "date": b["date"],
            "time": b["time"],
            "startAt": b.get("startAt"),
            "serviceIds": [str(x) for x in b.get("serviceIds", [])],
            "status": b["status"],
            "createdAt": b.get("createdAt"),
        }
        for b in cursor
    ]
    return jsonify(data), 200

@app.route("/api/admin/bookings/<bid>", methods=["PATCH"])
@require_admin
def admin_update_booking(bid):
    data = request.get_json(force=True)
    status = (data or {}).get("status")
    if status not in {"pending", "confirmed", "canceled", "completed"}:
        return jsonify({"error": "不合法的狀態"}), 400
    try:
        result = bookings_col.update_one(
            {"_id": ObjectId(bid)},
            {"$set": {"status": status, "updatedAt": datetime.utcnow()}}
        )
        if result.matched_count == 0:
            return jsonify({"error": "找不到預約"}), 404
        return jsonify({"ok": True}), 200
    except Exception:
        return jsonify({"error": "不合法的預約 ID"}), 400

@app.route("/api/admin/services", methods=["GET"])
@require_admin
def admin_list_services():
    cursor = services_col.find({}).sort("display_order", 1)
    services = [
        {
            "_id": str(s["_id"]),
            "name": s.get("name"),
            "price": s.get("price"),
            "is_active": s.get("is_active"),
            "display_order": s.get("display_order"),
        }
        for s in cursor
    ]
    return jsonify(services), 200

@app.route("/api/admin/services", methods=["POST"])
@require_admin
def admin_create_service():
    data = request.get_json(force=True)
    name = (data or {}).get("name")
    if not name:
        return jsonify({"error": "name 必填"}), 400
    doc = {
        "name": name,
        "price": int(data.get("price", 0)),
        "is_active": data.get("is_active", True),
        "display_order": int(data.get("display_order", 999)),
        "createdAt": datetime.utcnow(),
        "updatedAt": datetime.utcnow(),
    }
    rid = services_col.insert_one(doc).inserted_id
    return jsonify({"_id": str(rid)}), 201

@app.route("/api/admin/services/<sid>", methods=["PATCH"])
@require_admin
def admin_update_service(sid):
    data = request.get_json(force=True)
    update = {}
    for k in ["name", "price", "is_active", "display_order"]:
        if k in data:
            update[k] = data[k]
    if not update:
        return jsonify({"error": "沒有可更新欄位"}), 400
    try:
        services_col.update_one(
            {"_id": ObjectId(sid)},
            {"$set": {**update, "updatedAt": datetime.utcnow()}}
        )
        return jsonify({"ok": True}), 200
    except Exception:
        return jsonify({"error": "不合法的服務 ID"}), 400

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5001))
    app.run(host="0.0.0.0", port=port, debug=True)