/**
 * @deprecated Retired openclaw-style streaming draft — superseded by the
 * harness-native feed in ./harness-feed.js, which reuses DeepSeek Harness's
 * own output pipeline (assistant block folding + tool presenters + live
 * prose streaming) instead of mimicking openclaw's single flowing draft.
 *
 * This shim keeps existing loader profiles (`dsh-telegram/extensions/openclaw`)
 * and imports working: the old mount/unmount names now bind the harness feed.
 */
export { apply, inject, mountHarnessFeed as mountOpenclawFeed, unmountHarnessFeed as unmountOpenclawFeed, } from "./harness-feed.js";
