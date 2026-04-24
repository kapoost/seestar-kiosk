/* Seestar Kiosk — star canvas + day toggle + IntersectionObserver */

(function () {
    'use strict';

    // ── Star canvas ──────────────────────────────────────
    const canvas = document.getElementById('star-canvas');
    const ctx = canvas.getContext('2d');
    const stars = [];
    const COUNT = 80;

    function resize() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    }

    function init() {
        resize();
        for (let i = 0; i < COUNT; i++) {
            stars.push({
                x: Math.random() * canvas.width,
                y: Math.random() * canvas.height,
                r: Math.random() * 1.5 + 0.5,
                phase: Math.random() * Math.PI * 2,
                speed: Math.random() * 0.02 + 0.005
            });
        }
    }

    function draw(t) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const isDayMode = document.documentElement.classList.contains('day-mode');

        for (const s of stars) {
            const alpha = 0.3 + 0.7 * ((Math.sin(t * s.speed + s.phase) + 1) / 2);
            ctx.beginPath();
            ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
            ctx.fillStyle = isDayMode
                ? `rgba(180, 200, 255, ${alpha * 0.4})`
                : `rgba(204, 51, 51, ${alpha * 0.6})`;
            ctx.fill();
        }

        requestAnimationFrame(draw);
    }

    window.addEventListener('resize', () => {
        resize();
        // re-scatter stars on resize
        stars.forEach(s => {
            s.x = Math.random() * canvas.width;
            s.y = Math.random() * canvas.height;
        });
    });

    init();
    requestAnimationFrame(draw);

    // ── Day mode toggle (D key) ──────────────────────────
    document.addEventListener('keydown', (e) => {
        if (e.key === 'd' || e.key === 'D') {
            document.documentElement.classList.toggle('day-mode');
        }
    });

    // ── IntersectionObserver: fade-in sections ───────────
    const sectionObs = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('visible');
                sectionObs.unobserve(entry.target);
            }
        });
    }, { threshold: 0.15 });

    document.querySelectorAll('section:not(#hero)').forEach(s => sectionObs.observe(s));

    // ── IntersectionObserver: jazz table row stagger ─────
    const tableObs = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const rows = entry.target.querySelectorAll('tr');
                rows.forEach((row, i) => {
                    setTimeout(() => row.classList.add('visible'), i * 50);
                });
                tableObs.unobserve(entry.target);
            }
        });
    }, { threshold: 0.1 });

    const jazzTable = document.querySelector('.jazz-table');
    if (jazzTable) tableObs.observe(jazzTable);
})();
