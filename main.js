(function() {
    document.addEventListener("DOMContentLoaded", function() {

        // --- DOM Elements ---
        const welcomeScreen = document.getElementById('welcome-screen');
        const bookingScreen = document.getElementById('booking-screen');
        const agreeButton = document.getElementById('agreeButton');
        const displayNameSpan = document.getElementById('displayName');
        const bookingForm = document.getElementById('booking-form');
        const datePicker = document.getElementById('date-picker');
        const serviceOptions = document.getElementById('service-options');

        const liffId = "2007825302-BWYw4PK5"; // 您的 LIFF ID

        // --- Main Logic ---
        main();

        async function main() {
            agreeButton.disabled = true;
            setupEventListeners();
            try {
                await liff.init({ liffId: liffId });
                if (liff.isLoggedIn()) {
                    await showBookingScreen();
                } else {
                    agreeButton.disabled = false;
                }
            } catch (err) {
                console.error("LIFF Initialization failed.", err);
                alert("系統初始化失敗，請稍後再試。");
            }
        }

        // --- Event Listeners ---
        function setupEventListeners() {
            agreeButton.addEventListener('click', () => {
                if (!liff.isLoggedIn()) {
                    // 【Agent 建議】明確指定 redirectUri，避免跳轉錯誤
                    liff.login({ redirectUri: window.location.href });
                } else {
                    showBookingScreen();
                }
            });

            bookingForm.addEventListener('submit', function(event) {
                event.preventDefault(); // 阻止表單預設送出行為
                alert("預約請求已送出！（此為前端測試訊息）");
                // TODO: 呼叫後端 API
            });
        }

        // --- Core Functions ---
        async function showBookingScreen() {
            try {
                const userName = await getUserProfile();
                displayNameSpan.textContent = userName;
                
                welcomeScreen.style.display = 'none';
                bookingScreen.style.display = 'block';

                // 【Agent 建議】載入頁面時，自動設定日期並載入服務項目
                initializeBookingForm();

            } catch (err) {
                console.error('Error in showBookingScreen:', err);
                alert('無法顯示預約畫面，請稍後再試。');
            }
        }

        // 【Agent 建議】簡化 getUserProfile 函式
        async function getUserProfile() {
            if (liff.isInClient()) {
                const profile = await liff.getProfile();
                return profile.displayName;
            }
            // 在外部瀏覽器，從 ID Token 拿名字，若拿不到則回傳 '顧客'
            return liff.getDecodedIDToken()?.name || '顧客';
        }

        function initializeBookingForm() {
            // 【Agent 建議】自動禁用今天以前的日期
            const today = new Date().toISOString().split('T')[0];
            datePicker.min = today;

            // 【Agent 建議】動態載入服務項目
            loadServices();
        }

        // 【Agent 建議】載入服務項目的非同步函式 (目前為模擬)
        async function loadServices() {
            try {
                // TODO: 未來這裡會換成真實的 API 呼叫: await fetch('/api/services');
                // --- 以下為模擬資料 ---
                await new Promise(resolve => setTimeout(resolve, 1000)); // 模擬網路延遲 1 秒
                const services = [
                    { id: 'cut', name: '精緻剪髮', price: 1000 },
                    { id: 'perm', name: '日系燙髮', price: 2500 },
                    { id: 'color', name: '質感染髮', price: 2800 },
                ];
                // --- 模擬資料結束 ---

                // 將 (服務項目載入中...) 的文字清空
                serviceOptions.innerHTML = ''; 
                
                // 將從 API 拿到的服務項目，一個個做成選項加到畫面上
                services.forEach(service => {
                    const div = document.createElement('div');
                    div.className = 'service-item';
                    div.innerHTML = `
                        <input type="checkbox" id="service-${service.id}" name="services" value="${service.id}">
                        <label for="service-${service.id}">${service.name} ($${service.price})</label>
                    `;
                    serviceOptions.appendChild(div);
                });

            } catch (err) {
                console.error('Failed to load services:', err);
                serviceOptions.innerHTML = '<small style="color: red;">服務項目載入失敗，請重新整理。</small>';
            }
        }
    });
})();