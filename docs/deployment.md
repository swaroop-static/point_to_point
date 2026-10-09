# Deploying for free

The build output (`dist/`) is plain static files with relative asset paths (`base: './'`), so it works at a domain root or under a sub-path. There is no backend to deploy.

```powershell
npm install
npm run build      # produces dist/
```

I have **not** deployed this to any host yet, and free-tier limits change, so check each provider's current terms before relying on them.

## Option A: Cloudflare Pages

1. Push the repository to GitHub (your decision, not done automatically).
2. Cloudflare dashboard, Workers and Pages, Create, Pages, connect the repository.
3. Build command: `npm run build`. Output directory: `dist`. Node 18 or newer.

Or upload `dist/` directly with the dashboard's direct-upload option.

## Option B: GitHub Pages

1. Push to GitHub.
2. Build locally and publish the contents of `dist/` to a `gh-pages` branch, or use a GitHub Actions workflow that runs `npm ci && npm run build` and deploys `dist/`.
3. Settings, Pages, choose the branch or the Actions source.

## Before publishing

- Check `git status` for anything that should not be public. `.gitignore` excludes `node_modules`, `dist`, `.env` and image files.
- Confirm you are comfortable with the MIT license in `LICENSE`.
- Smoke-test the deployed URL: add an image, draw, save a project, export COCO, check the browser console for errors.
