(() => {
    const current = document.currentScript;
    const version = current?.src?.includes('?') ? current.src.slice(current.src.indexOf('?')) : '';
    const createScript = (src) => {
        const script = document.createElement('script');
        script.src = src + version;
        script.async = false;
        script.defer = false;
        return script;
    };
    const dialogs = createScript('/chat/app/dialogs.js');
    const main = createScript('/chat/app/main.js');
    const attachMain = () => {
        if (!main.isConnected) dialogs.after(main);
    };
    dialogs.addEventListener('load', attachMain);
    dialogs.addEventListener('error', attachMain);
    current?.after(dialogs);
})();
