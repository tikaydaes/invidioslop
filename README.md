# InvidioSlop

Firefox extension that hides or marks AI slop on YouTube and on any Invidious instance.

A video is flagged when:

- its channel is on the [AiSList](https://github.com/Override92/AiSList) **blocklist** (default: hidden),
- its channel is on the AiSList **warnlist** (default: marked),
- YouTube itself discloses it as altered / AI-generated — the "How this was made" label (default: marked).

Each of the three can be set to Hide, Mark or Ignore from the toolbar popup, which also has your own
allow/block lists, a "show hidden videos on this page" toggle and a manual list sync.

Right-clicking a video (or anywhere on a watch or channel page) adds an InvidioSlop menu:

- **Block / Unblock @channel** — adds the channel to your own block list, or lifts a block. Unblocking a
  channel that AiSList flags puts it on your never-flag list. Everything stays local to your browser.
- **Copy handle** — copies the channel's `@handle`.
- **Show hidden videos on this page** — toggles hidden videos on and off.

## Install

- **From Mozilla:** https://addons.mozilla.org/firefox/addon/invidioslop/
- **Unsigned build (temporary):** every push builds an `invidioslop-<version>-unsigned` artifact (Actions → Build),
  and each release has the same zip attached. Load it via `about:debugging` → This Firefox → Load Temporary Add-on.
- **From source (temporary):** `about:debugging` → This Firefox → Load Temporary Add-on → pick `manifest.json`.

## Releasing

Bump `version` in `manifest.json`, commit, then push a matching tag (`git tag v0.1.2 && git push --tags`).
The Release workflow lints the extension, submits it to addons.mozilla.org as a listed version and creates
a GitHub release. It needs the `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` repository secrets.

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

## How it was built

InvidioSlop was co-coded with Claude Fable 5.2, Anthropic's AI model, working in Claude Code. The
maintainer set the requirements, made the design and release decisions and tested the result; Fable
wrote the code and checked it in a real Firefox against YouTube and a live Invidious instance.

That is not the kind of AI use this extension targets. It filters mass-produced video content made
to fill feeds, not software written with AI assistance and reviewed by a person. Bug reports and
corrections are welcome either way.

## License

Code: [GPL-3.0](LICENSE). The AiSList data it downloads at runtime is CC BY-NC 4.0 and belongs to its contributors.
