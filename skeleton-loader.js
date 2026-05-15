function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function createLoadingController({
    onShow,
    onHide,
    delayMs = 120,
    minVisibleMs = 220
}) {
    let pendingCount = 0;
    let visible = false;
    let visibleSince = 0;
    let showTimer = null;

    function showNow() {
        if (visible || pendingCount <= 0) return;
        onShow();
        visible = true;
        visibleSince = Date.now();
    }

    function start() {
        pendingCount += 1;
        let stopped = false;

        if (!visible && !showTimer && delayMs <= 0) {
            showNow();
        } else if (!visible && !showTimer) {
            showTimer = setTimeout(() => {
                showTimer = null;
                showNow();
            }, delayMs);
        }

        return async () => {
            if (stopped) return;
            stopped = true;
            pendingCount = Math.max(0, pendingCount - 1);

            if (pendingCount > 0) return;

            if (showTimer) {
                clearTimeout(showTimer);
                showTimer = null;
            }

            if (!visible) return;

            const elapsed = Date.now() - visibleSince;
            if (elapsed < minVisibleMs) {
                await wait(minVisibleMs - elapsed);
            }

            if (pendingCount === 0 && visible) {
                onHide();
                visible = false;
            }
        };
    }

    return { start };
}

function createListSkeleton(count = 4) {
    const cards = Array.from({ length: count }).map((_, index) => `
        <div class="app-list-skeleton-item">
            <div class="app-list-skeleton-header">
                <div class="app-list-skeleton-title-group">
                    <div class="app-skeleton app-list-skeleton-date-left"></div>
                    <div class="app-skeleton app-list-skeleton-title"></div>
                </div>
                <div class="app-skeleton app-list-skeleton-date-right"></div>
            </div>
            <div class="app-skeleton app-list-skeleton-preview app-skeleton-line-long"></div>
            <div class="app-skeleton app-list-skeleton-preview ${index % 2 === 0 ? 'app-list-skeleton-preview-medium' : 'app-list-skeleton-preview-short'}"></div>
            <div class="app-list-skeleton-actions">
                <div class="app-skeleton app-list-skeleton-action"></div>
                <div class="app-skeleton app-list-skeleton-action"></div>
            </div>
        </div>
    `).join('');

    return `<div>${cards}</div>`;
}

function createKanbanSkeleton(cardsPerColumn = 3) {
    const cards = Array.from({ length: cardsPerColumn }).map(() => `
        <div class="app-skeleton-card">
            <div class="app-skeleton app-skeleton-line app-skeleton-line-medium"></div>
            <div class="app-skeleton app-skeleton-line app-skeleton-line-long"></div>
            <div class="app-skeleton app-skeleton-line app-skeleton-line-short"></div>
        </div>
    `).join('');

    return `<div class="app-skeleton-column">${cards}</div>`;
}

function createInlineSkeleton(lines = 2) {
    const items = Array.from({ length: lines }).map((_, index) => {
        const widthClass = index % 2 === 0 ? 'app-skeleton-line-long' : 'app-skeleton-line-medium';
        return `<div class="app-skeleton app-skeleton-line ${widthClass}"></div>`;
    }).join('');

    return `<div class="app-skeleton-container">${items}</div>`;
}

function createPersonMetricsSkeleton(count = 6) {
    const items = Array.from({ length: count }).map(() => `
        <div class="person-metric-item app-metric-skeleton-item" aria-hidden="true">
            <div class="person-metric-chart app-metric-skeleton-donut app-skeleton">
                <div class="app-metric-skeleton-center">
                    <div class="app-metric-skeleton-center-dot"></div>
                </div>
            </div>
            <div class="person-metric-name app-skeleton app-metric-skeleton-name"></div>
        </div>
    `).join('');

    return items;
}

module.exports = {
    createLoadingController,
    createListSkeleton,
    createKanbanSkeleton,
    createInlineSkeleton,
    createPersonMetricsSkeleton
};
