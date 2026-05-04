// --- 全局组件: Toast ---
function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerText = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

// --- 初始化 ---
document.addEventListener('DOMContentLoaded', () => {
    renderCopyright();
    showAuth();
});

function renderCopyright() {
    document.querySelectorAll('.copyright-text').forEach(el => {
        el.innerText = APP_COPYRIGHT;
    });
}

function showAuth() {
    document.getElementById('auth-container').classList.remove('hidden');
    document.getElementById('app').classList.add('hidden');
}

function showApp() {
    if (!currentUser) return;
    document.getElementById('auth-container').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    
    // 更新用户信息显示
    const userDisplay = document.getElementById('user-info') || document.getElementById('current-username');
    if (userDisplay) userDisplay.innerText = currentUser.nickname || currentUser.username;
    
    if (currentUser.role === 'admin') {
        const tag = document.getElementById('admin-tag');
        if (tag) tag.classList.remove('hidden');
        document.querySelectorAll('.admin-only').forEach(el => el.classList.remove('hidden'));
        const btn = document.getElementById('admin-panel-btn');
        if (btn) btn.classList.remove('hidden');
    }
    
    // 立即加载会话与模型列表
    loadSessions();
    loadModels();
}

// --- 全局图片预览 (支持聊天记录中点击放大) ---
window.closeImageViewer = () => {
    document.getElementById('image-viewer-modal').classList.add('hidden');
    document.getElementById('viewer-img').src = '';
};

// 使用事件委托，监听聊天区域内所有的图片点击
document.addEventListener('DOMContentLoaded', () => {
    const msgContainer = document.getElementById('message-container');
    if (msgContainer) {
        msgContainer.addEventListener('click', (e) => {
            if (e.target.tagName === 'IMG') {
                const viewer = document.getElementById('image-viewer-modal');
                const viewerImg = document.getElementById('viewer-img');
                viewerImg.src = e.target.src; // 获取被点击图片的真实地址
                viewer.classList.remove('hidden');
            }
        });
    }
});
