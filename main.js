// 在 main.js 中，找到並取代這個函式
async function loadServices() {
    try {
        // 指向我們在本機運行的後端伺服器 API
        const response = await fetch('http://127.0.0.1:5001/api/services');

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const services = await response.json();

        serviceOptions.innerHTML = ''; 

        services.forEach(service => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'service-button';
            button.textContent = service.name; // 從 API 來的名稱
            button.dataset.serviceId = service._id; // 從 API 來的 ID

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