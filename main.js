(() => {
  const BACKEND_BASE_URL = 'https://minyue-api.onrender.com';
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

  // 價目表相關元素
  const priceListButton = document.getElementById('priceListButton');
  const priceListModal = document.getElementById('price-list-modal');
  const closeModalButton = document.getElementById('closeModalButton');
  const modalPriceList = document.getElementById('modal-price-list');

  let allServices = []; // 儲存所有服務項目，供價目表使用

  // ============== 主流程 ==============
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

    // 送出預約的事件
    bookingForm.addEventListener('submit', async e => {
      e.preventDefault();
      const submitButton = e.target.querySelector('button[type="submit"]');
      submitButton.disabled = true; // 防止重複點擊
      submitButton.textContent = '傳送中...';

      try {
        const payload = collectFormData();
        await submitBooking(payload);
        alert('您的預約請求已成功送出！\n我們將盡快透過 LINE 官方帳號與您確認最終時間。');
        
        // 重設表單
        bookingForm.reset();
        serviceOptions.querySelectorAll('.service-button.selected').forEach(btn =>
          btn.classList.remove('selected')
        );

      } catch (err) {
        console.error('[Submit Booking] 失敗:', err);
        alert(err.message || '預約送出失敗，請稍後再試。');
      } finally {
        submitButton.disabled = false; // 恢復按鈕
        submitButton.textContent = '送出預約';
      }
    });

    // 開啟/關閉價目表
    priceListButton.addEventListener('click', () => {
        priceListModal.classList.remove('hidden');
    });
    closeModalButton.addEventListener('click',  () => {
        priceListModal.classList.add('hidden');
    });
    priceListModal.addEventListener('click', e => {
        if (e.target === priceListModal) { // 點擊黑色半透明背景時也關閉
            priceListModal.classList.add('hidden');
        }
    });
  }

  // 顯示預約畫面並載入資料
  async function showBookingScreen() {
    try {
      const userName = await getUserDisplayName();
      displayNameSpan.textContent = userName || '顧客';
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

  // 讀取服務清單並產生按鈕與價目表
  async function loadServices() {
    serviceOptions.innerHTML = '<small>(服務項目載入中…)</small>';
    modalPriceList.innerHTML = '<p>載入中...</p>';
    try {
      const res = await fetch(`${BACKEND_BASE_URL}/api/services`);
      if (!res.ok) throw new Error(`讀取失敗 (${res.status})`);
      allServices = await res.json();

      if (!Array.isArray(allServices) || allServices.length === 0) {
        throw new Error('目前尚無服務項目。');
      }
      
      // 產生預約選項按鈕
      serviceOptions.innerHTML = '';
      allServices.forEach(svc => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'service-button';
        btn.textContent = svc.name; // 只顯示名稱
        btn.dataset.serviceId = svc._id;
        btn.addEventListener('click', () => btn.classList.toggle('selected'));
        serviceOptions.appendChild(btn);
      });
      
      // 產生價目表內容
      const priceListHtml = '<ul>' + allServices.map(svc => 
        `<li><span>${svc.name}</span><span>$${svc.price}</span></li>`
      ).join('') + '</ul>';
      modalPriceList.innerHTML = priceListHtml;

    } catch (err) {
      console.error('[Load Services] 失敗:', err);
      const errorMsg = `<small style="color:red;">${err.message}</small>`;
      serviceOptions.innerHTML = errorMsg;
      modalPriceList.innerHTML = errorMsg;
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
    
    // 從 LIFF SDK 取得使用者 ID
    const userId = liff.getContext()?.userId;
    if (!userId) {
        throw new Error('無法取得您的 LINE 使用者資訊，請重新整理頁面再試。');
    }

    const serviceIds = Array.from(selectedButtons).map(btn => btn.dataset.serviceId);

    return {
      userId: userId,
      date: dateVal,
      time: timeVal,
      serviceIds: serviceIds,
    };
  }

  // 將預約資料送往後端
  async function submitBooking(payload) {
    const res = await fetch(`${BACKEND_BASE_URL}/api/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({})); // 如果回傳的不是JSON，避免程式崩潰
      const errorMessage = errorData.error || `伺服器發生錯誤 (${res.status})，請稍後再試。`;
      throw new Error(errorMessage);
    }
    return res.json();
  }
})();
