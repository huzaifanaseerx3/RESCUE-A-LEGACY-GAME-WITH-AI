import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

function getBase() {
  if (process.env.GITHUB_ACTIONS !== "true")
    return "/";
  const [owner, repository, ...extra] = (process.env.GITHUB_REPOSITORY ?? "").split("/");
  if (!owner || !repository || extra.length > 0)
    throw new Error("GITHUB_REPOSITORY must be set to owner/repository for a GitHub Actions build.");
  if (repository.toLowerCase() === `${owner.toLowerCase()}.github.io`)
    return "/";
  return `/${repository}/`;
}

export default defineConfig({
  base: getBase(),
  root: fileURLToPath(new URL("./app", import.meta.url)),
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});
