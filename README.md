# PokeSniper dashboard

The web dashboard for PokeSniper: start runs, see what they found, switch cards on and off, and change the schedule. Works on a phone too.

This repo holds only the page. It contains no cards, results or keys. After you sign in, the page uses your GitHub access token to talk straight to GitHub's API, reading from and saving to the private PokeSniper repo. The token is saved in your browser and nowhere else.

- `index.html`: the page and its styles
- `app.js`: everything it does

Published to GitHub Pages by `.github/workflows/pages.yml` on every push to `main`.
