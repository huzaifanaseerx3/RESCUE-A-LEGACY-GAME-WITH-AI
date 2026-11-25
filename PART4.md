# STILLFRAME - Part 4: GitHub Pages Preparation

## Repository name and Pages URL

There is no GitHub `origin` configured in this workspace, and public search returns multiple unrelated STILLFRAME repositories. The repository name therefore cannot be confirmed locally without guessing.

The GitHub Actions build derives the base path from the repository that runs the workflow (`GITHUB_REPOSITORY`, in `owner/repository` form):

- Project site: `/<repository>/`
- User or organization site whose repository is `<owner>.github.io`: `/`

The expected repository URL format is `https://github.com/<OWNER>/<REPOSITORY>`. For a project site, the expected Pages URL format is `https://<OWNER>.github.io/<REPOSITORY>/`. Replace the placeholders with the actual repository owner and name; the configured workflow does not hard-code either value.

## Vite base path and output

`vite.config.ts` uses `/` for local development and ordinary local builds. In GitHub Actions it validates `GITHUB_REPOSITORY` and sets Vite's `base` to `/<repository>/` (or `/` for a `<owner>.github.io` site). This lets Vite rewrite the HTML entry module and emitted JavaScript/CSS asset references for the published URL. The WGSL shader files are imported as raw module content and bundled into the application JavaScript.

The Vite root remains `app/`. The build output is `app/dist/`, matching the Pages artifact path; the original root `index.html` is not used or modified.

## Deployment workflow

`.github/workflows/deploy-pages.yml` runs for pushes to `main` and also supports a manual `workflow_dispatch`. Its build job checks out the project, installs the root npm dependencies with `npm ci`, runs the TypeScript check, builds the site, and uploads `app/dist/` with the official Pages artifact action. The deploy job depends on the build job, so a failed install, type-check, or build prevents deployment.

The workflow uses the official `actions/checkout@v7`, `actions/setup-node@v7`, `actions/configure-pages@v6`, `actions/upload-pages-artifact@v5`, and `actions/deploy-pages@v5` actions. The build job has `contents: read` and `pages: read`; the deployment job has `pages: write` and `id-token: write`. The deployment uses the `github-pages` environment and publishes the resulting Pages URL in that environment.

## Commands

Run these from the repository root:

```powershell
npm ci
npm run typecheck
npm run build
npm run dev
```

`npm run build` writes the production site to `app/dist/`. The deployment workflow runs the install, type-check, and build commands automatically before uploading that directory.

## GitHub repository settings

After creating or identifying the repository:

1. Ensure its default deployment branch is `main` and the workflow file is present on that branch.
2. In **Settings → Pages → Build and deployment**, set **Source** to **GitHub Actions**.
3. Ensure Actions are enabled for the repository and allow the workflow to use the `github-pages` environment.
4. No branch-based Pages build source is needed; the workflow publishes the artifact.

## How automatic deployment works

When a change is pushed to `main`, GitHub starts the workflow. The build job must pass `npm ci`, `npm run typecheck`, and `npm run build`. Only then does the dependent deploy job publish `app/dist/` to GitHub Pages. A manual run is also available from the repository's **Actions** tab via **Run workflow**.

## How to verify a deployment

1. Open the **Actions** tab and confirm **Deploy to GitHub Pages** completed successfully for the intended `main` commit.
2. Open **Settings → Pages** or the `github-pages` deployment environment and follow its published URL.
3. Load the published page in a supported WebGPU browser and confirm the title screen appears.
4. In browser developer tools, check that the entry module, generated JavaScript/CSS, and other requests use the repository subpath (for example, `/<REPOSITORY>/assets/...`) and return successfully.
5. After a later change is pushed to `main`, confirm a new workflow run starts for that commit and publishes it.

No GitHub Actions run or live deployment has been performed from this workspace, so deployment success and a concrete live URL are not yet verified.

## Local configuration verification

- `npm run typecheck` succeeded.
- `npm run build` succeeded and emitted `app/dist/`; the ordinary local build uses `/assets/...` URLs.
- A simulated GitHub Actions build with `GITHUB_REPOSITORY=example-owner/stillframe` emitted `app/dist/` with `/stillframe/assets/...` URLs. The sample owner/repository was only a test value, not an assertion about the actual repository.
- The running local Vite server returned HTTP 200 for `/` and `/src/main.ts`.

## Limitations

- The actual GitHub owner/repository is not configured in this workspace. The workflow derives the correct production path at runtime; the URL above remains a template until the repository is known and Pages has deployed.
- The game uses pointer lock. It could not be fully tested in the embedded browser because that browser rejected the pointer-lock request. Do not treat successful deployment or a visible title screen as verification of gameplay.
- WebGPU availability depends on the player's browser and device. This deployment configuration does not add a fallback renderer or change game behavior.
