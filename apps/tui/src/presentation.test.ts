import { expect, test } from "bun:test"
import { BoxRenderable, TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"

import { detailSummaryHeight, formatBingIndexLine, formatHomeCardStrip, homeCardStripHeight, masterVisibleRowLimit } from "./presentation.ts"
import type { EngineTotals } from "./types.ts"

const renderRegistrySummary = async (
  rendererWidth: number,
  detailWidth: number,
) => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
    width: detailWidth,
    height: 20,
  })
  const detail = new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    overflow: "hidden",
    borderStyle: "single",
    padding: 1,
    flexDirection: "column",
  })
  const summary = new BoxRenderable(renderer, {
    height: detailSummaryHeight(true, rendererWidth),
    flexShrink: 0,
    minWidth: 0,
    overflow: "hidden",
    border: ["bottom"],
    borderStyle: "single",
    paddingBottom: 1,
    flexDirection: "column",
  })
  summary.add(new TextRenderable(renderer, {
    height: 1,
    flexShrink: 0,
    content: "/ios-app",
  }))
  const summaryBody = new TextRenderable(renderer, {
    flexGrow: 1,
    minHeight: 0,
    overflow: "hidden",
    content: "",
  })
  summary.add(summaryBody)
  detail.add(summary)
  detail.add(new BoxRenderable(renderer, {
    flexGrow: 1,
    minHeight: 0,
  }))
  renderer.root.add(detail)

  await renderOnce()
  summaryBody.content = [
    "Page: /ios-app",
    "Current 28 days: 0 impressions",
    "Previous baseline: 0 impressions",
    "Search intent: Product / how-to",
    "Registry: P0 · USA · 4 keywords",
    "Google index: Discovered - currently not indexed",
  ].join("\n")
  await renderOnce()

  const frame = captureCharFrame().replaceAll(/\s+/g, " ")
  renderer.destroy()
  return frame
}

test("masterVisibleRowLimit subtracts base chrome from renderer height", () => {
  expect(masterVisibleRowLimit(40, { hasTableHeader: false })).toBe(28)
})

test("masterVisibleRowLimit subtracts one row when the table has a header", () => {
  expect(masterVisibleRowLimit(40, { hasTableHeader: true })).toBe(27)
})

test("masterVisibleRowLimit subtracts extra chrome for future strips", () => {
  expect(masterVisibleRowLimit(40, { hasTableHeader: false, extraChrome: 5 })).toBe(23)
})

test("masterVisibleRowLimit never returns less than one visible row", () => {
  expect(masterVisibleRowLimit(5, { hasTableHeader: true, extraChrome: 5 })).toBe(1)
})

const sampleTotals: EngineTotals = {
  google: {
    d28: { impressions: 368, clicks: 36, ctr: 0.098, daysCollected: 28, windowDays: 28 },
    d7: { impressions: 92, clicks: 9, ctr: 0.098, daysCollected: 7, windowDays: 7 },
  },
  bing: {
    d28: { impressions: 70, clicks: 4, ctr: 0.061, daysCollected: 8, windowDays: 28 },
    d7: { impressions: 18, clicks: 1, ctr: 0.056, daysCollected: 7, windowDays: 7 },
  },
}

test("homeCardStripHeight is five lines on home when the terminal is tall enough", () => {
  expect(homeCardStripHeight("home", 40)).toBe(5)
  expect(homeCardStripHeight("home", 29)).toBe(1)
  expect(homeCardStripHeight("registry", 40)).toBe(0)
})

test("formatHomeCardStrip labels a partial Bing 28d window", () => {
  const strip = formatHomeCardStrip(sampleTotals, 120, 40)
  expect(strip).toContain("28d · 8d")
  expect(strip).toContain("368")
  expect(strip).toContain("70")
})

test("formatHomeCardStrip collapses to one line on short terminals", () => {
  const strip = formatHomeCardStrip(sampleTotals, 120, 24)
  expect(strip.split("\n")).toHaveLength(1)
  expect(strip).toContain("IMPRESSIONS")
  expect(strip).toContain("CTR")
})

test("registry detail summary leaves room for the Google index line", async () => {
  const expected = "Google index: Discovered - currently not indexed"
  const narrow = await renderRegistrySummary(80, 40)

  expect(await renderRegistrySummary(200, 104)).toContain(expected)
  expect(narrow).toContain("Google index: Discovered -")
  expect(narrow).toContain("currently not indexed")
})

test("formatBingIndexLine reports not indexed and crawl dates", () => {
  expect(
    formatBingIndexLine({
      bingInIndex: false,
      bingDiscoveredAt: null,
      bingLastCrawledAt: null,
      bingInspectedAt: "2026-07-26T10:00:00.000Z",
    }),
  ).toBe("Bing: not indexed")
  expect(
    formatBingIndexLine({
      bingInIndex: true,
      bingDiscoveredAt: "2024-03-01",
      bingLastCrawledAt: "2024-06-15",
      bingInspectedAt: "2026-07-26T10:00:00.000Z",
    }),
  ).toBe("Bing: crawled 2024-06-15 · discovered 2024-03-01")
})

test("registry detail summary height accounts for the Bing index line", () => {
  expect(detailSummaryHeight(true, 120)).toBe(10)
  expect(detailSummaryHeight(true, 80)).toBe(14)
})
