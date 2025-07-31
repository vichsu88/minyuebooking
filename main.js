(function() {
    document.addEventListener("DOMContentLoaded", function() {

        const welcomeScreen = document.getElementById('welcome-screen');
        const bookingScreen = document.getElementById('booking-screen');
        const agreeButton = document.getElementById('agreeButton');
        const displayNameSpan = document.getElementById('displayName');
        const bookingForm = document.getElementById('booking-form');
        const datePicker = document.getElementById('date-picker');
        const serviceOptions = document.getElementById('service-options');

        const liffId = "2007825302-BWYw4PK5";

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
                const selectedButtons = serviceOptions.querySelectorAll('.service-button.selected');
                if (selectedButtons.length === 0) {
                    alert('請至少選擇一個預約項目！');
                    return;
                }
                const selectedServices = Array.from(selectedButtons).map(button => button.textContent);
                alert("您選擇的服務是：" + selectedServices.join(', ') + "。（此為前端測試訊息）");
                // TODO: 呼叫後端 API
            });
        }

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

        // **【最終修正】**
        // 將 loadServices 函式修改為呼叫您部署在 Render 上的雲端後端 API
        // 並且恢復成我們之前做好的「服務按鈕」
        async function loadServices() {
            try {
                // 請將 'https://your-backend-api.onrender.com' 換成您後端服務的真實 Render 網址
                const response = await fetch('https://minyue-api.onrender.com/');
                
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }

                const services = await response.json();

                serviceOptions.innerHTML = ''; 
                
                services.forEach(service => {
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.className = 'service-button';
                    button.textContent = service.name;
                    button.dataset.serviceId = service._id;

                    button.addEventListener('click', () => {
                        button.classList.toggle('selected');
                    });

                    serviceOptions.appendChild(button);
                });

            } catch (err) {
                console.error('Failed to load services:', err);
                serviceOptions.innerHTML = '<small style="color: red;">服務項目載入失敗，請確認後端伺服器是否已啟動。</small>';
            }
        }
    });
})();