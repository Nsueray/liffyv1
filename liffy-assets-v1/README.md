# Liffy Assets (v1)

CDN path suggestion: https://cdn.liffy.app/assets/

Included:
- assets/style.css
- assets/logo.png

Usage (HTML):

<link rel="stylesheet" href="https://cdn.liffy.app/assets/style.css">
<img src="https://cdn.liffy.app/assets/logo.png" class="logo" alt="Liffy">

Cache busting:
- Prefer versioned files (e.g., style-v1.css). Keep `style.css` as a stable alias that @imports the latest.