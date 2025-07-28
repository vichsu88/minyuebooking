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
                    liff.login();
                } else {
                    showBookingScreen();
                }
            });

            bookingForm.addEventListener('submit', function(event) {
                event.preventDefault(); 
                
                // 找出所有被選取的按鈕
                const selectedButtons = serviceOptions.querySelectorAll('.service-button.selected');
                const selectedServices = Array.from(selectedButtons).map(button => button.textContent);

                alert("您選擇的服務是：" + selectedServices.join(', ') + "。（此為前端測試訊息）");
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
                // TODO: 未來這裡會換成真實的 API 呼叫
                // --- 使用您提供的價目表作為模擬資料 ---
                await new Promise(resolve => setTimeout(resolve, 500)); // 模擬網路延遲
                const services = [
                    { id: 'wash-basic', name: '基礎洗髮' },
                    { id: 'spa-scalp', name: '頭皮SPA' },
                    { id: 'wash-oil', name: '精油洗' },
                    { id: 'cut', name: '剪髮' },
                    { id: 'hair-care', name: '護髮' },
                    { id: 'perm', name: '燙髮' },
                    { id: 'perm-cold', name: '日系冷塑燙' },
                    { id: 'perm-hot', name: '日系光感熱塑燙' },
                    { id: 'perm-ion', name: '日系光感離子燙' },
                    { id: 'dye', name: '染髮' },
                ];
                // --- 模擬資料結束 ---

                serviceOptions.innerHTML = ''; 
                
                // **【新功能核心】**
                // 將服務項目，一個個做成「按鈕」加到畫面上
                services.forEach(service => {
                    const button = document.createElement('button');
                    button.type = 'button'; // 確保按鈕不會觸發 form 提交
                    button.className = 'service-button';
                    button.textContent = service.name; // 只顯示名稱
                    button.dataset.serviceId = service.id; // 將 id 存在 data-* 屬性中

                    // 為每個按鈕加上點擊事件，用來切換「選取」狀態
                    button.addEventListener('click', () => {
                        button.classList.toggle('selected');
                    });

                    serviceOptions.appendChild(button);
                });

            } catch (err) {
                console.error('Failed to load services:', err);
                serviceOptions.innerHTML = '<small style="color: red;">服務項目載入失敗，請重新整理。</small>';
            }
        }
    });
})();