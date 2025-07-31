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
  
  const priceListButton = document.getElementById('priceListButton');
  const priceListModal = document.getElementById('price-list-modal');
  const closeModalButton = document.getElementById('closeModalButton');
  const modalPriceList = document.getElementById('modal-price-list');
  
  let allServices = [];
  let userProfile = null; // 用來儲存客人的 LINE Profile

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

  function bindUIEvents() {
    agreeButton.addEventListener('click', () => {
      if (!liff.isLoggedIn()) liff.login();
      else showBookingScreen();
    });

    bookingForm.addEventListener('submit', async e => {
      e.preventDefault();
      const submitButton = e.target.querySelector('button[type="submit"]');
      submitButton.disabled = true;
      submitButton.textContent = '傳送中...';

      try {
        const payload = collectFormData();
        await submitBooking(payload);
        alert('您的預約請求已成功送出！\n我們將盡快透過 LINE 官方帳號與您確認最終時間。');
        
        bookingForm.reset();
        serviceOptions.querySelectorAll('.service-button.selected').forEach(btn =>
          btn.classList.remove('selected')
        );

      } catch (err) {
        console.error('[Submit Booking] 失敗:', err);
        alert(err.message || '預約送出失敗，請稍後再試。');
      } finally {
        submitButton.disabled = false;
        submitButton.textContent = '送出預約';
      }
    });

    priceListButton.addEventListener('click', () => priceListModal.classList.remove('hidden'));
    closeModalButton.addEventListener('click',  () => priceListModal.classList.add('hidden'));
    priceListModal.addEventListener('click', e => {
      if (e.target === priceListModal) priceListModal.classList.add('hidden');
    });
  }

  async function showBookingScreen() {
    try {
      userProfile = await liff.getProfile(); // 【重要修正】將 Profile 存起來
      displayNameSpan.textContent = userProfile.displayName || '顧客';
      
      welcomeScreen.style.display = 'none';
      bookingScreen.style.display = 'block';
      initializeBookingForm();
    } catch (err) {
      console.error('[Show Booking Screen] 錯誤:', err);
      alert('無法顯示預約畫面，請稍後再試。');
    }
  }

  function initializeBookingForm() {
    datePicker.min = new Date().toISOString().split('T')[0];
    loadServices();
  }

  async function loadServices() {
    serviceOptions.innerHTML = '<small>(服務項目載入中…)</small>';
    modalPriceList.innerHTML = '<p>載入中...</p>';
    try {
      const res = await fetch(`${BACKEND_BASE_URL}/api/services`);
      if (!res.ok) throw new Error(`讀取失敗 (${res.status})`);
      allServices = await res.json();

      if (!Array.isArray(allServices) || allServices.length === 0)
        throw new Error('目前尚無服務項目。');

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

    const serviceIds = Array.from(selectedButtons).map(btn => btn.dataset.serviceId);

    return {
      userProfile: { // 【重要修正】附上完整的客人 LINE 資料
          userId: userProfile.userId,
          displayName: userProfile.displayName,
          pictureUrl: userProfile.pictureUrl
      },
      date: dateVal,
      time: timeVal,
      serviceIds: serviceIds,
    };
  }

  async function submitBooking(payload) {
    const res = await fetch(`${BACKEND_BASE_URL}/api/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      const errorMessage = errorData.error || `伺服器發生錯誤 (${res.status})，請稍後再試。`;
      throw new Error(errorMessage);
    }
    return res.json();
  }
})();
