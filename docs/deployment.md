# Deploying for free

The build output (`dist/`) is plain static files with relative asset paths (`base: './'`), so it works at a domain root or under a sub-path. There is no backend to deploy.

```powershell
npm install
npm run build      # produces dist/
```

I have **not** deployed this to any host yet, and free-tier limits change, so check each provider's current terms before relying on them.

## What gets built

The app itself is small (about 136 KB of JavaScript). Two lazy files are larger and are fetched only when a user opens the matching feature: three.js (about 688 KB) and the ONNX Runtime WebAssembly (about 11 MB). Both are served from your own site, so the host must allow files of that size (Cloudflare Pages allows up to 25 MiB per file; GitHub Pages is fine). AI models are **not** part of the build; users download them directly from Hugging Face. If Hugging Face changes or removes those files, the download button stops working, and "Use my own .onnx files" still works.

The AI runtime runs single-threaded on purpose, because multi-threaded WebAssembly needs special headers that free static hosts cannot set.

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
- Smoke-test the deployed URL: add an image, draw, save a project, export COCO, enable an AI model, load a `.glb`, check the browser console for errors. The built files have only been tested with `npm run preview` on one machine, not on a real host.
