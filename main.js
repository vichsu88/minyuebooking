// main.js

(() => {
  const BACKEND_BASE_URL = 'https://minyue-api.onrender.com';
  const LIFF_ID = '2007825302-BWYw4PK5';

  // --- DOM 元素 ---
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
  
  // 【新功能】註冊 Modal DOM
  const registerModal = document.getElementById('register-modal');
  const registerForm  = document.getElementById('register-form');
  const closeRegisterModal = document.getElementById('closeRegisterModal');

  let allServices = [];
  let userProfile = null;

  // --- 初始化 ---
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
      console.error('[LIFF] 初始化失敗:', err);
      alert('系統初始化失敗，請稍後再試。');
    }
  });

  // --- 事件綁定 ---
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

    // 【新功能】註冊 Modal 事件
    registerForm.addEventListener('submit', onSubmitRegister);
    closeRegisterModal.addEventListener('click', () => registerModal.classList.add('hidden'));
  }

  // --- 核心流程 ---
  async function showBookingScreen() {
    try {
      userProfile = await liff.getProfile();
      displayNameSpan.textContent = userProfile.displayName || '顧客';
      
      await ensureRegistered(); // <<< 新增：檢查/引導註冊

      welcomeScreen.style.display = 'none';
      bookingScreen.style.display = 'block';
      initializeBookingForm();
    } catch (err) {
      console.error('[Show Booking Screen] 錯誤:', err);
      alert(`無法顯示預約畫面：${err.message || '請稍後再試'}`);
    }
  }

  function initializeBookingForm() {
    // (A) 修正 datePicker.min 的時區誤差
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
        `<li><span>${svc.name}</span><span>$${svc.price.toLocaleString()}</span></li>`
      ).join('') + '</ul>';
      modalPriceList.innerHTML = priceListHtml;

    } catch (err) {
      console.error('[Load Services] 失敗:', err);
      const errorMsg = `<small style="color:red;">${err.message}</small>`;
      serviceOptions.innerHTML = errorMsg;
      modalPriceList.innerHTML = errorMsg;
    }
  }

  // --- 表單提交 ---
  async function onSubmitBooking(e) {
    e.preventDefault();
    const submitButton = e.target.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    submitButton.textContent = '傳送中...';

    try {
      const payload = collectFormData();
      await submitBooking(payload);
      alert('您的預約請求已成功送出！\n我們將盡快透過 LINE 官方帳號與您確認最終時間。');
      
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

  // (B) collectFormData()：去重 serviceIds
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

    // 去重
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

  // (C) submitBooking()：加入逾時/錯誤訊息最佳化
  async function submitBooking(payload) {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 15000); // 15s 逾時

    try {
      const res = await fetch(`${BACKEND_BASE_URL}/api/bookings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
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
      if (err.name === 'AbortError') {
        throw new Error('連線逾時，請稍後再試。');
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
  
  // --- 【新功能】新客註冊流程 ---
  async function ensureRegistered() {
    const url = `${BACKEND_BASE_URL}/api/users/check?userId=${encodeURIComponent(userProfile.userId)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('檢查使用者狀態失敗');
    const data = await res.json();
    if (data.registered) return;

    // 未註冊 -> 顯示 Modal，並等待註冊完成
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
      const body = {
        userId: userProfile.userId,
        displayName: userProfile.displayName,
        pictureUrl: userProfile.pictureUrl,
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
      // 通知 ensureRegistered 的 Promise 可以 resolve
      registerForm.dispatchEvent(new Event('registered'));
    } catch (err) {
      alert(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '儲存';
    }
  }

})();