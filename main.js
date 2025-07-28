// 當整個網頁的 DOM 結構都載入完成後，再執行我們的程式碼
document.addEventListener("DOMContentLoaded", function() {

    // 找到我們要操作的 HTML 元素
    const welcomeScreen = document.getElementById('welcome-screen');
    const bookingScreen = document.getElementById('booking-screen');
    const agreeButton = document.getElementById('agreeButton');
    const displayNameSpan = document.getElementById('displayName');

    // 1. 初始化 LIFF
    // 這裡的 LIFF ID 保持不變，繼續用您設定好的那一個
    liff.init({ liffId: '2007825302-BWYw4PK5' })
        .then(() => {
            console.log("LIFF Initialization succeeded.");

            // **【新流程核心】**
            // 初始化成功後，立刻檢查使用者是否已經登入
            if (liff.isLoggedIn()) {
                // 如果已經登入，代表使用者已經授權過了 (可能是剛授權完跳轉回來)
                // 我們直接執行下一步：取得使用者資料並切換畫面
                showBookingScreen();
            } else {
                // 如果還沒登入，代表這是使用者第一次打開
                // 我們什麼都不用做，就停留在歡迎畫面，並啟用按鈕讓他點擊
                agreeButton.disabled = false;
            }
        })
        .catch((err) => {
            console.error("LIFF Initialization failed.", err);
            // 為了方便除錯，我們把詳細錯誤印出來看看
            alert("系統初始化失敗，錯誤訊息：" + JSON.stringify(err));
        });

    // 2. 為「同意」按鈕加上點擊事件
    agreeButton.addEventListener('click', function() {
        // 這個按鈕現在只有一個功能：在使用者未登入時，引導他去登入
        liff.login();
    });

    // 3. 定義「取得資料並切換畫面」的函式 (這部分不變)
    function showBookingScreen() {
        liff.getProfile()
            .then(profile => {
                displayNameSpan.textContent = profile.displayName;
                welcomeScreen.style.display = 'none';
                bookingScreen.style.display = 'block';
            })
            .catch((err) => {
                console.error("Failed to get profile.", err);
                alert("無法取得您的 LINE 資料，請確認授權後再試。");
            });
    }
});