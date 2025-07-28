// 【Agent 建議】使用 IIFE (立即執行函式) 包裹程式碼，避免污染全域變數
(function() {
    // 當整個網頁的 DOM 結構都載入完成後，再執行我們的程式碼
    document.addEventListener("DOMContentLoaded", function() {

        // 宣告所有會用到的 HTML 元素
        const welcomeScreen = document.getElementById('welcome-screen');
        const bookingScreen = document.getElementById('booking-screen');
        const agreeButton = document.getElementById('agreeButton');
        const displayNameSpan = document.getElementById('displayName');
        const bookingForm = document.getElementById('booking-form');
        const datePicker = document.getElementById('date-picker');
        const serviceOptions = document.getElementById('service-options');

        const liffId = "2007825302-BWYw4PK5"; // 您的 LIFF ID

        // 主程式進入點
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
                    // **【最終修正】**
                    // 移除 redirectUri 參數，恢復到我們之前能成功運作的版本
                    liff.login();
                } else {
                    showBookingScreen();
                }
            });

            bookingForm.addEventListener('submit', function(event) {
                event.preventDefault(); 
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

                initializeBookingForm();

            } catch (err) {
                console.error('Error in showBookingScreen:', err);
                alert('無法顯示預約畫面，請稍後再試。');
            }
        }

        async function getUserProfile() {
            if (liff.isInClient()) {
                const profile = await liff.getProfile();
                return profile.displayName;
            }
            return liff.getDecodedIDToken()?.name || '顧客';
        }

        function initializeBookingForm() {
            const today = new Date().toISOString().split('T')[0];
            datePicker.min = today;
            loadServices();
        }

        async function loadServices() {
            try {
                await new Promise(resolve => setTimeout(resolve, 1000)); 
                const services = [
                    { id: 'cut', name: '精緻剪髮', price: 1000 },
                    { id: 'perm', name: '日系燙髮', price: 2500 },
                    { id: 'color', name: '質感染髮', price: 2800 },
                ];
                
                serviceOptions.innerHTML = ''; 
                
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