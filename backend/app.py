import os
import re
import logging
from datetime import datetime, timedelta, timezone
from functools import wraps
from typing import Optional, List

from flask import Flask, request, jsonify, abort
from flask_cors import CORS
from pymongo import MongoClient
from pymongo.errors import PyMongoError, ConfigurationError
from bson import ObjectId
from zoneinfo import ZoneInfo
from dotenv import load_dotenv

# Google Calendar
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

# LINE push
from linebot import LineBotApi
from linebot.models import TextSendMessage
from linebot.exceptions import LineBotApiError

# ----------------------------------------------------------------------------- #
# Initialization & Configuration
# ----------------------------------------------------------------------------- #
# 設定日誌
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

load_dotenv()
app = Flask(__name__)

# 安全性設定：允許的來源
ALLOWED_ORIGINS = os.environ.get("ALLOWED_ORIGINS", "*")
origins_list = [o.strip() for o in ALLOWED_ORIGINS.split(",")] if ALLOWED_ORIGINS != "*" else "*"

# CORS 設定
CORS(app, resources={r"/api/*": {"origins": origins_list}})

# MongoDB 連線設定
MONGO_URI = os.environ.get("MONGO_URI")
if not MONGO_URI:
    logger.error("FATAL: MONGO_URI is not set.")
    raise RuntimeError("FATAL: MONGO_URI is not set.")

try:
    # 加入 retryWrites=True 與連線超時設定，提升 Render 休眠喚醒時的穩定性
    client = MongoClient(
        MONGO_URI, 
        serverSelectionTimeoutMS=5000, 
        connectTimeoutMS=10000, 
        retryWrites=True
    )
    db = client.minyue_db
    # 立即測試連線
    client.admin.command("ping")
    logger.info("MongoDB connection successful.")
except ConfigurationError as ce:
    logger.error(f"MongoDB Configuration Error: {ce}")
except Exception as e:
    logger.error(f"MongoDB Connection Failed: {e}")

# Collections
services_col = db.services
bookings_col = db.bookings
users_col = db.users
customers_col = db.customers
hair_records_col = db.hair_records
reminders_col = db.reminders

# Timezone
TAIPEI = ZoneInfo("Asia/Taipei")

# External Services
LINE_CHANNEL_ACCESS_TOKEN = os.environ.get("LINE_CHANNEL_ACCESS_TOKEN")
line_bot_api = LineBotApi(LINE_CHANNEL_ACCESS_TOKEN) if LINE_CHANNEL_ACCESS_TOKEN else None

GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET")
GOOGLE_REFRESH_TOKEN = os.environ.get("GOOGLE_REFRESH_TOKEN")
GOOGLE_CALENDAR_ID = os.environ.get("GOOGLE_CALENDAR_ID", "primary")
SALON_ADDRESS = os.environ.get("SALON_ADDRESS", "")

ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN")
CRON_SECRET = os.environ.get("CRON_SECRET")
MAX_ATTEMPTS = int(os.environ.get("MAX_ATTEMPTS", "5"))

# 建立索引
try:
    users_col.create_index("userId", unique=True)
    services_col.create_index([("is_active", 1), ("display_order", 1)])
    bookings_col.create_index([("userId", 1), ("startAt", 1)])
    bookings_col.create_index([("status", 1), ("finalStartAt", 1)])
    reminders_col.create_index([("status", 1), ("dueAt", 1)])
    customers_col.create_index("phone", unique=False)
    customers_col.create_index("lineUserId", unique=False)
    hair_records_col.create_index([("userId", 1), ("customerId", 1), ("date", 1)])
except Exception as e:
    logger.warning(f"Index creation warning: {e}")

# ----------------------------------------------------------------------------- #
# Middleware: Security Check
# ----------------------------------------------------------------------------- #
@app.before_request
def check_origin():
    if request.method == "OPTIONS":
        return
    if ALLOWED_ORIGINS == "*":
        return
    request_origin = request.headers.get("Origin")
    if request_origin and request_origin not in origins_list:
        logger.warning(f"Blocked request from unauthorized origin: {request_origin}")
        abort(403, description="Unauthorized Origin")

# ----------------------------------------------------------------------------- #
# Utilities
# ----------------------------------------------------------------------------- #
def _is_valid_object_id(s: str) -> bool:
    return bool(re.fullmatch(r"[0-9a-fA-F]{24}", s))

def _to_utc_naive(dt_aware):
    if dt_aware is None:
        return None
    return dt_aware.astimezone(timezone.utc).replace(tzinfo=None)

def _to_local(dt_utc_naive):
    if dt_utc_naive is None:
        return None
    return dt_utc_naive.replace(tzinfo=timezone.utc).astimezone(TAIPEI)

def _iso_or_none(dt):
    if not dt:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc).isoformat()
    return dt.isoformat()

def _json_booking(doc: dict, service_map: dict = None) -> dict:
    # 若有傳入 service_map，自動填入服務名稱
    s_names = []
    if service_map:
        for sid in doc.get("serviceIds", []):
            try:
                # 處理 ObjectId 或 str 混用的情況
                key = str(sid)
                if key in service_map:
                    s_names.append(service_map[key])
            except:
                pass

    return {
        "_id": str(doc.get("_id")),
        "userId": doc.get("userId"),
        "date": doc.get("date"),
        "time": doc.get("time"),
        "serviceIds": [str(x) for x in doc.get("serviceIds", [])],
        "serviceNames": s_names,
        "status": doc.get("status"),
        "startAt": _iso_or_none(doc.get("startAt")),
        "finalStartAtLocal": _iso_or_none(_to_local(doc.get("finalStartAt"))),
        "createdAt": _iso_or_none(doc.get("createdAt")),
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

def _sync_customer_from_user(user_id: str):
    try:
        u = users_col.find_one({"userId": user_id})
        if not u:
            return
        customers_col.update_one(
            {"lineUserId": user_id},
            {
                "$set": {
                    "lineUserId": user_id,
                    "lineDisplayName": u.get("displayName"),
                    "phone": u.get("phone") or "",
                    "birthday": u.get("birthday") or "",
                    "updatedAt": datetime.utcnow(),
                },
                "$setOnInsert": {
                    "name": u.get("displayName") or "",
                    "nickname": "",
                    "note": "",
                    "createdAt": datetime.utcnow(),
                },
            },
            upsert=True,
        )
    except Exception as e:
        logger.error(f"Sync customer error: {e}")

# ----------------------------------------------------------------------------- #
# Google Calendar helpers
# ----------------------------------------------------------------------------- #
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

# ----------------------------------------------------------------------------- #
# LINE push
# ----------------------------------------------------------------------------- #
def send_line_push(user_id: str, message: str) -> bool:
    if not line_bot_api:
        logger.warning("[LINE] LINE_CHANNEL_ACCESS_TOKEN 未設定，跳過推播")
        return False
    try:
        line_bot_api.push_message(user_id, TextSendMessage(text=message))
        return True
    except LineBotApiError as e:
        logger.error(f"[LINE] push error: {e}")
        return False

# ----------------------------------------------------------------------------- #
# Validators
# ----------------------------------------------------------------------------- #
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
    
    try:
        y, m, d = map(int, date.split("-"))
        hh, mm = map(int, time.split(":"))
        start_local = datetime(y, m, d, hh, mm, tzinfo=TAIPEI)
        # 寬容檢查：允許今天的過去時間（避免操作延遲導致無法預約），但不能是昨天
        today_start = datetime.now(tz=TAIPEI).replace(hour=0, minute=0, second=0, microsecond=0)
        if start_local < today_start:
             return "無法預約過去的日期"
    except ValueError:
        return "不合法的日期或時間"

    return None

# ----------------------------------------------------------------------------- #
# Public Routes (Client Side)
# ----------------------------------------------------------------------------- #
@app.route("/")
def index():
    return "茗月髮型設計 - API 伺服器已啟動 v2.0"

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

# [NEW] 查詢忙碌時段 (Google Calendar Sync)
@app.route("/api/slots/busy", methods=["GET"])
def get_busy_slots():
    date_str = request.args.get("date")
    if not date_str or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date_str):
        return jsonify({"error": "Invalid date format"}), 400

    busy_slots = []
    try:
        y, m, d = map(int, date_str.split("-"))
        # 設定查詢範圍：當天 00:00 到 23:59 (Taipei Time)
        day_start = datetime(y, m, d, 0, 0, 0, tzinfo=TAIPEI)
        day_end = datetime(y, m, d, 23, 59, 59, tzinfo=TAIPEI)

        svc = _calendar_service()
        events_result = svc.events().list(
            calendarId=GOOGLE_CALENDAR_ID,
            timeMin=day_start.isoformat(),
            timeMax=day_end.isoformat(),
            singleEvents=True,
            orderBy='startTime'
        ).execute()
        items = events_result.get('items', [])

        # 定義我們要檢查的時段：09:00 - 19:00
        for hour in range(9, 20):
            slot_time = datetime(y, m, d, hour, 0, 0, tzinfo=TAIPEI)
            is_busy = False
            
            for event in items:
                # 處理開始結束時間 (包含全天事件)
                start = event['start'].get('dateTime') or event['start'].get('date')
                end = event['end'].get('dateTime') or event['end'].get('date')

                if 'T' not in start: # 全天事件 (YYYY-MM-DD)
                    # 全天事件視為整天忙碌
                    # 簡單比對日期字串即可
                    if start <= date_str and end > date_str:
                        is_busy = True
                        break
                else:
                    # 一般事件 (ISO 8601)
                    e_start = datetime.fromisoformat(start).astimezone(TAIPEI)
                    e_end = datetime.fromisoformat(end).astimezone(TAIPEI)
                    
                    # 判斷重疊：若事件在 Slot 開始時正在進行，則視為忙碌
                    # 邏輯：EventStart <= SlotTime < EventEnd
                    if e_start <= slot_time < e_end:
                        is_busy = True
                        break
            
            if is_busy:
                busy_slots.append(f"{hour:02d}:00")

        return jsonify({"date": date_str, "busySlots": busy_slots}), 200

    except Exception as e:
        logger.error(f"Get Busy Slots Error: {e}")
        # 若 Google API 失敗，回傳空清單，避免阻擋使用者預約（降級服務）
        return jsonify({"date": date_str, "busySlots": [], "warning": "Calendar sync failed"}), 200

# [NEW] 查詢我的預約
@app.route("/api/bookings/my", methods=["GET"])
def get_my_bookings():
    user_id = request.args.get("userId")
    if not user_id:
        return jsonify({"error": "userId required"}), 400
    
    try:
        # 抓取該用戶所有未刪除的預約 (pending, confirmed, cancelled)
        cursor = bookings_col.find(
            {"userId": user_id, "status": {"$in": ["pending", "confirmed", "cancelled"]}}
        ).sort("startAt", -1).limit(20) # 只抓最近 20 筆
        
        bookings = list(cursor)
        
        # 準備 Service Map 以填充名稱
        svc_ids = set()
        for b in bookings:
            for sid in b.get("serviceIds", []):
                if ObjectId.is_valid(sid):
                    svc_ids.add(ObjectId(sid))
        
        svc_map = {str(s["_id"]): s["name"] for s in services_col.find({"_id": {"$in": list(svc_ids)}})}
        
        result = [_json_booking(b, svc_map) for b in bookings]
        return jsonify(result), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/bookings", methods=["POST"])
def create_booking():
    try:
        payload = request.get_json(force=True)
    except Exception:
        return jsonify({"error": "無效的 JSON"}), 400

    err = _validate_booking_payload(payload)
    if err:
        return jsonify({"error": err}), 400

    up = payload["userProfile"]
    user_id = up["userId"]
    
    # [MODIFIED] 強制檢查：預約前必須先完成電話註冊
    user_in_db = users_col.find_one({"userId": user_id})
    if not user_in_db or not user_in_db.get("phone"):
        return jsonify({"error": "尚未完成註冊", "code": "USER_NOT_REGISTERED"}), 400

    date = payload["date"]
    time = payload["time"]
    svc_ids = list(dict.fromkeys(payload["serviceIds"]))

    # 更新 User Profile (僅更新顯示名稱與頭像，不覆蓋電話)
    try:
        users_col.update_one(
            {"userId": user_id},
            {"$set": {
                "displayName": up.get("displayName"),
                "pictureUrl": up.get("pictureUrl"),
                "updatedAt": datetime.utcnow()
            }},
            upsert=True
        )
    except Exception:
        pass

    # 驗證服務有效性
    svc_oids = [ObjectId(x) for x in svc_ids]
    found = list(services_col.find({"_id": {"$in": svc_oids}, "is_active": True}, {"_id": 1}))
    if len(found) != len(svc_oids):
        return jsonify({"error": "包含不存在或已下架的服務項目"}), 400

    y, m, d = map(int, date.split("-"))
    hh, mm = map(int, time.split(":"))
    start_local = datetime(y, m, d, hh, mm, tzinfo=TAIPEI)
    start_utc_naive = _to_utc_naive(start_local)

    # 檢查是否重複預約 (針對同一人)
    dup = bookings_col.find_one({
        "userId": user_id,
        "startAt": start_utc_naive,
        "status": {"$in": ["pending", "confirmed"]},
    })
    if dup:
        return jsonify({"error": "您在該時段已有預約，請勿重複提交"}), 409

    try:
        rid = bookings_col.insert_one({
            "userId": user_id,
            "date": date,
            "time": time,
            "startAt": start_utc_naive,
            "serviceIds": svc_oids,
            "status": "pending",
            "createdAt": datetime.utcnow(),
            "updatedAt": datetime.utcnow(),
        }).inserted_id

        # 推播通知
        try:
            svc_names = "、".join([s.get("name","") for s in services_col.find({"_id": {"$in": svc_oids}}, {"name":1})])
            msg = f"【預約申請收到】\n日期：{date} {time}\n項目：{svc_names}\n\n系統將等待設計師確認，確認後會再次通知您！"
            send_line_push(user_id, msg)
        except Exception:
            pass

        return jsonify({"_id": str(rid), "status": "pending"}), 201
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
    try:
        data = request.get_json(force=True)
    except Exception:
        return jsonify({"error": "無效的 JSON"}), 400
        
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
    try:
        users_col.update_one(
            {"userId": user_id},
            {"$set": update, "$setOnInsert": {"createdAt": datetime.utcnow()}},
            upsert=True
        )
        _sync_customer_from_user(user_id)
        user = users_col.find_one({"userId": user_id}, {"_id": 0})
        return jsonify(user), 200
    except PyMongoError as e:
        return jsonify({"error": str(e)}), 500

# ----------------------------------------------------------------------------- #
# Admin Routes
# ----------------------------------------------------------------------------- #
@app.route("/api/admin/bookings/pending", methods=["GET"])
@require_admin
def admin_list_pending_bookings():
    now_utc = datetime.utcnow()
    try:
        cur = bookings_col.find({"status": "pending", "startAt": {"$gte": now_utc}}).sort("startAt", 1)
        bookings = list(cur)

        user_ids = list({b.get("userId") for b in bookings if b.get("userId")})
        svc_ids = set()
        for b in bookings:
            for sid in b.get("serviceIds", []):
                if ObjectId.is_valid(sid): svc_ids.add(ObjectId(sid))

        users_map = {
            u["userId"]: {"displayName": u.get("displayName"), "phone": u.get("phone")}
            for u in users_col.find({"userId": {"$in": user_ids}})
        }
        services_map = {
            str(s["_id"]): s.get("name")
            for s in services_col.find({"_id": {"$in": list(svc_ids)}})
        }

        result = []
        for b in bookings:
            data = _json_booking(b, services_map)
            data["user"] = users_map.get(b.get("userId"), {})
            result.append(data)

        return jsonify(result), 200
    except PyMongoError as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/admin/bookings/<bid>/confirm", methods=["POST"])
@require_admin
def admin_confirm_booking(bid):
    try:
        data = request.get_json(force=True)
    except Exception:
        return jsonify({"error": "無效的 JSON"}), 400

    duration = int(data.get("durationMins", 90))
    final_start_str = (data.get("finalStart") or "").strip() # YYYY-MM-DDTHH:MM

    try:
        b = bookings_col.find_one({"_id": ObjectId(bid)})
        if not b: return jsonify({"error": "找不到預約"}), 404
        
        if "T" not in final_start_str:
            return jsonify({"error": "時間格式錯誤"}), 400
        
        ymd, hm = final_start_str.split("T")
        y, m, d = map(int, ymd.split("-"))
        hh, mm = map(int, hm.split(":"))
        final_start_local = datetime(y, m, d, hh, mm, tzinfo=TAIPEI)
        final_end_local = final_start_local + timedelta(minutes=duration)

        # 準備寫入行事曆
        user = users_col.find_one({"userId": b.get("userId")}) or {}
        svc_docs = list(services_col.find({"_id": {"$in": b.get("serviceIds", [])}}, {"name": 1}))
        svc_names = "、".join([s.get("name", "") for s in svc_docs]) or "服務"

        summary = f"{user.get('displayName') or '顧客'} - {svc_names}"
        desc_lines = [
            f"顧客：{user.get('displayName')}",
            f"電話：{user.get('phone')}",
            f"項目：{svc_names}",
            f"備註：系統自動排程"
        ]
        
        event_id, event_link = create_calendar_event(
            summary, "\n".join(desc_lines), final_start_local, final_end_local
        )

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

        # 建立 2 小時前提醒
        due_local = final_start_local - timedelta(hours=2)
        if due_local > datetime.now(tz=TAIPEI):
            msg = f"【提醒】您在茗月髮型的預約將於 {final_start_local.strftime('%H:%M')} 開始，請準時蒞臨！"
            reminder_id = reminders_col.insert_one({
                "bookingId": b["_id"],
                "userId": b.get("userId"),
                "channel": "line",
                "message": msg,
                "dueAt": _to_utc_naive(due_local),
                "status": "scheduled",
                "attempts": 0,
                "createdAt": datetime.utcnow(),
                "updatedAt": datetime.utcnow()
            }).inserted_id
            bookings_col.update_one({"_id": ObjectId(bid)}, {"$set": {"reminderId": reminder_id}})

        # 立即通知預約成功
        send_line_push(b.get("userId"), f"【預約成功】\n您的預約已確認！\n時間：{final_start_local.strftime('%Y-%m-%d %H:%M')}\n我們期待您的光臨。")

        return jsonify({"ok": True}), 200

    except Exception as e:
        logger.error(f"Confirm Error: {e}")
        return jsonify({"error": str(e)}), 500

# [NEW] 拒絕預約
@app.route("/api/admin/bookings/<bid>/reject", methods=["POST"])
@require_admin
def admin_reject_booking(bid):
    try:
        data = request.get_json(force=True) or {}
    except Exception:
        data = {}
        
    reason = data.get("reason", "").strip()

    try:
        b = bookings_col.find_one({"_id": ObjectId(bid)})
        if not b: return jsonify({"error": "找不到預約"}), 404

        bookings_col.update_one(
            {"_id": ObjectId(bid)},
            {"$set": {
                "status": "cancelled",
                "updatedAt": datetime.utcnow()
            }}
        )

        # 發送婉拒通知
        msg = f"【預約通知】\n很抱歉，您申請的時段目前無法安排。\n{f'原因：{reason}' if reason else '請嘗試預約其他時段。'}"
        send_line_push(b.get("userId"), msg)

        return jsonify({"ok": True}), 200
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
            {"lineDisplayName": {"$regex": keyword, "$options": "i"}}
        ]
    try:
        cur = customers_col.find(q).sort("updatedAt", -1).limit(200)
        data = [{**c, "_id": str(c["_id"])} for c in cur]
        return jsonify(data), 200
    except PyMongoError as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/admin/customers", methods=["POST"])
@require_admin
def admin_create_customer():
    try:
        d = request.get_json(force=True)
        name = d.get("name", "").strip()
        phone = d.get("phone", "").strip()
        if not name or not re.fullmatch(r"09\d{8}", phone):
            return jsonify({"error": "格式錯誤"}), 400
        
        cid = customers_col.insert_one({
            "name": name,
            "nickname": d.get("nickname", ""),
            "phone": phone,
            "birthday": d.get("birthday", ""),
            "note": d.get("note", ""),
            "createdAt": datetime.utcnow(),
            "updatedAt": datetime.utcnow()
        }).inserted_id
        return jsonify({"_id": str(cid)}), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/admin/customers/<cid>", methods=["PATCH"])
@require_admin
def admin_update_customer(cid):
    try:
        d = request.get_json(force=True)
        update = {k: d[k] for k in ["name", "nickname", "phone", "birthday", "note"] if k in d}
        if not update: return jsonify({"error": "No fields"}), 400
        
        customers_col.update_one({"_id": ObjectId(cid)}, {"$set": {**update, "updatedAt": datetime.utcnow()}})
        return jsonify({"ok": True}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# 染燙紀錄
@app.route("/api/admin/hair-records", methods=["GET", "POST"])
@require_admin
def admin_hair_records():
    if request.method == "POST":
        try:
            d = request.get_json(force=True)
            if not d.get("customerId") and not d.get("userId"):
                return jsonify({"error": "ID missing"}), 400
            
            rid = hair_records_col.insert_one({
                "userId": d.get("userId"),
                "customerId": ObjectId(d["customerId"]) if d.get("customerId") else None,
                "date": d.get("date"),
                "items": d.get("items", []),
                "amount": int(d.get("amount", 0)),
                "formula1": d.get("formula1", ""),
                "formula2": d.get("formula2", ""),
                "notes": d.get("notes", ""),
                "createdAt": datetime.utcnow()
            }).inserted_id
            return jsonify({"_id": str(rid)}), 201
        except Exception as e:
            return jsonify({"error": str(e)}), 500
    else:
        cid = request.args.get("customerId")
        try:
            q = {"customerId": ObjectId(cid)} if cid else {}
            cur = hair_records_col.find(q).sort("date", -1).limit(100)
            data = [{**r, "_id": str(r["_id"]), "customerId": str(r.get("customerId"))} for r in cur]
            return jsonify(data), 200
        except Exception as e:
            return jsonify({"error": str(e)}), 500

# 服務管理
@app.route("/api/admin/services", methods=["GET", "POST"])
@require_admin
def admin_services():
    if request.method == "GET":
        cur = services_col.find({}).sort("display_order", 1)
        data = [{**s, "_id": str(s["_id"])} for s in cur]
        return jsonify(data), 200
    else:
        d = request.get_json(force=True)
        try:
            sid = services_col.insert_one({
                "name": d["name"],
                "price": int(d["price"]),
                "display_order": int(d.get("display_order", 0)),
                "is_active": d.get("is_active", True),
                "createdAt": datetime.utcnow()
            }).inserted_id
            return jsonify({"_id": str(sid)}), 201
        except Exception as e:
            return jsonify({"error": str(e)}), 500

@app.route("/api/admin/services/<sid>", methods=["PATCH"])
@require_admin
def admin_update_service(sid):
    try:
        d = request.get_json(force=True)
        update = {}
        if "name" in d: update["name"] = d["name"]
        if "price" in d: update["price"] = int(d["price"])
        if "display_order" in d: update["display_order"] = int(d["display_order"])
        if "is_active" in d: update["is_active"] = bool(d["is_active"])
        
        services_col.update_one({"_id": ObjectId(sid)}, {"$set": update})
        return jsonify({"ok": True}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# Cron Job
@app.route("/api/admin/cron/dispatch", methods=["GET", "POST"])
def cron_dispatch():
    if not verify_cron(): return jsonify({"error": "Unauthorized"}), 401
    
    now_utc = datetime.utcnow()
    processed = 0
    # 批次處理 50 筆
    cursor = reminders_col.find({"status": "scheduled", "dueAt": {"$lte": now_utc}}).limit(50)
    
    for r in cursor:
        try:
            if r.get("channel") == "line":
                send_line_push(r["userId"], r["message"])
            
            reminders_col.update_one(
                {"_id": r["_id"]}, 
                {"$set": {"status": "sent", "sentAt": datetime.utcnow()}}
            )
            processed += 1
        except Exception as e:
            logger.error(f"Cron error: {e}")
            reminders_col.update_one({"_id": r["_id"]}, {"$set": {"status": "failed"}})
            
    return jsonify({"processed": processed}), 200

# ----------------------------------------------------------------------------- #
# Main
# ----------------------------------------------------------------------------- #
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5001))
    app.run(host="0.0.0.0", port=port)