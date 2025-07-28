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
            // **【流程修正】**
            // 初始化成功後，我們不再檢查登入狀態，
            // 直接啟用「同意」按鈕，讓歡迎畫面成為固定的第一站。
            agreeButton.disabled = false;
        })
        .catch((err) => {
            console.error("LIFF Initialization failed.", err);
            alert("系統初始化失敗，錯誤訊息：" + JSON.stringify(err));
        });

    // 在按鈕可以被點擊前，先將它設為禁用狀態
    agreeButton.disabled = true;

    // 2. 為「同意」按鈕加上點擊事件
    agreeButton.addEventListener('click', function() {
        // 檢查是否已登入
        if (!liff.isLoggedIn()) {
            // 如果沒登入，就引導去登入。登入後會跳轉回來，並重新執行一次這整段 JS。
            // 屆時 isLoggedIn() 就會是 true。
            liff.login();
        } else {
            // 如果已經登入了，就直接執行下一步：取得資料並切換畫面
            showBookingScreen();
        }
    });

    // 3. 定義「取得資料並切換畫面」的函式
    function showBookingScreen() {
        // **【名字顯示修正】**
        // 我們先取得使用者名字，在成功取得後，才執行畫面切換。
        getUserProfile()
            .then(userName => {
                // 成功拿到名字後...
                // 1. 把名字填上去
                displayNameSpan.textContent = userName;
                // 2. 再切換畫面
                welcomeScreen.style.display = 'none';
                bookingScreen.style.display = 'block';
            })
            .catch(err => {
                // 如果拿不到名字，就報錯
                console.error('Error getting user profile:', err);
                alert('無法取得您的 LINE 資料，請稍後再試。');
            });
    }

    // 4. 將取得使用者名稱的邏輯，獨立成一個新的函式，讓程式碼更清晰
    function getUserProfile() {
        // 這個函式會回傳一個 Promise，裡面包含了使用者的名字
        return new Promise((resolve, reject) => {
            if (liff.isInClient()) {
                // 在 LINE App 內部，使用 getProfile
                liff.getProfile()
                    .then(profile => {
                        resolve(profile.displayName); // 成功時，回傳名字
                    })
                    .catch(err => {
                        reject(err); // 失敗時，回絕
                    });
            } else {
                // 在外部瀏覽器，使用 getDecodedIDToken
                const idToken = liff.getDecodedIDToken();
                if (idToken && idToken.name) {
                    resolve(idToken.name); // 成功時，回傳名字
                } else {
                    // 如果連 ID Token 都沒有，就回傳一個預設名字
                    resolve('顧客'); 
                }
            }
        });
    }
});