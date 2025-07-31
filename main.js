(() => {
  const BACKEND_BASE_URL = 'https://minyue-api.onrender.com';
  const LIFF_ID = '2007825302-BWYw4PK5';

  // ---- DOM ----
  const welcomeScreen   = document.getElementById('welcome-screen');
  const bookingScreen   = document.getElementById('booking-screen');
  const agreeButton     = document.getElementById('agreeButton');
  const displayNameSpan = document.getElementById('displayName');
  const bookingForm     = document.getElementById('booking-form');
  const datePicker      = document.getElementById('date-picker');
  const timeSelect      = document.getElementById('time-slot');
  const serviceOptions  = document.getElementById('service-options');

  // Modal
  const priceListButton  = document.getElementById('priceListButton');
  const priceListModal   = document.getElementById('price-list-modal');
  const closeModalButton = document.getElementById('closeModalButton');
  const modalPriceList   = document.getElementById('modal-price-list');

  let allServices = []; // 供價目表 / 驗證使用

  // ── 初始化 ──
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

  // ── 綁定事件 ──
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
      const submitBtn = e.target.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      submitBtn.textContent = '傳送中…';

      try {
        const payload = collectFormData();
        await submitBooking(payload);
        alert('預約已送出！我們將盡快透過 LINE 與您確認。');

        // 重設
        bookingForm.reset();
        serviceOptions.querySelectorAll('.service-button.selected')
                      .forEach(btn => btn.classList.remove('selected'));
      } catch (err) {
        console.error('[submitBooking] failed:', err);
        alert(err.message || '預約送出失敗，請稍後再試。');
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = '送出預約';
      }
    });

    // 價目表 Modal
    priceListButton.addEventListener('click', () => priceListModal.classList.remove('hidden'));
    closeModalButton.addEventListener('click',  () => priceListModal.classList.add('hidden'));
    priceListModal.addEventListener('click', e => {
      if (e.target === priceListModal) priceListModal.classList.add('hidden');
    });
  }

  // ── 畫面流程 ──
  async function showBookingScreen() {
    try {
      displayNameSpan.textContent = await getUserDisplayName() || '顧客';
      welcomeScreen.style.display = 'none';
      bookingScreen.style.display = 'block';
      initializeBookingForm();
    } catch (err) {
      console.error('[showBookingScreen]', err);
      alert('無法顯示預約畫面，請稍後再試。');
    }
  }

  async function getUserDisplayName() {
    if (liff.isInClient()) {
      const profile = await liff.getProfile();
      return profile.displayName;
    }
    return liff.getDecodedIDToken()?.name;
  }

  function initializeBookingForm() {
    datePicker.min = new Date().toISOString().split('T')[0];
    loadServices();
  }

  // ── 服務清單 ──
  async function loadServices() {
    serviceOptions.innerHTML = '<small>(服務項目載入中…)</small>';
    modalPriceList.innerHTML = '<p>載入中…</p>';
    try {
      const res = await fetch(`${BACKEND_BASE_URL}/api/services`);
      if (!res.ok) throw new Error(`讀取失敗 (${res.status})`);
      allServices = await res.json();
      if (!Array.isArray(allServices) || allServices.length === 0)
        throw new Error('尚無服務項目');

      // 預約按鈕
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

      // 價目表
      modalPriceList.innerHTML =
        '<ul>' +
        allServices
          .map(s => `<li><span>${s.name}</span><span>$${s.price}</span></li>`)
          .join('') +
        '</ul>';
    } catch (err) {
      console.error('[loadServices]', err);
      const msg = `<small style="color:red;">${err.message}</small>`;
      serviceOptions.innerHTML = msg;
      modalPriceList.innerHTML = msg;
    }
  }

  // ── 表單收集 & 驗證 ──
  function collectFormData() {
    const date = datePicker.value;
    const time = timeSelect.value;
    const selectedBtns = serviceOptions.querySelectorAll('.service-button.selected');

    if (!date)  throw new Error('請選擇日期');
    if (!time)  throw new Error('請選擇時段');
    if (!selectedBtns.length) throw new Error('請至少選擇一項服務');

    const userId = liff.getContext()?.userId;
    if (!userId) throw new Error('無法取得 LINE UserID，請重新登入');

    const serviceIds = Array.from(selectedBtns).map(btn => ({
      id: btn.dataset.serviceId,
      name: btn.textContent.trim()
    }));
    return { userId, date, time, services: serviceIds };
  }

  // ── 送出預約 ──
  async function submitBooking(payload) {
    const res = await fetch(`${BACKEND_BASE_URL}/api/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `伺服器錯誤 (${res.status})`);
    }
    return res.json();
  }
})();
