# TridentCity BlueMap

[Open the live map](https://boscochristian12-stack.github.io/tridentcity-map/).

This repository publishes a static copy of the BlueMap web files from the TridentCity Minecraft server to GitHub Pages.

## Updates

GitHub Actions syncs the generated `bluemap/web` files through the exaroton API when `main` changes and once per hour. You can also start a run from the **Actions** tab with **Run workflow**.

The workflow needs the `EXAROTON_API_TOKEN` repository secret. Keep the token in GitHub Secrets; never commit it to this repository.

BlueMap must generate map tiles on the server before new areas can appear here. The public map remains available while the Minecraft server is stopped. After BlueMap renders new tiles, the next sync publishes them, usually within an hour.
