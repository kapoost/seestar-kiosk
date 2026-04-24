const { test, expect } = require('@playwright/test');

test.describe('Landing page — structure', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/');
    });

    test('renders all 7 sections', async ({ page }) => {
        const ids = ['hero', 'features', 'jazz-mapping', 'architecture', 'screenshot', 'quickstart'];
        for (const id of ids) {
            await expect(page.locator(`#${id}`)).toBeVisible();
        }
        await expect(page.locator('footer')).toBeVisible();
    });

    test('hero shows title and tagline', async ({ page }) => {
        await expect(page.locator('.hero-title')).toHaveText('Seestar Kiosk');
        await expect(page.locator('.hero-tagline')).toContainText('Jazz from the stars');
    });

    test('hero has two CTA buttons', async ({ page }) => {
        const ctas = page.locator('.hero-ctas .btn');
        await expect(ctas).toHaveCount(2);
        await expect(ctas.first()).toHaveText('View on GitHub');
        await expect(ctas.last()).toHaveText('Read the Docs');
    });

    test('GitHub link points to repo', async ({ page }) => {
        const link = page.locator('.hero-ctas a[href*="github.com"]');
        await expect(link).toHaveAttribute('href', 'https://github.com/kapoost/seestar-kiosk');
    });

    test('features grid has 3 cards', async ({ page }) => {
        await expect(page.locator('.feature-card')).toHaveCount(3);
    });

    test('features cards have correct titles', async ({ page }) => {
        const titles = page.locator('.feature-card h3');
        await expect(titles.nth(0)).toHaveText('Telescope');
        await expect(titles.nth(1)).toHaveText('Wide Camera');
        await expect(titles.nth(2)).toHaveText('Jazz Engine');
    });

    test('jazz table has 11 data rows', async ({ page }) => {
        const rows = page.locator('.jazz-table tbody tr');
        await expect(rows).toHaveCount(11);
    });

    test('architecture panel contains data flow diagram', async ({ page }) => {
        const pre = page.locator('.arch-panel pre');
        await expect(pre).toContainText('Seestar S30 Pro');
        await expect(pre).toContainText('seestar_alp');
        await expect(pre).toContainText('wide_proxy.py');
    });

    test('quick start has 6 steps', async ({ page }) => {
        await expect(page.locator('.step')).toHaveCount(6);
    });

    test('footer shows MIT license and credits', async ({ page }) => {
        const footer = page.locator('footer');
        await expect(footer).toContainText('MIT');
        await expect(footer).toContainText('kapoost');
        await expect(footer).toContainText('Magenta');
        await expect(footer).toContainText('Tone.js');
    });
});

test.describe('Landing page — day/night toggle', () => {
    test.beforeEach(async ({ page }) => {
        // Force dark color scheme so auto-detect picks night mode
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto('/');
    });

    test('starts in night mode with dark OS preference', async ({ page }) => {
        const html = page.locator('html');
        await expect(html).not.toHaveClass(/day-mode/);
    });

    test('starts in day mode with light OS preference', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto('/');
        const html = page.locator('html');
        await expect(html).toHaveClass(/day-mode/);
    });

    test('pressing D toggles day mode', async ({ page }) => {
        const html = page.locator('html');
        await page.keyboard.press('d');
        await expect(html).toHaveClass(/day-mode/);
    });

    test('pressing D twice returns to night mode', async ({ page }) => {
        const html = page.locator('html');
        await page.keyboard.press('d');
        await page.keyboard.press('d');
        await expect(html).not.toHaveClass(/day-mode/);
    });

    test('clicking D button toggles day mode (mobile)', async ({ page }) => {
        const html = page.locator('html');
        await page.locator('#day-toggle').click();
        await expect(html).toHaveClass(/day-mode/);
    });

    test('D button exists and is visible', async ({ page }) => {
        const btn = page.locator('#day-toggle');
        await expect(btn).toBeVisible();
        await expect(btn).toHaveText('D');
    });
});

test.describe('Landing page — scroll and animations', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/');
    });

    test('sections below hero start hidden', async ({ page }) => {
        const features = page.locator('#features');
        await expect(features).not.toHaveClass(/visible/);
    });

    test('scrolling to features triggers fade-in', async ({ page }) => {
        await page.locator('#features').scrollIntoViewIfNeeded();
        await expect(page.locator('#features')).toHaveClass(/visible/, { timeout: 3000 });
    });

    test('Read the Docs button scrolls to architecture', async ({ page }) => {
        await page.locator('a[href="#architecture"]').click();
        await expect(page.locator('#architecture')).toBeInViewport({ timeout: 3000 });
    });

    test('jazz table rows animate in on scroll', async ({ page }) => {
        const firstRow = page.locator('.jazz-table tbody tr').first();
        await expect(firstRow).not.toHaveClass(/visible/);

        await page.locator('#jazz-mapping').scrollIntoViewIfNeeded();
        await expect(firstRow).toHaveClass(/visible/, { timeout: 3000 });
    });
});

test.describe('Landing page — responsive', () => {
    test('grid collapses to 1 column at 400px', async ({ page }) => {
        await page.setViewportSize({ width: 400, height: 800 });
        await page.goto('/');

        const grid = page.locator('.features-grid');
        const columns = await grid.evaluate(el =>
            getComputedStyle(el).gridTemplateColumns
        );
        // Single column = one value (no spaces between multiple track sizes)
        const trackCount = columns.split(/\s+/).length;
        expect(trackCount).toBe(1);
    });
});

test.describe('Landing page — star canvas', () => {
    test('canvas element exists and is full viewport', async ({ page }) => {
        await page.goto('/');
        const canvas = page.locator('#star-canvas');
        await expect(canvas).toBeAttached();

        const box = await canvas.boundingBox();
        const viewport = page.viewportSize();
        expect(box.width).toBe(viewport.width);
        expect(box.height).toBe(viewport.height);
    });
});
