import os
from flask import Flask, jsonify
from pymongo import MongoClient
from dotenv import load_dotenv
from flask_cors import CORS # 引入 CORS

load_dotenv()

app = Flask(__name__)
CORS(app) # 啟用 CORS，允許所有來源的請求

MONGO_URI = os.environ.get('MONGO_URI')
try:
    client = MongoClient(MONGO_URI)
    db = client.minyue_db
    print("✅ MongoDB connection successful.")
except Exception as e:
    print(f"❌ MongoDB connection failed: {e}")

@app.route('/')
def index():
    return "茗月髮型設計 - 後端伺服器已啟動！"

@app.route('/api/services')
def get_services():
    try:
        services_cursor = db.services.find({"is_active": True}, {'_id': 1, 'name': 1}).sort("display_order", 1)
        services_list = []
        for service in services_cursor:
            service['_id'] = str(service['_id'])
            services_list.append(service)
        return jsonify(services_list)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    app.run(debug=True, port=5001)