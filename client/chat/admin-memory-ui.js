/* 拆自 admin-settings.js：长期记忆浮层提示与全局弹窗挂载辅助 */
(function() {
    let memoryTooltipEl = null;

    function getMemoryTooltip() {
        if (!memoryTooltipEl) {
            memoryTooltipEl = document.createElement('div');
            memoryTooltipEl.id = 'memory-cell-custom-tooltip';
            memoryTooltipEl.className = 'memory-custom-tooltip hidden';
            memoryTooltipEl.setAttribute('role', 'tooltip');
            document.body.appendChild(memoryTooltipEl);

            memoryTooltipEl.addEventListener('mouseenter', () => {
                memoryTooltipEl.classList.remove('hidden');
            });
            memoryTooltipEl.addEventListener('mouseleave', () => {
                memoryTooltipEl.classList.add('hidden');
            });
        }
        return memoryTooltipEl;
    }

    function ensureMemoryModalsAttached() {
        const editModal = document.getElementById('memory-edit-modal');
        const sourceModal = document.getElementById('memory-source-modal');
        if (editModal && editModal.parentElement !== document.body) {
            document.body.appendChild(editModal);
        }
        if (sourceModal && sourceModal.parentElement !== document.body) {
            document.body.appendChild(sourceModal);
        }
    }

    function initMemoryContentTooltips() {
        const tableBody = document.getElementById('memory-list-body');
        if (!tableBody || tableBody.__tooltipBound) return;
        tableBody.__tooltipBound = true;

        let hideTimer = null;

        tableBody.addEventListener('mouseover', (e) => {
            const cell = e.target.closest('.memory-content-cell');
            if (!cell) return;
            clearTimeout(hideTimer);
            const text = cell.getAttribute('data-full-content') || cell.textContent.trim();
            if (!text) return;

            const tooltip = getMemoryTooltip();
            if (window.Pivot.legacy.PivotSafeHtml?.setText) {
                window.Pivot.legacy.PivotSafeHtml.setText(tooltip, text);
            } else {
                tooltip.textContent = text;
            }
            tooltip.classList.remove('hidden');

            const rect = cell.getBoundingClientRect();
            const tooltipWidth = Math.min(560, Math.max(260, text.length * 10));
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;

            let left = rect.left;
            if (left + tooltipWidth > viewportWidth - 20) {
                left = Math.max(10, viewportWidth - tooltipWidth - 20);
            }

            let top = rect.bottom + 6;
            if (top + 160 > viewportHeight && rect.top > 180) {
                top = rect.top - 6;
                tooltip.classList.add('tooltip-top');
            } else {
                tooltip.classList.remove('tooltip-top');
            }

            tooltip.style.left = `${Math.round(left)}px`;
            tooltip.style.top = `${Math.round(top)}px`;
        });

        tableBody.addEventListener('mouseout', (e) => {
            const cell = e.target.closest('.memory-content-cell');
            if (!cell) return;
            hideTimer = setTimeout(() => {
                if (memoryTooltipEl && !memoryTooltipEl.matches(':hover')) {
                    memoryTooltipEl.classList.add('hidden');
                }
            }, 80);
        });
    }

    window.Pivot?.exposeModule?.('settings.memoryUi', {
        ensureMemoryModalsAttached,
        initMemoryContentTooltips
    });
})();
