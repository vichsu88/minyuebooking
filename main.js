// main.js – 完整可直接替換版本
// ============================================
// 茗月髮型設計預約前端腳本
// - 使用 LIFF v2
// - 從雲端後端 (Render) 讀取服務清單
// - 將預約資料 POST 至後端 /api/bookings
// - 含基本欄位驗證與錯誤處理
// ============================================

(() => {
  /**
   * ===== 可調整參數 =====
   * 後端 API Base URL (Render 或其他部署位址，不含結尾斜線)
   */
  const BACKEND_BASE_URL = 'https://minyue-api.onrender.com'; // ← 若日後改網域，在此調整

  /**
   * LINE LIFF App ID
   * - 可設在 .env 並於打包時注入；這裡先寫死方便示範
   */
  const LIFF_ID = '2007825302-BWYw4PK5';

  // DOM 元素
  const welcomeScreen = document.getElementById('welcome-screen');
  const bookingScreen = document.getElementById('booking-screen');
  const agreeButton = document.getElementById('agreeButton');
  const displayNameSpan = document.getElementById('displayName');
  const bookingForm = document.getElementById('booking-form');
  const datePicker = document.getElementById('date-picker');
  const timeSelect = document.getElementById('time-slot');
  const serviceOptions = document.getElementById('service-options');
  const priceListButton = document.getElementById('priceListButton');

  // ============== 主流程 ==============
  document.addEventListener('DOMContentLoaded', async () => {
    bindUIEvents();
    try {
      agreeButton.disabled = true; // 初始化前先鎖定
      await liff.init({ liffId: LIFF_ID });
      if (liff.isLoggedIn()) {
        await showBookingScreen();
      } else {
        agreeButton.disabled = false; // 允許使用者點擊同意
      }
    } catch (err) {
      console.error('[LIFF] 初始化失敗:', err);
      alert('系統初始化失敗，請稍後再試。');
      agreeButton.disabled = false;
    }
  });

  // 綁定 UI 事件
  function bindUIEvents() {
    agreeButton.addEventListener('click', () => {
      if (!liff.isLoggedIn()) {
        liff.login();
      } else {
        showBookingScreen();
      }
    });

    bookingForm.addEventListener('submit', async e => {
      e.preventDefault();
      try {
        const payload = collectFormData();
        await submitBooking(payload);
        alert('預約已送出！我們將透過 LINE 官方帳號與您確認時間。');
        bookingForm.reset();
        // 取消所有已選服務按鈕效果
        serviceOptions.querySelectorAll('.service-button.selected').forEach(btn =>
          btn.classList.remove('selected')
        );
      } catch (err) {
        console.error('[Submit Booking] 失敗:', err);
        alert(err.message || '預約送出失敗，請稍後再試。');
      }
    });

    priceListButton.addEventListener('click', () => {
      // 此處可替換為實際價目表連結或 modal
      window.open('https://linktr.ee/minyue_price', '_blank');
    });
  }

  // 顯示預約畫面並載入資料
  async function showBookingScreen() {
    try {
      const userName = await getUserDisplayName();
      displayNameSpan.textContent = userName || '顧客';
      // 切換畫面
      welcomeScreen.style.display = 'none';
      bookingScreen.style.display = 'block';
      initializeBookingForm();
    } catch (err) {
      console.error('[Show Booking Screen] 錯誤:', err);
      alert('無法顯示預約畫面，請稍後再試。');
    }
  }

  // 取得使用者名稱
  async function getUserDisplayName() {
    if (liff.isInClient()) {
      const profile = await liff.getProfile();
      return profile.displayName;
    }
    return liff.getDecodedIDToken()?.name;
  }

  // 初始化日期最小值與服務清單
  function initializeBookingForm() {
    const today = new Date().toISOString().split('T')[0];
    datePicker.min = today;
    loadServices();
  }

  // 讀取服務清單並產生按鈕
  async function loadServices() {
    serviceOptions.innerHTML = '<small>(服務項目載入中…)</small>';
    try {
      const res = await fetch(`${BACKEND_BASE_URL}/api/services`);
      if (!res.ok) throw new Error(`讀取失敗 (${res.status})`);
      const services = await res.json();

      if (!Array.isArray(services) || services.length === 0) {
        throw new Error('目前尚無服務項目。');
      }
      serviceOptions.innerHTML = '';
      services.forEach(svc => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'service-button';
        btn.textContent = svc.name;
        btn.dataset.serviceId = svc._id;
        btn.addEventListener('click', () => btn.classList.toggle('selected'));
        serviceOptions.appendChild(btn);
      });
    } catch (err) {
      console.error('[Load Services] 失敗:', err);
      serviceOptions.innerHTML = `<small style="color:red;">${err.message}</small>`;
    }
  }

  // 收集並驗證表單資料
  function collectFormData() {
    const dateVal = datePicker.value;
    const timeVal = timeSelect.value;
    const selectedButtons = serviceOptions.querySelectorAll('.service-button.selected');

    if (!dateVal) throw new Error('請選擇日期。');
    if (!timeVal) throw new Error('請選擇時段。');
    if (selectedButtons.length === 0) throw new Error('請至少選擇一個服務項目。');

    const services = Array.from(selectedButtons).map(btn => ({
      id: btn.dataset.serviceId,
      name: btn.textContent.trim(),
    }));

    return {
      date: dateVal,
      time: timeVal,
      services,
    };
  }

  // 將預約資料送往後端
  async function submitBooking(payload) {
    const res = await fetch(`${BACKEND_BASE_URL}/api/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const msg = (await res.json())?.error || `伺服器錯誤 (${res.status})`;
      throw new Error(msg);
    }
    return res.json();
  }
})();
