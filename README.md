# InvidioSlop

Firefox extension that hides or marks AI slop on YouTube and on any Invidious instance.

A video is flagged when:

- its channel is on the [AiSList](https://github.com/Override92/AiSList) **blocklist** (default: hidden),
- its channel is on the AiSList **warnlist** (default: marked),
- YouTube itself discloses it as altered / AI-generated — the "How this was made" label (default: marked).

Each of the three can be set to Hide, Mark or Ignore from the toolbar popup, which also has your own
allow/block lists, a "show hidden videos on this page" toggle and a manual list sync.

## Install

- **Signed build:** download the `.xpi` from the repository's Releases page and open it in Firefox.
- **From source (temporary):** `about:debugging` → This Firefox → Load Temporary Add-on → pick `manifest.json`.
- **Signing your own build:** `npx web-ext sign --channel=unlisted` with addons.mozilla.org API keys
  (bump `version` in `manifest.json` first; change the add-on ID if you are not the original owner).

## How it works

- The two AiSList files are downloaded from GitHub on install and re-checked every 6 hours (ETag, so
  unchanged lists cost nothing). They are fetched at runtime, not bundled; the list is CC BY-NC 4.0.
- AiSList identifies channels by `@handle`. YouTube pages usually carry the handle; Invidious pages only
  carry the `UC…` channel ID, so the extension asks youtube.com for the handle once per channel and
  caches it for 30 days.
- The AI label is not present in any listing, so it costs one youtube.com request per video
  (cached 14 days). Lookups run only for cards near the viewport, four at a time, and are skipped for
  videos already blocked by the list.
- Invidious is detected from page markup, so the content script is registered on all sites and exits
  immediately elsewhere.

**Privacy:** on Invidious those lookups go from your browser straight to youtube.com (no cookies).
Turn off "Look things up on youtube.com" in the popup to stop them; on Invidious that leaves almost
nothing to match against, on YouTube only the AI label and link-less cards (e.g. Shorts) are lost.

## Not covered

- Channel cards in search results (only video cards are handled).
- Flagged watch pages get a banner; the video is not prevented from playing.

## License

Code: [GPL-3.0](LICENSE). The AiSList data it downloads at runtime is CC BY-NC 4.0 and belongs to its contributors.
