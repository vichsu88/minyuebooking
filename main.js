// 當整個網頁的 DOM 結構都載入完成後，再執行我們的程式碼
document.addEventListener("DOMContentLoaded", function() {

    // 找到我們要操作的 HTML 元素
    const welcomeScreen = document.getElementById('welcome-screen');
    const bookingScreen = document.getElementById('booking-screen');
    const agreeButton = document.getElementById('agreeButton');
    const displayNameSpan = document.getElementById('displayName');

    // 1. 初始化 LIFF
    // 請記得將 'YOUR_LIFF_ID' 換成您真實的 LIFF ID
    liff.init({ liffId: '2007825302' })
        .then(() => {
            console.log("LIFF Initialization succeeded.");
            // 初始化成功後，就可以讓「同意」按鈕可以被點擊了
            agreeButton.disabled = false;
        })
        .catch((err) => {
            console.error("LIFF Initialization failed.", err);
            alert("系統初始化失敗，請稍後再試。");
        });
    
    // 在按鈕可以被點擊前，先將它設為禁用狀態，避免使用者在 LIFF 初始化完成前點擊
    agreeButton.disabled = true;

    // 2. 為「同意」按鈕加上點擊事件
    agreeButton.addEventListener('click', function() {
        // 檢查使用者是否已經登入 LINE
        if (!liff.isLoggedIn()) {
            // 如果沒登入，就呼叫 liff.login() 進行登入並請求授權
            // 這個動作會跳轉到 LINE 的授權畫面，完成後會自動跳轉回「同一個頁面」
            // 屆時，這整段 JavaScript 會重新執行一次，但 liff.isLoggedIn() 就會是 true 了
            liff.login();
        } else {
            // 如果已經登入了，就直接執行下一步：取得使用者資料並切換畫面
            showBookingScreen();
        }
    });

    // 3. 定義「取得資料並切換畫面」的函式
    function showBookingScreen() {
        // 呼叫 liff.getProfile() 來取得使用者的公開資料
        liff.getProfile()
            .then(profile => {
                // 成功取得資料後...

                // 將客人的名字填入到畫面的 <span> 元素中
                displayNameSpan.textContent = profile.displayName;

                // 執行畫面切換：隱藏歡迎畫面，顯示預約畫面
                welcomeScreen.style.display = 'none';
                bookingScreen.style.display = 'block';

                // 在這裡，我們未來還可以加上「載入服務項目」等其他功能
            })
            .catch((err) => {
                // 如果出錯，顯示錯誤訊息
                console.error("Failed to get profile.", err);
                alert("無法取得您的 LINE 資料，請確認授權後再試。");
            });
    }
});