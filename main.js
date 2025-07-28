// 當整個網頁的 DOM 結構都載入完成後，再執行我們的程式碼
document.addEventListener("DOMContentLoaded", function() {

    // 找到我們要操作的 HTML 元素
    const welcomeScreen = document.getElementById('welcome-screen');
    const bookingScreen = document.getElementById('booking-screen');
    const agreeButton = document.getElementById('agreeButton');
    const displayNameSpan = document.getElementById('displayName');

    // 1. 初始化 LIFF (您的 LIFF ID 是正確的，保持不變)
    liff.init({ liffId: '2007825302-BWYw4PK5' })
        .then(() => {
            console.log("LIFF Initialization succeeded.");
            if (liff.isLoggedIn()) {
                showBookingScreen();
            } else {
                agreeButton.disabled = false;
            }
        })
        .catch((err) => {
            console.error("LIFF Initialization failed.", err);
            alert("系統初始化失敗，錯誤訊息：" + JSON.stringify(err));
        });

    // 在按鈕可以被點擊前，先將它設為禁用狀態
    agreeButton.disabled = true;

    // 2. 為「同意」按鈕加上點擊事件
    agreeButton.addEventListener('click', function() {
        // 我們移除 redirectUri 參數，讓 LIFF SDK 自動處理，避免網址不一致問題
        liff.login(); 
    });

    // 3. 定義「取得資料並切換畫面」的函式 (整合 Agent 建議的最終版)
    function showBookingScreen() {
        let userName = '顧客'; // 預設名字

        // **【新流程核心】**
        // 先用 liff.isInClient() 判斷是不是在 LINE App 內部
        if (liff.isInClient()) {
            // **情況一：在 LINE App 內部**
            // 我們可以安全地呼叫 liff.getProfile()
            liff.getProfile()
                .then(profile => {
                    userName = profile.displayName;
                    displayNameSpan.textContent = userName;
                    switchToBookingView();
                })
                .catch((err) => {
                    console.error("Failed to get profile.", err);
                    alert("無法取得您的 LINE 資料，請確認授權後再試。");
                });
        } else {
            // **情況二：在外部瀏覽器 (電腦 Chrome, 手機 Safari 等)**
            // 我們不能用 getProfile()，但可以退而求其次，用 getDecodedIDToken()
            // 它一樣能拿到客人的名字，而且在外部瀏覽器中也能運作
            const idToken = liff.getDecodedIDToken();
            if (idToken && idToken.name) {
                userName = idToken.name; // 從 ID Token 中取得名字
            }
            displayNameSpan.textContent = userName;
            switchToBookingView();
        }
    }

    // 將畫面切換的動作獨立成一個函式，方便共用
    function switchToBookingView() {
        welcomeScreen.style.display = 'none';
        bookingScreen.style.display = 'block';
    }
});