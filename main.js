(() => {
  // ====== 1. 修改處：從 config.js 讀取設定 ======
  // 檢查 CONFIG 是否存在
  if (typeof CONFIG === 'undefined') {
    console.error('錯誤：找不到 config.js，請確保該檔案已正確引入。');
    alert('系統設定載入失敗，請稍後再試。');
    return;
  }

  const { BACKEND_BASE_URL, LIFF_ID, OA_ADD_FRIEND_URL, OA_BASIC_ID } = CONFIG;

  // --- DOM 元素 ---
  const welcomeScreen = document.getElementById('welcome-screen');
  const bookingScreen = document.getElementById('booking-screen');
  const agreeButton = document.getElementById('agreeButton');
  const displayNameSpan = document.getElementById('displayName');
  const bookingForm = document.getElementById('booking-form');
  const datePicker = document.getElementById('date-picker');
  const serviceOptionsContainer = document.getElementById('service-options');

  // Modal 相關 DOM
  const priceListButton = document.getElementById('priceListButton');
  const priceListModal = document.getElementById('price-list-modal');
  const closeModalButton = document.getElementById('closeModalButton');
  const modalPriceList = document.getElementById('modal-price-list');
  
  const registerModal = document.getElementById('register-modal');
  const closeRegisterModal = document.getElementById('closeRegisterModal');
  const registerForm = document.getElementById('register-form');
  const regPhoneInput = document.getElementById('reg-phone');
  const regBirthdayInput = document.getElementById('reg-birthday');

  // 狀態變數
  let userProfile = null; // LINE Profile
  let idToken = null;     // LINE ID Token
  let allServices = [];   // 儲存後端抓回來的服務列表

  // ====== 2. 修改處：新增安全過濾函式 (XSS 防護) ======
  function escapeHtml(text) {
    if (!text) return text;
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // --- 初始化 LIFF ---
  async function initLiff() {
    try {
      await liff.init({ liffId: LIFF_ID });
      if (!liff.isLoggedIn()) {
        liff.login();
      } else {
        // 取得使用者資料
        userProfile = await liff.getProfile();
        idToken = liff.getIDToken();
        displayNameSpan.textContent = userProfile.displayName;

        // 檢查是否為新客 (後端 API)
        checkUserRegistration(userProfile.userId);
      }
    } catch (err) {
      console.error('LIFF Initialization failed', err);
      alert('LINE 登入失敗，請檢查網路或 LIFF 設定');
    }
  }

  // --- 檢查使用者是否已註冊 (有沒有電話/生日) ---
  async function checkUserRegistration(userId) {
    try {
      const res = await fetch(`${BACKEND_BASE_URL}/api/users/check?userId=${userId}`);
      const data = await res.json();
      if (res.ok) {
        if (!data.registered) {
           // 沒註冊 -> 跳出註冊 Modal
           registerModal.classList.remove('hidden');
           // 預填生日如果有的話
           if (data.user && data.user.birthday) {
             regBirthdayInput.value = data.user.birthday;
           }
           if (data.user && data.user.phone) {
             regPhoneInput.value = data.user.phone;
           }
        }
      }
    } catch (err) {
      console.error('Check user error:', err);
    }
  }

  // --- 載入服務項目 ---
  async function loadServices() {
    try {
      const res = await fetch(`${BACKEND_BASE_URL}/api/services`);
      if (!res.ok) throw new Error('無法讀取服務列表');
      allServices = await res.json();
      
      // 渲染 "預約表單" 的選項 (使用 textContent 安全插入)
      serviceOptionsContainer.innerHTML = '';
      if (allServices.length === 0) {
        serviceOptionsContainer.textContent = '目前無可預約項目';
        return;
      }

      allServices.forEach(svc => {
        // 建立按鈕
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'service-button';
        btn.dataset.id = svc._id;
        // 顯示名稱與價格
        btn.textContent = `${svc.name} ($${svc.price})`;

        // 點擊事件
        btn.addEventListener('click', () => {
          btn.classList.toggle('selected');
          // 無障礙屬性更新
          btn.setAttribute('aria-pressed', btn.classList.contains('selected'));
        });

        serviceOptionsContainer.appendChild(btn);
      });

    } catch (err) {
      console.error(err);
      serviceOptionsContainer.textContent = '載入服務失敗';
    }
  }

  // --- 顯示價目表 (Modal) ---
  priceListButton.addEventListener('click', () => {
    // ====== 3. 修改處：使用 escapeHtml 進行渲染 ======
    const priceListHtml = '<ul>' + allServices.map(svc =>
      `<li>
         <span>${escapeHtml(svc.name)}</span>
         <span>$${Number(svc.price || 0).toLocaleString()}</span>
       </li>`
    ).join('') + '</ul>';
    
    modalPriceList.innerHTML = priceListHtml;
    priceListModal.classList.remove('hidden');
  });

  // 關閉 Modal
  closeModalButton.addEventListener('click', () => {
    priceListModal.classList.add('hidden');
  });
  priceListModal.addEventListener('click', (e) => {
    if (e.target === priceListModal) priceListModal.classList.add('hidden');
  });

  // --- 註冊 (補填資料) ---
  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const phone = regPhoneInput.value.trim();
    const birthday = regBirthdayInput.value;
    
    if (!phone.match(/^09\d{8}$/)) {
        alert('請輸入正確的手機號碼 (09xxxxxxxx)');
        return;
    }
    
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
      
      alert('資料已更新！');
      registerModal.classList.add('hidden');
    } catch (err) {
      alert(`錯誤: ${err.message}`);
    }
  });
  
  closeRegisterModal.addEventListener('click', () => {
      // 這裡策略可自行決定：強迫填寫就不讓關閉，或者允許關閉但無法預約
      registerModal.classList.add('hidden');
  });


  // --- 流程控制: 歡迎頁 -> 預約頁 ---
  agreeButton.addEventListener('click', () => {
    welcomeScreen.style.display = 'none';
    bookingScreen.style.display = 'block';
    // 切換到預約頁時，才載入服務
    loadServices();
  });

  // --- 送出預約 ---
  bookingForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (!userProfile) {
      alert('尚未取得 LINE 使用者資料，無法預約');
      return;
    }

    // 收集選取的服務
    const selectedBtns = document.querySelectorAll('.service-button.selected');
    const selectedIds = Array.from(selectedBtns).map(btn => btn.dataset.id);

    if (selectedIds.length === 0) {
      alert('請至少選擇一個服務項目');
      return;
    }

    const dateVal = datePicker.value;
    const timeVal = document.getElementById('time-slot').value;

    if (!dateVal || !timeVal) {
      alert('請選擇日期與時段');
      return;
    }

    // 組裝 Payload
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
        alert('預約申請已送出！\n請加入官方帳號確認最終時間。');
        // 引導加好友 (可選)
        window.location.href = OA_ADD_FRIEND_URL;
        liff.closeWindow();
      } else {
        alert(`預約失敗：${data.error || '未知錯誤'}`);
      }
    } catch (err) {
      console.error(err);
      alert('網路錯誤或伺服器無回應');
    }
  });

  // 啟動
  initLiff();

})();