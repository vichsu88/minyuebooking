(() => {
  // ====== 1. 設定與初始化 ======
  if (typeof CONFIG === 'undefined') {
    console.error('錯誤：找不到 config.js，請確保該檔案已正確引入。');
    alert('系統設定載入失敗，請稍後再試。');
    return;
  }

  const { BACKEND_BASE_URL, LIFF_ID, OA_ADD_FRIEND_URL } = CONFIG;

  // --- DOM 元素 ---
  // 畫面容器
  const welcomeScreen = document.getElementById('welcome-screen');
  const bookingScreen = document.getElementById('booking-screen');
  const successScreen = document.getElementById('success-screen');

  // 按鈕
  const agreeButton = document.getElementById('agreeButton');
  const checkMyBookingsBtn = document.getElementById('checkMyBookingsBtn');
  const backToHomeBtn = document.getElementById('backToHomeBtn');
  const successViewBookingsBtn = document.getElementById('successViewBookingsBtn');
  const successHomeBtn = document.getElementById('successHomeBtn');

  // 表單與輸入框
  const bookingForm = document.getElementById('booking-form');
  const datePicker = document.getElementById('date-picker');
  const timeSlotSelect = document.getElementById('time-slot');
  const serviceOptionsContainer = document.getElementById('service-options');
  const displayNameSpan = document.getElementById('displayName');

  // Modals
  const priceListButton = document.getElementById('priceListButton');
  const priceListModal = document.getElementById('price-list-modal');
  const closeModalButton = document.getElementById('closeModalButton');
  const modalPriceList = document.getElementById('modal-price-list');
  
  const registerModal = document.getElementById('register-modal');
  const closeRegisterModal = document.getElementById('closeRegisterModal');
  const registerForm = document.getElementById('register-form');
  const regPhoneInput = document.getElementById('reg-phone');
  const regBirthdayInput = document.getElementById('reg-birthday');

  // 我的預約 Modal
  const myBookingsModal = document.getElementById('my-bookings-modal');
  const closeMyBookingsBtn = document.getElementById('closeMyBookingsBtn');
  const myBookingsList = document.getElementById('my-bookings-list');

  // 狀態變數
  let userProfile = null; // LINE Profile
  let allServices = [];   // 服務列表
  
  // 預設營業時間 (可依需求調整)
  const BUSINESS_HOURS = [
      "09:00", "10:00", "11:00", "12:00", 
      "13:00", "14:00", "15:00", "16:00", 
      "17:00", "18:00", "19:00"
  ];

  // ====== 2. 工具函式 ======
  function escapeHtml(text) {
    if (!text) return text;
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function showScreen(screenId) {
      [welcomeScreen, bookingScreen, successScreen].forEach(el => el.style.display = 'none');
      document.getElementById(screenId).style.display = 'block';
  }

  // 設定日期選擇器的最小值為今天
  function setMinDate() {
      const today = new Date();
      const yyyy = today.getFullYear();
      const mm = String(today.getMonth() + 1).padStart(2, '0');
      const dd = String(today.getDate()).padStart(2, '0');
      datePicker.min = `${yyyy}-${mm}-${dd}`;
  }

  // ====== 3. LIFF 初始化 ======
  async function initLiff() {
    try {
      await liff.init({ liffId: LIFF_ID });
      if (!liff.isLoggedIn()) {
        liff.login();
      } else {
        userProfile = await liff.getProfile();
        alert("您的 ID 是：" + userProfile.userId);
        if (displayNameSpan) displayNameSpan.textContent = userProfile.displayName;
        setMinDate();
      }
    } catch (err) {
      console.error('LIFF Init failed', err);
      alert('LINE 登入失敗，請檢查網路設定');
    }
  }

  // ====== 4. 核心功能：預約相關 ======

  // (A) 載入服務列表
  async function loadServices() {
    try {
      const res = await fetch(`${BACKEND_BASE_URL}/api/services`);
      if (!res.ok) throw new Error('無法讀取服務列表');
      allServices = await res.json();
      
      serviceOptionsContainer.innerHTML = '';
      if (allServices.length === 0) {
        serviceOptionsContainer.textContent = '目前無可預約項目';
        return;
      }

      allServices.forEach(svc => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'service-button';
        btn.dataset.id = svc._id;
        btn.textContent = `${svc.name} ($${svc.price})`;
        btn.addEventListener('click', () => {
          btn.classList.toggle('selected');
        });
        serviceOptionsContainer.appendChild(btn);
      });
    } catch (err) {
      console.error(err);
      serviceOptionsContainer.textContent = '載入服務失敗';
    }
  }

  // (B) 查詢 Google Calendar 忙碌時段
  async function fetchBusySlots(dateStr) {
      try {
          // 顯示載入中
          timeSlotSelect.innerHTML = '<option>查詢時段中...</option>';
          timeSlotSelect.disabled = true;

          const res = await fetch(`${BACKEND_BASE_URL}/api/slots/busy?date=${dateStr}`);
          const data = await res.json();
          const busySlots = data.busySlots || []; // 例如 ["14:00", "15:00"]

          renderTimeSlots(busySlots);
      } catch (err) {
          console.error('Fetch busy slots failed:', err);
          // 若失敗，則不鎖定，僅顯示預設時段
          renderTimeSlots([]);
      } finally {
          timeSlotSelect.disabled = false;
      }
  }

  function renderTimeSlots(busySlots) {
      timeSlotSelect.innerHTML = '<option value="" disabled selected>請選擇時段</option>';
      
      BUSINESS_HOURS.forEach(time => {
          const option = document.createElement('option');
          option.value = time;
          
          if (busySlots.includes(time)) {
              option.textContent = `${time} (已額滿)`;
              option.disabled = true;
          } else {
              option.textContent = time;
          }
          timeSlotSelect.appendChild(option);
      });
  }

  // 監聽日期變更
  datePicker.addEventListener('change', (e) => {
      const dateVal = e.target.value;
      if (dateVal) {
          fetchBusySlots(dateVal);
      }
  });

  // (C) 送出預約
  bookingForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!userProfile) return alert('請先登入 LINE');

    const selectedBtns = document.querySelectorAll('.service-button.selected');
    const selectedIds = Array.from(selectedBtns).map(btn => btn.dataset.id);
    const dateVal = datePicker.value;
    const timeVal = timeSlotSelect.value;

    if (!dateVal || !timeVal) return alert('請完整選擇日期與時段');
    if (selectedIds.length === 0) return alert('請至少選擇一個服務項目');

    const payload = {
      userProfile: {
        userId: userProfile.userId,
        displayName: userProfile.displayName,
        pictureUrl: userProfile.pictureUrl
      },
      date: dateVal,
      time: timeVal,
      serviceIds: selectedIds
    };

    try {
      const res = await fetch(`${BACKEND_BASE_URL}/api/bookings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();

      if (res.ok) {
        // 成功 -> 切換到成功畫面
        showScreen('success-screen');
      } else {
        // 失敗處理
        if (data.code === 'USER_NOT_REGISTERED') {
            // 強制註冊流程
            alert('這是您第一次預約，請先填寫聯絡電話以便確認！');
            registerModal.classList.remove('hidden');
            // 嘗試預填
            checkUserRegistration(userProfile.userId); 
        } else {
            alert(`預約失敗：${data.error}`);
        }
      }
    } catch (err) {
      alert('伺服器連線錯誤，請稍後再試');
    }
  });

  // ====== 5. 查詢我的預約 ======
  async function loadMyBookings() {
      if (!userProfile) return;
      
      myBookingsList.innerHTML = '<p style="text-align:center;">讀取中...</p>';
      myBookingsModal.classList.remove('hidden');

      try {
          const res = await fetch(`${BACKEND_BASE_URL}/api/bookings/my?userId=${userProfile.userId}`);
          if (!res.ok) throw new Error('讀取失敗');
          
          const bookings = await res.json();
          if (bookings.length === 0) {
              myBookingsList.innerHTML = '<p style="text-align:center;">您目前沒有預約紀錄。</p>';
              return;
          }

          myBookingsList.innerHTML = bookings.map(b => {
              // 狀態文字轉換
              let statusText = '待確認';
              let badgeClass = 'badge-pending';
              let cardClass = 'status-pending';

              if (b.status === 'confirmed') {
                  statusText = '預約成功';
                  badgeClass = 'badge-confirmed';
                  cardClass = 'status-confirmed';
              } else if (b.status === 'cancelled') {
                  statusText = '已取消/婉拒';
                  badgeClass = 'badge-cancelled';
                  cardClass = 'status-cancelled';
              }

              const displayTime = b.finalStartAtLocal 
                  ? new Date(b.finalStartAtLocal).toLocaleString('zh-TW', {hour12:false}).slice(0, -3)
                  : `${b.date} ${b.time}`;

              return `
                <div class="booking-card ${cardClass}">
                  <span class="status-badge ${badgeClass}">${statusText}</span>
                  <div style="font-weight:bold; font-size:1.1rem; margin:5px 0;">
                    ${displayTime}
                  </div>
                  <div style="color:#555; font-size:0.9rem;">
                    項目：${b.serviceNames ? b.serviceNames.join('、') : '一般服務'}
                  </div>
                </div>
              `;
          }).join('');

      } catch (err) {
          myBookingsList.innerHTML = '<p style="text-align:center; color:red;">讀取失敗，請稍後再試。</p>';
      }
  }

  // ====== 6. 註冊與其他 Modal ======
  
  // 檢查使用者資料 (用於預填)
  async function checkUserRegistration(userId) {
    try {
      const res = await fetch(`${BACKEND_BASE_URL}/api/users/check?userId=${userId}`);
      const data = await res.json();
      if (res.ok && data.user) {
         if (data.user.phone) regPhoneInput.value = data.user.phone;
         if (data.user.birthday) regBirthdayInput.value = data.user.birthday;
      }
    } catch (e) { /* ignore */ }
  }

  // 註冊表單送出
  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const phone = regPhoneInput.value.trim();
    const birthday = regBirthdayInput.value;
    
    if (!phone.match(/^09\d{8}$/)) return alert('請輸入正確的手機號碼 (09xxxxxxxx)');
    
    try {
      const payload = {
          userId: userProfile.userId,
          displayName: userProfile.displayName,
          pictureUrl: userProfile.pictureUrl,
          phone: phone,
          birthday: birthday
      };
      const res = await fetch(`${BACKEND_BASE_URL}/api/users`, {
          method: 'PUT',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error('註冊失敗');
      
      alert('資料已更新，請再次點擊「送出預約」！');
      registerModal.classList.add('hidden');
    } catch (err) {
      alert(`錯誤: ${err.message}`);
    }
  });

  // 價目表 Modal
  priceListButton.addEventListener('click', () => {
    const html = '<ul>' + allServices.map(svc =>
      `<li><span>${escapeHtml(svc.name)}</span><span>$${svc.price}</span></li>`
    ).join('') + '</ul>';
    modalPriceList.innerHTML = html;
    priceListModal.classList.remove('hidden');
  });

  // ====== 7. 事件綁定總覽 ======

  // 按鈕切換頁面
  agreeButton.addEventListener('click', () => {
      showScreen('booking-screen');
      loadServices(); // 進入頁面才讀取服務
  });
  backToHomeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      showScreen('welcome-screen');
  });
  successHomeBtn.addEventListener('click', () => showScreen('welcome-screen'));
  
  // 我的預約相關
  checkMyBookingsBtn.addEventListener('click', loadMyBookings);
  successViewBookingsBtn.addEventListener('click', () => {
      // 這裡如果直接跳 Modal 體驗較好，不用換頁
      loadMyBookings();
  });

  // 關閉 Modal 通用邏輯
  [priceListModal, registerModal, myBookingsModal].forEach(modal => {
      modal.addEventListener('click', (e) => {
          if (e.target === modal) modal.classList.add('hidden');
      });
  });
  closeModalButton.addEventListener('click', () => priceListModal.classList.add('hidden'));
  closeRegisterModal.addEventListener('click', () => registerModal.classList.add('hidden'));
  closeMyBookingsBtn.addEventListener('click', () => myBookingsModal.classList.add('hidden'));

  // 啟動
  initLiff();

})();