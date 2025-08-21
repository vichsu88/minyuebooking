(() => {
  // ====== 必填設定 ======
  const BACKEND_BASE_URL = 'https://minyue-api.onrender.com';
  const LIFF_ID = '2007825302-BWYw4PK5'; // 你的 LIFF ID

  // ====== 官方帳號導流（至少填一個）======
  // 推薦用加好友短網址（後台「加好友連結」）
  const OA_ADD_FRIEND_URL = '@693hnoib'; // TODO: 換成你的
  // 或者填 Basic ID（含 @），系統會組出聊天網址作為備援
  const OA_BASIC_ID = '@你的官方帳號ID'; // TODO: 換成你的（含 @），或留空

  // --- DOM ---
  const welcomeScreen = document.getElementById('welcome-screen');
  const bookingScreen = document.getElementById('booking-screen');
  const agreeButton = document.getElementById('agreeButton');
  const displayNameSpan = document.getElementById('displayName');
  const bookingForm = document.getElementById('booking-form');
  const datePicker = document.getElementById('date-picker');
  const timeSelect = document.getElementById('time-slot');
  const serviceOptions = document.getElementById('service-options');

  const priceListButton = document.getElementById('priceListButton');
  const priceListModal = document.getElementById('price-list-modal');
  const closeModalButton = document.getElementById('closeModalButton');
  const modalPriceList = document.getElementById('modal-price-list');

  const registerModal = document.getElementById('register-modal');
  const registerForm  = document.getElementById('register-form');
  const closeRegisterModal = document.getElementById('closeRegisterModal');

  let allServices = [];
  let userProfile = null;

  document.addEventListener('DOMContentLoaded', async () => {
    bindUIEvents();
    try {
      agreeButton.disabled = true;
      await liff.init({ liffId: LIFF_ID });
      if (liff.isLoggedIn()) {
        await showBookingScreen();
      } else {
        agreeButton.disabled = false;
      }
    } catch (err) {
      console.error('[LIFF] init error:', err);
      alert('系統初始化失敗，請稍後再試。');
    }
  });

  function bindUIEvents() {
    agreeButton.addEventListener('click', () => {
      if (!liff.isLoggedIn()) liff.login();
      else showBookingScreen();
    });

    bookingForm.addEventListener('submit', onSubmitBooking);

    priceListButton.addEventListener('click', () => priceListModal.classList.remove('hidden'));
    closeModalButton.addEventListener('click',  () => priceListModal.classList.add('hidden'));
    priceListModal.addEventListener('click', e => {
      if (e.target === priceListModal) priceListModal.classList.add('hidden');
    });

    registerForm.addEventListener('submit', onSubmitRegister);
    closeRegisterModal.addEventListener('click', () => registerModal.classList.add('hidden'));
  }

  async function showBookingScreen() {
    try {
      userProfile = await liff.getProfile();
      displayNameSpan.textContent = userProfile.displayName || '顧客';
      await ensureRegistered();
      welcomeScreen.style.display = 'none';
      bookingScreen.style.display = 'block';
      initializeBookingForm();
    } catch (err) {
      console.error('[Show Booking Screen] error:', err);
      alert(`無法顯示預約畫面：${err.message || '請稍後再試'}`);
    }
  }

  function initializeBookingForm() {
    const today = new Date();
    today.setMinutes(today.getMinutes() - today.getTimezoneOffset());
    datePicker.min = today.toISOString().split('T')[0];
    loadServices();
  }

  async function loadServices() {
    serviceOptions.innerHTML = '<small>(服務項目載入中…)</small>';
    modalPriceList.innerHTML = '<p>載入中...</p>';
    try {
      const res = await fetch(`${BACKEND_BASE_URL}/api/services`);
      if (!res.ok) throw new Error(`讀取失敗 (${res.status})`);
      allServices = await res.json();
      if (!Array.isArray(allServices) || allServices.length === 0) throw new Error('目前尚無服務項目。');

      serviceOptions.innerHTML = '';
      allServices.forEach(svc => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'service-button';
        btn.textContent = svc.name;
        btn.dataset.serviceId = svc._id;
        btn.addEventListener('click', () => btn.classList.toggle('selected'));
        serviceOptions.appendChild(btn);
      });

      const priceListHtml = '<ul>' + allServices.map(svc =>
        `<li><span>${svc.name}</span><span>$${Number(svc.price || 0).toLocaleString()}</span></li>`
      ).join('') + '</ul>';
      modalPriceList.innerHTML = priceListHtml;

    } catch (err) {
      console.error('[Load Services] 失敗:', err);
      const errorMsg = `<small style="color:red;">${err.message}</small>`;
      serviceOptions.innerHTML = errorMsg;
      modalPriceList.innerHTML = errorMsg;
    }
  }

  async function onSubmitBooking(e) {
    e.preventDefault();
    const submitButton = e.target.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    submitButton.textContent = '傳送中...';

    try {
      const payload = collectFormData();
      const resp = await submitBooking(payload);

      // === 成功：建立聊天關係 → 關閉畫面 ===
      await sendMessageThenClose(resp, payload);

      // 清表單（保險）
      bookingForm.reset();
      serviceOptions.querySelectorAll('.service-button.selected').forEach(btn => btn.classList.remove('selected'));

    } catch (err) {
      console.error('[Submit Booking] 失敗:', err);
      alert(err.message || '預約送出失敗，請稍後再試。');
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = '送出預約';
    }
  }

  function collectFormData() {
    const dateVal = datePicker.value;
    const timeVal = timeSelect.value;
    const selectedButtons = serviceOptions.querySelectorAll('.service-button.selected');

    if (!dateVal || !timeVal || selectedButtons.length === 0) {
      throw new Error('請確認所有欄位都已正確填寫！');
    }
    if (!userProfile?.userId) {
      throw new Error('無法取得您的 LINE 使用者資訊，請重新整理頁面再試。');
    }

    const serviceIds = Array.from(new Set(
      Array.from(selectedButtons).map(btn => btn.dataset.serviceId)
    ));

    return {
      userProfile: {
        userId: userProfile.userId,
        displayName: userProfile.displayName,
        pictureUrl: userProfile.pictureUrl
      },
      date: dateVal,
      time: timeVal,
      serviceIds
    };
  }

  async function submitBooking(payload) {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 15000); // 15s

    try {
      const res = await fetch(`${BACKEND_BASE_URL}/api/bookings`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'Accept': 'application/json'},
        body: JSON.stringify(payload),
        signal: ctrl.signal
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        const msg = errorData.error || `伺服器發生錯誤 (${res.status})，請稍後再試。`;
        throw new Error(msg);
      }
      return res.json();
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('連線逾時，請稍後再試。');
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  // === 預約成功後：丟一則訊息到官方帳號 → 關閉 LIFF（或導流到聊天/加好友頁）
  async function sendMessageThenClose(resp, payload) {
    // 準備發送的文字
    const selectedNames = allServices
      .filter(s => payload.serviceIds.includes(s._id))
      .map(s => s.name)
      .join('、');

    const lines = [
      '您好～我剛送出預約申請：',
      `日期：${payload.date}`,
      `時間：${payload.time}`,
      `項目：${selectedNames}`,
      resp?._id ? `預約編號：${resp._id}` : ''
    ].filter(Boolean);

    let sent = false;
    if (liff.isLoggedIn() && liff.isInClient()) {
      try {
        await liff.sendMessages([{ type: 'text', text: lines.join('\n') }]);
        sent = true;
      } catch (e) {
        console.warn('[LIFF] sendMessages 失敗：', e);
      }
    }

    if (!sent) {
      // 備援：外開加好友/聊天頁
      const chatUrl = OA_ADD_FRIEND_URL || (OA_BASIC_ID ? `https://line.me/R/ti/p/${encodeURIComponent(OA_BASIC_ID)}` : '');
      if (chatUrl) liff.openWindow({ url: chatUrl, external: true });
    }

    // 關閉 LIFF / 或在外部瀏覽器導轉
    setTimeout(() => {
      if (liff.isInClient()) {
        liff.closeWindow();
      } else {
        const chatUrl = OA_ADD_FRIEND_URL || (OA_BASIC_ID ? `https://line.me/R/ti/p/${encodeURIComponent(OA_BASIC_ID)}` : '/');
        location.replace(chatUrl);
      }
    }, 300);
  }

  // --- 新客註冊 ---
  async function ensureRegistered() {
    const url = `${BACKEND_BASE_URL}/api/users/check?userId=${encodeURIComponent((await liff.getProfile()).userId)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('檢查使用者狀態失敗');
    const data = await res.json();
    if (data.registered) return;

    // 未註冊 -> 顯示 Modal
    registerModal.classList.remove('hidden');
    return new Promise(resolve => {
      const handler = () => {
        registerModal.classList.add('hidden');
        registerForm.removeEventListener('registered', handler);
        resolve();
      };
      registerForm.addEventListener('registered', handler);
    });
  }

  async function onSubmitRegister(e) {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = '送出中...';

    try {
      const phone = document.getElementById('reg-phone').value.trim();
      const birthday = document.getElementById('reg-birthday').value;
      const profile = await liff.getProfile();
      const body = {
        userId: profile.userId,
        displayName: profile.displayName,
        pictureUrl: profile.pictureUrl,
        phone,
        birthday
      };
      const res = await fetch(`${BACKEND_BASE_URL}/api/users`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json', 'Accept': 'application/json'},
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || '註冊失敗，請稍後再試');
      }
      alert('基本資料已完成，感謝！');
      registerForm.dispatchEvent(new Event('registered'));
    } catch (err) {
      alert(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '儲存';
    }
  }
})();
