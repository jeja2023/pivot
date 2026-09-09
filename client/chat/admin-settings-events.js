/* 设置工作区延迟事件注册 */

(function installAdminSettingsEvents() {
    let registerEvents = null;
    let boundRoot = null;

    function bindAdminSettingsEvents() {
        const root = document.getElementById('admin-container');
        if (!root || !registerEvents || boundRoot === root) return Boolean(root && boundRoot === root);
        registerEvents();
        boundRoot = root;
        return true;
    }

    function registerAdminSettingsEvents(callback) {
        registerEvents = typeof callback === 'function' ? callback : null;
        return bindAdminSettingsEvents();
    }

    window.Pivot?.exposeModule?.('settings.events', {
        bindAdminSettingsEvents,
        registerAdminSettingsEvents
    });
}());
