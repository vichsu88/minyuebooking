import os
import re
from datetime import datetime, timedelta, timezone
from functools import wraps
from typing import Optional

from flask import Flask, request, jsonify
from flask_cors import CORS
from pymongo import MongoClient
from pymongo.errors import PyMongoError
from bson import ObjectId
from zoneinfo import ZoneInfo
from dotenv import load_dotenv

# Google Calendar
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build

# LINE push
from linebot import LineBotApi
from linebot.models import TextSendMessage
from linebot.exceptions import LineBotApiError

# -----------------------------------------------------------------------------
# Initialization
# -----------------------------------------------------------------------------
load_dotenv()
app = Flask(__name__)

# CORS：以環境變數設定白名單，開發期可用 "*"；正式上線請收斂
ALLOWED_ORIGINS = os.environ.get("ALLOWED_ORIGINS", "*")
origins = [o.strip() for o in ALLOWED_ORIGINS.split(",")] if ALLOWED_ORIGINS != "*" else "*"
CORS(app, resources={r"/api/*": {"origins": origins}})

# MongoDB
MONGO_URI = os.environ.get("MONGO_URI")
if not MONGO_URI:
    raise RuntimeError("FATAL: MONGO_URI is not set.")

client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
db = client.minyue_db
client.admin.command("ping")

services_col = db.services
bookings_col = db.bookings
users_col = db.users
customers_col = db.customers
hair_records_col = db.hair_records
reminders_col = db.reminders

# 時區
TAIPEI = ZoneInfo("Asia/Taipei")

# LINE
LINE_CHANNEL_ACCESS_TOKEN = os.environ.get("LINE_CHANNEL_ACCESS_TOKEN")
line_bot_api = LineBotApi(LINE_CHANNEL_ACCESS_TOKEN) if LINE_CHANNEL_ACCESS_TOKEN else None

# Google OAuth（用 refresh token 長期換取存取權）
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET")
GOOGLE_REFRESH_TOKEN = os.environ.get("GOOGLE_REFRESH_TOKEN")
GOOGLE_CALENDAR_ID = os.environ.get("GOOGLE_CALENDAR_ID", "primary")
SALON_ADDRESS = os.environ.get("SALON_ADDRESS", "")

# Admin 與 Cron 安全
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN")
CRON_SECRET = os.environ.get("CRON_SECRET")
MAX_ATTEMPTS = int(os.environ.get("MAX_ATTEMPTS", "5"))  # Cron 重試上限

# 建議索引（可重複呼叫）
try:
    users_col.create_index("userId", unique=True)
    services_col.create_index([("is_active", 1), ("display_order", 1)])
    bookings_col.create_index([("userId", 1), ("startAt", 1)])
    bookings_col.create_index([("status", 1), ("finalStartAt", 1)])
    reminders_col.create_index([("status", 1), ("dueAt", 1)])
    customers_col.create_index("phone", unique=False)
    customers_col.create_index("lineUserId", unique=False)  # 新增：以 LINE ID 映射顧客
    hair_records_col.create_index([("userId", 1), ("customerId", 1), ("date", 1)])
except Exception:
    pass

# -----------------------------------------------------------------------------
# Utilities
# -----------------------------------------------------------------------------
def _is_valid_object_id(s: str) -> bool:
    return bool(re.fullmatch(r"[0-9a-fA-F]{24}", s))

def _to_utc_naive(dt_aware):
    """tz-aware -> UTC naive（存 DB 用，避免 PyMongo aware/naive 混用問題）"""
    if dt_aware is None:
        return None
    return dt_aware.astimezone(timezone.utc).replace(tzinfo=None)

def _to_local(dt_utc_naive):
    """UTC naive -> Asia/Taipei aware（回應/運算用）"""
    if dt_utc_naive is None:
        return None
    return dt_utc_naive.replace(tzinfo=timezone.utc).astimezone(TAIPEI)

def _iso_or_none(dt):
    if not dt:
        return None
    # 若是 naive 視為 UTC
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc).isoformat()
    return dt.isoformat()

def _json_booking(doc: dict) -> dict:
    """將 bookings 文件安全輸出（避免 datetime 直接丟 jsonify 出錯）"""
    return {
        "_id": str(doc.get("_id")),
        "userId": doc.get("userId"),
        "date": doc.get("date"),
        "time": doc.get("time"),
        "serviceIds": [str(x) for x in doc.get("serviceIds", [])],
        "status": doc.get("status"),
        "startAt": _iso_or_none(doc.get("startAt")),               # UTC
        "startAtLocal": _iso_or_none(_to_local(doc.get("startAt"))),
        "finalStartAt": _iso_or_none(doc.get("finalStartAt")),     # UTC
        "finalStartAtLocal": _iso_or_none(_to_local(doc.get("finalStartAt"))),
        "finalEndAt": _iso_or_none(doc.get("finalEndAt")),
        "finalEndAtLocal": _iso_or_none(_to_local(doc.get("finalEndAt"))),
        "calendarEventId": doc.get("calendarEventId"),
        "calendarHtmlLink": doc.get("calendarHtmlLink"),
        "reminderId": str(doc.get("reminderId")) if doc.get("reminderId") else None,
        "createdAt": _iso_or_none(doc.get("createdAt")),
        "updatedAt": _iso_or_none(doc.get("updatedAt")),
    }

def _require_admin() -> Optional[str]:
    if not ADMIN_TOKEN:
        return "後台未設定 Admin Token"
    token = request.headers.get("X-Admin-Token")
    if token != ADMIN_TOKEN:
        return "未授權"
    return None

def require_admin(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        msg = _require_admin()
        if msg:
            return jsonify({"error": msg}), 401 if msg == "未授權" else 500
        return fn(*args, **kwargs)
    return wrapper

def verify_cron() -> bool:
    token = request.args.get("token") or request.headers.get("X-Cron-Token")
    return bool(token and CRON_SECRET and token == CRON_SECRET)

# 將 users 資料同步/建立到 customers（顯示 LINE 名稱、方便後台管理）
def _sync_customer_from_user(user_id: str):
    u = users_col.find_one({"userId": user_id})
    if not u:
        return
    customers_col.update_one(
        {"lineUserId": user_id},
        {
            "$set": {
                "lineUserId": user_id,
                "lineDisplayName": u.get("displayName"),
                "updatedAt": datetime.utcnow(),
            },
            "$setOnInsert": {
                # 第一次建立時帶入 phone/birthday；name 先用 LINE 名稱，可於後台更改
                "name": u.get("displayName") or "",
                "nickname": "",
                "phone": u.get("phone") or "",
                "birthday": u.get("birthday") or "",
                "note": "",
                "createdAt": datetime.utcnow(),
            },
        },
        upsert=True,
    )

# -----------------------------------------------------------------------------
# Google Calendar helpers
# -----------------------------------------------------------------------------
def _calendar_service():
    if not (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN):
        raise RuntimeError("Google OAuth 環境變數未設定完全")
    creds = Credentials(
        None,
        refresh_token=GOOGLE_REFRESH_TOKEN,
        token_uri="https://oauth2.googleapis.com/token",
        client_id=GOOGLE_CLIENT_ID,
        client_secret=GOOGLE_CLIENT_SECRET,
        scopes=["https://www.googleapis.com/auth/calendar"],
    )
    if not creds.valid and creds.refresh_token:
        creds.refresh(Request())
    return build("calendar", "v3", credentials=creds)

def create_calendar_event(summary: str, description: str, start_local, end_local):
    """
    start_local/end_local: tz-aware Asia/Taipei
    回傳 (event_id, htmlLink)
    """
    svc = _calendar_service()
    body = {
        "summary": summary,
        "description": description,
        "start": {"dateTime": start_local.isoformat(), "timeZone": "Asia/Taipei"},
        "end":   {"dateTime": end_local.isoformat(),   "timeZone": "Asia/Taipei"},
        "location": SALON_ADDRESS or None,
    }
    ev = svc.events().insert(calendarId=GOOGLE_CALENDAR_ID, body=body, sendUpdates="none").execute()
    return ev.get("id"), ev.get("htmlLink")

# -----------------------------------------------------------------------------
# LINE push helper
# -----------------------------------------------------------------------------
def send_line_push(user_id: str, message: str) -> bool:
    if not line_bot_api:
        print("[LINE] LINE_CHANNEL_ACCESS_TOKEN 未設定，跳過推播")
        return False
    try:
        line_bot_api.push_message(user_id, TextSendMessage(text=message))
        return True
    except LineBotApiError as e:
        print(f"[LINE] push error: {e}")
        return False

# -----------------------------------------------------------------------------
# Validators
# -----------------------------------------------------------------------------
def _validate_booking_payload(payload: dict) -> Optional[str]:
    if not payload:
        return "Request body is empty"
    up = payload.get("userProfile") or {}
    if not up.get("userId"):
        return "缺少 userProfile.userId"
    date = payload.get("date")
    time = payload.get("time")
    svc_ids = payload.get("serviceIds")

    if not date or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        return "缺少或不合法的 date（YYYY-MM-DD）"
    if not time or not re.fullmatch(r"\d{2}:\d{2}", time):
        return "缺少或不合法的 time（HH:MM）"
    if not isinstance(svc_ids, list) or not svc_ids:
        return "serviceIds 必須為非空陣列"
    if len(svc_ids) != len(set(svc_ids)):
        return "serviceIds 不可重複"
    if not all(isinstance(x, str) and _is_valid_object_id(x) for x in svc_ids):
        return "serviceIds 需為合法的 24 hex ObjectId 字串"

    # 禁止預約在「現在」之前
    try:
        y, m, d = map(int, date.split("-"))
        hh, mm = map(int, time.split(":"))
        start_local = datetime(y, m, d, hh, mm, tzinfo=TAIPEI)
        if start_local < datetime.now(tz=TAIPEI):
            return "預約時間不可早於現在"
    except ValueError:
        return "不合法的日期或時間"

    return None

# -----------------------------------------------------------------------------
# Routes - Public
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
    # 前台送出：pending
    try:
        payload = request.get_json(force=True)
    except Exception:
        return jsonify({"error": "無效的 JSON"}), 400

    err = _validate_booking_payload(payload)
    if err:
        return jsonify({"error": err}), 400

    up = payload["userProfile"]
    user_id = up["userId"]
    date = payload["date"]
    time = payload["time"]
    svc_ids = list(dict.fromkeys(payload["serviceIds"]))  # 去重保序

    # upsert 使用者（同步 displayName/pictureUrl）
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
    # 同步到 customers（確保顧客管理可見）
    _sync_customer_from_user(user_id)

    # 驗證服務存在且啟用
    svc_oids = [ObjectId(x) for x in svc_ids]
    found = list(services_col.find({"_id": {"$in": svc_oids}, "is_active": True}, {"_id": 1}))
    if len(found) != len(svc_oids):
        return jsonify({"error": "包含不存在或未啟用的服務項目"}), 400

    # 建立 startAt（存 UTC naive）
    y, m, d = map(int, date.split("-"))
    hh, mm = map(int, time.split(":"))
    start_local = datetime(y, m, d, hh, mm, tzinfo=TAIPEI)
    start_utc_naive = _to_utc_naive(start_local)

    # 阻擋同一 user 同時段重複 pending/confirmed
    dup = bookings_col.find_one({
        "userId": user_id,
        "startAt": start_utc_naive,
        "status": {"$in": ["pending", "confirmed"]},
    })
    if dup:
        return jsonify({"error": "同一時段已有未完成的預約"}), 409

    try:
        doc = {
            "userId": user_id,
            "date": date,
            "time": time,
            "startAt": start_utc_naive,
            "serviceIds": svc_oids,
            "status": "pending",
            "createdAt": datetime.utcnow(),
            "updatedAt": datetime.utcnow(),
        }
        rid = bookings_col.insert_one(doc).inserted_id
        return jsonify({"_id": str(rid), "status": "pending"}), 201
    except PyMongoError as e:
        return jsonify({"error": str(e)}), 500

# 新客註冊 / 檢查
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
    # 同步到 customers（註冊/更新後）
    _sync_customer_from_user(user_id)

    user = users_col.find_one({"userId": user_id}, {"_id": 0})
    return jsonify(user), 200

# -----------------------------------------------------------------------------
# Routes - Admin
# -----------------------------------------------------------------------------
@app.route("/api/admin/bookings/pending", methods=["GET"])
@require_admin
def admin_list_pending_bookings():
    """
    回傳待處理預約（含顧客姓名/電話、服務名稱列表），只列出尚未開始的。
    """
    now_utc = datetime.utcnow()
    q = {"status": "pending", "startAt": {"$gte": now_utc}}
    cur = bookings_col.find(q).sort("startAt", 1)
    bookings = list(cur)

    # 蒐集 userId 與 serviceIds 做一次性查詢
    user_ids = {b.get("userId") for b in bookings if b.get("userId")}
    svc_oid_set = set()
    for b in bookings:
        for sid in b.get("serviceIds", []):
            try:
                svc_oid_set.add(ObjectId(sid) if not isinstance(sid, ObjectId) else sid)
            except Exception:
                pass

    users_map = {
        u["userId"]: {"displayName": u.get("displayName"), "phone": u.get("phone")}
        for u in users_col.find(
            {"userId": {"$in": list(user_ids)}},
            {"_id": 0, "userId": 1, "displayName": 1, "phone": 1}
        )
    }

    services_map = {
        s["_id"]: s.get("name")
        for s in services_col.find({"_id": {"$in": list(svc_oid_set)}}, {"_id": 1, "name": 1})
    }

    def enrich(doc):
        base = _json_booking(doc)
        u = users_map.get(doc.get("userId"), {})
        base["user"] = u  # {displayName, phone}
        names = []
        for sid in doc.get("serviceIds", []):
            try:
                key = ObjectId(sid) if not isinstance(sid, ObjectId) else sid
            except Exception:
                continue
            n = services_map.get(key)
            if n:
                names.append(n)
        base["serviceNames"] = names
        return base

    data = [enrich(b) for b in bookings]
    return jsonify(data), 200

@app.route("/api/admin/bookings/<bid>/confirm", methods=["POST"])
@require_admin
def admin_confirm_booking(bid):
    """
    Body:
    - 可用下列任一方式提供最終開始時間（優先順序由上而下）：
      1) finalStart: "YYYY-MM-DDTHH:MM"  (台北時間)
      2) final_datetime: ISO 8601，如 "2025-08-20T10:30:00.000Z"
      3) finalDate: "YYYY-MM-DD" + finalTime: "HH:MM"
    - durationMins: 預設 90
    """
    try:
        data = request.get_json(force=True)
    except Exception:
        return jsonify({"error": "無效的 JSON"}), 400

    # duration 驗證
    try:
        duration = int(data.get("durationMins", 90))
        if duration <= 0 or duration > 8 * 60:
            return jsonify({"error": "不合法的 durationMins"}), 400
    except Exception:
        return jsonify({"error": "不合法的 durationMins"}), 400

    final_start_str = (data.get("finalStart") or "").strip()
    final_datetime_iso = (data.get("final_datetime") or "").strip()
    final_date = (data.get("finalDate") or "").strip()
    final_time = (data.get("finalTime") or "").strip()

    try:
        b = bookings_col.find_one({"_id": ObjectId(bid)})
        if not b:
            return jsonify({"error": "找不到預約"}), 404
        if b.get("status") not in ("pending", "confirmed"):
            return jsonify({"error": "此預約狀態不可確認"}), 400

        # 1) finalStart: "YYYY-MM-DDTHH:MM"（視為 Asia/Taipei）
        final_start_local = None
        if final_start_str:
            if "T" not in final_start_str:
                return jsonify({"error": "finalStart 需為 YYYY-MM-DDTHH:MM"}), 400
            ymd, hm = final_start_str.split("T")
            y, m, d = map(int, ymd.split("-"))
            hh, mm = map(int, hm.split(":"))
            final_start_local = datetime(y, m, d, hh, mm, tzinfo=TAIPEI)
        # 2) final_datetime: ISO 8601（允許 Z）
        elif final_datetime_iso:
            try:
                iso = final_datetime_iso.replace("Z", "+00:00")
                dt_aware = datetime.fromisoformat(iso)
                final_start_local = dt_aware.astimezone(TAIPEI)
            except Exception:
                return jsonify({"error": "final_datetime 格式不合法（需 ISO 8601）"}), 400
        # 3) finalDate + finalTime
        else:
            if not final_date or not final_time:
                return jsonify({"error": "需提供 finalStart 或 final_datetime 或 finalDate+finalTime"}), 400
            y, m, d = map(int, final_date.split("-"))
            hh, mm = map(int, final_time.split(":"))
            final_start_local = datetime(y, m, d, hh, mm, tzinfo=TAIPEI)

        final_end_local = final_start_local + timedelta(minutes=duration)

        # 建立 Google Calendar 事件
        user = users_col.find_one({"userId": b.get("userId")}) or {}
        svc_docs = list(services_col.find({"_id": {"$in": b.get("serviceIds", [])}}, {"name": 1}))
        svc_names = "、".join([s.get("name", "") for s in svc_docs]) or "服務"

        summary = f"顧客預約：{user.get('displayName') or 'LINE 使用者'} - {svc_names}"
        desc_lines = [
            f"顧客：{user.get('displayName') or ''}",
            f"LINE ID：{b.get('userId') or ''}",
            f"電話：{user.get('phone') or ''}",
            f"項目：{svc_names}",
        ]
        try:
            event_id, event_link = create_calendar_event(
                summary, "\n".join(desc_lines), final_start_local, final_end_local
            )
        except Exception as e:
            return jsonify({"error": f"建立行事曆事件失敗：{e}"}), 500

        # 寫回 bookings（時間以 UTC naive 存）
        bookings_col.update_one(
            {"_id": ObjectId(bid)},
            {"$set": {
                "status": "confirmed",
                "finalStartAt": _to_utc_naive(final_start_local),
                "finalEndAt": _to_utc_naive(final_end_local),
                "calendarEventId": event_id,
                "calendarHtmlLink": event_link,
                "updatedAt": datetime.utcnow()
            }}
        )

        # 建立提醒（預約前 2 小時）
        due_local = final_start_local - timedelta(hours=2)
        reminder_id = None
        if due_local > datetime.now(tz=TAIPEI):
            msg = f"溫馨提醒：您在『茗月髮型設計』的預約將於 {final_start_local.strftime('%m/%d %H:%M')} 開始，期待您的光臨！"
            reminder_id = reminders_col.insert_one({
                "bookingId": b["_id"],
                "userId": b.get("userId"),
                "channel": "line",
                "message": msg,
                "dueAt": _to_utc_naive(due_local),  # 存 UTC naive
                "status": "scheduled",
                "attempts": 0,
                "createdAt": datetime.utcnow(),
                "updatedAt": datetime.utcnow()
            }).inserted_id

            bookings_col.update_one({"_id": ObjectId(bid)}, {"$set": {"reminderId": reminder_id}})

        return jsonify({
            "ok": True,
            "calendarHtmlLink": event_link,
            "reminderCreated": bool(reminder_id)
        }), 200

    except Exception as e:
        return jsonify({"error": str(e)}), 500

# 顧客管理
@app.route("/api/admin/customers", methods=["GET"])
@require_admin
def admin_list_customers():
    q = {}
    keyword = request.args.get("q", "").strip()
    if keyword:
        q["$or"] = [
            {"name": {"$regex": keyword, "$options": "i"}},
            {"phone": {"$regex": keyword}},
            {"lineDisplayName": {"$regex": keyword, "$options": "i"}},  # 支援用 LINE 名稱找
            {"nickname": {"$regex": keyword, "$options": "i"}},         # 支援用暱稱找
        ]
    cur = customers_col.find(q).sort("updatedAt", -1).limit(200)
    data = []
    for c in cur:
        c["_id"] = str(c["_id"])
        data.append(c)
    return jsonify(data), 200

@app.route("/api/admin/customers", methods=["POST"])
@require_admin
def admin_create_customer():
    d = request.get_json(force=True)
    name = (d or {}).get("name", "").strip()
    phone = (d or {}).get("phone", "").strip()
    birthday = (d or {}).get("birthday", "").strip()
    if not name or not re.fullmatch(r"09\d{8}", phone):
        return jsonify({"error": "姓名必填，電話需 09 開頭共10碼"}), 400
    doc = {
        "name": name,
        "nickname": d.get("nickname", ""),  # 新增：店內暱稱
        "phone": phone,
        "birthday": birthday,
        "note": d.get("note", ""),
        "createdAt": datetime.utcnow(),
        "updatedAt": datetime.utcnow()
    }
    cid = customers_col.insert_one(doc).inserted_id
    return jsonify({"_id": str(cid)}), 201

@app.route("/api/admin/customers/<cid>", methods=["PATCH"])
@require_admin
def admin_update_customer(cid):
    d = request.get_json(force=True)
    update = {}
    for k in ["name", "nickname", "phone", "birthday", "note"]:  # 允許更新暱稱
        if k in d:
            update[k] = d[k]
    if not update:
        return jsonify({"error": "沒有可更新欄位"}), 400
    try:
        customers_col.update_one({"_id": ObjectId(cid)}, {"$set": {**update, "updatedAt": datetime.utcnow()}})
        return jsonify({"ok": True}), 200
    except Exception:
        return jsonify({"error": "不合法的顧客 ID"}), 400

# 染燙/消費紀錄
@app.route("/api/admin/hair-records", methods=["POST"])
@require_admin
def admin_create_hair_record():
    d = request.get_json(force=True)
    user_id = d.get("userId")
    customer_id = d.get("customerId")
    if not user_id and not customer_id:
        return jsonify({"error": "需提供 userId 或 customerId"}), 400
    date = d.get("date")
    if not date or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        return jsonify({"error": "不合法的日期（YYYY-MM-DD）"}), 400
    items = d.get("items") or []
    amount = int(d.get("amount", 0))

    doc = {
        "userId": user_id,
        "customerId": ObjectId(customer_id) if customer_id else None,
        "date": date,
        "items": items,
        "amount": amount,
        "formula1": d.get("formula1", ""),
        "formula2": d.get("formula2", ""),
        "notes": d.get("notes", ""),
        "createdAt": datetime.utcnow(),
        "updatedAt": datetime.utcnow()
    }
    rid = hair_records_col.insert_one(doc).inserted_id
    return jsonify({"_id": str(rid)}), 201

@app.route("/api/admin/hair-records", methods=["GET"])
@require_admin
def admin_list_hair_records():
    user_id = request.args.get("userId")
    customer_id = request.args.get("customerId")
    q = {}
    if user_id:
        q["userId"] = user_id
    if customer_id:
        try:
            q["customerId"] = ObjectId(customer_id)
        except Exception:
            return jsonify({"error": "不合法的 customerId"}), 400
    cur = hair_records_col.find(q).sort("date", -1).limit(200)
    data = []
    for r in cur:
        r["_id"] = str(r["_id"])
        if r.get("customerId"):
            r["customerId"] = str(r["customerId"])
        data.append(r)
    return jsonify(data), 200

# 服務管理（Admin）
@app.route("/api/admin/services", methods=["GET"])
@require_admin
def admin_list_services():
    cur = services_col.find({}, {"name": 1, "price": 1, "is_active": 1, "display_order": 1}).sort("display_order", 1)
    data = [
        {"_id": str(s["_id"]), "name": s.get("name", ""), "price": int(s.get("price", 0)),
         "is_active": bool(s.get("is_active", True)), "display_order": int(s.get("display_order", 0))}
        for s in cur
    ]
    return jsonify(data), 200

@app.route("/api/admin/services", methods=["POST"])
@require_admin
def admin_create_service():
    d = request.get_json(force=True) or {}
    name = (d.get("name") or "").strip()
    try:
        price = int(d.get("price", 0))
        display_order = int(d.get("display_order", 0))
    except Exception:
        return jsonify({"error": "price/display_order 需為整數"}), 400
    is_active = bool(d.get("is_active", True))
    if not name:
        return jsonify({"error": "name 必填"}), 400

    doc = {
        "name": name,
        "price": price,
        "display_order": display_order,
        "is_active": is_active,
        "createdAt": datetime.utcnow(),
        "updatedAt": datetime.utcnow()
    }
    sid = services_col.insert_one(doc).inserted_id
    return jsonify({"_id": str(sid)}), 201

@app.route("/api/admin/services/<sid>", methods=["PATCH"])
@require_admin
def admin_update_service(sid):
    d = request.get_json(force=True) or {}
    update = {}
    if "name" in d:
        name = (d.get("name") or "").strip()
        if not name:
            return jsonify({"error": "name 不可為空"}), 400
        update["name"] = name
    if "price" in d:
        try:
            update["price"] = int(d.get("price"))
        except Exception:
            return jsonify({"error": "price 需為整數"}), 400
    if "display_order" in d:
        try:
            update["display_order"] = int(d.get("display_order"))
        except Exception:
            return jsonify({"error": "display_order 需為整數"}), 400
    if "is_active" in d:
        update["is_active"] = bool(d.get("is_active"))

    if not update:
        return jsonify({"error": "沒有可更新欄位"}), 400

    try:
        services_col.update_one({"_id": ObjectId(sid)}, {"$set": {**update, "updatedAt": datetime.utcnow()}})
        return jsonify({"ok": True}), 200
    except Exception:
        return jsonify({"error": "不合法的服務 ID"}), 400

# Cron：派送提醒
@app.route("/api/admin/cron/dispatch", methods=["GET", "POST"])
def cron_dispatch():
    if not verify_cron():
        return jsonify({"error": "未授權"}), 401

    now_utc = datetime.utcnow()
    processed = 0
    # 每次最多處理 50 筆
    for _ in range(50):
        r = reminders_col.find_one_and_update(
            {"status": "scheduled", "dueAt": {"$lte": now_utc}},
            {"$set": {"status": "sending", "updatedAt": datetime.utcnow()}},
            sort=[("dueAt", 1)]
        )
        if not r:
            break

        ok = False
        try:
            if r.get("channel") == "line" and r.get("userId") and r.get("message"):
                ok = send_line_push(r["userId"], r["message"])
        except Exception as e:
            ok = False
            print(f"[CRON] send error: {e}")

        if ok:
            reminders_col.update_one(
                {"_id": r["_id"]},
                {"$set": {"status": "sent", "sentAt": datetime.utcnow(), "updatedAt": datetime.utcnow()}}
            )
        else:
            if r.get("attempts", 0) + 1 >= MAX_ATTEMPTS:
                reminders_col.update_one(
                    {"_id": r["_id"]},
                    {"$set": {"status": "failed", "updatedAt": datetime.utcnow()}, "$inc": {"attempts": 1}}
                )
            else:
                reminders_col.update_one(
                    {"_id": r["_id"]},
                    {"$inc": {"attempts": 1}, "$set": {"status": "scheduled", "updatedAt": datetime.utcnow()}}
                )
        processed += 1

    return jsonify({"ok": True, "processed": processed}), 200

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5001))
    app.run(host="0.0.0.0", port=port)
