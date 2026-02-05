(() => {
  // ====== 1. 設定與初始化 ======
  if (typeof CONFIG === 'undefined') {
    console.error('錯誤：找不到 config.js，請確保該檔案已正確引入。');
    alert('系統設定載入失敗，請稍後再試。');
    return;
  }

  const { BACKEND_BASE_URL, LIFF_ID } = CONFIG;

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
  
  // 預設營業時間
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
      // 隱藏所有畫面，只顯示指定的
      [welcomeScreen, bookingScreen, successScreen].forEach(el => {
          if (el) el.classList.add('hidden');
      });
      // 顯示目標畫面 (移除 hidden class)
      const target = document.getElementById(screenId);
      if (target) target.classList.remove('hidden');

      // 為了相容舊邏輯，若 CSS 用 display:none 控制，這裡補強一下
      [welcomeScreen, bookingScreen, successScreen].forEach(el => {
         if(el && !el.classList.contains('hidden')) el.style.display = 'block';
         else if(el) el.style.display = 'none';
      });
  }

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
        if (displayNameSpan) displayNameSpan.textContent = userProfile.displayName;
        setMinDate();
      }
    } catch (err) {
      console.error('LIFF Init failed', err);
      // 在開發環境若沒 LIFF，可以用假資料測試
      // alert('LINE 登入失敗'); 
    }
  }

  // ====== 4. 核心功能：預約相關 ======

  // (A) 載入服務列表 (更新為漂亮的 Service Chips)
  async function loadServices() {
    try {
      const res = await fetch(`${BACKEND_BASE_URL}/api/services`);
      if (!res.ok) throw new Error('無法讀取服務列表');
      allServices = await res.json();
      
      serviceOptionsContainer.innerHTML = '';
      if (allServices.length === 0) {
        serviceOptionsContainer.innerHTML = '<small>目前無可預約項目</small>';
        return;
      }

      allServices.forEach(svc => {
        // 建立外層 div (Service Chip)
        const chip = document.createElement('div');
        chip.className = 'service-chip'; // 對應新的 CSS
        chip.dataset.id = svc._id;
        
        // 內部結構：名稱與價格
        chip.innerHTML = `
            <div class="name">${escapeHtml(svc.name)}</div>
            <div class="price">$${svc.price}</div>
        `;

        // 點擊事件
        chip.addEventListener('click', () => {
          chip.classList.toggle('selected');
        });

        serviceOptionsContainer.appendChild(chip);
      });
    } catch (err) {
      console.error(err);
      serviceOptionsContainer.textContent = '載入服務失敗';
    }
  }

  // (B) 查詢忙碌時段
  async function fetchBusySlots(dateStr) {
      try {
          timeSlotSelect.innerHTML = '<option>查詢時段中...</option>';
          timeSlotSelect.disabled = true;

          const res = await fetch(`${BACKEND_BASE_URL}/api/slots/busy?date=${dateStr}`);
          const data = await res.json();
          const busySlots = data.busySlots || []; 

          renderTimeSlots(busySlots);
      } catch (err) {
          console.error('Fetch busy slots failed:', err);
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

    // 注意：這裡選擇器改成 .service-chip.selected
    const selectedChips = document.querySelectorAll('.service-chip.selected');
    const selectedIds = Array.from(selectedChips).map(chip => chip.dataset.id);
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
        showScreen('success-screen');
      } else {
        if (data.code === 'USER_NOT_REGISTERED') {
            alert('這是您第一次預約，請先填寫聯絡電話！');
            registerModal.classList.remove('hidden');
            checkUserRegistration(userProfile.userId); 
        } else {
            alert(`預約失敗：${data.error}`);
        }
      }
    } catch (err) {
      alert('伺服器連線錯誤，請稍後再試');
    }
  });

// 找到 loadMyBookings 函式，整段換成這個：
async function loadMyBookings() {
    if (!userProfile) return;
    
    // 先顯示載入中
    myBookingsList.innerHTML = '<p style="text-align:center;">讀取中...</p>';
    myBookingsModal.classList.remove('hidden');

    try {
        const res = await fetch(`${BACKEND_BASE_URL}/api/bookings/my?userId=${userProfile.userId}`);
        if (!res.ok) throw new Error('讀取失敗');
        
        const bookings = await res.json();
        
        // 如果沒有預約
        if (bookings.length === 0) {
            myBookingsList.innerHTML = '<p style="text-align:center;">您目前沒有預約紀錄。</p>';
            return;
        }

        // ★★★ 關鍵修改在這裡 ★★★
        // 這裡會產生有 "booking-card" class 的 HTML，CSS 才會生效變紫色
        myBookingsList.innerHTML = bookings.map(b => {
            // 1. 決定狀態顏色 (紫色系)
            let statusText = '待確認';
            let badgeClass = 'pending'; // 對應 CSS 的淺紫色標籤
            
            // 根據後端回傳的狀態文字做判斷 (請依據你資料庫實際存的值調整)
            if (b.status === 'confirmed' || b.status === '預約成功' || b.status === '成功') {
                statusText = '預約成功';
                badgeClass = 'confirmed'; // 對應 CSS 的深紫色標籤
            } else if (b.status === 'cancelled' || b.status === '已取消') {
                statusText = '已取消';
                badgeClass = 'cancelled';
            }

            // 2. 處理時間顯示 (讓它漂亮一點)
            let displayTime = `${b.date} ${b.time}`;
            if (b.finalStartAtLocal) {
                const d = new Date(b.finalStartAtLocal);
                // 格式：2026/02/06 13:00
                const dateStr = `${d.getFullYear()}/${(d.getMonth()+1).toString().padStart(2,'0')}/${d.getDate().toString().padStart(2,'0')}`;
                const timeStr = `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
                displayTime = `${dateStr} ${timeStr}`;
            }

            // 3. 回傳漂亮的卡片 HTML
            return `
              <div class="booking-card">
                <div class="booking-header">
                  <span class="booking-date">${displayTime}</span>
                  <span class="status-badge ${badgeClass}">${statusText}</span>
                </div>
                <div class="booking-detail">
                  項目：${b.serviceNames ? b.serviceNames.join('、') : '一般服務'}
                </div>
              </div>
            `;
        }).join('');

    } catch (err) {
        console.error(err);
        myBookingsList.innerHTML = '<p style="text-align:center; color:red;">讀取失敗，請稍後再試。</p>';
    }
}
  // ====== 6. 註冊與其他 Modal ======
  
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
    // 使用簡單的 HTML，CSS 會處理顏色
    const html = '<ul style="list-style: none; padding: 0;">' + allServices.map(svc =>
      `<li style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px dashed #ddd;">
         <span>${escapeHtml(svc.name)}</span>
         <span style="font-weight:bold;">$${svc.price}</span>
       </li>`
    ).join('') + '</ul>';
    modalPriceList.innerHTML = html;
    priceListModal.classList.remove('hidden');
  });

  // ====== 7. 事件綁定總覽 ======

  agreeButton.addEventListener('click', () => {
      showScreen('booking-screen');
      loadServices();
  });
  backToHomeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      showScreen('welcome-screen');
  });
  successHomeBtn.addEventListener('click', () => showScreen('welcome-screen'));
  
  checkMyBookingsBtn.addEventListener('click', loadMyBookings);
  successViewBookingsBtn.addEventListener('click', () => {
      loadMyBookings();
  });

  // 點擊 Modal 背景關閉
  [priceListModal, registerModal, myBookingsModal].forEach(modal => {
      modal.addEventListener('click', (e) => {
          if (e.target === modal) modal.classList.add('hidden');
      });
  });
  
  // 關閉按鈕
  closeModalButton.addEventListener('click', () => priceListModal.classList.add('hidden'));
  closeRegisterModal.addEventListener('click', () => registerModal.classList.add('hidden'));
  closeMyBookingsBtn.addEventListener('click', () => myBookingsModal.classList.add('hidden'));

  // 啟動
  initLiff();

})();